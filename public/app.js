(() => {
  'use strict';

  /* ───────── 도우미 ───────── */
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k, d = null) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);

  let playerId = store.get('hw_pid');
  if (!playerId) {
    playerId = uuid();
    store.set('hw_pid', playerId);
  }

  const WORD_RE = /^[가-힣]{1,10}$/;
  const NOT_NOUN_RE = /(하다|되다|시키다|스럽다|롭다|있다|없다|했다|된다|한다)$/; // 동사·형용사 어미
  const heat = (t) => `hsl(${Math.round(220 - t * 2.1)} 80% 58%)`; // 0% 파랑 → 100% 빨강
  const label = (t) =>
    t >= 90 ? '거의 다 왔어요!' : t >= 70 ? '아주 가까워요' : t >= 50 ? '가까운 편이에요' : t >= 30 ? '조금 관련 있어요' : t >= 10 ? '많이 멀어요' : '관련이 거의 없어요';

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      const e = new Error('인터넷 연결을 확인해 주세요.');
      e.code = 'NETWORK';
      throw e;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const e = new Error((data && data.message) || '문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.');
      e.code = data && data.code;
      e.data = data || {};
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // 원인 파악용: 서버가 보내준 상세 사유(있을 때만) — 운영 전에는 지워도 돼요.
  const errHint = (err) => (err && err.data && err.data.detail ? String(err.data.detail).slice(0, 200) : '');

  /* ───────── 팝업 ───────── */
  const dlg = $('#popup');
  function popup({ icon = '💬', title, message, hint, button = '확인', alt }) {
    return new Promise((resolve) => {
      $('#popup-icon').textContent = icon;
      $('#popup-title').textContent = title;
      $('#popup-msg').textContent = message || '';
      const hintEl = $('#popup-hint');
      hintEl.hidden = !hint;
      hintEl.textContent = hint || '';
      $('#popup-ok').textContent = button;
      const altBtn = $('#popup-alt');
      altBtn.hidden = !alt;
      if (alt) altBtn.textContent = alt;
      altBtn.onclick = () => dlg.close('alt');
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'alt' ? 'alt' : 'ok');
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else {
        alert(`${title}\n${message || ''}`);
        onClose();
      }
    });
  }

  // 서버가 돌려준 "이해하지 못한 단어" 오류를 팝업으로 보여주고, 추천 단어를 고르면 돌려줘요.
  async function invalidWordPopup(err, fallbackWord) {
    const d = err.data || {};
    const word = d.word || fallbackWord || '';
    const who = d.which === 'answer' ? '정답 단어' : '유사 단어';
    const sug = d.suggestion && d.suggestion !== word ? d.suggestion : '';
    if (d.reason === 'not_noun') {
      const choice = await popup({
        icon: '📝',
        title: '명사만 입력할 수 있어요',
        message: word
          ? `‘${word}’은(는) 명사가 아니에요. 사물·동물·장소처럼 이름이 되는 단어를 입력해 주세요.`
          : '사물·동물·장소처럼 이름이 되는 단어(명사)를 입력해 주세요.',
        hint: sug ? `이런 단어는 어때요? ‘${sug}’` : '',
        button: '다시 입력',
        alt: sug ? `‘${sug}’(으)로 입력` : undefined,
      });
      return choice === 'alt' ? sug : null;
    }
    const choice = await popup({
      icon: '✏️',
      title: '다시 입력해 주세요',
      message: word ? `${who} ‘${word}’을(를) 이해하지 못했어요. 오타가 없는지 확인해 주세요.` : err.message,
      hint: sug ? `혹시 ‘${sug}’ 아닐까요?` : '',
      button: '다시 입력',
      alt: sug ? `‘${sug}’(으)로 입력` : undefined,
    });
    return choice === 'alt' ? sug : null;
  }

  /* ───────── 화면 전환 ───────── */
  const views = { lobby: $('#view-lobby'), waiting: $('#view-waiting'), play: $('#view-play') };
  function showView(name) {
    Object.entries(views).forEach(([k, el]) => (el.hidden = k !== name));
  }

  /* ───────── 상태 ───────── */
  let room = null; // 서버에서 받은 방 상태 (code만 있을 수도 있어요)
  let pollTimer = null;
  let busy = false; // 내가 요청을 보내는 중
  let advancing = false; // 컴퓨터 차례를 이어서 진행하는 중
  let announced = {}; // 이미 팝업으로 알려준 일 (판 종료, 라운드 실패 등)
  let refreshing = false;

  const nameInput = $('#name');
  nameInput.value = store.get('hw_name', '');
  const myName = () => {
    const n = nameInput.value.trim().slice(0, 8);
    store.set('hw_name', n);
    return n;
  };

  const nameOf = (id) => {
    const p = room && room.players && room.players.find((x) => x.id === id);
    return p ? p.name : '';
  };

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  function startPolling() {
    stopPolling();
    if (room && room.mode === 'multi') pollTimer = setInterval(() => refresh().catch(() => {}), 2000);
  }

  async function refresh() {
    if (!room || refreshing) return room;
    refreshing = true;
    try {
      const state = await api(`/rooms/${room.code}?playerId=${encodeURIComponent(playerId)}`);
      const prev = room;
      room = state;
      render(prev);
      await continueComputer();
      return state;
    } finally {
      refreshing = false;
    }
  }

  // 컴퓨터가 해야 할 일이 남아 있으면 서버에 이어서 진행해 달라고 요청해요.
  async function continueComputer() {
    if (!room || !room.computerPending || advancing) return;
    advancing = true;
    setStatus('🤖 컴퓨터가 생각하고 있어요…');
    try {
      await api(`/rooms/${room.code}/computer`, { method: 'POST', body: { playerId } });
      const state = await api(`/rooms/${room.code}?playerId=${encodeURIComponent(playerId)}`);
      const prev = room;
      room = state;
      render(prev);
    } catch (err) {
      await popup({ icon: '🤖', title: '컴퓨터가 잠시 멈췄어요', message: err.message, hint: errHint(err), button: '확인' });
    } finally {
      advancing = false;
      if (room) setStatus('');
    }
  }

  async function enterRoom(code) {
    store.set('hw_room', code);
    announced = {};
    room = { code, mode: 'multi' };
    await refresh();
    startPolling();
  }

  function leaveRoom() {
    stopPolling();
    room = null;
    announced = {};
    store.del('hw_room');
    history.replaceState(null, '', location.pathname);
    showView('lobby');
  }

  /* ───────── 로비 ───────── */
  async function requireName() {
    const n = myName();
    if (n) return n;
    await popup({ icon: '👋', title: '이름을 입력해 주세요', message: '게임에서 보일 이름이 필요해요.', button: '확인' });
    nameInput.focus();
    return null;
  }

  async function createRoom(mode) {
    const name = await requireName();
    if (!name) return;
    try {
      const { code } = await api('/rooms', { method: 'POST', body: { playerId, name, mode } });
      await enterRoom(code);
    } catch (err) {
      await popup({ icon: '⚠️', title: '방을 만들 수 없어요', message: err.message, hint: errHint(err) });
    }
  }

  $('#btn-computer').addEventListener('click', () => createRoom('computer'));
  $('#btn-create').addEventListener('click', () => createRoom('multi'));

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = await requireName();
    if (!name) return;
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 4) {
      await popup({ icon: '🔑', title: '방 코드를 확인해 주세요', message: '방 코드는 영문·숫자 4글자예요.' });
      return;
    }
    try {
      await api(`/rooms/${code}/join`, { method: 'POST', body: { playerId, name } });
      await enterRoom(code);
    } catch (err) {
      await popup({ icon: '🚪', title: '입장할 수 없어요', message: err.message });
    }
  });

  /* ───────── 대기실 ───────── */
  $('#btn-copy').addEventListener('click', async () => {
    if (!room) return;
    const link = `${location.origin}/?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(link);
      await popup({ icon: '📋', title: '복사했어요', message: '친구에게 링크를 보내 주세요.', hint: link });
    } catch {
      await popup({ icon: '📋', title: '초대 링크', message: '아래 링크를 복사해 친구에게 보내 주세요.', hint: link });
    }
  });

  $('#btn-start').addEventListener('click', async () => {
    try {
      await api(`/rooms/${room.code}/start`, { method: 'POST', body: { playerId } });
      await refresh();
    } catch (err) {
      await popup({ icon: '⏳', title: '아직 시작할 수 없어요', message: err.message });
    }
  });

  $('#btn-leave-wait').addEventListener('click', leaveRoom);

  /* ───────── 게임 화면 ───────── */
  const inputForm = $('#input-form');
  const inputWord = $('#input-word');
  const statusEl = $('#status');

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function myRole() {
    const g = room && room.game;
    if (!g) return null;
    return g.setterId === playerId ? 'setter' : 'guesser';
  }

  // 지금 내가 입력할 수 있는 일: 'hint' | 'guess' | null
  function myAction() {
    const g = room && room.game;
    if (!g || room.status !== 'playing') return null;
    if (g.phase === 'hinting' && g.setterId === playerId) return 'hint';
    if (g.phase === 'guessing' && g.setterId !== playerId && !g.guessedThisRound) return 'guess';
    return null;
  }

  function render(prev) {
    if (!room || !room.status) return;
    if (!room.isMember) {
      leaveRoom();
      return;
    }
    if (room.status === 'waiting') {
      renderWaiting();
      showView('waiting');
      return;
    }
    renderPlay();
    showView('play');
    announceChanges(prev);
  }

  function renderWaiting() {
    $('#wait-code').textContent = room.code;
    $('#wait-players').innerHTML = room.players
      .map((p) => `<li class="${p.id === playerId ? 'me' : ''}">${p.id === room.hostId ? '👑' : '🙂'} ${esc(p.name)}${p.id === playerId ? ' <small>(나)</small>' : ''}</li>`)
      .join('');
    const isHost = room.hostId === playerId;
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = room.players.length < 2;
    $('#wait-note').textContent = isHost
      ? room.players.length < 2
        ? '친구가 입장하면 시작할 수 있어요. (2명 이상, 최대 8명)'
        : '준비가 되면 게임을 시작하세요! (총 3판)'
      : '방장이 게임을 시작하길 기다리고 있어요…';
  }

  function renderPlay() {
    const g = room.game;
    const finished = room.status === 'finished';
    const role = myRole();
    const action = myAction();

    $('#play-title').textContent = room.mode === 'computer' ? '🤖 컴퓨터와 대결' : `👥 방 ${room.code}`;
    $('#play-sub').textContent = finished
      ? '모든 판이 끝났어요'
      : g
        ? `${g.gameNo}번째 판 / 총 ${room.totalGames}판 · ${g.round}라운드 / ${g.maxRounds}`
        : '';
    $('#btn-end').hidden = finished || room.hostId !== playerId;
    $('#btn-new').hidden = !finished;

    // 점수판
    $('#score-board').innerHTML = room.players
      .map((p) => {
        const isSetter = g && g.setterId === p.id && !finished;
        return `<li class="${p.id === playerId ? 'me ' : ''}${isSetter ? 'setter' : ''}">
          <span class="sb-name">${p.isComputer ? '🤖' : '🙂'} ${esc(p.name)}${p.id === playerId ? ' (나)' : ''}</span>
          <span class="sb-role">${isSetter ? '출제자' : ''}</span>
          <span class="sb-score">${p.score}점</span></li>`;
      })
      .join('');

    // 안내 배너
    const banner = $('#role-banner');
    const boxChoose = $('#box-choose');
    boxChoose.hidden = true;
    inputForm.hidden = true;
    $('#box-done').hidden = true;
    const answerBox = $('#box-answer');
    answerBox.hidden = true;

    if (!g) {
      banner.innerHTML = '게임을 준비하고 있어요…';
    } else if (g.phase === 'done') {
      banner.innerHTML = '이번 판이 끝났어요!';
      answerBox.hidden = false;
      answerBox.innerHTML = `정답은 <strong>${esc(g.answer || '')}</strong>`;
      $('#box-done').hidden = finished || g.gameNo >= room.totalGames;
    } else if (role === 'setter') {
      if (g.answer) {
        answerBox.hidden = false;
        answerBox.innerHTML = `내가 고른 정답: <strong>${esc(g.answer)}</strong> <small class="muted">(다른 사람에게는 비밀이에요)</small>`;
      }
      if (g.phase === 'choosing') {
        banner.innerHTML = '당신이 출제자예요!<small>후보 3개 중 하나를 정답으로 골라 주세요.</small>';
        boxChoose.hidden = false;
        renderOptions(g.options || []);
      } else if (g.phase === 'hinting') {
        banner.innerHTML = `${g.round}라운드: 힌트를 내 주세요<small>정답과 유사도 ${room.hintMin}% 이상인 명사를 입력해야 상대가 추리할 수 있어요.</small>`;
      } else {
        banner.innerHTML = '힌트가 통과됐어요!<small>다른 플레이어가 정답을 추리하고 있어요…</small>';
      }
    } else {
      const setter = nameOf(g.setterId);
      if (g.phase === 'choosing') banner.innerHTML = `${esc(setter)}님이 정답 단어를 고르고 있어요…`;
      else if (g.phase === 'hinting') banner.innerHTML = `${esc(setter)}님이 ${g.round}라운드 힌트를 생각하고 있어요…`;
      else if (g.guessedThisRound) banner.innerHTML = '내 답을 냈어요<small>다른 플레이어를 기다리고 있어요…</small>';
      else banner.innerHTML = `${g.round}라운드: 정답을 맞혀 보세요!<small>아래 힌트와 가장 어울리는 단어를 한 번 추측할 수 있어요.</small>`;
    }

    // 입력창
    if (action) {
      inputForm.hidden = false;
      inputWord.placeholder = action === 'hint' ? `정답과 비슷한 명사 (유사도 ${room.hintMin}% 이상)` : '정답이라고 생각하는 단어';
      $('#btn-input').textContent = action === 'hint' ? '힌트 내기' : '정답 제출';
      inputWord.disabled = busy || advancing;
      $('#btn-input').disabled = busy || advancing;
    }

    renderHints();
    renderGuesses();
  }

  function renderOptions(options) {
    const box = $('#option-list');
    box.innerHTML = options.map((w) => `<button type="button" data-w="${esc(w)}">${esc(w)}</button>`).join('');
    box.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => chooseAnswer(b.dataset.w)),
    );
  }

  function renderHints() {
    const g = room.game;
    const hints = (g && g.hints) || [];
    $('#hint-empty').hidden = hints.length > 0;
    $('#hint-count').textContent = hints.length ? `(${hints.length})` : '';
    const isSetter = myRole() === 'setter';
    $('#hint-list').innerHTML = hints
      .slice()
      .reverse()
      .map((h) => {
        const color = heat(h.total);
        return `<li class="guess${h.accepted ? '' : ' rejected'}">
          <div class="g-word">${esc(h.word)}<span class="g-who">${h.round}라운드</span>${h.accepted ? '' : '<span class="g-tag">80% 미만 · 통과 못 함</span>'}</div>
          <div class="g-total" style="color:${color}">${isSetter || h.accepted ? h.total + '%' : ''}</div>
          <div class="bar"><i style="width:${h.total}%;background:${color}"></i></div>
        </li>`;
      })
      .join('');
  }

  function renderGuesses() {
    const g = room.game;
    const guesses = (g && g.guesses) || [];
    $('#wrap-guesses').hidden = guesses.length === 0;
    $('#guess-list').innerHTML = guesses
      .map(
        (x) =>
          `<li class="${x.correct ? 'hit' : ''}">${esc(x.word)}<small>${esc(x.playerName)} · ${x.round}라운드${x.correct ? ' · 정답!' : ''}</small></li>`,
      )
      .join('');
  }

  /* ───────── 변화 알림 (팝업) ───────── */
  async function announceChanges(prev) {
    const g = room.game;
    if (!g || !prev || !prev.game || prev.game.gameNo !== g.gameNo) {
      // 새 판이 시작되면 내 역할을 알려줘요
      if (g && g.phase !== 'done' && !announced['start' + g.gameNo] && room.mode === 'multi' && room.gameNo > 1) {
        announced['start' + g.gameNo] = true;
        const mine = g.setterId === playerId;
        popup({ icon: '🎲', title: `${g.gameNo}번째 판`, message: mine ? '이번 판은 내가 출제자예요!' : `이번 판 출제자는 ${nameOf(g.setterId)}님이에요.` });
      }
      return;
    }

    // 판 종료
    if (g.phase === 'done' && !announced['done' + g.gameNo]) {
      announced['done' + g.gameNo] = true;
      const mine = g.setterId === playerId;
      let icon = '🏁';
      let title = '판 종료';
      let msg = `정답은 ‘${g.answer}’였어요.`;
      if (g.outcome === 'guessed') {
        const w = g.winnerId;
        if (w === playerId) {
          icon = '🎉';
          title = '정답이에요! +1점';
        } else {
          icon = '👏';
          title = `${nameOf(w)}님이 맞혔어요`;
          msg += mine ? ' 아쉽게도 이번 판은 출제자 점수가 없어요.' : '';
        }
      } else {
        icon = mine ? '😎' : '😮';
        title = mine ? '아무도 못 맞혔어요!' : '아무도 못 맞혔어요';
        msg += mine ? ' 출제자인 내가 3점을 모두 받았어요.' : ` 출제자 ${nameOf(g.setterId)}님이 3점을 받았어요.`;
      }
      if (room.status === 'finished') msg += ' 이제 최종 결과를 확인해 볼까요?';
      await popup({ icon, title, message: msg });
      if (room.status === 'finished') await showFinal();
      return;
    }

    // 라운드 실패 (다음 라운드로)
    if (g.round > prev.game.round && g.phase !== 'done' && !announced['round' + g.gameNo + '-' + g.round]) {
      announced['round' + g.gameNo + '-' + g.round] = true;
      const mine = g.setterId === playerId;
      popup({
        icon: '🔄',
        title: `${prev.game.round}라운드에서 못 맞혔어요`,
        message: mine
          ? `출제자인 내가 1점을 받았어요. ${g.round}라운드 새 힌트를 내 주세요!`
          : `출제자 ${nameOf(g.setterId)}님이 1점을 받았어요. ${g.round}라운드 새 힌트를 기다려 주세요.`,
      });
    }

    // 게임 전체 종료(방장이 중간에 끝낸 경우 포함)
    if (room.status === 'finished' && prev.status !== 'finished' && !announced.final) {
      await showFinal();
    }
  }

  async function showFinal() {
    if (announced.final) return;
    announced.final = true;
    stopPolling();
    const sorted = room.players.slice().sort((a, b) => b.score - a.score);
    const top = sorted[0] ? sorted[0].score : 0;
    const winners = sorted.filter((p) => p.score === top);
    const board = sorted.map((p) => `${p.name} ${p.score}점`).join(' · ');
    const iWon = winners.some((p) => p.id === playerId);
    await popup({
      icon: winners.length > 1 ? '🤝' : iWon ? '🏆' : '🎖️',
      title: winners.length > 1 ? `공동 우승: ${winners.map((p) => p.name).join(', ')}` : `${winners[0].name}님 우승!`,
      message: iWon ? '축하해요! 최종 점수예요.' : '최종 점수예요.',
      hint: board,
    });
  }

  /* ───────── 행동 ───────── */
  async function chooseAnswer(word) {
    if (busy || !room) return;
    busy = true;
    setStatus('단어를 정하고 있어요…');
    try {
      await api(`/rooms/${room.code}/choose`, { method: 'POST', body: { playerId, word } });
      await refresh();
    } catch (err) {
      await popup({ icon: '⚠️', title: '앗, 문제가 생겼어요', message: err.message, hint: errHint(err) });
    } finally {
      busy = false;
      setStatus('');
      if (room) renderPlayIfActive();
    }
  }

  function renderPlayIfActive() {
    if (room && room.status && room.status !== 'waiting' && room.isMember) renderPlay();
  }

  function checkLocal(word, action) {
    if (!word) return '단어를 입력해 주세요.';
    if (/\s/.test(word)) return '띄어쓰기 없이 한 단어만 입력해 주세요.';
    if (!WORD_RE.test(word)) return '한글 단어(1~10글자)만 입력할 수 있어요. 자음·모음만 있거나 영어·숫자가 섞이면 안 돼요.';
    if (action === 'hint' && NOT_NOUN_RE.test(word)) return '명사만 입력할 수 있어요. 사물·동물·장소처럼 이름이 되는 단어를 입력해 주세요.';
    return '';
  }

  inputForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = myAction();
    if (busy || advancing || !room || !action) return;
    const word = inputWord.value.normalize('NFC').trim();

    const problem = checkLocal(word, action);
    if (problem) {
      await popup({ icon: '✏️', title: '다시 입력해 주세요', message: problem, button: '다시 입력' });
      inputWord.focus();
      return;
    }

    busy = true;
    renderPlayIfActive();
    setStatus(action === 'hint' ? 'AI가 유사도를 계산하고 있어요…' : '정답을 확인하고 있어요…');
    try {
      if (action === 'hint') {
        const r = await api(`/rooms/${room.code}/hint`, { method: 'POST', body: { playerId, word } });
        inputWord.value = '';
        await refresh();
        if (!r.accepted) {
          await popup({
            icon: '📉',
            title: `유사도 ${r.result.total}%예요`,
            message: `힌트는 정답과 유사도 ${r.minimum}% 이상이어야 해요. 더 가까운 명사를 다시 입력해 주세요.`,
            hint: r.result.explanation || '',
            button: '다시 입력',
          });
        }
      } else {
        const r = await api(`/rooms/${room.code}/guess`, { method: 'POST', body: { playerId, word } });
        inputWord.value = '';
        await refresh();
        if (r.waiting && !r.gameOver) setStatus('틀렸어요. 다른 플레이어를 기다리고 있어요…');
      }
    } catch (err) {
      if (err.code === 'INVALID_WORD') {
        const picked = await invalidWordPopup(err, word);
        inputWord.value = picked || word;
      } else if (err.code === 'DUPLICATE') {
        await popup({ icon: '🔁', title: '이미 낸 힌트예요', message: `‘${word}’은(는) 이미 사용했어요. 다른 단어를 입력해 보세요.`, button: '다시 입력' });
        inputWord.select();
      } else if (err.code === 'ANSWER_AS_HINT') {
        await popup({ icon: '🙈', title: '정답은 힌트가 될 수 없어요', message: err.message, button: '다시 입력' });
      } else if (['NOT_HINTING', 'NOT_GUESSING', 'ALREADY_GUESSED', 'NOT_SETTER', 'IS_SETTER'].includes(err.code)) {
        await refresh().catch(() => {});
      } else {
        await popup({ icon: '⚠️', title: '앗, 문제가 생겼어요', message: err.message, hint: errHint(err), button: '다시 시도' });
      }
    } finally {
      busy = false;
      setStatus('');
      renderPlayIfActive();
      if (myAction()) inputWord.focus();
    }
  });

  $('#btn-next').addEventListener('click', async () => {
    if (busy || !room || !room.game) return;
    busy = true;
    $('#btn-next').disabled = true;
    try {
      await api(`/rooms/${room.code}/next`, { method: 'POST', body: { playerId, gameNo: room.game.gameNo } });
      await refresh();
    } catch (err) {
      await popup({ icon: '⚠️', title: '앗, 문제가 생겼어요', message: err.message, hint: errHint(err) });
    } finally {
      busy = false;
      $('#btn-next').disabled = false;
      renderPlayIfActive();
    }
  });

  $('#btn-end').addEventListener('click', async () => {
    if (!room) return;
    const ok = await popup({ icon: '🏳️', title: '게임을 끝낼까요?', message: '지금까지의 점수로 결과가 정해져요.', button: '끝내기', alt: '계속하기' });
    if (ok === 'alt') return;
    try {
      await api(`/rooms/${room.code}/end`, { method: 'POST', body: { playerId } });
      await refresh();
    } catch (err) {
      await popup({ icon: '⚠️', title: '문제가 생겼어요', message: err.message });
    }
  });

  $('#btn-new').addEventListener('click', leaveRoom);

  /* ───────── 연습실 ───────── */
  const examples = [
    ['사과', '바나나'],
    ['고양이', '강아지'],
    ['학교', '선생님'],
    ['자동차', '비행기'],
    ['바다', '고래'],
    ['연필', '우유'],
    ['과일', '사과'],
    ['낮', '밤'],
  ];
  $('#p-example').addEventListener('click', () => {
    const [a, g] = examples[Math.floor(Math.random() * examples.length)];
    $('#p-answer').value = a;
    $('#p-guess').value = g;
  });

  $('#practice-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const aEl = $('#p-answer');
    const gEl = $('#p-guess');
    const answer = aEl.value.normalize('NFC').trim();
    const guess = gEl.value.normalize('NFC').trim();

    for (const [word, el, who] of [[answer, aEl, '정답 단어'], [guess, gEl, '유사 단어']]) {
      if (!WORD_RE.test(word)) {
        await popup({
          icon: '✏️',
          title: '다시 입력해 주세요',
          message: word ? `${who}는 띄어쓰기 없는 한글 1~10글자로 입력해 주세요.` : `${who}를 입력해 주세요.`,
          button: '다시 입력',
        });
        el.focus();
        return;
      }
    }

    if (NOT_NOUN_RE.test(guess)) {
      await popup({ icon: '📝', title: '명사만 입력할 수 있어요', message: `유사 단어는 명사만 입력할 수 있어요. ‘${guess}’ 대신 사물·동물·장소처럼 이름이 되는 단어를 넣어 주세요.`, button: '다시 입력' });
      gEl.focus();
      return;
    }

    const btn = $('#p-submit');
    const out = $('#p-result');
    btn.disabled = true;
    btn.textContent = '계산 중…';
    try {
      const { result } = await api('/practice', { method: 'POST', body: { answer, guess } });
      renderPractice(answer, guess, result);
    } catch (err) {
      out.hidden = true;
      if (err.code === 'INVALID_WORD') {
        const picked = await invalidWordPopup(err, '');
        const el = err.data && err.data.which === 'answer' ? aEl : gEl;
        if (picked) el.value = picked;
        el.focus();
      } else {
        await popup({ icon: '⚠️', title: '앗, 문제가 생겼어요', message: err.message, hint: errHint(err), button: '확인' });
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '유사도 확인';
    }
  });

  function renderPractice(answer, guess, r) {
    const out = $('#p-result');
    const bar = (name, v) =>
      `<div class="p-row"><span>${name}</span><div class="bar"><i style="width:${v}%;background:${heat(v)}"></i></div><em>${v}</em></div>`;
    out.innerHTML = `
      <div class="muted">‘${esc(answer)}’ ↔ ‘${esc(guess)}’</div>
      <div class="p-total" style="color:${heat(r.total)}">${r.total}%</div>
      <div class="p-label">${label(r.total)}${r.total >= 80 ? ' · 게임에서 힌트로 쓸 수 있어요' : ''}</div>
      ${bar('의미적 거리', r.semantic)}
      ${bar('문맥적 공생', r.contextual)}
      ${bar('관계적 구조', r.relational)}
      ${r.explanation ? `<div class="p-note">💡 ${esc(r.explanation)}</div>` : ''}`;
    out.hidden = false;
  }

  /* ───────── 시작 ───────── */
  (async function init() {
    const params = new URLSearchParams(location.search);
    const invite = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (invite) $('#join-code').value = invite;

    const saved = store.get('hw_room');
    if (saved && saved !== invite) {
      try {
        await enterRoom(saved);
        return;
      } catch {
        leaveRoom();
      }
    }
    showView('lobby');
    if (invite && myName()) $('#join-form').requestSubmit();
  })();
})();
