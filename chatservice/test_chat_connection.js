/**
 * 실제 SOOP 채팅 서버에 붙어서 진짜 메시지를 세고, Firestore(에뮬레이터)에
 * 새 가격 시스템(5분 이동평균)이 반영되는지 확인하는 통합 테스트.
 *
 * 사용법:
 *   1) 다른 터미널: npx firebase-tools emulators:start --only firestore --project demo-chuntacoin
 *   2) FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-chuntacoin node test_chat_connection.js <bjId>
 *      (bjId 생략시 기본값 사용 - 반드시 "현재 방송 중"인 활발한 채팅방이어야 의미있는 결과가 나옴)
 *
 * 5분 고정 구간까지 실제로 기다리면 테스트가 너무 오래 걸리므로, broadcastStartedAt을
 * "6분 전"으로 미리 세팅해서 곧바로 이동평균 계산 분기를 검증한다.
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-chuntacoin";

const {
  checkIsLive,
  getChatConnectInfo,
  openChatConnection,
  closeChatConnection,
  connections,
  coinState,
  priceTick,
  db,
} = require("./index.js");

const BJ_ID = process.argv[2] || "gjgj3274";
const COIN_ID = "chattest_sample";
const WAIT_MS = 35000;

async function main() {
  const isLive = await checkIsLive(BJ_ID);
  console.log(`${BJ_ID} isLive =`, isLive);
  if (!isLive) {
    console.error("테스트 대상 BJ가 방송 중이 아닙니다. 현재 방송 중인 다른 BJ ID를 인자로 넘겨주세요.");
    process.exit(1);
  }

  const initialDoc = {
    name: "채팅테스트",
    bjId: BJ_ID,
    status: "live",
    tradable: true,
    currentPrice: 1000,
    frozenPrice: 1000,
    broadcastStartedAt: Date.now() - 6 * 60000, // 6분 전 시작한 것으로 가정 -> 바로 이동평균 구간
    chatSamples: [],
    priceHistory: [],
  };
  await db.collection("coins").doc(COIN_ID).set(initialDoc);
  coinState.set(COIN_ID, initialDoc); // priceTick은 Firestore를 안 읽고 coinState만 보므로 직접 세팅

  const info = await getChatConnectInfo(BJ_ID);
  if (!info) throw new Error("채팅 접속 정보 조회 실패");
  console.log("chat connect info:", info);

  openChatConnection(COIN_ID, BJ_ID, info);

  console.log(`${WAIT_MS / 1000}초 동안 실제 채팅 수집 중...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const conn = connections.get(COIN_ID);
  const collectedChatCount = conn?.chatCount ?? 0; // priceTick()이 conn.chatCount를 0으로 리셋하므로 미리 저장
  console.log("수집 시점 conn.chatCount =", collectedChatCount);

  console.log("priceTick() 실행 (Firestore에 currentPrice 반영)...");
  await priceTick();

  const doc = await db.collection("coins").doc(COIN_ID).get();
  const data = doc.data();
  console.log("coins/chattest_sample 결과:", data);

  closeChatConnection(COIN_ID);

  if (data.status !== "live") throw new Error("FAIL: 방송중인데 status가 live로 반영되지 않음");
  if (data.tradable !== true) throw new Error("FAIL: 방송중인데 tradable이 true가 아님");
  const expectedPrice = 1000 + collectedChatCount * 100; // 이동평균 구간, 샘플 1개뿐이므로 그 값 그대로
  if (data.currentPrice !== expectedPrice) {
    throw new Error(`FAIL: currentPrice 불일치 (expected ${expectedPrice}, got ${data.currentPrice})`);
  }

  console.log("\nPASS: 실제 채팅 웹소켓 연결 -> 카운트 -> 새 가격 시스템 -> Firestore 반영 파이프라인 정상 동작 확인");
  process.exit(0);
}

main().catch((e) => {
  console.error("테스트 실패:", e);
  process.exit(1);
});
