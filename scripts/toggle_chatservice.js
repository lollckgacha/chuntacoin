/**
 * chatservice(Cloud Run)를 켜고 끄는 스크립트.
 * 정식 오픈 전까지는 테스트할 때만 켜두고, 평소엔 꺼서 불필요한 채팅 수집/Firestore
 * 사용을 막기 위함.
 *
 * - on:  minInstanceCount=1 로 설정 -> 인스턴스가 항상 떠있어서 채팅 수집이 계속 돎
 * - off: minInstanceCount=0 로 설정 -> 들어오는 요청이 없으므로 Cloud Run이 곧
 *        인스턴스를 0으로 내림 (보통 몇 분 이내). 인스턴스가 0이면 폴링/웹소켓
 *        연결도 전부 멈추고 비용도 0.
 *
 * 사용법:
 *   node toggle_chatservice.js on
 *   node toggle_chatservice.js off
 *   node toggle_chatservice.js status
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ID = "chunta-d80c5";
const REGION = "asia-northeast3";
const SERVICE_NAME = "chuntacoin-chatservice";
const SERVICE_URL = `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}`;

const CONFIGSTORE_PATH = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");

async function getAccessToken() {
  let store = JSON.parse(fs.readFileSync(CONFIGSTORE_PATH, "utf8"));
  if (Date.now() < store.tokens.expires_at - 60000) {
    return store.tokens.access_token;
  }

  // firebase-tools 자체에 토큰 갱신을 맡긴다 (내부적으로 configstore를 새 토큰으로 갱신해줌).
  console.log("access_token 만료 - firebase-tools로 갱신 중...");
  execSync("npx --yes firebase-tools projects:list", { stdio: "ignore" });
  store = JSON.parse(fs.readFileSync(CONFIGSTORE_PATH, "utf8"));
  return store.tokens.access_token;
}

async function getService(token) {
  const res = await fetch(SERVICE_URL, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error("서비스 조회 실패: " + JSON.stringify(body));
  return body;
}

async function setMinInstances(token, minInstanceCount) {
  const res = await fetch(`${SERVICE_URL}?updateMask=template.scaling`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      template: { scaling: { minInstanceCount, maxInstanceCount: 1 } },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error("설정 변경 실패: " + JSON.stringify(body, null, 2));
  return body;
}

async function main() {
  const mode = process.argv[2];
  if (!["on", "off", "status"].includes(mode)) {
    console.error("사용법: node toggle_chatservice.js on|off|status");
    process.exit(1);
  }

  const token = await getAccessToken();

  if (mode === "status") {
    const svc = await getService(token);
    const min = svc.template.scaling.minInstanceCount || 0;
    console.log("현재 minInstanceCount:", min);
    console.log(
      min > 0
        ? "-> 켜짐 (항상 실행 중, 채팅 수집 동작)"
        : "-> 꺼짐 상태로 설정됨 (트래픽 없으면 곧 인스턴스 0으로 내려감)"
    );
    return;
  }

  const target = mode === "on" ? 1 : 0;
  console.log(`chatservice ${mode === "on" ? "켜는" : "끄는"} 중...`);
  await setMinInstances(token, target);
  console.log(
    mode === "on"
      ? "완료. minInstanceCount=1 로 설정됨 - 바로 실행 시작합니다."
      : "완료. minInstanceCount=0 로 설정됨 - 몇 분 내로 인스턴스가 0으로 내려가고 채팅 수집이 멈춥니다."
  );
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
