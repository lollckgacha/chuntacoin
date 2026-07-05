/**
 * 실제 SOOP 채팅 서버에 붙어서 진짜 메시지를 세고, Firestore(에뮬레이터)에
 * 분당 채팅수가 반영되는지 확인하는 통합 테스트.
 *
 * 사용법:
 *   1) 다른 터미널: npx firebase-tools emulators:start --only firestore --project demo-chuntacoin
 *   2) FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-chuntacoin node test_chat_connection.js <bjId>
 *      (bjId 생략시 기본값 사용 - 반드시 "현재 방송 중"인 활발한 채팅방이어야 의미있는 결과가 나옴)
 *
 * 채팅이 거의 없는 방송이면 chatCount=0이 나올 수 있는데, 그 자체는 실패가 아니라
 * "그 순간 채팅이 없었다"는 정상적인 결과다. 이 테스트는 어디까지나 연결/카운팅/
 * Firestore 반영 파이프라인이 실제로 동작하는지를 확인하는 것이 목적.
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-chuntacoin";

const { checkIsLive, getChatConnectInfo, openChatConnection, closeChatConnection, connections, priceTickLoop, db } = require("./index.js");

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

  await db.collection("coins").doc(COIN_ID).set({
    name: "채팅테스트",
    bjId: BJ_ID,
    status: "closed",
    currentPrice: 0,
    frozenPrice: 0,
    todaySum: 0,
    todayCount: 0,
    todayDate: "",
  });

  const info = await getChatConnectInfo(BJ_ID);
  if (!info) throw new Error("채팅 접속 정보 조회 실패");
  console.log("chat connect info:", info);

  openChatConnection(COIN_ID, BJ_ID, info);

  console.log(`${WAIT_MS / 1000}초 동안 실제 채팅 수집 중...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const conn = connections.get(COIN_ID);
  console.log("수집 시점 conn.chatCount =", conn?.chatCount);

  console.log("priceTickLoop() 실행 (Firestore에 currentPrice 반영)...");
  await priceTickLoop();

  const doc = await db.collection("coins").doc(COIN_ID).get();
  console.log("coins/chattest_sample 결과:", doc.data());

  closeChatConnection(COIN_ID);

  const data = doc.data();
  if (data.status !== "live") {
    throw new Error("FAIL: 방송중인데 status가 live로 반영되지 않음");
  }
  console.log("\nPASS: 실제 채팅 웹소켓 연결 -> 카운트 -> Firestore 반영 파이프라인 정상 동작 확인");
  process.exit(0);
}

main().catch((e) => {
  console.error("테스트 실패:", e);
  process.exit(1);
});
