/**
 * trade() 콜러블 함수를 Firestore 에뮬레이터로 직접 테스트.
 * - tradable:false인 코인은 매수/매도 모두 막히는지
 * - 매도 시 1% 수수료가 정확히 적용되는지 (실수령액 = 가격×수량×0.99)
 * - 매수에는 수수료가 없는지
 *
 * 실행:
 *   npx firebase-tools emulators:start --only firestore --project demo-chuntacoin
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-chuntacoin node test_trade.js
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-chuntacoin";

// trade는 onCall로 감싸져 있어 직접 export되지 않으므로, admin 앱을 재사용해서
// 같은 트랜잭션 로직을 검증하는 목적의 소형 재구현 대신 실제 exports.trade의 핸들러를
// 가져와 호출한다. onCall(handler)로 감싼 CloudFunction 객체는 .run()으로 원본 핸들러를
// 호출할 수 있다 (firebase-functions v2 테스트 유틸리티).
const mod = require("./index.js");
const { db, SELL_FEE_RATE } = mod._internal;

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
async function assertThrows(fn, codeSubstr, label) {
  try {
    await fn();
    console.error(`FAIL [${label}]: 에러가 발생해야 하는데 통과함`);
    fails++;
  } catch (e) {
    if (String(e.message).includes(codeSubstr)) {
      console.log(`ok   [${label}] (에러: ${e.message})`);
    } else {
      console.error(`FAIL [${label}]: 다른 에러 - ${e.message}`);
      fails++;
    }
  }
}

async function callTrade(request) {
  return mod.trade.run(request);
}

async function main() {
  const uid = "trade_test_uid";
  const coinId = "trade_test_coin";

  await db.collection("users").doc(uid).set({ balance: 100000, holdings: {} });
  await db.collection("transactions").where("uid", "==", uid).get().then((s) =>
    Promise.all(s.docs.map((d) => d.ref.delete()))
  );

  console.log("--- 1. tradable:false 코인은 매수 불가 ---");
  await db.collection("coins").doc(coinId).set({
    name: "테스트코인", bjId: "x", status: "closed", tradable: false, currentPrice: 1000,
  });
  await assertThrows(
    () => callTrade({ auth: { uid }, data: { coinId, type: "buy", qty: 1 } }),
    "거래할 수 없는",
    "방송종료 코인 매수 시도 거부"
  );

  console.log("\n--- 2. tradable:true - 매수는 수수료 없이 정가로 ---");
  await db.collection("coins").doc(coinId).update({ status: "live", tradable: true, currentPrice: 1000 });
  const buyRes = await callTrade({ auth: { uid }, data: { coinId, type: "buy", qty: 10 } });
  assertEqual(buyRes.fee, 0, "매수는 수수료 0");
  assertEqual(buyRes.netAmount, 10000, "매수 netAmount = 가격×수량 그대로");

  const userAfterBuy = await db.collection("users").doc(uid).get();
  assertEqual(userAfterBuy.data().balance, 100000 - 10000, "매수 후 잔액 차감");
  assertEqual(userAfterBuy.data().holdings[coinId], 10, "매수 후 보유수량 반영");
  assertEqual(userAfterBuy.data().avgCost[coinId], 1000, "매수 후 평단가 = 매수가");

  console.log("\n--- 2-1. 추가 매수 시 평단가 가중평균 계산 ---");
  await db.collection("coins").doc(coinId).update({ currentPrice: 2000 });
  await callTrade({ auth: { uid }, data: { coinId, type: "buy", qty: 10 } });
  const userAfterBuy2 = await db.collection("users").doc(uid).get();
  // (1000*10 + 2000*10) / 20 = 1500
  assertEqual(userAfterBuy2.data().avgCost[coinId], 1500, "추가 매수 후 가중평균 평단가");
  assertEqual(userAfterBuy2.data().holdings[coinId], 20, "추가 매수 후 보유수량 합산");
  await db.collection("coins").doc(coinId).update({ currentPrice: 1000 });
  await callTrade({ auth: { uid }, data: { coinId, type: "sell", qty: 10 } }); // 20 -> 10으로 원복

  console.log("\n--- 3. 매도 시 1% 수수료 적용 (평단가는 매도로 안 바뀜) ---");
  const sellRes = await callTrade({ auth: { uid }, data: { coinId, type: "sell", qty: 10 } });
  const expectedGross = 1000 * 10;
  const expectedFee = Math.round(expectedGross * SELL_FEE_RATE);
  const expectedNet = expectedGross - expectedFee;
  assertEqual(sellRes.gross, expectedGross, "매도 gross(수수료 전 금액)");
  assertEqual(sellRes.fee, expectedFee, "매도 수수료 1%");
  assertEqual(sellRes.netAmount, expectedNet, "매도 실수령액 = gross - fee");

  const userAfterSell = await db.collection("users").doc(uid).get();
  // 100000 -10000(매수1) -20000(매수2) +9900(매도1, 2-1단계) +9900(매도2, 이번 단계) = 89800
  assertEqual(userAfterSell.data().balance, 89800, "매도 후 잔액에 수수료 제외 금액만 반영");
  assertEqual(userAfterSell.data().holdings[coinId], 0, "매도 후 보유수량 0");
  assertEqual(userAfterSell.data().avgCost[coinId], undefined, "보유수량 0이 되면 평단가도 정리됨");

  console.log("\n--- 4. 방송 종료(tradable:false)로 전환되면 매도도 막힘 ---");
  await db.collection("coins").doc(coinId).update({ status: "closed", tradable: false });
  await callTrade({ auth: { uid }, data: { coinId, type: "buy", qty: 5 } }).then(
    () => { throw new Error("매수가 성공하면 안 됨"); },
    () => {}
  );
  await db.collection("users").doc(uid).update({ holdings: { [coinId]: 5 } });
  await assertThrows(
    () => callTrade({ auth: { uid }, data: { coinId, type: "sell", qty: 1 } }),
    "거래할 수 없는",
    "방송종료 코인 매도 시도 거부"
  );

  console.log("\n=================================");
  if (fails > 0) {
    console.error(`${fails}개 항목 실패`);
    process.exit(1);
  } else {
    console.log("PASS: trade() tradable 게이트 + 매도 수수료 검증 통과");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("테스트 실패:", e);
  process.exit(1);
});
