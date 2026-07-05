/**
 * 천타버스 코인 거래소 - SOOP 실시간 채팅 카운트 서비스 (Cloud Run, 상시 구동)
 *
 * 시청자수 대신 "분당 채팅수"를 코인 가격으로 사용한다.
 * 시청자수는 REST 폴링으로 충분했지만, 채팅수는 SOOP이 REST로 제공하지 않고
 * 방송별 실시간 채팅 웹소켓에 직접 붙어서 메시지를 세는 방법뿐이라(비공식 프로토콜),
 * Cloud Scheduler + 짧게 끝나는 Cloud Functions 구조로는 안 되고 상시 연결이 필요하다.
 * 그래서 이 부분만 Cloud Run으로 분리했다.
 *
 * 검증된 프로토콜 (2026-07-06, 실제 라이브 방송 gjgj3274 대상 테스트):
 *   1) GET/POST player_live_api.php 로 CHATNO/CHDOMAIN/CHPT 획득
 *   2) wss://{CHDOMAIN}:{CHPT+1}/Websocket/{bjId} 로 연결 (subprotocol: 'chat')
 *   3) CONNECT_PACKET 전송 -> 2초 대기 -> JOIN_PACKET(CHATNO 포함) 전송
 *   4) 들어오는 프레임은 0x0C(form feed)로 필드가 구분됨. 헤더의 opcode가 "0005"인
 *      프레임만 실제 채팅 메시지 (0127=입장, 0109=퇴장, 0002=join ack 등은 채팅 아님 -
 *      실제 라이브 방송에서 각 opcode별 프레임을 직접 캡처해서 확인함)
 *   5) 5분 이상 핑이 없으면 서버가 연결을 끊으므로 60초마다 PING_PACKET 전송
 *
 * 방송 종료(offline) 시에는 그날 누적된 분당 채팅수의 평균으로 가격을 고정한다
 * (같은 날 여러 번 방송해도 하루 전체 평균 1개로 통합 - functions/index.js의
 * computeUpdate와 동일한 로직을 그대로 포팅함).
 */
const axios = require("axios");
const WebSocket = require("ws");
const admin = require("firebase-admin");
const http = require("http");

admin.initializeApp();
const db = admin.firestore();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const LIVE_CHECK_INTERVAL_MS = 30 * 1000; // 방송 시작/종료 여부 체크 주기
const PRICE_TICK_INTERVAL_MS = 60 * 1000; // 코인 가격(분당 채팅수) 반영 주기
const CHAT_PING_INTERVAL_MS = 60 * 1000; // 채팅 소켓 keepalive (5분 무핑이면 끊김)

// ====================== KST 날짜 ======================
function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// ====================== 코인 가격 계산 (순수 함수, functions/index.js와 동일 로직) ======================
function computeUpdate(coin, isLive, chatCount, today, now = Date.now()) {
  const wasLive = coin.status === "live";

  let todaySum = coin.todaySum || 0;
  let todayCount = coin.todayCount || 0;
  if (coin.todayDate !== today) {
    todaySum = 0;
    todayCount = 0;
  }

  const update = { todayDate: today };
  const history = Array.isArray(coin.priceHistory) ? coin.priceHistory.slice(-59) : [];

  if (isLive) {
    todaySum += chatCount;
    todayCount += 1;
    update.status = "live";
    update.currentPrice = chatCount;
    update.todaySum = todaySum;
    update.todayCount = todayCount;
    history.push({ t: now, v: chatCount });
    update.priceHistory = history;
  } else {
    update.status = "closed";
    if (wasLive && todayCount > 0) {
      const avg = Math.round(todaySum / todayCount);
      update.frozenPrice = avg;
      update.currentPrice = avg;
      history.push({ t: now, v: avg });
      update.priceHistory = history;
    }
    update.todaySum = todaySum;
    update.todayCount = todayCount;
  }

  return update;
}

// ====================== 방송 중 여부 ======================
async function checkIsLive(bjId) {
  try {
    const res = await axios.get(`https://bjapi.afreecatv.com/api/${encodeURIComponent(bjId)}/station`, {
      headers: { "User-Agent": UA },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (res.status !== 200) return false;
    return !!res.data?.broad;
  } catch (e) {
    console.error(`checkIsLive(${bjId}) 실패:`, e.message);
    return false;
  }
}

// ====================== 채팅 접속 정보 (CHATNO/CHDOMAIN/CHPT) ======================
async function getChatConnectInfo(bjId) {
  const res = await axios.post(
    "https://live.afreecatv.com/afreeca/player_live_api.php",
    new URLSearchParams({ bid: bjId, type: "live", pwd: "", player_type: "html5" }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        "Referer": `https://play.sooplive.co.kr/${bjId}`,
      },
      timeout: 8000,
    }
  );
  const c = res.data?.CHANNEL;
  if (!c || Number(c.RESULT) !== 1) return null;
  return {
    chatNo: c.CHATNO,
    chatDomain: String(c.CHDOMAIN).toLowerCase(),
    chatPort: String(Number(c.CHPT) + 1),
  };
}

// ====================== 채팅 패킷 (SOOP 비공식 프로토콜) ======================
const F = Buffer.from([0x0c]);
const ESC = Buffer.from([0x1b, 0x09]);

function buildPacket(opcode, body) {
  const header = Buffer.from(
    `${String(opcode).padStart(4, "0")}${String(body.length).padStart(6, "0")}00`,
    "ascii"
  );
  return Buffer.concat([ESC, header, body]);
}

function connectPacket() {
  return buildPacket(1, Buffer.concat([F, F, F, Buffer.from("16", "ascii"), F]));
}
function joinPacket(chatNo) {
  return buildPacket(2, Buffer.concat([F, Buffer.from(String(chatNo), "utf8"), F, F, F, F, F]));
}
function pingPacket() {
  return buildPacket(0, F);
}

// coinId -> { ws, bjId, chatCount, pingTimer }
const connections = new Map();

function openChatConnection(coinId, bjId, connectInfo) {
  const url = `wss://${connectInfo.chatDomain}:${connectInfo.chatPort}/Websocket/${bjId}`;
  const ws = new WebSocket(url, ["chat"]);
  const conn = { ws, bjId, chatCount: 0, pingTimer: null };
  connections.set(coinId, conn);

  ws.on("open", () => {
    console.log(`[${coinId}/${bjId}] 채팅 연결 성공`);
    ws.send(connectPacket());
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(joinPacket(connectInfo.chatNo));
    }, 2000);
    conn.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pingPacket());
    }, CHAT_PING_INTERVAL_MS);
  });

  ws.on("message", (data) => {
    const parts = Buffer.from(data).toString("utf8").split("\x0c");
    const opcode = parts[0].slice(2, 6);
    if (opcode === "0005") {
      conn.chatCount += 1;
    }
  });

  ws.on("error", (e) => {
    console.error(`[${coinId}/${bjId}] 채팅 소켓 에러:`, e.message);
  });

  ws.on("close", () => {
    console.log(`[${coinId}/${bjId}] 채팅 연결 종료`);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    // isLive 재확인 루프가 다시 열지 결정하도록 맵에서만 제거
    if (connections.get(coinId) === conn) connections.delete(coinId);
  });
}

function closeChatConnection(coinId) {
  const conn = connections.get(coinId);
  if (!conn) return;
  if (conn.pingTimer) clearInterval(conn.pingTimer);
  try {
    conn.ws.close();
  } catch (e) {
    // ignore
  }
  connections.delete(coinId);
}

// ====================== 방송 시작/종료 감지 루프 ======================
async function liveCheckLoop() {
  const coinsSnap = await db.collection("coins").get();
  const today = todayKST();

  await Promise.all(
    coinsSnap.docs.map(async (doc) => {
      const coinId = doc.id;
      const coin = doc.data();
      const isLive = await checkIsLive(coin.bjId);
      const hasConn = connections.has(coinId);

      if (isLive && !hasConn) {
        const info = await getChatConnectInfo(coin.bjId);
        if (info) {
          openChatConnection(coinId, coin.bjId, info);
        }
      } else if (!isLive && hasConn) {
        closeChatConnection(coinId);
      }

      if (!isLive && coin.status === "live") {
        // 방금 방송이 끝난 시점: 그날 평균으로 가격 고정
        const update = computeUpdate(coin, false, 0, today);
        update.lastUpdated = admin.firestore.FieldValue.serverTimestamp();
        await doc.ref.update(update);
      }
    })
  );
}

// ====================== 1분마다 가격(분당 채팅수) 반영 루프 ======================
async function priceTickLoop() {
  const today = todayKST();
  const entries = Array.from(connections.entries());

  await Promise.all(
    entries.map(async ([coinId, conn]) => {
      const chatCount = conn.chatCount;
      conn.chatCount = 0; // 다음 1분을 위해 리셋

      const doc = await db.collection("coins").doc(coinId).get();
      if (!doc.exists) return;
      const coin = doc.data();

      const update = computeUpdate(coin, true, chatCount, today);
      update.lastUpdated = admin.firestore.FieldValue.serverTimestamp();
      await doc.ref.update(update);

      console.log(`[${coinId}] 분당 채팅수=${chatCount} -> currentPrice=${update.currentPrice}`);
    })
  );
}

function startLoops() {
  liveCheckLoop().catch((e) => console.error("liveCheckLoop 실패:", e.message));
  setInterval(() => {
    liveCheckLoop().catch((e) => console.error("liveCheckLoop 실패:", e.message));
  }, LIVE_CHECK_INTERVAL_MS);

  setInterval(() => {
    priceTickLoop().catch((e) => console.error("priceTickLoop 실패:", e.message));
  }, PRICE_TICK_INTERVAL_MS);
}

// ====================== Cloud Run 헬스체크용 HTTP 서버 ======================
// require()로 테스트에서 순수 함수만 가져다 쓸 때는 서버/폴링 루프가 돌면 안 되므로
// 실제로 `node index.js`로 직접 실행했을 때만 기동한다.
if (require.main === module) {
  const port = process.env.PORT || 8080;
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          activeConnections: Array.from(connections.keys()),
        })
      );
    })
    .listen(port, () => {
      console.log(`chatservice listening on ${port}`);
      startLoops();
    });

  process.on("SIGTERM", () => {
    console.log("SIGTERM 수신, 채팅 연결 정리 중...");
    for (const coinId of Array.from(connections.keys())) {
      closeChatConnection(coinId);
    }
    process.exit(0);
  });
}

module.exports = {
  computeUpdate,
  todayKST,
  checkIsLive,
  getChatConnectInfo,
  buildPacket,
  connectPacket,
  joinPacket,
  pingPacket,
  openChatConnection,
  closeChatConnection,
  connections,
  liveCheckLoop,
  priceTickLoop,
  db,
};
