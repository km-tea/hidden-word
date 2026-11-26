// 히든 워드 API — Netlify Functions(v2) 하나로 모든 /api/* 요청을 처리해요.
//
// 게임 규칙 (3판 승부)
//  1) 출제자가 후보 3개 중 정답 단어 하나를 고른다.
//  2) 출제자는 정답과 유사도 80% 이상인 '명사'를 힌트로 낸다. (80% 미만이면 다시)
//  3) 힌트가 통과하면 나머지 플레이어가 정답을 추측한다 (라운드당 1번).
//  4) 누군가 맞히면 그 사람 +1점으로 게임 끝. 아무도 못 맞히면 출제자 +1점, 다음 라운드(새 힌트).
//  5) 3라운드까지 못 맞히면 출제자는 총 3점을 얻고 게임 끝. 출제자는 판마다 돌아가며 맡는다.
//  6) 3판이 끝나면 점수가 가장 높은 사람이 승리.
import { neon } from '@neondatabase/serverless';
import { pickOptions, pickRandom } from './words.mjs';
import {
  judgeSimilarity,
  computerHintCandidates,
  computerAnswerGuess,
  pingGemini,
  AiError,
} from './gemini.mjs';

export const config = { path: '/api/*' };

const COMPUTER_ID = 'computer';
const MAX_PLAYERS = 8;
const TOTAL_GAMES = 3;
const MAX_ROUNDS = 3;
const HINT_MIN = 80; // 힌트로 인정되는 최소 유사도(%)
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

// 이전 버전의 rooms/players/guesses 표와 겹치지 않도록 hw_ 접두어를 써요.
const SCHEMA = [
  `create table if not exists hw_rooms (
     code text primary key,
     mode text not null,
     status text not null default 'waiting',
     host_id text not null,
     game_no int not null default 0,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists hw_players (
     room_code text not null references hw_rooms(code) on delete cascade,
     player_id text not null,
     name text not null,
     is_computer boolean not null default false,
     seat int not null default 0,
     score int not null default 0,
     joined_at timestamptz not null default now(),
     primary key (room_code, player_id)
   )`,
  `create table if not exists hw_games (
     room_code text not null references hw_rooms(code) on delete cascade,
     game_no int not null,
     setter_id text not null,
     options jsonb not null default '[]'::jsonb,
     answer text,
     phase text not null default 'choosing',
     round int not null default 1,
     winner_id text,
     outcome text,
     created_at timestamptz not null default now(),
     primary key (room_code, game_no)
   )`,
  `create table if not exists hw_hints (
     id bigserial primary key,
     room_code text not null references hw_rooms(code) on delete cascade,
     game_no int not null,
     round int not null,
     word text not null,
     total int not null,
     accepted boolean not null,
     created_at timestamptz not null default now(),
     unique (room_code, game_no, word)
   )`,
  `create table if not exists hw_guesses (
     id bigserial primary key,
     room_code text not null references hw_rooms(code) on delete cascade,
     game_no int not null,
     round int not null,
     player_id text not null,
     word text not null,
     correct boolean not null default false,
     created_at timestamptz not null default now(),
     unique (room_code, game_no, round, player_id)
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

function badWord(message, extra = {}) {
  return new HttpError(422, 'INVALID_WORD', message, { which: 'guess', suggestion: '', ...extra });
}

// 한글 단어 모양 확인 (정답 추측용)
function requireHangul(raw) {
  const word = normalizeWord(raw);
  if (!WORD_RE.test(word)) throw badWord('한글 단어(1~10글자)만 입력할 수 있어요.', { word });
  return word;
}

// 한글 + 명사 모양 확인 (힌트·연습실 유사 단어용)
function requireNoun(raw) {
  const word = requireHangul(raw);
  assertNoun(word);
  return word;
}

function assertNoun(word) {
  if (NOT_NOUN_RE.test(word)) throw badWord('명사만 입력할 수 있어요.', { word, reason: 'not_noun' });
}

function requirePlayerId(raw) {
  const id = String(raw ?? '').trim();
  if (id.length < 8 || id.length > 64 || !/^[\w-]+$/.test(id)) {
    throw new HttpError(400, 'BAD_PLAYER', '플레이어 정보가 올바르지 않아요. 새로고침 후 다시 시도해 주세요.');
  }
  return id;
}

const parseOptions = (v) => {
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return [];
  }
};

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

  // 두 단어가 모두 명사로 확인된 경우에만 저장 (저장된 값이 명사 규칙을 우회하지 않도록)
  if (j.aNoun && j.bNoun) {
    await q`insert into similarity_cache_v2 (word_a, word_b, semantic, contextual, relational, total, explanation)
            values (${x}, ${y}, ${result.semantic}, ${result.contextual}, ${result.relational}, ${result.total}, ${result.explanation})
            on conflict do nothing`;
  }
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

/* ───────── 방 · 판 도우미 ───────── */

async function getRoom(code) {
  const q = db();
  const rows = await q`select * from hw_rooms where code = ${code}`;
  if (!rows.length) throw new HttpError(404, 'NO_ROOM', '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.');
  return rows[0];
}

async function requireMember(code, playerId) {
  const q = db();
  const rows = await q`select 1 from hw_players where room_code = ${code} and player_id = ${playerId}`;
  if (!rows.length) throw new HttpError(403, 'NOT_MEMBER', '이 방의 참가자가 아니에요.');
}

async function getCurrentGame(code, room) {
  const q = db();
  const r = room || (await getRoom(code));
  const rows = await q`select * from hw_games where room_code = ${code} and game_no = ${r.game_no}`;
  return { room: r, game: rows[0] || null };
}

// 판 시작: 출제자는 입장 순서대로 돌아가며 맡고, 후보 단어 3개를 뽑아요.
async function startGame(code, gameNo) {
  const q = db();
  const players = await q`select player_id from hw_players where room_code = ${code} order by seat, joined_at`;
  if (!players.length) return;
  const setter = players[(gameNo - 1) % players.length].player_id;
  const options = pickOptions(3);
  await q`insert into hw_games (room_code, game_no, setter_id, options)
          values (${code}, ${gameNo}, ${setter}, ${JSON.stringify(options)}::jsonb)
          on conflict do nothing`;
  await q`update hw_rooms set game_no = ${gameNo} where code = ${code} and game_no < ${gameNo}`;
}

async function afterGameDone(code, gameNo) {
  const q = db();
  if (gameNo >= TOTAL_GAMES) await q`update hw_rooms set status = 'finished' where code = ${code}`;
}

async function loadState(code, playerId) {
  const q = db();
  const [roomRows, players, games, hints, guesses] = await Promise.all([
    q`select * from hw_rooms where code = ${code}`,
    q`select player_id, name, is_computer, seat, score from hw_players
      where room_code = ${code} order by seat, joined_at`,
    q`select * from hw_games where room_code = ${code} order by game_no`,
    q`select id, game_no, round, word, total, accepted from hw_hints
      where room_code = ${code} and game_no = (select game_no from hw_rooms where code = ${code})
      order by id`,
    q`select g.game_no, g.round, g.player_id, p.name as player_name, g.word, g.correct
      from hw_guesses g
      join hw_players p on p.room_code = g.room_code and p.player_id = g.player_id
      where g.room_code = ${code} and g.game_no = (select game_no from hw_rooms where code = ${code})
      order by g.id`,
  ]);
  if (!roomRows.length) throw new HttpError(404, 'NO_ROOM', '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.');
  const room = roomRows[0];
  const g = games.find((x) => x.game_no === room.game_no) || null;

  let game = null;
  if (g) {
    const isSetter = g.setter_id === playerId;
    const done = g.phase === 'done';
    game = {
      gameNo: g.game_no,
      setterId: g.setter_id,
      phase: g.phase,
      round: g.round,
      maxRounds: MAX_ROUNDS,
      // 정답과 후보는 출제자에게만(판이 끝나면 정답은 모두에게) 보내요
      options: isSetter && g.phase === 'choosing' ? parseOptions(g.options) : null,
      answer: isSetter || done ? g.answer : null,
      // 80% 미만으로 실패한 시도는 점수가 새어 나가지 않도록 출제자에게만 보여요
      hints: hints
        .filter((h) => isSetter || h.accepted)
        .map((h) => ({ id: Number(h.id), round: h.round, word: h.word, total: h.total, accepted: h.accepted })),
      // 같은 라운드의 다른 사람 추측은 라운드가 끝난 뒤에 공개해요
      guesses: guesses
        .filter((x) => done || x.round < g.round || x.player_id === playerId)
        .map((x) => ({
          round: x.round,
          playerId: x.player_id,
          playerName: x.player_name,
          word: x.word,
          correct: x.correct,
        })),
      guessedThisRound: guesses.some((x) => x.round === g.round && x.player_id === playerId),
      winnerId: g.winner_id,
      outcome: g.outcome,
    };
  }

  // 컴퓨터가 지금 해야 할 일이 남아 있는지 (화면이 /computer 를 불러 이어서 진행해요)
  let computerPending = false;
  if (room.mode === 'computer' && room.status === 'playing' && g) {
    const computerSets = g.setter_id === COMPUTER_ID;
    if (g.phase === 'choosing' || g.phase === 'hinting') computerPending = computerSets;
    else if (g.phase === 'guessing') {
      computerPending = !computerSets && !guesses.some((x) => x.round === g.round && x.player_id === COMPUTER_ID);
    }
  }

  const finished = room.status === 'finished';
  const top = Math.max(0, ...players.map((p) => p.score));
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    hostId: room.host_id,
    gameNo: room.game_no,
    totalGames: TOTAL_GAMES,
    hintMin: HINT_MIN,
    isMember: players.some((p) => p.player_id === playerId),
    players: players.map((p) => ({ id: p.player_id, name: p.name, isComputer: p.is_computer, score: p.score })),
    game,
    history: games
      .filter((x) => x.phase === 'done')
      .map((x) => ({
        gameNo: x.game_no,
        setterId: x.setter_id,
        answer: x.answer,
        winnerId: x.winner_id,
        outcome: x.outcome,
        rounds: x.round,
      })),
    winners: finished ? players.filter((p) => p.score === top).map((p) => p.player_id) : [],
    computerPending,
  };
}

/* ───────── 추측 처리 (사람·컴퓨터 공용) ───────── */

async function submitGuess(code, game, playerId, word) {
  const q = db();
  const correct = word === game.answer;
  const ins = await q`insert into hw_guesses (room_code, game_no, round, player_id, word, correct)
                      values (${code}, ${game.game_no}, ${game.round}, ${playerId}, ${word}, ${correct})
                      on conflict do nothing returning id`;
  if (!ins.length) throw new HttpError(409, 'ALREADY_GUESSED', '이번 라운드에는 이미 답을 냈어요.');

  if (correct) {
    // 먼저 맞힌 한 명만 인정돼요 (동시에 맞혀도 조건부 갱신이 한 번만 성공)
    const won = await q`update hw_games set phase = 'done', winner_id = ${playerId}, outcome = 'guessed'
                        where room_code = ${code} and game_no = ${game.game_no}
                          and phase = 'guessing' and round = ${game.round} returning game_no`;
    if (!won.length) return { correct: false, late: true };
    await q`update hw_players set score = score + 1 where room_code = ${code} and player_id = ${playerId}`;
    await afterGameDone(code, game.game_no);
    return { correct: true, gameOver: true };
  }

  // 틀렸다면, 맞히는 사람 모두가 이번 라운드 답을 냈는지 확인
  const [[{ done }], [{ need }]] = await Promise.all([
    q`select count(*)::int as done from hw_guesses
      where room_code = ${code} and game_no = ${game.game_no} and round = ${game.round}`,
    q`select count(*)::int as need from hw_players where room_code = ${code} and player_id <> ${game.setter_id}`,
  ]);
  if (done < need) return { correct: false, waiting: true };

  // 라운드 실패 → 출제자 +1점. 마지막 라운드면 판 종료, 아니면 다음 라운드(새 힌트)
  const failed = await q`update hw_games
                         set phase   = case when round >= ${MAX_ROUNDS} then 'done' else 'hinting' end,
                             outcome = case when round >= ${MAX_ROUNDS} then 'failed' else outcome end,
                             round   = case when round >= ${MAX_ROUNDS} then round else round + 1 end
                         where room_code = ${code} and game_no = ${game.game_no}
                           and phase = 'guessing' and round = ${game.round}
                         returning phase`;
  if (!failed.length) return { correct: false, waiting: true };
  await q`update hw_players set score = score + 1 where room_code = ${code} and player_id = ${game.setter_id}`;
  const gameOver = failed[0].phase === 'done';
  if (gameOver) await afterGameDone(code, game.game_no);
  return { correct: false, roundFailed: true, gameOver };
}

/* ───────── 컴퓨터 상대 ───────── */

async function computerGiveHint(code, game) {
  const q = db();
  const prior = await q`select word from hw_hints where room_code = ${code} and game_no = ${game.game_no}`;
  const used = prior.map((r) => r.word);
  let best = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let cands = [];
    try {
      cands = await computerHintCandidates(game.answer, used);
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      console.error('[computer-hint]', err.message);
    }
    cands = [...new Set(cands)]
      .filter((w) => WORD_RE.test(w) && !NOT_NOUN_RE.test(w) && w !== game.answer && !used.includes(w))
      .slice(0, 6);
    if (!cands.length) continue;
    used.push(...cands);

    // 후보들을 동시에 채점해서 시간을 아껴요
    const scored = (
      await Promise.all(
        cands.map((w) =>
          similarity(game.answer, w, { trustAnswer: true })
            .then((r) => (r.ok ? { word: w, total: r.total } : null))
            .catch(() => null),
        ),
      )
    ).filter(Boolean);

    // 80% 이상 중 가장 낮은 것(너무 뻔하지 않은 힌트)을 골라요
    const passing = scored.filter((r) => r.total >= HINT_MIN).sort((a, b) => a.total - b.total);
    if (passing.length) {
      best = passing[0];
      break;
    }
    for (const r of scored) if (!best || r.total > best.total) best = r;
  }
  if (!best) throw new HttpError(502, 'AI_ERROR', '컴퓨터가 힌트를 고르지 못했어요. 잠시 뒤에 다시 시도해 주세요.');

  await q`insert into hw_hints (room_code, game_no, round, word, total, accepted)
          values (${code}, ${game.game_no}, ${game.round}, ${best.word}, ${best.total}, true)
          on conflict do nothing`;
  await q`update hw_games set phase = 'guessing'
          where room_code = ${code} and game_no = ${game.game_no} and phase = 'hinting' and round = ${game.round}`;
}

async function computerMakeGuess(code, game) {
  const q = db();
  const [hints, wrong] = await Promise.all([
    q`select word from hw_hints where room_code = ${code} and game_no = ${game.game_no} and accepted order by id`,
    q`select word from hw_guesses where room_code = ${code} and game_no = ${game.game_no} and player_id = ${COMPUTER_ID}`,
  ]);
  const hintWords = hints.map((h) => h.word);
  const wrongWords = wrong.map((w) => w.word);
  let word = '';
  try {
    word = await computerAnswerGuess(hintWords, wrongWords);
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    console.error('[computer-guess]', err.message);
  }
  if (!WORD_RE.test(word) || wrongWords.includes(word)) word = pickRandom([...wrongWords, ...hintWords]);
  return submitGuess(code, game, COMPUTER_ID, word);
}

// 컴퓨터가 할 일이 있으면 사람의 차례가 올 때까지 이어서 진행해요.
async function computerAdvance(code) {
  const q = db();
  for (let step = 0; step < 4; step++) {
    const { room, game } = await getCurrentGame(code);
    if (room.mode !== 'computer' || room.status !== 'playing' || !game) return;
    const computerSets = game.setter_id === COMPUTER_ID;

    if (game.phase === 'choosing' && computerSets) {
      const opts = parseOptions(game.options);
      const word = opts[Math.floor(Math.random() * opts.length)];
      await q`update hw_games set answer = ${word}, phase = 'hinting'
              where room_code = ${code} and game_no = ${game.game_no} and phase = 'choosing'`;
      continue;
    }
    if (game.phase === 'hinting' && computerSets) {
      await computerGiveHint(code, game);
      continue;
    }
    if (game.phase === 'guessing' && !computerSets) {
      const mine = await q`select 1 from hw_guesses
                           where room_code = ${code} and game_no = ${game.game_no}
                             and round = ${game.round} and player_id = ${COMPUTER_ID}`;
      if (mine.length) return;
      await computerMakeGuess(code, game);
      continue;
    }
    return;
  }
}

// 사람의 행동 뒤에 컴퓨터가 같은 요청 안에서 바로 이어서 두도록 해요. 실패해도 사람의 결과는 유지하고,
// 화면이 computerPending 을 보고 /computer 로 다시 이어가요.
async function advanceQuietly(code, mode) {
  if (mode !== 'computer') return;
  try {
    await computerAdvance(code);
  } catch (err) {
    console.error('[computer-advance]', err.message);
  }
}

/* ───────── 핸들러들 ───────── */

async function handlePractice(body) {
  const answer = normalizeWord(body.answer);
  if (!WORD_RE.test(answer)) {
    throw badWord('정답 단어는 한글 1~10글자로 입력해 주세요.', { which: 'answer', word: answer });
  }
  const guess = normalizeWord(body.guess);
  if (!WORD_RE.test(guess)) {
    throw badWord('유사 단어는 한글 1~10글자로 입력해 주세요.', { word: guess });
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

  await q`delete from hw_rooms where created_at < now() - interval '1 day'`; // 하루 지난 방 정리

  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = null;
  for (let i = 0; i < 8 && !code; i++) {
    const c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const ins = await q`insert into hw_rooms (code, mode, status, host_id)
                        values (${c}, ${mode}, ${mode === 'computer' ? 'playing' : 'waiting'}, ${playerId})
                        on conflict do nothing returning code`;
    if (ins.length) code = c;
  }
  if (!code) throw new HttpError(500, 'NO_CODE', '방을 만들지 못했어요. 다시 시도해 주세요.');

  await q`insert into hw_players (room_code, player_id, name, seat) values (${code}, ${playerId}, ${name}, 0)`;
  if (mode === 'computer') {
    await q`insert into hw_players (room_code, player_id, name, is_computer, seat)
            values (${code}, ${COMPUTER_ID}, '컴퓨터', true, 1)`;
    await startGame(code, 1);
    await advanceQuietly(code, mode); // 첫 출제자가 컴퓨터라면 바로 진행
  }
  return { code };
}

async function handleJoin(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const name = cleanName(body.name);
  const room = await getRoom(code);
  if (room.mode !== 'multi') throw new HttpError(409, 'NOT_JOINABLE', '컴퓨터와 하는 게임에는 들어갈 수 없어요.');

  const existing = await q`select 1 from hw_players where room_code = ${code} and player_id = ${playerId}`;
  if (existing.length) return { code }; // 다시 들어오는 경우

  if (room.status !== 'waiting') throw new HttpError(409, 'STARTED', '이미 시작된 게임이에요.');
  const [{ n }] = await q`select count(*)::int as n from hw_players where room_code = ${code}`;
  if (n >= MAX_PLAYERS) throw new HttpError(409, 'FULL', `방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)`);

  await q`insert into hw_players (room_code, player_id, name, seat) values (${code}, ${playerId}, ${name}, ${n})`;
  return { code };
}

async function handleStart(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const room = await getRoom(code);
  if (room.host_id !== playerId) throw new HttpError(403, 'NOT_HOST', '방장만 시작할 수 있어요.');
  if (room.status !== 'waiting') return { ok: true };
  const [{ n }] = await q`select count(*)::int as n from hw_players where room_code = ${code}`;
  if (n < 2) throw new HttpError(409, 'NEED_PLAYERS', '2명 이상 모여야 시작할 수 있어요.');
  const started = await q`update hw_rooms set status = 'playing' where code = ${code} and status = 'waiting' returning code`;
  if (started.length) await startGame(code, 1);
  return { ok: true };
}

// 출제자가 후보 3개 중 정답 단어를 고른다
async function handleChoose(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const word = normalizeWord(body.word);
  const { room, game } = await getCurrentGame(code);
  await requireMember(code, playerId);
  if (room.status !== 'playing' || !game) throw new HttpError(409, 'NOT_PLAYING', '지금은 단어를 고를 수 없어요.');
  if (game.setter_id !== playerId) throw new HttpError(403, 'NOT_SETTER', '이번 판의 출제자가 아니에요.');
  if (game.phase !== 'choosing') return { ok: true }; // 이미 골랐어요
  if (!parseOptions(game.options).includes(word)) throw new HttpError(422, 'BAD_OPTION', '후보에 없는 단어예요.');

  await q`update hw_games set answer = ${word}, phase = 'hinting'
          where room_code = ${code} and game_no = ${game.game_no} and phase = 'choosing'`;
  return { ok: true };
}

// 출제자가 힌트(정답과 유사도 80% 이상인 명사)를 낸다
async function handleHint(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const word = requireNoun(body.word);
  const { room, game } = await getCurrentGame(code);
  await requireMember(code, playerId);
  if (room.status !== 'playing' || !game) throw new HttpError(409, 'NOT_PLAYING', '지금은 힌트를 낼 수 없어요.');
  if (game.setter_id !== playerId) throw new HttpError(403, 'NOT_SETTER', '이번 판의 출제자가 아니에요.');
  if (game.phase !== 'hinting') throw new HttpError(409, 'NOT_HINTING', '지금은 힌트를 낼 차례가 아니에요.');
  if (word === game.answer) {
    throw new HttpError(422, 'ANSWER_AS_HINT', '정답 단어 자체는 힌트로 낼 수 없어요. 비슷한 다른 단어를 입력해 주세요.', { word });
  }
  const dup = await q`select 1 from hw_hints where room_code = ${code} and game_no = ${game.game_no} and word = ${word}`;
  if (dup.length) throw new HttpError(409, 'DUPLICATE', '이미 낸 힌트예요.', { word });

  const r = await similarity(game.answer, word, { trustAnswer: true });
  if (!r.ok) throw invalidWordError(word, r);

  const accepted = r.total >= HINT_MIN;
  await q`insert into hw_hints (room_code, game_no, round, word, total, accepted)
          values (${code}, ${game.game_no}, ${game.round}, ${word}, ${r.total}, ${accepted})
          on conflict do nothing`;
  if (accepted) {
    await q`update hw_games set phase = 'guessing'
            where room_code = ${code} and game_no = ${game.game_no} and phase = 'hinting' and round = ${game.round}`;
    await advanceQuietly(code, room.mode); // 컴퓨터가 맞히는 쪽이면 바로 추측
  }
  return { word, accepted, minimum: HINT_MIN, result: r };
}

// 맞히는 사람이 정답을 추측한다 (라운드당 한 번)
async function handleGuess(code, body) {
  const playerId = requirePlayerId(body.playerId);
  const word = requireHangul(body.word);
  const { room, game } = await getCurrentGame(code);
  await requireMember(code, playerId);
  if (room.status !== 'playing' || !game || game.phase !== 'guessing') {
    throw new HttpError(409, 'NOT_GUESSING', '지금은 정답을 추측할 수 없어요.');
  }
  if (game.setter_id === playerId) throw new HttpError(403, 'IS_SETTER', '출제자는 정답을 추측하지 않아요.');

  const out = await submitGuess(code, game, playerId, word);
  if (out.roundFailed || out.gameOver) await advanceQuietly(code, room.mode); // 컴퓨터가 출제자면 새 힌트
  return { word, ...out };
}

async function handleNext(code, body) {
  const playerId = requirePlayerId(body.playerId);
  const gameNo = Number(body.gameNo);
  const { room, game } = await getCurrentGame(code);
  await requireMember(code, playerId);
  if (room.status !== 'playing' || !game) return { ok: true };
  if (game.game_no !== gameNo || game.phase !== 'done' || gameNo >= TOTAL_GAMES) return { ok: true }; // 이미 넘어갔어요
  await startGame(code, gameNo + 1);
  await advanceQuietly(code, room.mode); // 다음 출제자가 컴퓨터면 단어를 고르고 힌트까지
  return { ok: true };
}

async function handleComputer(code, body) {
  const playerId = requirePlayerId(body.playerId);
  const room = await getRoom(code);
  await requireMember(code, playerId);
  if (room.mode !== 'computer') throw new HttpError(409, 'NOT_COMPUTER', '컴퓨터와 하는 게임이 아니에요.');
  await computerAdvance(code);
  return { ok: true };
}

async function handleEnd(code, body) {
  const q = db();
  const playerId = requirePlayerId(body.playerId);
  const room = await getRoom(code);
  if (room.host_id !== playerId) throw new HttpError(403, 'NOT_HOST', '방장만 게임을 끝낼 수 있어요.');
  await q`update hw_rooms set status = 'finished' where code = ${code}`;
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
          case 'choose':
            return json(await handleChoose(code, body));
          case 'hint':
            return json(await handleHint(code, body));
          case 'guess':
            return json(await handleGuess(code, body));
          case 'next':
            return json(await handleNext(code, body));
          case 'computer':
            return json(await handleComputer(code, body));
          case 'end':
            return json(await handleEnd(code, body));
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
