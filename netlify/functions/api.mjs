// 히든 워드 API — Netlify Functions(v2) 하나로 모든 /api/* 요청을 처리해요.
import { neon } from '@neondatabase/serverless';
import { pickAnswer, pickRandom } from './words.mjs';
import { judgeSimilarity, computerGuess, pingGemini, AiError } from './gemini.mjs';

export const config = { path: '/api/*' };

const COMPUTER_ID = 'computer';
const MAX_PLAYERS = 8;
const WORD_RE = /^[가-힣]{1,10}$/;
const WEIGHTS = { semantic: 0.4, contextual: 0.3, relational: 0.3 };
// 동의어·반의어·상위어·하위어는 뜻이 직접 이어진 관계라서 점수의 바닥(최소값)을 보장해요.
const RELATION_FLOOR = { synonym: 90, antonym: 82, hypernym: 80, hyponym: 80 };
// 동사·형용사처럼 보이는 어미는 AI에게 묻기 전에 바로 걸러요.
const NOT_NOUN_RE = /(하다|되다|시키다|스럽다|롭다|있다|없다|했다|된다|한다)$/;

/* ───────── 공통 도우미 ───────── */

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

let sql = null;
let schemaReady = null;

function db() {
  if (sql) return sql;
  const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new HttpError(500, 'NO_DB', '데이터베이스 주소(DATABASE_URL)가 설정되지 않았어요.');
  sql = neon(url);
  return sql;
}

const SCHEMA = [
  `create table if not exists rooms (
     code text primary key,
     mode text not null,
     answer text not null,
     status text not null default 'waiting',
     host_id text not null,
     winner_id text,
     created_at timestamptz not null default now(),
     started_at timestamptz,
     finished_at timestamptz
   )`,
  `create table if not exists players (
     room_code text not null references rooms(code) on delete cascade,
     player_id text not null,
     name text not null,
     is_computer boolean not null default false,
     joined_at timestamptz not null default now(),
     primary key (room_code, player_id)
   )`,
  `create table if not exists guesses (
     id bigserial primary key,
     room_code text not null references rooms(code) on delete cascade,
     player_id text not null,
     word text not null,
     semantic int not null,
     contextual int not null,
     relational int not null,
     total int not null,
     created_at timestamptz not null default now(),
     unique (room_code, player_id, word)
   )`,
  `create table if not exists similarity_cache_v2 (
     word_a text not null,
     word_b text not null,
     semantic int not null,
     contextual int not null,
     relational int not null,
     total int not null,
     explanation text not null default '',
     created_at timestamptz not null default now(),
     primary key (word_a, word_b)
   )`,
];

function ensureSchema() {
  if (!schemaReady) {
    const q = db();
    schemaReady = (async () => {
      for (const stmt of SCHEMA) await q.query(stmt);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

const normalizeWord = (w) => String(w ?? '').normalize('NFC').trim();

function cleanName(n) {
  const name = String(n ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 8);
  return name || `플레이어${Math.floor(Math.random() * 90) + 10}`;
}

function requireWord(raw) {
  const word = normalizeWord(raw);
  if (!WORD_RE.test(word)) {
    throw new HttpError(422, 'INVALID_WORD', '한글 단어(1~10글자)만 입력할 수 있어요.', {
      which: 'guess',
      word,
      suggestion: '',
    });
  }
  assertNoun(word);
  return word;
}

function assertNoun(word) {
  if (NOT_NOUN_RE.test(word)) {
    throw new HttpError(422, 'INVALID_WORD', '명사만 입력할 수 있어요.', {
      which: 'guess',
      word,
      suggestion: '',
      reason: 'not_noun',
    });
  }
}

function requirePlayerId(raw) {
  const id = String(raw ?? '').trim();
  if (id.length < 8 || id.length > 64 || !/^[\w-]+$/.test(id)) {
    throw new HttpError(400, 'BAD_PLAYER', '플레이어 정보가 올바르지 않아요. 새로고침 후 다시 시도해 주세요.');
  }
  return id;
}

/* ───────── 유사도 계산 (캐시 → Gemini) ───────── */

const perfect = () => ({
  ok: true,
  semantic: 100,
  contextual: 100,
  relational: 100,
  total: 100,
  explanation: '똑같은 단어예요!',
});

// trustAnswer: 정답이 우리 단어 목록에서 온 경우(게임) true
async function similarity(answer, guess, { trustAnswer = false } = {}) {
  if (answer === guess) return perfect();
  const q = db();
  const [x, y] = answer < guess ? [answer, guess] : [guess, answer]; // 순서와 상관없이 같은 점수

  const cached = await q`select semantic, contextual, relational, total, explanation
                         from similarity_cache_v2 where word_a = ${x} and word_b = ${y}`;
  if (cached.length) return { ok: true, ...cached[0] };

  let j;
  try {
    j = await judgeSimilarity(answer, guess);
  } catch (err) {
    if (err instanceof AiError) {
      console.error('[gemini]', err.message);
      throw new HttpError(502, 'AI_ERROR', 'AI가 잠시 응답하지 못했어요. 잠깐 뒤에 다시 시도해 주세요.', {
        detail: err.message,
      });
    }
    throw err;
  }

  if (!j.bOk) return { ok: false, which: 'guess', suggestion: j.suggestion };
  if (!j.aOk && !trustAnswer) return { ok: false, which: 'answer', suggestion: j.suggestion };

  if (!j.bNoun) return { ok: false, which: 'guess', reason: 'not_noun', suggestion: j.suggestion };

  let { semantic, contextual, relational } = j;
  const floor = RELATION_FLOOR[j.relation] || 0;
  if (floor) {
    // 점수 막대도 자연스럽게 보이도록 세 점수를 함께 끌어올려요.
    semantic = Math.max(semantic, floor - 12);
    contextual = Math.max(contextual, floor - 12);
    relational = Math.max(relational, floor);
  }
  const raw = semantic * WEIGHTS.semantic + contextual * WEIGHTS.contextual + relational * WEIGHTS.relational;
  const total = Math.min(99, Math.max(Math.round(raw), floor)); // 정답이 아니면 100%는 나오지 않아요
  const result = { semantic, contextual, relational, total, explanation: j.explanation };
  await q`insert into similarity_cache_v2 (word_a, word_b, semantic, contextual, relational, total, explanation)
          values (${x}, ${y}, ${result.semantic}, ${result.contextual}, ${result.relational}, ${result.total}, ${result.explanation})
          on conflict do nothing`;
  return { ok: true, ...result };
}

function invalidWordError(word, r) {
  const message =
    r.reason === 'not_noun'
      ? '명사만 입력할 수 있어요.'
      : '이해하지 못한 단어예요. 오타가 없는지 확인하고 다시 입력해 주세요.';
  return new HttpError(422, 'INVALID_WORD', message, {
    which: r.which,
    word,
    suggestion: r.suggestion || '',
    reason: r.reason || '',
  });
}

/* ───────── 방 도우미 ───────── */

async function getRoom(code) {
  const q = db();
  const rows = await q`select * from rooms where code = ${code}`;
  if (!rows.length) throw new HttpError(404, 'NO_ROOM', '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.');
  return rows[0];
}

async function requireMember(code, playerId) {
  const q = db();
  const rows = await q`select 1 from players where room_code = ${code} and player_id = ${playerId}`;
  if (!rows.length) throw new HttpError(403, 'NOT_MEMBER', '이 방의 참가자가 아니에요.');
}

async function loadState(code, playerId) {
  const q = db();
  const [room, players, guesses] = await Promise.all([
    getRoom(code),
    q`select p.player_id, p.name, p.is_computer,
             coalesce(g.cnt, 0)::int as guess_count, g.best::int as best
      from players p
      left join (select player_id, count(*) as cnt, max(total) as best
                 from guesses where room_code = ${code} group by player_id) g
        on g.player_id = p.player_id
      where p.room_code = ${code}
      order by p.joined_at, p.player_id`,
    q`select g.id, g.player_id, p.name as player_name, g.word,
             g.semantic, g.contextual, g.relational, g.total
      from guesses g
      join players p on p.room_code = g.room_code and p.player_id = g.player_id
      where g.room_code = ${code}
      order by g.id
      limit 600`,
  ]);

  const winner = players.find((p) => p.player_id === room.winner_id);
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    hostId: room.host_id,
    isMember: players.some((p) => p.player_id === playerId),
    answer: room.status === 'finished' ? room.answer : null, // 끝나기 전에는 절대 보내지 않아요
    winner: winner ? { id: winner.player_id, name: winner.name, isComputer: winner.is_computer } : null,
    players: players.map((p) => ({
      id: p.player_id,
      name: p.name,
      isComputer: p.is_computer,
      guessCount: p.guess_count,
      best: p.best,
    })),
    guesses: guesses.map((g) => ({
      id: Number(g.id),
      playerId: g.player_id,
      playerName: g.player_name,
      word: g.word,
      semantic: g.semantic,
      contextual: g.contextual,
      relational: g.relational,
      total: g.total,
    })),
  };
}

// 추측 하나를 저장하고, 정답이면 방을 끝낸다 (먼저 맞힌 한 명만 승자)
async function recordGuess(room, playerId, word, r) {
  const q = db();
  const ins = await q`insert into guesses (room_code, player_id, word, semantic, contextual, relational, total)
                      values (${room.code}, ${playerId}, ${word}, ${r.semantic}, ${r.contextual}, ${r.relational}, ${r.total})
                      on conflict do nothing returning id`;
  if (!ins.length) throw new HttpError(409, 'DUPLICATE', '이미 입력한 단어예요.', { word });

  let correct = false;
  if (word === room.answer) {
    const won = await q`update rooms set status = 'finished', winner_id = ${playerId}, finished_at = now()
                        where code = ${room.code} and status = 'playing' returning code`;
    correct = won.length > 0;
  }
  return { correct, finished: correct };
}

/* ───────── 핸들러들 ───────── */

async function handlePractice(body) {
  const answer = normalizeWord(body.answer);
  const guess = normalizeWord(body.guess);
  if (!WORD_RE.test(answer)) {
    throw new HttpError(422, 'INVALID_WORD', '정답 단어는 한글 1~10글자로 입력해 주세요.', {
      which: 'answer',
      word: answer,
      suggestion: '',
    });
  }
  if (!WORD_RE.test(guess)) {
    throw new HttpError(422, 'INVALID_WORD', '유사 단어는 한글 1~10글자로 입력해 주세요.', {
      which: 'guess',
      word: guess,
      suggestion: '',
    });
  }
  assertNoun(guess);
  const r = await similarity(answer, guess);
  if (!r.ok) throw invalidWordError(r.which === 'answer' ? answer : guess, r);
  return { answer, guess, result: r };
}

async function handleCreateRoom(body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const name = cleanName(body.name);
  const mode = body.mode === 'multi' ? 'multi' : 'computer';
  const answer = pickAnswer();
  const status = mode === 'computer' ? 'playing' : 'waiting';

  // 하루 지난 방은 정리
  await q`delete from rooms where created_at < now() - interval '1 day'`;

  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = null;
  for (let i = 0; i < 8 && !code; i++) {
    const c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const ins = await q`insert into rooms (code, mode, answer, status, host_id, started_at)
                        values (${c}, ${mode}, ${answer}, ${status}, ${playerId}, ${mode === 'computer' ? new Date().toISOString() : null})
                        on conflict do nothing returning code`;
    if (ins.length) code = c;
  }
  if (!code) throw new HttpError(500, 'NO_CODE', '방을 만들지 못했어요. 다시 시도해 주세요.');

  await q`insert into players (room_code, player_id, name) values (${code}, ${playerId}, ${name})`;
  if (mode === 'computer') {
    await q`insert into players (room_code, player_id, name, is_computer)
            values (${code}, ${COMPUTER_ID}, '컴퓨터', true)`;
  }
  return { code };
}

async function handleJoin(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const name = cleanName(body.name);
  const room = await getRoom(code);
  if (room.mode !== 'multi') throw new HttpError(409, 'NOT_JOINABLE', '컴퓨터와 하는 게임에는 들어갈 수 없어요.');

  const existing = await q`select 1 from players where room_code = ${code} and player_id = ${playerId}`;
  if (existing.length) return { code }; // 다시 들어오는 경우

  if (room.status !== 'waiting') throw new HttpError(409, 'STARTED', '이미 시작된 게임이에요.');
  const [{ n }] = await q`select count(*)::int as n from players where room_code = ${code}`;
  if (n >= MAX_PLAYERS) throw new HttpError(409, 'FULL', `방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)`);

  await q`insert into players (room_code, player_id, name) values (${code}, ${playerId}, ${name})`;
  return { code };
}

async function handleStart(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const room = await getRoom(code);
  if (room.host_id !== playerId) throw new HttpError(403, 'NOT_HOST', '방장만 시작할 수 있어요.');
  if (room.status !== 'waiting') return { ok: true };
  const [{ n }] = await q`select count(*)::int as n from players where room_code = ${code}`;
  if (n < 2) throw new HttpError(409, 'NEED_PLAYERS', '2명 이상 모여야 시작할 수 있어요.');
  await q`update rooms set status = 'playing', started_at = now() where code = ${code} and status = 'waiting'`;
  return { ok: true };
}

async function loadComputerHistory(code) {
  const q = db();
  return q`select word, total from guesses where room_code = ${code} and player_id = ${COMPUTER_ID} order by id`;
}

async function pickComputerWord(mine, used) {
  let word = '';
  try {
    word = await computerGuess(mine.map((g) => ({ word: g.word, total: g.total })), used);
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    console.error('[computer-guess]', err.message);
  }
  if (!WORD_RE.test(word) || used.includes(word)) word = pickRandom(used);
  return word;
}

// 컴퓨터의 한 수: 단어를 고르고(미리 골라 둔 게 있으면 그걸 쓰고) 유사도를 구해 기록해요.
async function playComputerMove(room, mine, firstWord) {
  const used = mine.map((g) => g.word);
  let word = firstWord;
  for (let tried = 0; tried < 3; tried++) {
    if (!word || used.includes(word)) word = await pickComputerWord(mine, used);
    const r = await similarity(room.answer, word, { trustAnswer: true });
    if (!r.ok) {
      used.push(word); // 이해 못 한 단어·명사가 아닌 단어면 다른 단어로 다시
      word = '';
      continue;
    }
    const { correct, finished } = await recordGuess(room, COMPUTER_ID, word, r);
    return { word, total: r.total, correct, finished };
  }
  throw new HttpError(502, 'AI_ERROR', '컴퓨터가 단어를 고르지 못했어요. 잠시 뒤에 다시 시도해 주세요.');
}

async function handleGuess(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const word = requireWord(body.word);
  const [room, member, dup] = await Promise.all([
    getRoom(code),
    q`select 1 from players where room_code = ${code} and player_id = ${playerId}`,
    q`select 1 from guesses where room_code = ${code} and player_id = ${playerId} and word = ${word}`,
  ]);
  if (!member.length) throw new HttpError(403, 'NOT_MEMBER', '이 방의 참가자가 아니에요.');
  if (room.status !== 'playing') throw new HttpError(409, 'NOT_PLAYING', '지금은 단어를 입력할 수 없어요.');
  if (dup.length) throw new HttpError(409, 'DUPLICATE', '이미 입력한 단어예요.', { word });

  // 컴퓨터는 정답을 모르니 사람의 추측과 상관없이 다음 단어를 미리 골라 둬요 (기다리는 시간 단축)
  let pre = null;
  if (room.mode === 'computer') {
    pre = loadComputerHistory(code)
      .then(async (mine) => ({ mine, word: await pickComputerWord(mine, mine.map((g) => g.word)) }))
      .catch(() => null);
  }

  const r = await similarity(room.answer, word, { trustAnswer: true });
  if (!r.ok) throw invalidWordError(word, r);
  const human = await recordGuess(room, playerId, word, r);

  // 같은 요청 안에서 컴퓨터도 바로 한 수 둬요. 실패해도 사람의 결과는 그대로 돌려주고,
  // 화면이 /computer 로 이어서 진행해요.
  let computer = null;
  if (room.mode === 'computer' && !human.finished) {
    try {
      const picked = await pre;
      const mine = picked ? picked.mine : await loadComputerHistory(code);
      const [{ n }] = await q`select count(*)::int as n from guesses where room_code = ${code} and player_id <> ${COMPUTER_ID}`;
      if (mine.length < n) computer = await playComputerMove(room, mine, picked && picked.word);
    } catch (err) {
      console.error('[computer-move]', err.message);
    }
  }
  return {
    word,
    result: r,
    correct: human.correct,
    finished: human.finished || Boolean(computer && computer.finished),
    computer,
  };
}

async function handleComputerTurn(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const room = await getRoom(code);
  await requireMember(code, playerId);
  if (room.mode !== 'computer') throw new HttpError(409, 'NOT_COMPUTER', '컴퓨터와 하는 게임이 아니에요.');
  if (room.status !== 'playing') return { skipped: true };

  const mine = await loadComputerHistory(code);
  const [{ n }] = await q`select count(*)::int as n from guesses where room_code = ${code} and player_id <> ${COMPUTER_ID}`;
  if (mine.length >= n) return { skipped: true }; // 아직 컴퓨터 차례가 아니에요
  return playComputerMove(room, mine, null);
}

async function handleGiveUp(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const room = await getRoom(code);
  if (room.host_id !== playerId) throw new HttpError(403, 'NOT_HOST', '방장만 포기할 수 있어요.');
  await q`update rooms set status = 'finished', finished_at = now()
          where code = ${code} and status in ('playing', 'waiting')`;
  return { ok: true };
}

/* ───────── 라우터 ───────── */

export default async (req) => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const method = req.method;

    if (method === 'GET' && parts[0] === 'health') {
      return json({
        ok: true,
        db: Boolean(process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
        ...(url.searchParams.get('test') ? { geminiTest: await pingGemini() } : {}),
      });
    }

    await ensureSchema();
    const body = method === 'POST' ? await req.json().catch(() => ({})) : {};
    const code = (parts[1] || '').toUpperCase();

    if (method === 'POST' && parts[0] === 'practice' && parts.length === 1) {
      return json(await handlePractice(body));
    }
    if (method === 'POST' && parts[0] === 'rooms' && parts.length === 1) {
      return json(await handleCreateRoom(body));
    }
    if (parts[0] === 'rooms' && code) {
      if (method === 'GET' && parts.length === 2) {
        return json(await loadState(code, url.searchParams.get('playerId') || ''));
      }
      if (method === 'POST' && parts.length === 3) {
        switch (parts[2]) {
          case 'join':
            return json(await handleJoin(code, body));
          case 'start':
            return json(await handleStart(code, body));
          case 'guess':
            return json(await handleGuess(code, body));
          case 'computer':
            return json(await handleComputerTurn(code, body));
          case 'giveup':
            return json(await handleGiveUp(code, body));
        }
      }
    }
    throw new HttpError(404, 'NOT_FOUND', '없는 주소예요.');
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ code: err.code, message: err.message, ...err.extra }, err.status);
    }
    console.error('[api]', err);
    return json({ code: 'SERVER_ERROR', message: '서버에 문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.' }, 500);
  }
};
