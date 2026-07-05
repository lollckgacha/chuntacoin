/**
 * coins 컬렉션에 천타버스 12명 문서를 한 번에 생성/초기화하는 스크립트.
 *
 * 사용법:
 *   1) Firebase 콘솔 > 프로젝트 설정 > 서비스 계정 > "새 비공개 키 생성" 으로 JSON 키 발급
 *   2) cd scripts && npm init -y && npm install firebase-admin
 *   3) STREAMERS 배열을 실제 12명 이름/BJ ID로 채우기 (streamer_coin_app.html의
 *      STREAMER_LIST와 반드시 동일한 streamerId를 써야 함)
 *   4) GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node seed_coins.js
 *
 * 이미 존재하는 문서는 status/currentPrice 등 "런타임 필드"는 덮어쓰지 않고,
 * name/bjId 같은 "정적 필드"만 갱신한다 (merge: true). 처음 실행이면 초기값으로 생성된다.
 */
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

// streamerId: Firestore 문서 ID (streamer_coin_app.html의 STREAMER_LIST와 동일해야 함)
// bjId: 실제 SOOP 계정 아이디 (play.sooplive.co.kr/{bjId} 의 그 부분)
const STREAMERS = [
  { streamerId: "chunyang",  name: "천양",   bjId: "243000" },
  { streamerId: "imhaming",  name: "임하밍", bjId: "imha22" },
  { streamerId: "kyaang",    name: "캬앙",   bjId: "kyaang123" },
  { streamerId: "kimwello",  name: "김웰로", bjId: "wellro314" },
  { streamerId: "dalta",     name: "달타",   bjId: "dalta20" },
  { streamerId: "chebi",     name: "체비",   bjId: "chebi2" },
  { streamerId: "nanamoon",  name: "나나문", bjId: "nanamoon777" },
  { streamerId: "moonmomo",  name: "문모모", bjId: "doormomo" },
  { streamerId: "moca",      name: "모카",   bjId: "mocamu2" },
  { streamerId: "kapu",      name: "카푸",   bjId: "kappuchan" },
  { streamerId: "madaom",    name: "마다옴", bjId: "madaomm" },
  { streamerId: "plli",      name: "플리",   bjId: "plincess" },
];

async function main() {
  const placeholder = STREAMERS.filter((s) => s.bjId.startsWith("실제BJ아이디"));
  if (placeholder.length > 0) {
    console.error(
      `STREAMERS 배열이 아직 placeholder 상태입니다 (${placeholder.length}명). ` +
      `실제 이름/BJ ID로 채운 뒤 다시 실행하세요.`
    );
    process.exit(1);
  }

  const batch = db.batch();
  for (const s of STREAMERS) {
    const ref = db.collection("coins").doc(s.streamerId);
    batch.set(
      ref,
      {
        name: s.name,
        bjId: s.bjId,
        status: "closed",
        currentPrice: 0,
        frozenPrice: 0,
        todaySum: 0,
        todayCount: 0,
        todayDate: "",
        priceHistory: [],
      },
      { merge: true }
    );
  }
  await batch.commit();
  console.log(`coins 컬렉션에 ${STREAMERS.length}개 문서 생성/갱신 완료`);
  process.exit(0);
}

main().catch((e) => {
  console.error("시드 실패:", e);
  process.exit(1);
});
