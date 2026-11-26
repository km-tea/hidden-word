# 히든 워드

숨겨진 정답 단어를 AI가 알려주는 **유사도(%)** 를 보고 맞히는 게임이에요.

- **게임 방식 (3판 승부)**
  1. 출제자가 후보 단어 3개 중 하나를 정답으로 골라요. 출제자는 판마다 돌아가며 맡아요.
  2. 출제자는 정답과 **유사도 80% 이상**인 명사를 힌트로 내요. 80%가 안 되면 통과하지 못하고 다시 내요.
  3. 힌트가 통과하면 나머지 플레이어가 정답을 한 번씩 추측해요. 맞힌 사람이 1점을 받고 판이 끝나요.
  4. 아무도 못 맞히면 출제자가 1점을 받고 새 힌트로 다음 라운드를 해요. 3라운드까지 못 맞히면 출제자는 그 판에 3점이에요.
  5. 3판이 끝나면 점수가 가장 높은 사람이 승리해요.
- **모드**: 컴퓨터와 대결(출제자·추리자를 번갈아 맡음) / 방 코드로 2~8명 대결
- **연습실**: 정답 단어·유사 단어를 직접 넣고 유사도를 확인
- **유사도**: Gemini가 세 기준(의미적 거리 40% · 문맥적 공생 30% · 관계적 구조 30%)으로 점수를 매겨요
- **관계어 점수**: 동의어·반의어·상위어·하위어는 최소 점수를 보장해 높게 나와요 (`api.mjs`의 `RELATION_FLOOR`에서 조절). 힌트 기준(80%)은 `HINT_MIN`
- **입력 검사**: 유사 단어는 명사만 가능해요. 오타·모르는 단어·명사가 아닌 단어는 팝업으로 알려주고 다시 입력하게 해요

## 구조

```
public/                 화면 (index.html, style.css, app.js)
netlify/functions/
  api.mjs               모든 /api/* 요청 처리 (방, 정답 선택, 힌트, 추측, 점수, 컴퓨터 차례)
  gemini.mjs            Gemini 호출 (유사도 판정, 컴퓨터의 추측)
  words.mjs             정답 후보 단어 목록 (여기에 단어를 추가하면 돼요)
schema.sql              참고용 DB 스키마 (함수가 첫 실행 때 자동 생성)
```

## 배포 순서 (GitHub → Netlify, DB는 Neon)

1. **GitHub**: 새 저장소를 만들고 이 폴더를 올려요.
   ```bash
   git init && git add . && git commit -m "히든 워드" 
   git branch -M main
   git remote add origin https://github.com/<내계정>/hidden-word.git
   git push -u origin main
   ```
2. **Neon**: 프로젝트를 만들고 연결 문자열(`postgresql://...`)을 복사해요.
   (Netlify의 Neon 연동을 쓰면 `NETLIFY_DATABASE_URL`이 자동으로 들어가고, 코드가 둘 다 인식해요.)
3. **Gemini 키**: [Google AI Studio](https://aistudio.google.com)에서 API 키를 발급받아요.
4. **Netlify**: *Add new site → Import from Git*으로 저장소를 연결해요. 빌드 설정은 `netlify.toml`에 들어 있어요.
   *Site configuration → Environment variables*에 아래를 추가하고 재배포해요.

   | 이름 | 값 |
   |---|---|
   | `DATABASE_URL` | Neon 연결 문자열 |
   | `GEMINI_API_KEY` | Gemini API 키 |
   | `GEMINI_MODEL` | (선택) 기본값 `gemini-3.5-flash-lite` |
   | `GEMINI_THINKING` | (선택) 기본 `minimal`(빠름). 모델이 지원하지 않으면 자동으로 꺼져요. `off`로 직접 끌 수 있어요 |

5. 배포된 주소 뒤에 `/api/health`를 열어 `db`, `gemini`가 모두 `true`인지 확인해요.

## 로컬에서 실행

```bash
npm install
cp .env.example .env      # 값 채우기
npx netlify dev           # http://localhost:8888
```

## 알아두면 좋은 점

- 정답은 서버(Neon)에만 있고, 게임이 끝나기 전에는 브라우저로 내려가지 않아요.
- 같은 단어쌍은 `similarity_cache`에 저장해 Gemini를 다시 부르지 않아요 (비용 절약, 점수 일관성).
- 방은 만든 지 하루가 지나면 새 방을 만들 때 자동으로 정리돼요.
- 로그인이 없어서 브라우저마다 임의의 플레이어 ID를 저장해 써요. 공개 서비스로 운영한다면 요청 횟수 제한(rate limit)을 추가하는 걸 권해요.
- 정답은 출제자에게만 보이고, 판이 끝나기 전에는 다른 플레이어의 브라우저로 내려가지 않아요. 80% 미만으로 탈락한 힌트도 출제자에게만 보여요.
- 이번 버전부터 표 이름이 `hw_`로 시작해요(`hw_rooms`, `hw_players`, `hw_games`, `hw_hints`, `hw_guesses`). 이전 버전의 `rooms`, `players`, `guesses` 표는 더 이상 쓰이지 않으니 Neon에서 지워도 돼요.
