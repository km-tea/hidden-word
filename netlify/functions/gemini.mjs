// Google Gemini API 호출 — 유사도 판정 + 컴퓨터 상대의 추측
// 정확한 모델 이름은 환경변수 GEMINI_MODEL로 바꿀 수 있어요.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export class AiError extends Error {}

// 생각(thinking) 단계를 줄이면 응답이 훨씬 빨라져요. 모델이 이 설정을 지원하지 않으면 자동으로 끄고 다시 시도해요.
// GEMINI_THINKING=off 로 직접 끌 수도 있어요.
let thinkingLevel = process.env.GEMINI_THINKING || 'minimal';

async function callGemini(prompt, { temperature = 0, timeoutMs = 20000 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiError('GEMINI_API_KEY가 설정되지 않았어요.');
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const generationConfig = { temperature };
    if (thinkingLevel && thinkingLevel !== 'off') generationConfig.thinkingConfig = { thinkingLevel };
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        lastErr = new AiError(`Gemini 응답 오류 (${res.status}) ${detail}`);
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (res.status === 400 && /thinking/i.test(detail) && thinkingLevel !== 'off') {
          thinkingLevel = 'off'; // 이 모델은 thinking 설정을 받지 않아요 → 끄고 같은 시도를 다시
          attempt--;
          continue;
        }
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

// 연결 점검용: /api/health?test=1 에서 호출해 진짜 원인을 보여줘요.
export async function pingGemini() {
  const t0 = Date.now();
  try {
    const reply = await callGemini('JSON 하나로만 답해: {"ok": true}', { timeoutMs: 15000 });
    return { ok: true, ms: Date.now() - t0, thinking: thinkingLevel, reply: reply.slice(0, 100) };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  }
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

const SIMILARITY_PROMPT = (a, b) => `한국어 단어 게임 '히든 워드'의 심판이야. A(정답)와 B(추측)를 비교해 JSON 하나만 출력해. 설명·코드블록 금지.

1) 단어 확인
- a_ok, b_ok: 실제로 쓰이는 한국어 단어인가? (오타, 의미 없는 글자, 자음·모음만 있는 글자, 사람 이름, 욕설이면 false)
- b_noun: B가 명사인가? (동사·형용사·부사·감탄사·활용형이면 false. 예: 먹다, 예쁘다, 빨리는 false)
- false가 있으면 suggestion에 B와 가장 가까운 올바른 명사를 넣어 (없으면 "").

2) relation: A와 B의 관계 하나
synonym(동의어) / antonym(반의어) / hypernym(B가 A의 상위어) / hyponym(B가 A의 하위어) / sibling(같은 상위 범주, 예: 사과-배) / related(자주 함께 쓰이는 관련어) / none

3) 점수 (0~100 정수)
- semantic: 사전적 정의와 개념적 특징이 겹치는 정도
- contextual: 같은 문장·비슷한 맥락에서 함께 등장하는 정도
- relational: 상하위·반의·부분-전체 등 관계 구조가 얼마나 긴밀한가
반의어·상위어·하위어는 뜻이 직접 이어진 가까운 관계이므로 점수를 높게 줘: relation이 antonym/hypernym/hyponym이면 세 점수 모두 70 이상, relational은 85 이상.
synonym 85~97, sibling 55~75, related 25~55, 약한 연결 10~30, 무관 0~10.

explanation: 초등학생도 이해할 존댓말 한 문장 (35자 이내).

A(정답): ${a}
B(추측): ${b}

{"a_ok":true,"b_ok":true,"b_noun":true,"suggestion":"","relation":"none","semantic":0,"contextual":0,"relational":0,"explanation":""}`;

const RELATIONS = new Set(['synonym', 'antonym', 'hypernym', 'hyponym', 'sibling', 'related', 'none']);

export async function judgeSimilarity(a, b) {
  const raw = extractJson(await callGemini(SIMILARITY_PROMPT(a, b)));
  const rel = String(raw.relation ?? '').toLowerCase();
  return {
    aOk: raw.a_ok !== false,
    bOk: raw.b_ok !== false,
    bNoun: raw.b_noun !== false,
    relation: RELATIONS.has(rel) ? rel : 'none',
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
  const prompt = `너는 '히든 워드'를 하는 플레이어야. 숨겨진 정답 단어는 초등학생이 아는 흔한 한국어 명사야.
정답은 모르고, 지금까지 네가 추측한 단어와 정답과의 유사도(%)만 알아. 점수가 높은 단어와 비슷한 방향으로, 점수가 낮은 단어와는 다른 방향으로 다음 추측 단어 하나를 골라.
첫 추측이면 동물, 음식, 자연, 학교 물건, 생활용품 등 다양한 분류에서 흔한 단어를 하나 골라.

지금까지의 추측:
${lines}

이미 쓴 단어는 다시 고르면 안 돼: ${used.length ? used.join(', ') : '없음'}

JSON 하나로만 답해. 한글 명사 하나만 넣어.
{"guess": ""}`;
  const raw = extractJson(await callGemini(prompt, { temperature: 0.9, timeoutMs: 15000 }));
  return typeof raw.guess === 'string' ? raw.guess.normalize('NFC').trim() : '';
}
