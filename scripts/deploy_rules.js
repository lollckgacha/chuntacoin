/**
 * firebase-tools 없이 Firebase Rules API를 직접 호출해서 firestore.rules를 배포한다.
 * firebase-tools의 `firebase deploy --only firestore:rules`는 배포 전에
 * serviceusage.googleapis.com 권한을 확인하는데, 이 서비스 계정은 그 권한이
 * 없어서 막혔다. Firestore 데이터 권한만으로도 Rules API는 호출 가능한지 시도.
 *
 * 사용법: GOOGLE_APPLICATION_CREDENTIALS=... node deploy_rules.js
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "chunta-d80c5";
const RULES_PATH = path.join(__dirname, "..", "firestore.rules");

async function main() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) throw new Error("GOOGLE_APPLICATION_CREDENTIALS 환경변수가 필요합니다.");

  const cred = admin.credential.cert(require(keyPath));
  const { access_token } = await cred.getAccessToken();

  const rulesSource = fs.readFileSync(RULES_PATH, "utf8");
  console.log(`firestore.rules 읽음 (${rulesSource.length}자)`);

  const headers = {
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
  };

  console.log("1) 새 ruleset 생성 중...");
  const createRes = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/rulesets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: { files: [{ content: rulesSource, name: "firestore.rules" }] },
    }),
  });
  const createBody = await createRes.json();
  if (!createRes.ok) {
    console.error("ruleset 생성 실패:", JSON.stringify(createBody, null, 2));
    process.exit(1);
  }
  const rulesetName = createBody.name;
  console.log("생성된 ruleset:", rulesetName);

  console.log("2) cloud.firestore 릴리스에 연결 중...");
  const releaseName = `projects/${PROJECT_ID}/releases/cloud.firestore`;
  const patchRes = await fetch(`https://firebaserules.googleapis.com/v1/${releaseName}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ release: { name: releaseName, rulesetName } }),
  });
  const patchBody = await patchRes.json();
  if (!patchRes.ok) {
    console.error("릴리스 업데이트 실패:", JSON.stringify(patchBody, null, 2));
    process.exit(1);
  }

  console.log("PASS: firestore.rules 배포 완료 ->", patchBody.name);
  process.exit(0);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
