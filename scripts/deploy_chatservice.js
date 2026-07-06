/**
 * gcloud CLI 없이 chatservice(Cloud Run)를 배포한다.
 * firebase-tools login으로 이미 저장된 사용자 OAuth 토큰(cloud-platform 스코프 포함)을
 * 재사용해서 Cloud Build로 이미지를 빌드하고 Cloud Run Admin API v2로 배포한다.
 *
 * 사용법: node deploy_chatservice.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ID = "chunta-d80c5";
const PROJECT_NUMBER = "806899242677";
const REGION = "asia-northeast3";
const SERVICE_NAME = "chuntacoin-chatservice";
const BUCKET = `gcf-v2-sources-${PROJECT_NUMBER}-${REGION}`; // functions 배포 때 이미 만들어진 버킷 재사용
const CHATSERVICE_DIR = path.join(__dirname, "..", "chatservice");
const IMAGE_BASE = `${REGION}-docker.pkg.dev/${PROJECT_ID}/gcf-artifacts/chatservice`;
const IMAGE = `${IMAGE_BASE}:latest`;
const RUNTIME_SA = `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`;

const CONFIGSTORE_PATH = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");

async function getAccessToken() {
  let store = JSON.parse(fs.readFileSync(CONFIGSTORE_PATH, "utf8"));
  if (Date.now() < store.tokens.expires_at - 60000) {
    return store.tokens.access_token;
  }

  // firebase-tools 자체에 토큰 갱신을 맡긴다 (내부적으로 configstore를 새 토큰으로 갱신해줌).
  console.log("access_token 만료 임박 - firebase-tools로 갱신 중...");
  execSync("npx --yes firebase-tools projects:list", { stdio: "ignore" });
  store = JSON.parse(fs.readFileSync(CONFIGSTORE_PATH, "utf8"));
  return store.tokens.access_token;
}

function tarSource() {
  // 절대경로(C:\...)를 tar에 넘기면 git-bash의 tar가 "원격 호스트:경로"로 오인해서
  // 실패하므로, chatservice/ 디렉토리를 cwd로 두고 상대경로로 출력한다.
  const relName = "../_chatservice_source.tar.gz";
  execSync(`tar -czf "${relName}" --exclude=node_modules --exclude=test_*.js .`, {
    cwd: CHATSERVICE_DIR,
    stdio: "inherit",
  });
  return path.join(CHATSERVICE_DIR, "..", "_chatservice_source.tar.gz");
}

async function uploadSource(token, tarPath) {
  const objectName = `chatservice-builds/${Date.now()}-source.tar.gz`;
  const data = fs.readFileSync(tarPath);
  const res = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/gzip" },
      body: data,
    }
  );
  const body = await res.json();
  if (!res.ok) throw new Error("소스 업로드 실패: " + JSON.stringify(body));
  console.log("소스 업로드 완료:", objectName, `(${data.length} bytes)`);
  return objectName;
}

async function submitBuild(token, objectName) {
  const res = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${PROJECT_ID}/builds`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { storageSource: { bucket: BUCKET, object: objectName } },
      steps: [
        { name: "gcr.io/cloud-builders/docker", args: ["build", "-t", IMAGE, "."] },
        { name: "gcr.io/cloud-builders/docker", args: ["push", IMAGE] },
      ],
      images: [IMAGE],
      options: { logging: "CLOUD_LOGGING_ONLY" },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error("빌드 제출 실패: " + JSON.stringify(body));
  const buildId = body.metadata.build.id;
  console.log("빌드 제출됨:", buildId);
  return buildId;
}

async function waitForBuild(getToken, buildId) {
  for (let i = 0; i < 60; i++) {
    const token = await getToken();
    const res = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${PROJECT_ID}/builds/${buildId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const build = await res.json();
    console.log(`[${i * 10}s] 빌드 상태:`, build.status);
    if (build.status === "SUCCESS") return build;
    if (["FAILURE", "TIMEOUT", "CANCELLED", "EXPIRED", "INTERNAL_ERROR"].includes(build.status)) {
      throw new Error(`빌드 실패 (${build.status}). 로그: ${build.logUrl}`);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error("빌드 대기 시간 초과 (10분)");
}

// Cloud Run은 서비스 스펙에 들어있는 이미지 "문자열"이 이전과 똑같으면(예: 계속 같은
// :latest 태그) 실제로는 그 태그가 새 digest를 가리키게 됐어도 변경 사항이 없다고
// 보고 새 리비전을 만들지 않는다 (실제로 이 버그 때문에 재배포가 조용히 무시된 적이
// 있었음). 그래서 :latest 같은 유동 태그 대신 반드시 build 결과의 고정 digest를
// 이미지 참조로 써야 한다.
function extractDigest(build) {
  const digest = build.results?.images?.[0]?.digest;
  if (!digest) throw new Error("빌드 결과에서 이미지 digest를 찾을 수 없습니다: " + JSON.stringify(build.results));
  return digest;
}

async function deployCloudRun(token, imageWithDigest) {
  const serviceBody = {
    template: {
      scaling: { minInstanceCount: 1, maxInstanceCount: 1 },
      serviceAccount: RUNTIME_SA,
      containers: [
        {
          image: imageWithDigest,
          ports: [{ containerPort: 8080 }],
          resources: { limits: { cpu: "1", memory: "512Mi" } },
        },
      ],
    },
    // 인증되지 않은 외부 요청은 기본적으로 막힘 (allUsers invoker를 별도로 부여하지 않음)
  };

  const checkRes = await fetch(
    `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const before = checkRes.status === 200 ? await checkRes.json() : null;

  let res;
  if (before) {
    console.log("기존 서비스 발견 - 업데이트(PATCH). 이전 리비전:", before.latestReadyRevision);
    res = await fetch(
      `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}?updateMask=template`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(serviceBody),
      }
    );
  } else {
    console.log("새 서비스 생성");
    res = await fetch(
      `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services?serviceId=${SERVICE_NAME}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(serviceBody),
      }
    );
  }
  const body = await res.json();
  if (!res.ok) throw new Error("Cloud Run 배포 실패: " + JSON.stringify(body, null, 2));
  console.log("Cloud Run 배포 요청 완료:", body.name || body.metadata?.target);
  return { body, previousRevision: before?.latestReadyRevision };
}

// 서비스가 실제로 "새 리비전"으로 전환됐는지 확인 (이전 리비전 이름과 달라야 함).
async function verifyNewRevision(getToken, previousRevision) {
  for (let i = 0; i < 30; i++) {
    const token = await getToken();
    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const svc = await res.json();
    const ready = svc.terminalCondition?.state === "CONDITION_SUCCEEDED";
    const changed = svc.latestReadyRevision !== previousRevision;
    console.log(
      `[확인 ${i * 5}s] latestReadyRevision=${svc.latestReadyRevision} ready=${ready} changed=${changed}`
    );
    if (ready && changed) return svc;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    "새 리비전이 생성되지 않았습니다 (이전과 같은 리비전 유지 중). Cloud Run이 이미지 변경을 감지하지 못한 것으로 보입니다."
  );
}

async function main() {
  console.log("1) 소스 패키징...");
  const tarPath = tarSource();

  console.log("2) GCS 업로드...");
  const token1 = await getAccessToken();
  const objectName = await uploadSource(token1, tarPath);

  console.log("3) Cloud Build 제출...");
  const token2 = await getAccessToken();
  const buildId = await submitBuild(token2, objectName);

  console.log("4) 빌드 완료 대기...");
  const build = await waitForBuild(getAccessToken, buildId);
  const digest = extractDigest(build);
  const imageWithDigest = `${IMAGE_BASE}@${digest}`;
  console.log("빌드 성공. 이미지(digest 고정):", imageWithDigest);

  console.log("5) Cloud Run 배포...");
  const token3 = await getAccessToken();
  const { previousRevision } = await deployCloudRun(token3, imageWithDigest);

  console.log("6) 새 리비전으로 실제 전환됐는지 확인...");
  const finalSvc = await verifyNewRevision(getAccessToken, previousRevision);

  fs.unlinkSync(tarPath);

  console.log("\nPASS: chatservice 배포 완료 - 새 리비전:", finalSvc.latestReadyRevision);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
