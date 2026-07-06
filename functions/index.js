/**
 * Firebase Cloud Functions - 천타버스 코인 거래소
 *
 * 가격 산정(코인 시세)은 더 이상 여기서 하지 않는다. SOOP 시청자수는 REST 폴링으로
 * 가져올 수 있었지만, "분당 채팅수"로 지표를 바꾸면서 실시간 채팅 웹소켓에 상시
 * 연결이 필요해졌고, 이건 Cloud Scheduler + 짧게 끝나는 Cloud Functions 구조로는
 * 불가능하다. 그래서 가격 폴링/채팅 카운팅은 ../chatservice (Cloud Run, 상시 구동)로
 * 옮겼다. 이 파일에는 매수/매도/계정생성/출석보상 콜러블 함수만 남아있다.
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

const INITIAL_BALANCE = 300000; // 최초 접속 시 지급액
const DAILY_BONUS = 30000; // 매일(KST 기준 하루 1회) 출석 보상
const SELL_FEE_RATE = 0.01; // 매도 수수료 1%

function todayKST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

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
// YYYY-MM-DD 형식이 아니면 무시 (클라이언트가 이상한 값을 보내도 서버가 오염되지 않게)
function sanitizeAttendanceDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
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

  const { balance, holdings, avgCost, history, lastAttendanceDate } = request.data || {};
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
        avgCost: sanitizeHoldings(avgCost),
        lastAttendanceDate: sanitizeAttendanceDate(lastAttendanceDate),
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
 * 매일(KST 기준 하루 1회) 출석 보상 콜러블 함수. 로그인 상태에서 사이트를 열 때마다
 * 호출해도 안전하다 - 오늘 이미 받았으면 아무 것도 하지 않고 claimed:false를 반환한다.
 */
async function claimDailyBonusHandler(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const userRef = db.collection("users").doc(uid);
  const today = todayKST();

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) throw new HttpsError("failed-precondition", "사용자 정보가 없습니다.");
    const data = doc.data();

    if (data.lastAttendanceDate === today) {
      return { claimed: false, balance: data.balance || 0 };
    }

    const newBalance = (data.balance || 0) + DAILY_BONUS;
    tx.update(userRef, { balance: newBalance, lastAttendanceDate: today });
    return { claimed: true, bonus: DAILY_BONUS, balance: newBalance };
  });
}

exports.claimDailyBonus = onCall({ region: "asia-northeast3" }, claimDailyBonusHandler);

/**
 * 매수/매도 콜러블 함수.
 * 클라이언트는 coinId/type/qty만 보내고, 가격/잔액/보유수량/수수료 계산은 전부
 * 서버(트랜잭션)에서 처리한다 (기존 프론트엔드처럼 클라이언트가 balance/holdings를
 * 직접 계산해 write하는 구조는 개발자도구로 조작 가능하므로, 실거래소 신뢰성을 위해
 * 이 함수로 옮겼다).
 *
 * 매도 시 1% 수수료를 뗀다: 실수령액 = 가격×수량×(1 - SELL_FEE_RATE).
 * 방송이 종료되어 coins/{coinId}.tradable이 false인 코인은 매수/매도 모두 막는다.
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

    const coinData = coinDoc.data();
    if (coinData.tradable !== true) {
      throw new HttpsError("failed-precondition", "지금은 거래할 수 없는 코인입니다 (방송 종료 중).");
    }

    const price = coinData.currentPrice || 0;
    const gross = price * qtyNum;
    const userData = userDoc.data();
    const holdings = { ...(userData.holdings || {}) };
    const avgCost = { ...(userData.avgCost || {}) };
    const currentQty = holdings[coinId] || 0;

    let fee = 0;
    let netAmount = gross;

    if (type === "buy") {
      if ((userData.balance || 0) < gross) throw new HttpsError("failed-precondition", "잔액이 부족합니다.");
      // 평단가(평균 매수 단가) 갱신: 기존 보유분 원가 + 이번 매수 원가를 합쳐서 새 평균을 낸다.
      const prevAvg = avgCost[coinId] || 0;
      const newQty = currentQty + qtyNum;
      avgCost[coinId] = newQty > 0 ? Math.round((prevAvg * currentQty + gross) / newQty) : 0;
      holdings[coinId] = newQty;
      tx.update(userRef, { balance: userData.balance - gross, holdings, avgCost });
    } else {
      if (currentQty < qtyNum) throw new HttpsError("failed-precondition", "보유 수량이 부족합니다.");
      fee = Math.round(gross * SELL_FEE_RATE);
      netAmount = gross - fee;
      // 평단가(평균 매수 단가)는 매도로 바뀌지 않는다 (평균원가법) - 수량만 감소.
      holdings[coinId] = currentQty - qtyNum;
      if (holdings[coinId] === 0) delete avgCost[coinId];
      tx.update(userRef, { balance: (userData.balance || 0) + netAmount, holdings, avgCost });
    }

    const txRef = db.collection("transactions").doc();
    tx.set(txRef, {
      uid,
      streamerId: coinId,
      type,
      qty: qtyNum,
      price,
      fee,
      netAmount,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { price, gross, fee, netAmount };
  });

  return { ok: true, ...result };
});

// 로컬 테스트 스크립트에서 재사용하기 위해 내부 헬퍼도 export
exports._internal = {
  sanitizeBalance,
  sanitizeHoldings,
  sanitizeHistory,
  sanitizeAttendanceDate,
  todayKST,
  ensureAccountHandler,
  claimDailyBonusHandler,
  INITIAL_BALANCE,
  DAILY_BONUS,
  SELL_FEE_RATE,
  db,
};
