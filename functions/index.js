/**
 * Firebase Cloud Functions - 천타버스 코인 거래소
 *
 * 가격 산정(코인 시세)은 더 이상 여기서 하지 않는다. SOOP 시청자수는 REST 폴링으로
 * 가져올 수 있었지만, "분당 채팅수"로 지표를 바꾸면서 실시간 채팅 웹소켓에 상시
 * 연결이 필요해졌고, 이건 Cloud Scheduler + 짧게 끝나는 Cloud Functions 구조로는
 * 불가능하다. 그래서 가격 폴링/채팅 카운팅은 ../chatservice (Cloud Run, 상시 구동)로
 * 옮겼다. 이 파일에는 매수/매도 콜러블 함수만 남아있다.
 *
 * 배포 방법:
 *   1) firebase init functions (Node 18+ 권장)
 *   2) 이 파일 내용을 functions/index.js 에 붙여넣기
 *   3) functions 폴더에서: npm install axios firebase-admin firebase-functions
 *   4) firebase deploy --only functions
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const INITIAL_BALANCE = 100000;

function sanitizeBalance(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : INITIAL_BALANCE;
}
function sanitizeHoldings(h) {
  const out = {};
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h)) {
      const n = Math.round(Number(v));
      if (Number.isInteger(n) && n > 0) out[k] = n;
    }
  }
  return out;
}
function sanitizeHistory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e) => e && (e.type === "buy" || e.type === "sell") && e.streamerId)
    .slice(-200)
    .map((e) => ({
      streamerId: String(e.streamerId),
      type: e.type,
      qty: Math.max(1, Math.round(Number(e.qty)) || 1),
      price: Math.max(0, Number(e.price) || 0),
      timestamp: Number.isFinite(Number(e.timestamp)) ? Number(e.timestamp) : Date.now(),
    }));
}

/**
 * 로그인 시 호출되는 콜러블 함수. 아직 천타코인 계정이 없으면(= users/{uid} 문서에
 * balance 필드가 없으면, 첫 로그인) 새로 만들면서 클라이언트가 보낸 게스트
 * (localStorage) 데이터를 그대로 이어받는다. 이미 계정이 있으면(재로그인) 아무것도
 * 하지 않는다 - 기존 클라우드 데이터를 게스트 데이터로 덮어쓰지 않기 위함.
 *
 * users/{uid} 문서는 같은 Firebase 프로젝트를 쓰는 천타버스 팡팡(매치 퍼즐 게임)과
 * 공유될 수 있어서, "문서가 존재하는지"가 아니라 "balance 필드가 있는지"로 첫 로그인
 * 여부를 판단하고, set()이 아니라 merge:true로 써서 팡팡이 이미 넣어둔 bestScore/
 * nickname 등의 필드를 지우지 않는다.
 *
 * balance/holdings를 클라이언트가 원하는 값으로 보낼 수 있지만, 이건 본인 계정
 * 최초 생성 시에만 반영되고(트랜잭션으로 확인) 다른 사용자나 코인 가격에는
 * 영향이 없는 개인 자산이라 trade()만큼 엄격한 검증은 필요 없다. 다만 형태는 검증한다.
 */
async function ensureAccountHandler(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const { balance, holdings, history } = request.data || {};
  const userRef = db.collection("users").doc(uid);

  const migrated = await db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (doc.exists && typeof doc.data().balance === "number") return false;

    tx.set(
      userRef,
      {
        displayName: request.auth.token?.name || "",
        balance: sanitizeBalance(balance),
        holdings: sanitizeHoldings(holdings),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });

  if (migrated) {
    const entries = sanitizeHistory(history);
    if (entries.length > 0) {
      const batch = db.batch();
      for (const e of entries) {
        const ref = db.collection("transactions").doc();
        batch.set(ref, {
          uid,
          streamerId: e.streamerId,
          type: e.type,
          qty: e.qty,
          price: e.price,
          timestamp: admin.firestore.Timestamp.fromMillis(e.timestamp),
        });
      }
      await batch.commit();
    }
  }

  return { migrated };
}

exports.ensureAccount = onCall({ region: "asia-northeast3" }, ensureAccountHandler);

/**
 * 매수/매도 콜러블 함수.
 * 클라이언트는 coinId/type/qty만 보내고, 가격/잔액/보유수량 계산은 전부 서버(트랜잭션)에서 처리한다.
 * (기존 프론트엔드처럼 클라이언트가 balance/holdings를 직접 계산해 write하는 구조는
 *  개발자도구로 조작 가능하므로, 실거래소 신뢰성을 위해 이 함수로 옮겼다.)
 */
exports.trade = onCall({ region: "asia-northeast3" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const { coinId, type, qty } = request.data || {};
  if (!coinId || (type !== "buy" && type !== "sell")) {
    throw new HttpsError("invalid-argument", "coinId 또는 type이 올바르지 않습니다.");
  }
  const qtyNum = Number(qty);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    throw new HttpsError("invalid-argument", "수량은 1 이상의 정수여야 합니다.");
  }

  const userRef = db.collection("users").doc(uid);
  const coinRef = db.collection("coins").doc(coinId);

  const result = await db.runTransaction(async (tx) => {
    const [userDoc, coinDoc] = await Promise.all([tx.get(userRef), tx.get(coinRef)]);
    if (!userDoc.exists) throw new HttpsError("failed-precondition", "사용자 정보가 없습니다.");
    if (!coinDoc.exists) throw new HttpsError("not-found", "코인 정보를 찾을 수 없습니다.");

    const price = coinDoc.data().currentPrice || 0;
    const cost = price * qtyNum;
    const userData = userDoc.data();
    const holdings = { ...(userData.holdings || {}) };
    const currentQty = holdings[coinId] || 0;

    if (type === "buy") {
      if ((userData.balance || 0) < cost) throw new HttpsError("failed-precondition", "잔액이 부족합니다.");
      holdings[coinId] = currentQty + qtyNum;
      tx.update(userRef, { balance: userData.balance - cost, holdings });
    } else {
      if (currentQty < qtyNum) throw new HttpsError("failed-precondition", "보유 수량이 부족합니다.");
      holdings[coinId] = currentQty - qtyNum;
      tx.update(userRef, { balance: (userData.balance || 0) + cost, holdings });
    }

    const txRef = db.collection("transactions").doc();
    tx.set(txRef, {
      uid,
      streamerId: coinId,
      type,
      qty: qtyNum,
      price,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { price, cost };
  });

  return { ok: true, ...result };
});

// 로컬 테스트 스크립트에서 재사용하기 위해 내부 헬퍼도 export
exports._internal = { sanitizeBalance, sanitizeHoldings, sanitizeHistory, ensureAccountHandler, db };
