/**
 * 더미 데이터로 새 가격 시스템의 라이프사이클을 검증하는 시뮬레이션.
 * 네트워크/Firestore 없이 index.js의 computeLiveTick/computeCloseTick 순수 로직만 호출한다.
 *
 * 시나리오:
 *   1. 방송 시작 -> 첫 5분은 이전 종가로 고정 (거래는 가능)
 *   2. 5분 이후 -> 최근 5분 평균 분당 채팅수로 현재가 계산, 변동 제한 없음
 *   3. 방송 종료 -> 첫 5분/마지막 5분을 제외한 구간의 평균으로 종가 계산 + 즉시 거래 정지
 *   4. 다음 방송 시작 -> 방금 계산된 종가로 다시 고정되며 재시작
 *
 * 실행: node test_lifecycle_simulation.js
 */
const { computeLiveTick, computeCloseTick, averageOf, priceFromAvg } = require("./index.js");

let fails = 0;
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL [${label}]: expected ${expected}, got ${actual}`);
    fails++;
  } else {
    console.log(`ok   [${label}] = ${actual}`);
  }
}

const MIN = 60000;
let coin = {
  status: "closed",
  tradable: false,
  currentPrice: 1000,
  frozenPrice: 1000,
  broadcastStartedAt: null,
  chatSamples: [],
  priceHistory: [],
};

console.log("--- 1. 방송 시작 (t=0) ---");
const broadcastStart = 0;
coin = {
  ...coin,
  status: "live",
  tradable: true,
  broadcastStartedAt: broadcastStart,
  currentPrice: coin.frozenPrice,
};
assertEqual(coin.tradable, true, "방송 시작 직후 거래 가능");
assertEqual(coin.currentPrice, 1000, "방송 시작 직후 가격 = 이전 종가");

console.log("\n--- 2. 첫 5분: 이전 종가로 고정 (분당 채팅수와 무관) ---");
const chatByMinute = [10, 12, 8, 15, 20, 25, 18, 22, 19, 21, 30, 5, 8, 12, 9]; // 15분 방송
for (let i = 1; i <= 4; i++) {
  const now = broadcastStart + i * MIN;
  const update = computeLiveTick(coin, chatByMinute[i - 1], now);
  coin = { ...coin, ...update };
  assertEqual(coin.currentPrice, 1000, `${i}분째 가격(고정 구간)`);
  assertEqual(coin.tradable, true, `${i}분째 거래 가능 여부`);
}

console.log("\n--- 3. 5분째부터: 최근 5분 평균으로 계산 ---");
for (let i = 5; i <= 15; i++) {
  const now = broadcastStart + i * MIN;
  const update = computeLiveTick(coin, chatByMinute[i - 1], now);
  coin = { ...coin, ...update };
  const window = chatByMinute.slice(Math.max(0, i - 5), i); // 최근 5개 샘플
  const expected = priceFromAvg(averageOf(window.map((v) => ({ v }))));
  assertEqual(coin.currentPrice, expected, `${i}분째 가격(이동평균 구간)`);
}
assertEqual(coin.chatSamples.length, 15, "15분 방송 후 chatSamples 개수");

console.log("\n--- 4. 방송 종료 (t=15분): 첫5분/끝5분 제외한 평균으로 종가 ---");
const endTime = broadcastStart + 15 * MIN;
const closeUpdate = computeCloseTick(coin, endTime);
coin = { ...coin, ...closeUpdate };

// 첫5분/끝5분 제외 -> 5~10분째 샘플(인덱스 4~9, 값 20,25,18,22,19,21)만 남아야 함
const middleValues = [20, 25, 18, 22, 19, 21];
const expectedClose = priceFromAvg(averageOf(middleValues.map((v) => ({ v }))));
assertEqual(coin.status, "closed", "방송 종료 status");
assertEqual(coin.tradable, false, "방송 종료 즉시 거래 정지");
assertEqual(coin.currentPrice, expectedClose, "종가 = 첫/끝 5분 제외 평균");
assertEqual(coin.frozenPrice, expectedClose, "frozenPrice에도 종가 반영");
assertEqual(coin.chatSamples.length, 0, "방송 종료 후 chatSamples 리셋");

console.log("\n--- 5. 오프라인 유지 중: 종가 그대로 유지 (거래 불가) ---");
assertEqual(coin.currentPrice, expectedClose, "오프라인 중 가격 불변");
assertEqual(coin.tradable, false, "오프라인 중 거래 불가 유지");

console.log("\n--- 6. 다음 방송 시작: 방금 종가로 다시 고정 ---");
const secondBroadcastStart = endTime + 3 * MIN; // 3분 쉬었다가 재방송
coin = {
  ...coin,
  status: "live",
  tradable: true,
  broadcastStartedAt: secondBroadcastStart,
  currentPrice: coin.frozenPrice,
};
assertEqual(coin.currentPrice, expectedClose, "재방송 시작 시 직전 종가로 고정");

const tick1 = computeLiveTick(coin, 999, secondBroadcastStart + 1 * MIN);
assertEqual(tick1.currentPrice, expectedClose, "재방송 1분째도 여전히 고정 구간 (채팅수 무시)");

console.log("\n--- 7. 매우 짧은 방송(10분 미만) 종료 시 폴백: 전체 평균 사용 ---");
let shortCoin = {
  status: "live",
  tradable: true,
  broadcastStartedAt: 0,
  frozenPrice: 1000,
  currentPrice: 1000,
  chatSamples: [],
  priceHistory: [],
};
const shortChat = [10, 20, 30]; // 3분만 방송
for (let i = 1; i <= 3; i++) {
  const update = computeLiveTick(shortCoin, shortChat[i - 1], i * MIN);
  shortCoin = { ...shortCoin, ...update };
}
const shortClose = computeCloseTick(shortCoin, 3 * MIN);
const expectedShortClose = priceFromAvg(averageOf(shortChat.map((v) => ({ v })))); // 중간 구간 없어 전체 평균 폴백
assertEqual(shortClose.currentPrice, expectedShortClose, "10분 미만 방송은 전체 평균으로 폴백");

console.log("\n=================================");
if (fails > 0) {
  console.error(`${fails}개 항목 실패`);
  process.exit(1);
} else {
  console.log("PASS: 새 가격 시스템 라이프사이클 전체 검증 통과");
  process.exit(0);
}
