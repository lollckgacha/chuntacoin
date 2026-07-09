/**
 * 좀비 채팅 연결(close/error 이벤트 없이 응답만 조용히 멈추는 연결) 감지 로직 검증.
 * 2026-07-09 문모모 사고(분당 채팅수가 close 로그 없이 계속 0으로 찍힌 문제) 재발 방지용.
 *
 * 실행: node test_stale_connection.js
 */
const { isStaleConnection, closeChatConnection, connections, STALE_CONNECTION_MS } = require("./index.js");

let fails = 0;
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL [${label}]: expected ${expected}, got ${actual}`);
    fails++;
  } else {
    console.log(`ok   [${label}] = ${actual}`);
  }
}

const now = Date.now();

console.log("--- isStaleConnection 순수 함수 ---");
assertEqual(isStaleConnection(undefined, now), false, "연결 없음 -> stale 아님");
assertEqual(isStaleConnection({ lastMessageAt: now }, now), false, "방금 메시지 받음 -> stale 아님");
assertEqual(
  isStaleConnection({ lastMessageAt: now - (STALE_CONNECTION_MS - 1000) }, now),
  false,
  "임계값 직전 -> 아직 stale 아님"
);
assertEqual(
  isStaleConnection({ lastMessageAt: now - (STALE_CONNECTION_MS + 1000) }, now),
  true,
  "임계값 초과(예: 문모모처럼 3분+ 무응답) -> stale"
);

console.log("--- closeChatConnection이 좀비 연결을 실제로 제거하는지 ---");
const fakeWs = { close: () => {} };
connections.set("testcoin", { ws: fakeWs, chatCount: 0, pingTimer: null, lastMessageAt: now - 10 * 60 * 1000 });
assertEqual(connections.has("testcoin"), true, "테스트용 좀비 연결 등록됨");
closeChatConnection("testcoin");
assertEqual(connections.has("testcoin"), false, "closeChatConnection 후 연결 제거됨 (다음 liveCheckLoop에서 재연결 가능해짐)");

if (fails > 0) {
  console.error(`\n${fails}개 실패`);
  process.exit(1);
} else {
  console.log("\n모두 통과");
  process.exit(0);
}
