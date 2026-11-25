// Google Gemini API 호출 — 유사도 판정 + 컴퓨터 상대의 추측
// 정확한 모델 이름은 환경변수 GEMINI_MODEL로 바꿀 수 있어요.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export class AiError extends Error {}

async function callGemini(prompt, { temperature = 0, timeoutMs = 20000 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiError('GEMINI_API_KEY가 설정되지 않았어요.');
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  });

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new AiError(`Gemini 응답 오류 (${res.status})`);
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new AiError(`Gemini 요청 실패 (${res.status}) ${detail.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      if (!text) throw new AiError('Gemini가 빈 응답을 보냈어요.');
      return text;
    } catch (err) {
      lastErr = err instanceof AiError ? err : new AiError(`Gemini 호출 중 문제: ${err.message}`);
      if (err instanceof AiError && !/응답 오류/.test(err.message)) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new AiError('Gemini 호출 실패');
}

// 모델이 코드블록(```json)이나 설명을 덧붙여도 JSON만 꺼내요.
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new AiError('AI 응답을 해석하지 못했어요.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new AiError('AI 응답을 해석하지 못했어요.');
  }
}

const clampInt = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

const SIMILARITY_PROMPT = (a, b) => `너는 '히든 워드' 게임의 심판이야. 한국어 단어 A(정답)와 B(추측)를 비교해서 JSON 하나로만 답해. 설명이나 코드블록은 붙이지 마.

[1단계: 단어 확인]
A와 B가 각각 실제로 쓰이는 한국어 단어인지 확인해.
- 일상에서 쓰이는 일반 단어(명사·동사·형용사 등)는 true.
- 오타, 의미 없는 글자 나열, 자음·모음만 있는 글자, 사람 이름 같은 고유명사, 욕설은 false.
- false인 단어가 있으면 가장 가까운 올바른 단어를 suggestion에 넣어 (없으면 빈 문자열).

[2단계: 유사도 점수] 두 단어가 모두 true일 때만 아래 세 가지를 각각 0~100 정수로 매겨.
1) semantic (의미적 거리): 사전적 정의와 개념적 특징이 얼마나 겹치는가
2) contextual (문맥적 공생): 한 문장이나 비슷한 상황·맥락에서 함께 자주 등장하는가
3) relational (관계적 구조): 상위·하위 개념, 같은 분류, 부분-전체, 반대, 도구-용도 같은 관계로 얼마나 가깝게 연결되는가

점수 기준 (너무 후하게 주지 마):
- 거의 같은 뜻의 동의어: 85~97
- 같은 작은 분류(예: 사과-배): 55~75
- 같은 큰 분류(예: 사과-당근): 35~55
- 자주 함께 쓰이지만 종류는 다름(예: 학교-연필): 25~50
- 약하게 연결: 10~30
- 거의 관련 없음: 0~10

explanation은 초등학생도 이해할 수 있게 존댓말(~예요)로 한 문장, 40자 안쪽으로 써.

A(정답): ${a}
B(추측): ${b}

출력 형식:
{"a_ok": true, "b_ok": true, "suggestion": "", "semantic": 0, "contextual": 0, "relational": 0, "explanation": ""}`;

export async function judgeSimilarity(a, b) {
  const raw = extractJson(await callGemini(SIMILARITY_PROMPT(a, b)));
  const aOk = raw.a_ok !== false;
  const bOk = raw.b_ok !== false;
  return {
    aOk,
    bOk,
    suggestion: typeof raw.suggestion === 'string' ? raw.suggestion.trim() : '',
    semantic: clampInt(raw.semantic),
    contextual: clampInt(raw.contextual),
    relational: clampInt(raw.relational),
    explanation: typeof raw.explanation === 'string' ? raw.explanation.trim() : '',
  };
}

// 컴퓨터 상대: 정답은 모른 채, 자기가 했던 추측과 점수만 보고 다음 단어를 고른다.
export async function computerGuess(history, used) {
  const lines = history.length
    ? history.map((h) => `- ${h.word}: ${h.total}%`).join('\n')
    : '(아직 추측한 단어가 없어)';
  const prompt = `너는 '히든 워드'를 하는 플레이어야. 숨겨진 정답 단어는 초등학생이 아는 흔한 한국어 단어(대부분 명사)야.
정답은 모르고, 지금까지 네가 추측한 단어와 정답과의 유사도(%)만 알아. 점수가 높은 단어와 비슷한 방향으로, 점수가 낮은 단어와는 다른 방향으로 다음 추측 단어 하나를 골라.
첫 추측이면 동물, 음식, 자연, 학교 물건, 생활용품 등 다양한 분류에서 흔한 단어를 하나 골라.

지금까지의 추측:
${lines}

이미 쓴 단어는 다시 고르면 안 돼: ${used.length ? used.join(', ') : '없음'}

JSON 하나로만 답해. 한글 단어 하나만 넣어.
{"guess": ""}`;
  const raw = extractJson(await callGemini(prompt, { temperature: 0.9, timeoutMs: 15000 }));
  return typeof raw.guess === 'string' ? raw.guess.normalize('NFC').trim() : '';
}
