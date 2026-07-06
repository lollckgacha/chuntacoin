/**
 * 천타버스 코인 거래소 - SOOP 실시간 채팅 카운트 서비스 (Cloud Run, 상시 구동)
 *
 * 가격 산정 규칙 (2026-07-06 재설계):
 *   - 방송 종료 중: 거래 정지, 마지막 종가만 표시
 *   - 방송 시작 후 첫 5분: 이전 종가로 가격 고정, 거래는 가능
 *   - 방송 시작 5분 이후: 최근 5분 평균 분당 채팅수로 현재가 계산, 매분 0초에 갱신
 *     현재가 = 1000원 + 최근 5분 평균 분당 채팅수 × 100원
 *   - 방송 종료 시: 즉시 거래 정지, 첫 5분/마지막 5분을 제외한 구간의 평균으로 종가 계산
 *     종가 = 1000원 + (첫/끝 5분 제외) 방송 평균 분당 채팅수 × 100원
 *
 * 검증된 채팅 웹소켓 프로토콜 (2026-07-06, 실제 라이브 방송 gjgj3274 대상 테스트):
 *   1) GET/POST player_live_api.php 로 CHATNO/CHDOMAIN/CHPT 획득
 *   2) wss://{CHDOMAIN}:{CHPT+1}/Websocket/{bjId} 로 연결 (subprotocol: 'chat')
 *   3) CONNECT_PACKET 전송 -> 2초 대기 -> JOIN_PACKET(CHATNO 포함) 전송
 *   4) 들어오는 프레임은 0x0C(form feed)로 필드가 구분됨. 헤더의 opcode가 "0005"인
 *      프레임만 실제 채팅 메시지 (0127=입장, 0109=퇴장, 0002=join ack 등은 채팅 아님)
 *   5) 5분 이상 핑이 없으면 서버가 연결을 끊으므로 60초마다 PING_PACKET 전송
 *
 * Firestore 사용량 최적화 (2026-07-06):
 *   예전에는 30초마다 coins 컬렉션 전체를 다시 읽어왔는데(하루 약 3.4만 읽기,
 *   트래픽과 무관하게 고정 발생), 12명의 bjId 목록은 거의 바뀌지 않으므로 시작할 때
 *   딱 한 번만 읽고 메모리에 캐싱한다. 이후로는 실제로 가격이 바뀔 때(매분 0초)와
 *   방송 시작/종료 시점에만 Firestore를 쓴다 (읽기는 인스턴스 재시작 시 1회뿐).
 */
const axios = require("axios");
const WebSocket = require("ws");
const admin = require("firebase-admin");
const http = require("http");

admin.initializeApp();
const db = admin.firestore();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const LIVE_CHECK_INTERVAL_MS = 30 * 1000; // 방송 시작/종료 여부 체크 주기 (Firestore 아님, SOOP API 호출)
const CHAT_PING_INTERVAL_MS = 60 * 1000; // 채팅 소켓 keepalive (5분 무핑이면 끊김)

const PRICE_BASE = 1000; // 현재가/종가 공식의 기본값
const PRICE_MULTIPLIER = 100; // 분당 채팅수 1당 가격 가중치
const FREEZE_MINUTES = 5; // 방송 시작 후 가격 고정 구간(분) / 종가 계산 시 제외하는 앞뒤 구간(분)
const ROLLING_WINDOW_MINUTES = 5; // 현재가 계산에 쓰는 이동평균 구간(분)
const MAX_CHAT_SAMPLES = 600; // chatSamples 무한정 증가 방지 (10시간 방송까지 커버)
const MAX_PRICE_HISTORY = 180; // 차트용 priceHistory 상한 (3시간)

// ====================== KST 시간 ======================
function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function todayKST() {
  return nowKST().toISOString().slice(0, 10);
}

// ====================== 가격 계산 순수 함수 ======================
function averageOf(samples) {
  if (!samples || samples.length === 0) return 0;
  return samples.reduce((s, x) => s + x.v, 0) / samples.length;
}
function priceFromAvg(avgChatPerMin) {
  return Math.round(PRICE_BASE + avgChatPerMin * PRICE_MULTIPLIER);
}

// 방송 시작 직후(첫 5분) -> 이전 종가로 고정 / 5분 이후 -> 최근 5분 평균으로 계산
// coin: { frozenPrice, broadcastStartedAt, chatSamples, priceHistory }
// chatCountThisMinute: 이번 1분간 실제로 카운트된 채팅 수
function computeLiveTick(coin, chatCountThisMinute, now) {
  const chatSamples = (Array.isArray(coin.chatSamples) ? coin.chatSamples : [])
    .concat([{ t: now, v: chatCountThisMinute }])
    .slice(-MAX_CHAT_SAMPLES);

  const broadcastStartedAt = coin.broadcastStartedAt ?? now;
  const elapsedMin = (now - broadcastStartedAt) / 60000;

  const currentPrice =
    elapsedMin < FREEZE_MINUTES
      ? coin.frozenPrice || PRICE_BASE
      : priceFromAvg(averageOf(chatSamples.slice(-ROLLING_WINDOW_MINUTES)));

  const priceHistory = (Array.isArray(coin.priceHistory) ? coin.priceHistory : [])
    .concat([{ t: now, v: currentPrice }])
    .slice(-MAX_PRICE_HISTORY);

  return {
    status: "live",
    tradable: true,
    broadcastStartedAt,
    currentPrice,
    chatSamples,
    priceHistory,
  };
}

// 방송 종료 시점 -> 첫 5분/마지막 5분을 제외한 구간의 평균으로 종가 계산
function computeCloseTick(coin, now) {
  const chatSamples = Array.isArray(coin.chatSamples) ? coin.chatSamples : [];
  const broadcastStartedAt = coin.broadcastStartedAt ?? now;

  const middle = chatSamples.filter((s) => {
    const fromStart = (s.t - broadcastStartedAt) / 60000;
    const fromEnd = (now - s.t) / 60000;
    return fromStart >= FREEZE_MINUTES && fromEnd >= FREEZE_MINUTES;
  });
  // 방송이 10분(첫5분+끝5분)보다 짧으면 중간 구간이 비므로 전체 평균으로 대체
  const basis = middle.length > 0 ? middle : chatSamples;
  const closePrice = priceFromAvg(averageOf(basis));

  const priceHistory = (Array.isArray(coin.priceHistory) ? coin.priceHistory : [])
    .concat([{ t: now, v: closePrice }])
    .slice(-MAX_PRICE_HISTORY);

  return {
    status: "closed",
    tradable: false,
    currentPrice: closePrice,
    frozenPrice: closePrice,
    broadcastStartedAt: null,
    chatSamples: [], // 다음 방송을 위해 리셋
    priceHistory,
  };
}

// ====================== 방송 중 여부 (SOOP API, Firestore 아님) ======================
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

// ====================== 상태 (전부 메모리 캐시, coinState가 Firestore 값의 사본 역할) ======================
// coinId -> { bjId, status, tradable, currentPrice, frozenPrice, broadcastStartedAt, chatSamples, priceHistory }
const coinState = new Map();
// coinId -> { ws, chatCount, pingTimer }
const connections = new Map();

// 인스턴스 시작 시 1회만 coins 컬렉션을 읽어서 메모리에 채운다 (그 이후로는 주기적 재조회 없음)
async function loadInitialState() {
  const snap = await db.collection("coins").get();
  snap.forEach((doc) => {
    coinState.set(doc.id, { bjId: doc.data().bjId, ...doc.data() });
  });
  console.log(`초기 상태 로드 완료: ${coinState.size}개 코인 (Firestore 읽기 1회)`);
}

function openChatConnection(coinId, bjId, connectInfo) {
  const url = `wss://${connectInfo.chatDomain}:${connectInfo.chatPort}/Websocket/${bjId}`;
  const ws = new WebSocket(url, ["chat"]);
  const conn = { ws, chatCount: 0, pingTimer: null };
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
    if (opcode === "0005") conn.chatCount += 1;
  });

  ws.on("error", (e) => console.error(`[${coinId}/${bjId}] 채팅 소켓 에러:`, e.message));

  ws.on("close", () => {
    console.log(`[${coinId}/${bjId}] 채팅 연결 종료`);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
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

// ====================== 방송 시작/종료 감지 루프 (SOOP API만 호출, Firestore 읽기 없음) ======================
async function liveCheckLoop() {
  const now = Date.now();

  await Promise.all(
    Array.from(coinState.entries()).map(async ([coinId, coin]) => {
      const isLive = await checkIsLive(coin.bjId);
      const hasConn = connections.has(coinId);
      const wasLive = coin.status === "live";

      if (isLive && !hasConn) {
        const info = await getChatConnectInfo(coin.bjId);
        if (info) openChatConnection(coinId, coin.bjId, info);
      } else if (!isLive && hasConn) {
        closeChatConnection(coinId);
      }

      if (isLive && !wasLive) {
        // 방송 시작: 이전 종가로 가격 고정하고 5분 카운트다운 시작
        const update = {
          status: "live",
          tradable: true,
          broadcastStartedAt: now,
          currentPrice: coin.frozenPrice || PRICE_BASE,
          chatSamples: [],
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        };
        coinState.set(coinId, { ...coin, ...update, broadcastStartedAt: now });
        await db.collection("coins").doc(coinId).update(update);
        console.log(`[${coinId}] 방송 시작 감지`);
      } else if (!isLive && wasLive) {
        // 방송 종료: 즉시 거래 정지 + 종가 계산
        const update = computeCloseTick(coin, now);
        coinState.set(coinId, { ...coin, ...update });
        await db.collection("coins").doc(coinId).update({
          ...update,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[${coinId}] 방송 종료 감지, 종가=${update.currentPrice}`);
      }
    })
  );
}

// ====================== 매분 0초 정각에 가격 갱신 ======================
async function priceTick() {
  const now = Date.now();

  await Promise.all(
    Array.from(connections.entries()).map(async ([coinId, conn]) => {
      const chatCount = conn.chatCount;
      conn.chatCount = 0;

      const coin = coinState.get(coinId);
      if (!coin || coin.status !== "live") return;

      const update = computeLiveTick(coin, chatCount, now);
      coinState.set(coinId, { ...coin, ...update });
      await db.collection("coins").doc(coinId).update({
        ...update,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[${coinId}] 분당 채팅수=${chatCount} -> currentPrice=${update.currentPrice}`);
    })
  );
}

// 매분 정각(0초)에 정확히 맞춰서 priceTick을 실행하고, 그 뒤로는 60초 간격 유지
function scheduleMinuteTick() {
  const msUntilNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    priceTick().catch((e) => console.error("priceTick 실패:", e.message));
    setInterval(() => {
      priceTick().catch((e) => console.error("priceTick 실패:", e.message));
    }, 60000);
  }, msUntilNextMinute);
}

function startLoops() {
  liveCheckLoop().catch((e) => console.error("liveCheckLoop 실패:", e.message));
  setInterval(() => {
    liveCheckLoop().catch((e) => console.error("liveCheckLoop 실패:", e.message));
  }, LIVE_CHECK_INTERVAL_MS);

  scheduleMinuteTick();
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
    .listen(port, async () => {
      console.log(`chatservice listening on ${port}`);
      await loadInitialState();
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
  todayKST,
  nowKST,
  averageOf,
  priceFromAvg,
  computeLiveTick,
  computeCloseTick,
  checkIsLive,
  getChatConnectInfo,
  buildPacket,
  connectPacket,
  joinPacket,
  pingPacket,
  openChatConnection,
  closeChatConnection,
  connections,
  coinState,
  loadInitialState,
  liveCheckLoop,
  priceTick,
  db,
};
