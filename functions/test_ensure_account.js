/**
 * ensureAccount() 콜러블 핸들러를 Firestore 에뮬레이터로 직접 테스트.
 * - 첫 로그인: 게스트 데이터(balance/holdings/history)가 그대로 계정에 이관되는지
 * - 재로그인: 이미 계정이 있으면 기존 데이터를 덮어쓰지 않는지 (migrated: false)
 *
 * 실행:
 *   npx firebase-tools emulators:start --only firestore --project demo-chuntacoin
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-chuntacoin node test_ensure_account.js
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-chuntacoin";

const { _internal } = require("./index.js");
const { ensureAccountHandler, claimDailyBonusHandler, todayKST, DAILY_BONUS, db } = _internal;

let fails = 0;
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL [${label}]: expected ${e}, got ${a}`);
    fails++;
  } else {
    console.log(`ok   [${label}] = ${a}`);
  }
}

async function main() {
  const uid = "guest_migrate_test_uid";
  await db.collection("users").doc(uid).delete().catch(() => {});
  const oldTx = await db.collection("transactions").where("uid", "==", uid).get();
  await Promise.all(oldTx.docs.map((d) => d.ref.delete()));

  const guestHistory = [
    { streamerId: "chunyang", type: "buy", qty: 5, price: 20, timestamp: Date.now() - 60000 },
    { streamerId: "chunyang", type: "buy", qty: 3, price: 25, timestamp: Date.now() - 30000 },
  ];

  console.log("--- 1. 첫 로그인: 게스트 데이터 이관 ---");
  const res1 = await ensureAccountHandler({
    auth: { uid, token: { name: "테스트유저" } },
    data: { balance: 87000, holdings: { chunyang: 8 }, history: guestHistory },
  });
  assertEqual(res1.migrated, true, "첫 로그인 migrated");

  const userDoc1 = await db.collection("users").doc(uid).get();
  const userData1 = userDoc1.data();
  assertEqual(userData1.balance, 87000, "이관된 balance");
  assertEqual(userData1.holdings, { chunyang: 8 }, "이관된 holdings");

  const txSnap = await db.collection("transactions").where("uid", "==", uid).get();
  assertEqual(txSnap.size, 2, "이관된 거래내역 개수");

  console.log("\n--- 2. 재로그인: 기존 계정 데이터는 덮어쓰지 않음 ---");
  const res2 = await ensureAccountHandler({
    auth: { uid, token: { name: "테스트유저" } },
    data: { balance: 999999, holdings: { chunyang: 999 }, history: [] },
  });
  assertEqual(res2.migrated, false, "재로그인 migrated");

  const userDoc2 = await db.collection("users").doc(uid).get();
  const userData2 = userDoc2.data();
  assertEqual(userData2.balance, 87000, "재로그인 후에도 balance 그대로");
  assertEqual(userData2.holdings, { chunyang: 8 }, "재로그인 후에도 holdings 그대로");

  console.log("\n--- 3. 이상한 입력값 sanitize 확인 ---");
  const uid2 = "guest_migrate_test_uid2";
  await db.collection("users").doc(uid2).delete().catch(() => {});
  const res3 = await ensureAccountHandler({
    auth: { uid: uid2, token: {} },
    data: { balance: -500, holdings: { chunyang: -3, dalta: 2.7, plli: "hack" }, history: "not-an-array" },
  });
  assertEqual(res3.migrated, true, "이상값 입력도 계정은 생성됨");
  const userDoc3 = await db.collection("users").doc(uid2).get();
  const userData3 = userDoc3.data();
  assertEqual(userData3.balance, 300000, "음수 balance는 기본값(30만원)으로 대체");
  assertEqual(userData3.holdings, { dalta: 3 }, "음수/소수/문자열 holdings는 걸러지고 유효한 것만 반올림 반영");

  console.log("\n--- 4. 천타팡(같은 프로젝트 공유 앱)이 이미 만들어둔 문서 - balance 없음 ---");
  const uid3 = "pangpang_shared_uid";
  await db.collection("users").doc(uid3).set({
    displayName: "천타팡유저",
    bestScore: 12345,
    nickname: "천타짱",
    bgmVolume: 0.4,
  });
  const res4 = await ensureAccountHandler({
    auth: { uid: uid3, token: { name: "천타팡유저" } },
    data: { balance: 95000, holdings: { dalta: 2 }, history: [] },
  });
  assertEqual(res4.migrated, true, "balance 없는 기존 문서도 첫 로그인으로 인식되어 migrated");
  const userDoc4 = await db.collection("users").doc(uid3).get();
  const userData4 = userDoc4.data();
  assertEqual(userData4.balance, 95000, "천타코인 balance가 추가됨");
  assertEqual(userData4.holdings, { dalta: 2 }, "천타코인 holdings가 추가됨");
  assertEqual(userData4.bestScore, 12345, "천타팡의 bestScore 필드는 그대로 보존됨 (merge)");
  assertEqual(userData4.nickname, "천타짱", "천타팡의 nickname 필드도 그대로 보존됨 (merge)");

  console.log("\n--- 5. 위 상태에서 재로그인하면 이제는 migrated:false ---");
  const res5 = await ensureAccountHandler({
    auth: { uid: uid3, token: { name: "천타팡유저" } },
    data: { balance: 1, holdings: {}, history: [] },
  });
  assertEqual(res5.migrated, false, "balance가 생긴 뒤로는 재로그인으로 인식");
  const userDoc5 = await db.collection("users").doc(uid3).get();
  assertEqual(userDoc5.data().balance, 95000, "재로그인 시도로 balance가 덮어써지지 않음");

  console.log("\n--- 6. 매일 출석 보상 ---");
  const uid4 = "daily_bonus_test_uid";
  await db.collection("users").doc(uid4).delete().catch(() => {});
  await ensureAccountHandler({ auth: { uid: uid4, token: {} }, data: { balance: 300000, holdings: {}, history: [] } });

  const claim1 = await claimDailyBonusHandler({ auth: { uid: uid4 } });
  assertEqual(claim1.claimed, true, "첫 출석 보상 지급됨");
  assertEqual(claim1.balance, 300000 + DAILY_BONUS, "첫 출석 보상 반영된 잔액");

  const claim2 = await claimDailyBonusHandler({ auth: { uid: uid4 } });
  assertEqual(claim2.claimed, false, "같은 날 재요청은 중복 지급 안 됨");
  assertEqual(claim2.balance, 300000 + DAILY_BONUS, "중복 요청 시 잔액 변화 없음");

  const userDoc4b = await db.collection("users").doc(uid4).get();
  assertEqual(userDoc4b.data().lastAttendanceDate, todayKST(), "lastAttendanceDate가 오늘 날짜로 기록됨");

  console.log("\n=================================");
  if (fails > 0) {
    console.error(`${fails}개 항목 실패`);
    process.exit(1);
  } else {
    console.log("PASS: 게스트→계정 이관 로직 정상 동작 확인");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("테스트 실패:", e);
  process.exit(1);
});
