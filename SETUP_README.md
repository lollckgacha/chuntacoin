# 천타버스 코인 거래소 - 설정 가이드

## -2. GitHub 자동 배포 설정 (2026-07-06 추가, 아래 2가지 수동 설정 필요)

`.github/workflows/deploy.yml`을 추가해서 `main` 브랜치에 push하면 바뀐 폴더에 맞춰
자동으로 재배포되도록 했습니다 (`functions/` 변경 → Cloud Functions만, `chatservice/`
변경 → Cloud Run만, `firestore.rules` 변경 → 규칙만, `index.html`/`images/` 변경 →
Hosting만). 다만 이건 GitHub 저장소 설정과 GCP IAM 권한 부여가 필요한데, 둘 다 콘솔
접근이 필요해서 제가 대신 할 수 없습니다 - 아래 2가지를 직접 해주셔야 합니다.

**1) GitHub 저장소에 서비스 계정 키를 시크릿으로 등록**
- GitHub 저장소(`lollckgacha/chuntacoin`) → Settings → Secrets and variables →
  Actions → "New repository secret"
- Name: `GCP_SA_KEY`
- Value: `chunta-d80c5-firebase-adminsdk-fbsvc-8c57d32864.json` 파일 내용 전체를
  그대로 붙여넣기 (이 키는 로컬에도 있고 `.gitignore`로 저장소에는 안 올라가 있습니다)

**2) 이 서비스 계정에 배포 권한 부여 (IAM)**
- Google Cloud Console → IAM 및 관리자 → IAM →
  `firebase-adminsdk-fbsvc@chunta-d80c5.iam.gserviceaccount.com` 찾기 → 권한 추가
- 가장 간단한 방법: **편집자(Editor)** 역할 추가
  > 이 서비스 계정은 지금까지 Firestore 데이터 읽기/쓰기 권한만 있어서 배포에 필요한
  > `serviceusage`/Cloud Build/Artifact Registry/Cloud Run 관련 권한이 없습니다
  > (그래서 이전에는 이 계정으로 배포가 막혀서, 직접 `firebase login`으로 로그인한
  > 계정을 대신 썼습니다). CI에서는 사람이 로그인할 수 없으니 이 서비스 계정 자체에
  > 권한을 줘야 합니다.
  > 세분화하고 싶으면 Editor 대신 다음 역할들을 개별로 추가해도 됩니다: Cloud
  > Functions 개발자, Cloud Build 편집자, Artifact Registry 관리자, Cloud Run 관리자,
  > Firebase Hosting 관리자, 서비스 사용량 소비자, 서비스 계정 사용자.

이 두 가지를 마치면, 그 다음부터는 `git push`만 하면 알아서 배포됩니다.
`.github/workflows/deploy.yml`의 진행 상황은 GitHub 저장소의 "Actions" 탭에서
확인할 수 있습니다.

## -1. 정식 오픈 전 chatservice 켜고 끄기 (2026-07-06 추가)

정식 오픈 전까지는 테스트할 때만 `chatservice`(채팅 수집)가 돌아가게 하고, 평소엔 꺼서
불필요한 Firestore 사용을 막을 수 있습니다. Cloud Run 서비스를 지우는 게 아니라
"최소 인스턴스 수"만 0으로 내리는 방식이라 즉시 반영되고, 다시 켤 때도 재배포가 필요
없습니다.

- **끄기**: `사이트_끄기.bat` 더블클릭 (또는 `cd scripts && npm run chat:off`)
  - minInstanceCount=0으로 바뀌고, 들어오는 트래픽이 없으므로 Cloud Run이 몇 분 내로
    인스턴스를 0으로 내립니다. 인스턴스가 0이면 채팅 웹소켓 연결도, Firestore 읽기/
    쓰기도 전부 멈추고 비용도 0입니다.
- **켜기**: `사이트_켜기.bat` 더블클릭 (또는 `npm run chat:on`)
  - minInstanceCount=1로 즉시 바뀌고, 인스턴스가 바로 뜨면서 채팅 수집이 다시
    시작됩니다.
- **상태 확인**: `사이트_상태확인.bat` (또는 `npm run chat:status`)

> 꺼져 있어도 `coins` 문서 자체는 남아있어서(마지막으로 기록된 가격이 그대로 보임),
> 사이트를 열어보는 것 자체는 항상 가능합니다. 다만 방송 상태/가격이 실시간으로
> 갱신되지 않을 뿐입니다.

`scripts/toggle_chatservice.js`가 실제 로직입니다. `firebase login`으로 이미 저장된
OAuth 토큰을 재사용해서 Cloud Run Admin API를 직접 호출하므로, `gcloud` CLI 설치나
콘솔 접속 없이 터미널(또는 .bat 더블클릭)만으로 켜고 끌 수 있습니다.

## 0. 가격 지표 변경: 시청자수 → 분당 채팅수 (2026-07-06)

시청자수를 그대로 노출하는 게 민감할 수 있다는 판단으로, 코인 가격 지표를
**"분당 채팅수"**로 바꿨습니다. SOOP은 채팅수를 REST API로 제공하지 않아서,
실시간 채팅 웹소켓에 직접 붙어 메시지를 세는 방식으로 구현했고, 이 때문에
아키텍처가 하나 늘었습니다:

- `functions/` (Firebase Cloud Functions): 매수/매도 콜러블(`trade`)만 남음
- `chatservice/` (Cloud Run, **상시 구동**): 채팅 웹소켓 연결 + 분당 채팅수 카운팅 +
  Firestore에 가격 반영 - **새로 추가된 부분, 반드시 별도 배포 필요**

기존 시청자수 REST 폴링(`pollViewers`, Cloud Scheduler 1분 주기)은 완전히 제거했습니다.
채팅수는 짧게 끝나는 Cloud Functions로는 셀 수 없기 때문입니다 (방송마다 웹소켓을
계속 열어두고 있어야 함).

## 1. 채팅 웹소켓 프로토콜 검증 완료

실제 라이브 방송(`gjgj3274`, 500명대 시청자)에 직접 접속해서 프로토콜을 확인했습니다:

1. `POST live.afreecatv.com/afreeca/player_live_api.php` (bid=BJ아이디) 응답의
   `CHANNEL.CHATNO` / `CHANNEL.CHDOMAIN` / `CHANNEL.CHPT` 획득
2. `wss://{CHDOMAIN}:{CHPT+1}/Websocket/{bjId}` 로 연결 (subprotocol: `chat`)
3. CONNECT_PACKET 전송 → 2초 후 JOIN_PACKET(CHATNO 포함) 전송
4. 들어오는 프레임은 `0x0C`(form feed)로 필드 구분. **헤더의 opcode가 `0005`인
   프레임만 실제 채팅 메시지** (`0127`=입장, `0109`=퇴장, `0002`=join ack 등은 채팅
   아님 - 실채팅 51개 프레임을 직접 캡처해서 opcode별로 교차검증함)
5. 5분 이상 핑이 없으면 서버가 끊으므로 60초마다 PING_PACKET 전송 필요

이 로직은 `chatservice/index.js`에 구현되어 있고, 실제 방송에 붙여서 35초 동안
16개의 진짜 채팅 메시지를 세고 Firestore에 반영하는 것까지 통합 테스트로 확인했습니다
(`chatservice/test_chat_connection.js`).

> ⚠️ 이 프로토콜은 SOOP 공식 API가 아니라 비공식(리버스엔지니어링)입니다.
> SOOP이 프로토콜을 바꾸면 `chatservice`가 깨질 수 있고, 이용약관상 그레이존일 수
> 있습니다. 공식적으로는 SOOP Developers 사이트(developers.afreecatv.com)에
> "채팅 SDK"가 있지만 파트너십 제안서 제출 후 API 키 발급이 필요해서, 개인
> 프로젝트로 빠르게 쓰기는 어렵습니다. 리스크를 감수할 만한지 검토해보시고,
> 필요하면 다시 시청자수 기반으로 되돌리는 것도 가능합니다 (이전 커밋의
> `fetchLiveInfo`/`extractViewerCount`가 REST 폴링 버전입니다).

## 2. Firestore 컬렉션 초기 데이터 (완료)

`coins` 컬렉션에 12명 멤버 문서가 필요합니다. `scripts/seed_coins.js`에 실제 12명의
이름/BJ ID가 채워져 있고, `index.html`의 `STREAMER_LIST`에도 동일한
`streamerId`로 이미지 파일/퍼스널컬러까지 채워져 있습니다.

```bash
cd scripts
npm install
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node seed_coins.js
```

서비스 계정 키는 Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성"으로
발급받으세요. 이미 존재하는 문서는 `merge: true`로 실행되어 실시간 필드(status,
currentPrice 등)를 덮어쓰지 않고 name/bjId 같은 정적 필드만 갱신합니다.

**코인 이미지/퍼스널컬러**: `images/01.png`~`12.png`를 코인 카드 아이콘으로 쓰고,
카드 배경/테두리 색은 천타버스 팡팡(매치 퍼즐 게임) 코드의 `ALL_MEMBERS.color` 값을
그대로 가져왔습니다. 이미지가 바뀌거나 멤버가 추가/변경되면 `index.html`의
`STREAMER_LIST`와 `images/` 폴더를 같이 갱신해야 합니다.

## 3. Firestore 보안 규칙

`firestore.rules`에 이미 반영되어 있습니다 (거래 로직이 Cloud Function으로
이동하면서 users/transactions 쓰기 권한도 함께 잠갔습니다):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /coins/{coinId} {
      // 로그인 없이도(게스트) 실시간 시세를 봐야 하므로 공개 읽기
      allow read: if true;
      allow write: if false; // 서버(chatservice의 Admin SDK)만 수정
    }

    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create: if request.auth != null && request.auth.uid == uid
                    && request.resource.data.balance == 100000;
      allow update: if false; // trade() 콜러블 함수(Admin SDK)만 수정
    }

    match /transactions/{txId} {
      allow read: if request.auth != null && resource.data.uid == request.auth.uid;
      allow create: if false; // trade() 콜러블 함수 안에서만 생성
    }
  }
}
```

배포: `firebase deploy --only firestore:rules`

## 4. 매수/매도 로직 - 클라이언트 → Cloud Function(callable)으로 이동 완료

**기존 구조의 문제**: 처음 스캐폴드는 클라이언트가 `balance`/`holdings`를 직접 계산해서
Firestore에 write하는 구조였습니다. Firestore 규칙이 `request.auth.uid == uid`만
확인하기 때문에, 사용자가 개발자도구 콘솔에서 직접 잔액을 마음대로 바꿀 수
있었습니다. 가상 재화라도 랭킹/시상이 붙으면 바로 악용 가능한 구조입니다.

**변경 사항**: `functions/index.js`의 `trade` 콜러블 함수가 가격 조회, 잔액/보유수량
검증, Firestore 트랜잭션 write를 전부 서버에서 처리합니다. 클라이언트는
`coinId/type/qty`만 넘깁니다.

## 4-1. 로그인 없이도 거래 가능 (게스트 모드, 2026-07-06 추가)

Google 로그인을 강제하지 않고, 로그인 전에도 바로 거래할 수 있게 바꿨습니다.

- **게스트(비로그인)**: 잔액/보유수량/거래내역을 브라우저 `localStorage`
  (`chuntacoin_guest_v1` 키)에 저장합니다. 매수/매도는 `tradeLocal()`이 클라이언트에서
  직접 계산합니다 — 이건 서버에 공유되는 자산이 아니라 이 브라우저에만 있는 개인
  데이터라서, 로그인 사용자 때와 달리 클라이언트 계산이어도 조작 리스크가 없습니다
  (조작해도 본인 로컬 데이터만 바뀔 뿐 다른 사람/서버와는 무관).
- **로그인 시**: 기존과 동일하게 Firestore + `trade` 콜러블 함수(서버 검증)로 전환됩니다.
- 코인 시세(`coins` 컬렉션)는 로그인 여부와 무관하게 항상 공개로 구독하므로,
  게스트도 실시간 가격을 봅니다 (그래서 3번 항목의 `coins` 읽기 규칙을 `if true`로
  바꿨습니다).
- 화면 상단에 로그인 이점을 안내하는 배너(`#guestBanner`)를 추가했습니다: "PC/모바일
  기기 간 데이터 연동", "브라우저 쿠키를 삭제해도 잔액/보유내역 유지"라고 설명하고,
  로그인을 요구하지는 않습니다.

**게스트 → 로그인 시 데이터 이관 (2026-07-06 추가)**: 게스트로 거래하다가 처음으로
Google 로그인을 하면, `functions/index.js`의 `ensureAccount` 콜러블 함수가 지금까지
쌓인 게스트 balance/holdings/history를 그대로 새 클라우드 계정에 넣어줍니다 (거래내역도
`transactions`에 원래 시각 그대로 기록됨). 이관이 끝나면 로컬 게스트 지갑은 초기화되고
"게스트로 거래하던 내역을 계정으로 그대로 이어받았어요!" 알림이 잠깐 표시됩니다.

- **이미 계정이 있는 상태에서 재로그인**하면 아무 것도 이관하지 않습니다 (기존 클라우드
  데이터가 게스트 데이터로 덮어써지는 걸 막기 위함 - `ensureAccount`는 계정 문서가
  없을 때만 동작).
- `holdings`/`history`는 형태를 서버에서 검증합니다 (음수/소수/문자열 등은 걸러내고,
  이상하면 기본값 10만원으로 대체). 다만 이건 다른 사용자나 코인 가격에 영향을 주지
  않는 개인 자산이라 `trade()`만큼 엄격하게 막을 필요는 없다고 판단해 최소한의
  sanity check만 넣었습니다 (`functions/test_ensure_account.js`로 검증 완료).
- `firestore.rules`의 `users` 컬렉션 `create` 권한도 클라이언트 직접 생성을 막고
  `ensureAccount()`(Admin SDK)만 계정을 만들 수 있도록 바꿨습니다.

## 4-2. 천타버스 팡팡과 Firebase 프로젝트 공유 (2026-07-06 추가)

`index.html`의 `firebaseConfig`와 `.firebaserc`를 천타버스 팡팡(매치 퍼즐
게임)이 쓰는 프로젝트(`chunta-d80c5`)로 맞췄습니다. 즉 이제 두 앱이 **같은 Firebase
프로젝트, 같은 Firestore 데이터베이스**를 씁니다. 이 때문에 아래 두 가지를 같이
손봤습니다 (안 했으면 둘 중 하나가 조용히 깨졌을 부분들입니다):

1. **`users/{uid}` 문서를 두 앱이 공유합니다.** 팡팡은 `bestScore`/`bgmVolume`/
   `sfxVolume`/`nickname` 필드를 쓰고, 코인은 `balance`/`holdings`를 씁니다. 같은
   Google 계정으로 두 앱을 다 쓰면 한 문서에 필드가 같이 들어갑니다.
   - `ensureAccountHandler`가 "문서가 존재하는지"가 아니라 **"balance 필드가
     있는지"**로 첫 로그인 여부를 판단하도록 고쳤습니다. 팡팡을 먼저 써서 문서가
     이미 있는 사용자가 나중에 코인 거래소에 처음 로그인해도, balance가 없으면
     정상적으로 게스트 데이터 이관이 일어납니다.
   - `tx.set(..., {merge: true})`로 써서 팡팡이 넣어둔 필드를 지우지 않습니다.
   - `firestore.rules`도 필드 단위로 나눴습니다: 팡팡 클라이언트는 자기 문서를 계속
     자유롭게 read/write할 수 있지만 `balance`/`holdings` 필드만은 클라이언트가 절대
     건드릴 수 없고(diff 체크), 이 두 필드는 `trade()`/`ensureAccount()`(Admin SDK)만
     쓸 수 있습니다.
   - `functions/test_ensure_account.js`에 이 시나리오(천타팡이 먼저 만든 문서에
     코인 계정이 나중에 병합되는 경우)를 추가해서 검증했습니다.
2. **`firestore.rules`를 병합했습니다.** Firestore 보안 규칙은 프로젝트당 파일 하나라서,
   코인 거래소 규칙만 배포하면 팡팡의 `nicknames`/`daily_best`/`weekly_best`/
   `all_time_best` 규칙이 통째로 사라져서 팡팡이 망가집니다. 지금 `firestore.rules`는
   팡팡의 `index.html` 주석에 적힌 규칙 + 코인 거래소 규칙을 합친 것입니다.
   > ⚠️ 이 주석은 실제로 Firebase 콘솔에 배포된 규칙과 다를 수 있습니다 (특히
   > `all_time_best`는 팡팡 코드가 실제로 read/write하는데 주석엔 없어서, daily_best/
   > weekly_best와 같은 패턴으로 추가해뒀습니다). **배포하기 전에 Firebase 콘솔 →
   > Firestore Database → 규칙 탭에서 지금 이 파일과 실제 배포본을 한 번 대조해보고
   > 배포하세요.**

## 5. Firebase Authentication 설정

Google 로그인은 이미 `chunta-d80c5` 프로젝트에서 활성화되어 있을 가능성이 높습니다
(천타버스 팡팡이 이미 쓰고 있으므로). Firebase 콘솔 → Authentication → Sign-in method
에서 확인만 하면 됩니다. `firebaseConfig`는 이미 `index.html`에 채워져
있습니다 (팡팡과 동일한 프로젝트 값).

## 6. 배포 순서

1. `.firebaserc`는 이미 `chunta-d80c5`(천타버스 팡팡과 공유하는 프로젝트)로 설정됨
2. `cd functions && npm install` → `firebase deploy --only functions` (region:
   `asia-northeast3`, `trade`/`ensureAccount` 콜러블이 배포됨)
3. `firebase deploy --only firestore:rules`
4. `coins` 문서 12개 생성 (`scripts/seed_coins.js`, 2번 항목 참고)
5. **`chatservice` 배포 (Cloud Run, 이번에 새로 추가됨)**:
   ```bash
   cd chatservice
   gcloud run deploy chuntacoin-chatservice \
     --source . \
     --region asia-northeast3 \
     --no-allow-unauthenticated \
     --min-instances 1 --max-instances 1
   ```
   - `--min-instances 1 --max-instances 1`가 중요합니다. 이 서비스는 인메모리로
     채팅 연결 상태(`connections` Map)를 들고 있어서, 인스턴스가 여러 개로
     스케일되거나 0으로 내려가면(cold start) 채팅 카운팅이 끊기거나 중복 연결이
     생길 수 있습니다. 상시 1개 인스턴스로 고정하세요.
   - `--no-allow-unauthenticated`: 외부에서 호출할 필요 없는 백그라운드 서비스라
     인증 없이 공개할 필요 없습니다 (헬스체크는 Cloud Run 콘솔/`gcloud run services
     describe`로 확인).
   - 서비스 계정에 Firestore 쓰기 권한(`roles/datastore.user` 또는
     `Firebase Admin`)이 있어야 합니다. Cloud Run 배포 시 기본 컴퓨트 서비스
     계정을 쓰거나, 전용 서비스 계정을 만들어 `--service-account` 옵션으로 지정하세요.
6. `index.html`을 Firebase Hosting에 배포하거나 로컬에서 열어서 테스트

## 7. 로컬 테스트 (이미 실행 및 통과 확인함)

- `chatservice/test_chat_connection.js`: Firestore 에뮬레이터 + **실제 SOOP 채팅
  서버**에 붙어서 진짜 메시지를 세고 Firestore에 반영되는지 확인하는 통합 테스트.
  ```bash
  npx firebase-tools emulators:start --only firestore --project demo-chuntacoin
  # 다른 터미널에서 (인자로 현재 방송 중인 BJ ID를 넘겨야 함)
  cd chatservice && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-chuntacoin node test_chat_connection.js <현재_방송중인_BJ_ID>
  ```
- `chatservice/test_lifecycle_simulation.js`: 네트워크/Firestore 없이 더미 데이터로
  방송 시작 → 채팅수 변동 → 종료 → 평균 고정 → 같은 날 재방송 → 평균 재통합 →
  날짜 전환 → 다음날 새 방송까지 전체 라이프사이클을 24개 항목으로 검증
  (`node test_lifecycle_simulation.js`).
- `functions/test_ensure_account.js`: Firestore 에뮬레이터로 게스트→계정 이관 로직
  검증 (첫 로그인 시 이관 / 재로그인 시 기존 데이터 보존 / 이상값 sanitize, 9개 항목).
  ```bash
  npx firebase-tools emulators:start --only firestore --project demo-chuntacoin
  cd functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-chuntacoin node test_ensure_account.js
  ```

## 8. 필요한 Firebase / GCP 콘솔 접근 권한

- Firebase 콘솔 프로젝트에 **편집자(Editor)** 이상 권한 (Cloud Functions/Firestore
  규칙 배포에 필요)
- **Cloud Run 배포 권한** (`roles/run.admin` 또는 편집자) - `chatservice` 배포용,
  이번에 새로 필요해진 권한입니다
- **서비스 계정 키 발급 권한** (프로젝트 설정 → 서비스 계정) - `scripts/seed_coins.js`
  실행 및 로컬 테스트용
- Authentication에서 Google 로그인 활성화 권한
- (선택) Firebase Hosting을 쓸 경우 Hosting 배포 권한

## 9. 정책 메모 (사용자 확인 완료 사항)

- 초기 지급 가상 자금: **100,000원**
- 코인 가격 지표: **분당 채팅수** (시청자수 대신, 2026-07-06 변경)
- 하루 중 같은 스트리머가 여러 번 방송 시: **그날 방송 전체를 합쳐 평균 1개**로 고정
  (재방송 시작 시 `todaySum`/`todayCount`가 리셋되지 않고 이어서 누적됨 - 시뮬레이션
  테스트로 검증 완료)
- 로그인: **Google 로그인 연동 (선택 사항 - 로그인 없이도 게스트로 거래 가능)**
- 매수/매도가 가격에 영향 없음 (가격은 오직 채팅 활동으로만 결정)
- 매수/매도 로직은 Cloud Function(callable)에서 서버 검증 (클라이언트 직접 조작 불가)
- 채팅수 기반 지표는 도배(스팸)로 부풀리기 쉽다는 트레이드오프가 있음 (사용자 확인,
  참고만 하고 진행하기로 함)
