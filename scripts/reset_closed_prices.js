/**
 * 가격 공식이 바뀌기 전에 방송이 끝나서 옛날 공식 값(예: 5원)으로 멈춰있는
 * "방송종료(closed)" 코인들의 currentPrice/frozenPrice를 기준가(1,000원)로
 * 한 번 리셋하는 일회성 마이그레이션 스크립트.
 *
 * 방송 중(live)인 코인은 건드리지 않는다 - 이미 새 공식으로 정상 갱신되고 있으므로.
 *
 * 사용법: GOOGLE_APPLICATION_CREDENTIALS=... node reset_closed_prices.js
 */
const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PRICE_BASE = 1000;

async function main() {
  const snap = await db.collection("coins").get();
  let resetCount = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.status === "live") {
      console.log(`${doc.id}: 방송 중이라 건너뜀 (currentPrice=${data.currentPrice})`);
      continue;
    }
    if (data.currentPrice === PRICE_BASE && data.frozenPrice === PRICE_BASE) {
      console.log(`${doc.id}: 이미 기준가라 건너뜀`);
      continue;
    }
    console.log(`${doc.id}: ${data.currentPrice}원 -> ${PRICE_BASE}원으로 리셋`);
    await doc.ref.update({ currentPrice: PRICE_BASE, frozenPrice: PRICE_BASE });
    resetCount++;
  }

  console.log(`\n완료: ${resetCount}개 코인 리셋됨`);
  process.exit(0);
}

main().catch((e) => {
  console.error("실패:", e);
  process.exit(1);
});
