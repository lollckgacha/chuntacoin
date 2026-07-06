/**
 * coins 컬렉션에 천타버스 12명 문서를 한 번에 생성/초기화하는 스크립트.
 *
 * 사용법:
 *   1) Firebase 콘솔 > 프로젝트 설정 > 서비스 계정 > "새 비공개 키 생성" 으로 JSON 키 발급
 *   2) cd scripts && npm init -y && npm install firebase-admin
 *   3) STREAMERS 배열을 실제 12명 이름/BJ ID로 채우기 (index.html의
 *      STREAMER_LIST와 반드시 동일한 streamerId를 써야 함)
 *   4) GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node seed_coins.js
 *
 * 이미 존재하는 문서는 name/bjId 같은 정적 필드만 갱신하고, chatservice가 관리하는
 * currentPrice/status/chatSamples 같은 런타임 필드는 이미 있으면 절대 덮어쓰지 않는다
 * (운영 중인 실제 가격 데이터를 재실행으로 날리지 않기 위함). 새 스키마 필드가 아직
 * 없는 예전 문서에 한해서만 기본값을 채워준다.
 */
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const PRICE_BASE = 1000; // chatservice의 가격 공식 기본값과 동일해야 함

// streamerId: Firestore 문서 ID (index.html의 STREAMER_LIST와 동일해야 함)
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

  for (const s of STREAMERS) {
    const ref = db.collection("coins").doc(s.streamerId);
    const doc = await ref.get();

    if (!doc.exists) {
      await ref.set({
        name: s.name,
        bjId: s.bjId,
        status: "closed",
        tradable: false,
        currentPrice: PRICE_BASE,
        frozenPrice: PRICE_BASE,
        broadcastStartedAt: null,
        chatSamples: [],
        priceHistory: [],
      });
      console.log(`${s.streamerId}: 새로 생성`);
      continue;
    }

    const data = doc.data();
    const patch = { name: s.name, bjId: s.bjId };
    if (data.tradable === undefined) patch.tradable = data.status === "live";
    if (data.chatSamples === undefined) patch.chatSamples = [];
    if (data.broadcastStartedAt === undefined) patch.broadcastStartedAt = null;
    if (data.currentPrice === undefined) patch.currentPrice = PRICE_BASE;
    if (data.frozenPrice === undefined) patch.frozenPrice = data.currentPrice ?? PRICE_BASE;
    if (data.priceHistory === undefined) patch.priceHistory = [];

    await ref.set(patch, { merge: true });
    console.log(`${s.streamerId}: 갱신 (${Object.keys(patch).join(", ")})`);
  }

  console.log(`완료: ${STREAMERS.length}명 처리`);
  process.exit(0);
}

main().catch((e) => {
  console.error("시드 실패:", e);
  process.exit(1);
});
