/**
 * 더미 데이터로 하루 전체 라이프사이클을 검증하는 시뮬레이션 (채팅 기반 가격).
 * 네트워크/Firestore 없이 index.js의 computeUpdate() 순수 로직만 반복 호출한다.
 * (functions/의 예전 시청자수 버전과 동일한 시나리오 - 입력값만 "분당 채팅수"로 바뀜)
 *
 * 실행: node test_lifecycle_simulation.js
 */
const { computeUpdate } = require("./index.js");

let fails = 0;
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL [${label}]: expected ${expected}, got ${actual}`);
    fails++;
  } else {
    console.log(`ok   [${label}] = ${actual}`);
  }
}

function applyUpdate(coin, update) {
  return { ...coin, ...update };
}

let coin = {
  name: "테스트멤버",
  bjId: "dummy_bj",
  status: "closed",
  currentPrice: 0,
  frozenPrice: 0,
  todaySum: 0,
  todayCount: 0,
  todayDate: "",
};

const DAY1 = "2026-07-06";
const DAY2 = "2026-07-07";
let t = 0;
function tick(isLive, chatCount, today) {
  t += 1;
  const update = computeUpdate(coin, isLive, chatCount, today, t);
  coin = applyUpdate(coin, update);
}

console.log("--- 1. 방송 시작, 분당 채팅수 변동 ---");
tick(true, 12, DAY1);
assertEqual(coin.status, "live", "1차 방송 status");
assertEqual(coin.currentPrice, 12, "1차 방송 1틱 가격(분당 채팅수)");
assertEqual(coin.todaySum, 12, "todaySum after tick1");
assertEqual(coin.todayCount, 1, "todayCount after tick1");

tick(true, 30, DAY1);
tick(true, 18, DAY1);
assertEqual(coin.currentPrice, 18, "1차 방송 마지막 가격 = 최신 분당 채팅수");
assertEqual(coin.todaySum, 12 + 30 + 18, "todaySum after 3 ticks");
assertEqual(coin.todayCount, 3, "todayCount after 3 ticks");

console.log("\n--- 2. 방송 종료 -> 그날 평균 고정 ---");
tick(false, 0, DAY1);
const avg1 = Math.round((12 + 30 + 18) / 3);
assertEqual(coin.status, "closed", "방송 종료 status");
assertEqual(coin.frozenPrice, avg1, "1차 방송 종료 후 평균 고정가");
assertEqual(coin.currentPrice, avg1, "고정가가 currentPrice에도 반영");

console.log("\n--- 3. 오프라인 유지 중 가격 불변 확인 ---");
tick(false, 0, DAY1);
assertEqual(coin.currentPrice, avg1, "오프라인 유지 중에도 고정가 그대로 유지");

console.log("\n--- 4. 같은 날 재방송 시작 -> 실시간 가격으로 전환, 평균은 누적 계속 ---");
tick(true, 40, DAY1);
assertEqual(coin.status, "live", "재방송 status");
assertEqual(coin.currentPrice, 40, "재방송 실시간 가격");
assertEqual(coin.todayCount, 4, "재방송 시작 후 todayCount는 리셋되지 않고 이어짐");
assertEqual(coin.todaySum, 12 + 30 + 18 + 40, "재방송 시작 후 todaySum도 이어서 누적");

tick(true, 60, DAY1);
assertEqual(coin.todaySum, 12 + 30 + 18 + 40 + 60, "재방송 2틱째 누적");
assertEqual(coin.todayCount, 5, "재방송 2틱째 카운트");

console.log("\n--- 5. 재방송 종료 -> 하루 전체(두 세션 합산) 평균으로 고정 ---");
tick(false, 0, DAY1);
const totalSum = 12 + 30 + 18 + 40 + 60;
const avgFinal = Math.round(totalSum / 5);
assertEqual(coin.status, "closed", "재방송 종료 status");
assertEqual(coin.frozenPrice, avgFinal, "하루 전체 통합 평균으로 고정 (여러 방송 세션 합산 검증)");

console.log("\n--- 6. 날짜가 바뀜 (다음날), 아직 방송 시작 전 ---");
tick(false, 0, DAY2);
assertEqual(coin.todaySum, 0, "날짜 변경 시 todaySum 리셋");
assertEqual(coin.todayCount, 0, "날짜 변경 시 todayCount 리셋");
assertEqual(coin.frozenPrice, avgFinal, "전날 고정가는 다음 방송 전까지 화면에 유지되어야 함");

console.log("\n--- 7. 다음날 새 방송 시작 -> 실시간 가격으로 다시 전환 ---");
tick(true, 25, DAY2);
assertEqual(coin.status, "live", "다음날 방송 시작 status");
assertEqual(coin.currentPrice, 25, "다음날 새 실시간 가격 (전날 평균과 무관하게 초기화)");
assertEqual(coin.todaySum, 25, "다음날 todaySum은 0에서 새로 시작");
assertEqual(coin.todayCount, 1, "다음날 todayCount는 1부터 시작");

console.log("\n=================================");
if (fails > 0) {
  console.error(`${fails}개 항목 실패`);
  process.exit(1);
} else {
  console.log("PASS: 전체 라이프사이클 시나리오 통과 (채팅 기반 가격, 방송 시작/변동/종료/평균고정/재방송/날짜전환)");
  process.exit(0);
}
