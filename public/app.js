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

  /* ───────── 게임 상태 ───────── */
  let room = null;
  let pollTimer = null;
  let busy = false;
  let sortMode = 'sim';
  let resultShownFor = null;
  let lastSeenGuessId = 0;
  let thinking = false;

  const nameInput = $('#name');
  nameInput.value = store.get('hw_name', '');
  const myName = () => {
    const n = nameInput.value.trim().slice(0, 8);
    store.set('hw_name', n);
    return n;
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
    if (!room) return;
    const state = await api(`/rooms/${room.code}?playerId=${encodeURIComponent(playerId)}`);
    room = state;
    render();
    return state;
  }

  async function enterRoom(code) {
    store.set('hw_room', code);
    resultShownFor = null;
    lastSeenGuessId = 0;
    room = { code, mode: 'multi' };
    const state = await refresh();
    startPolling();
    // 새로고침 등으로 컴퓨터 차례가 밀려 있다면 이어서 진행
    if (state && state.mode === 'computer' && state.status === 'playing') await maybeComputerTurn();
  }

  function leaveRoom() {
    stopPolling();
    room = null;
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
      await popup({ icon: '⚠️', title: '방을 만들 수 없어요', message: err.message });
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

  /* ───────── 게임 진행 ───────── */
  const guessInput = $('#guess');
  const statusEl = $('#status');

  function setBusy(on, text = '') {
    busy = on;
    $('#btn-guess').disabled = on;
    guessInput.disabled = on || (room && room.status === 'finished');
    statusEl.textContent = text;
  }

  function checkLocal(word) {
    if (!word) return '단어를 입력해 주세요.';
    if (/\s/.test(word)) return '띄어쓰기 없이 한 단어만 입력해 주세요.';
    if (!WORD_RE.test(word)) return '한글 단어(1~10글자)만 입력할 수 있어요. 자음·모음만 있거나 영어·숫자가 섞이면 안 돼요.';
    return '';
  }

  $('#guess-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !room || room.status !== 'playing') return;
    const word = guessInput.value.normalize('NFC').trim();

    const problem = checkLocal(word);
    if (problem) {
      await popup({ icon: '✏️', title: '다시 입력해 주세요', message: problem, button: '다시 입력' });
      guessInput.focus();
      return;
    }

    setBusy(true, 'AI가 유사도를 계산하고 있어요…');
    let finished = false;
    try {
      const r = await api(`/rooms/${room.code}/guess`, { method: 'POST', body: { playerId, word } });
      guessInput.value = '';
      finished = r.finished;
      await refresh();
    } catch (err) {
      setBusy(false);
      if (err.code === 'INVALID_WORD') {
        const picked = await invalidWordPopup(err, word);
        guessInput.value = picked || word;
      } else if (err.code === 'DUPLICATE') {
        await popup({ icon: '🔁', title: '이미 입력한 단어예요', message: `‘${word}’은(는) 이미 시도했어요. 다른 단어를 입력해 보세요.`, button: '다시 입력' });
        guessInput.select();
      } else if (err.code === 'NOT_PLAYING') {
        await refresh().catch(() => {});
      } else {
        await popup({ icon: '⚠️', title: '앗, 문제가 생겼어요', message: err.message, button: '다시 시도' });
      }
      guessInput.focus();
      return;
    }
    setBusy(false);

    if (!finished && room && room.mode === 'computer') await maybeComputerTurn();
    if (room && room.status === 'playing') guessInput.focus();
  });

  // 컴퓨터 차례: 사람 추측 수보다 컴퓨터 추측 수가 적을 때만 진행
  async function maybeComputerTurn() {
    if (!room || room.mode !== 'computer' || room.status !== 'playing') return;
    const human = room.players.find((p) => !p.isComputer);
    const comp = room.players.find((p) => p.isComputer);
    if (!human || !comp || comp.guessCount >= human.guessCount) return;

    thinking = true;
    setBusy(true, '🤖 컴퓨터가 생각하고 있어요…');
    try {
      await api(`/rooms/${room.code}/computer`, { method: 'POST', body: { playerId } });
      await refresh();
    } catch (err) {
      await popup({ icon: '🤖', title: '컴퓨터가 잠시 멈췄어요', message: err.message, button: '확인' });
    } finally {
      thinking = false;
      setBusy(false);
      if (room && room.status === 'playing') guessInput.focus();
    }
  }

  $('#btn-giveup').addEventListener('click', async () => {
    if (!room) return;
    const isHost = room.hostId === playerId;
    if (!isHost) {
      await popup({ icon: '🙋', title: '방장만 포기할 수 있어요', message: '방장이 포기하면 모두에게 정답이 공개돼요.' });
      return;
    }
    try {
      await api(`/rooms/${room.code}/giveup`, { method: 'POST', body: { playerId } });
      await refresh();
    } catch (err) {
      await popup({ icon: '⚠️', title: '문제가 생겼어요', message: err.message });
    }
  });

  $('#btn-new').addEventListener('click', leaveRoom);

  document.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      sortMode = b.dataset.sort;
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      renderGuesses();
    }),
  );

  /* ───────── 그리기 ───────── */
  function render() {
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
    if (room.status === 'finished' && resultShownFor !== room.code) {
      resultShownFor = room.code;
      stopPolling();
      showResult();
    }
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
        : '준비가 되면 게임을 시작하세요!'
      : '방장이 게임을 시작하길 기다리고 있어요…';
  }

  function renderPlay() {
    const finished = room.status === 'finished';
    $('#play-title').textContent = room.mode === 'computer' ? '🤖 컴퓨터와 대결' : `👥 방 ${room.code}`;
    $('#play-sub').textContent = finished ? '게임이 끝났어요' : '비슷한 단어를 입력해 숨겨진 정답에 다가가세요';
    $('#btn-giveup').hidden = finished || (room.mode === 'multi' && room.hostId !== playerId);
    $('#btn-new').hidden = !finished;
    $('#play-players').innerHTML = room.players
      .map((p) => {
        const best = p.best == null ? '-' : `${p.best}%`;
        return `<li class="${p.id === playerId ? 'me' : ''}">${p.isComputer ? '🤖' : p.id === room.hostId ? '👑' : '🙂'} ${esc(p.name)} <small>${p.guessCount}번 · 최고 ${best}</small></li>`;
      })
      .join('');
    if (!thinking && !busy) {
      guessInput.disabled = finished;
      $('#btn-guess').disabled = finished;
    }
    renderGuesses();
  }

  function renderGuesses() {
    const list = $('#guess-list');
    const guesses = (room && room.guesses) || [];
    $('#guess-empty').hidden = guesses.length > 0;
    $('#guess-count').textContent = guesses.length ? `(${guesses.length})` : '';
    const rows = guesses.slice().sort((a, b) => (sortMode === 'sim' ? b.total - a.total || b.id - a.id : b.id - a.id));
    const newest = Math.max(0, ...guesses.map((g) => g.id));
    list.innerHTML = rows
      .map((g) => {
        const color = heat(g.total);
        const fresh = g.id === newest && newest > lastSeenGuessId ? ' latest' : '';
        return `<li class="guess${g.playerId === playerId ? ' mine' : ''}${fresh}">
          <div class="g-word">${esc(g.word)}<span class="g-who">${esc(g.playerName)}</span></div>
          <div class="g-total" style="color:${color}">${g.total}%</div>
          <div class="bar"><i style="width:${g.total}%;background:${color}"></i></div>
          <div class="g-mini"><span>의미 <b>${g.semantic}</b></span><span>문맥 <b>${g.contextual}</b></span><span>관계 <b>${g.relational}</b></span></div>
        </li>`;
      })
      .join('');
    lastSeenGuessId = newest;
  }

  async function showResult() {
    const w = room.winner;
    let icon = '🏳️';
    let title = '게임 종료';
    let msg = `정답은 ‘${room.answer}’였어요.`;
    if (w) {
      if (w.id === playerId) {
        icon = '🎉';
        title = '정답이에요!';
        msg = `‘${room.answer}’을(를) 가장 먼저 맞혔어요. 축하해요!`;
      } else if (w.isComputer) {
        icon = '🤖';
        title = '컴퓨터가 먼저 맞혔어요';
        msg = `정답은 ‘${room.answer}’였어요. 다음엔 꼭 이겨 봐요!`;
      } else {
        icon = '👏';
        title = `${w.name}님이 맞혔어요`;
        msg = `정답은 ‘${room.answer}’였어요.`;
      }
    }
    await popup({ icon, title, message: msg, button: '확인' });
  }

  /* ───────── 연습실 ───────── */
  const examples = [
    ['사과', '바나나'],
    ['고양이', '강아지'],
    ['학교', '선생님'],
    ['자동차', '비행기'],
    ['바다', '고래'],
    ['연필', '우유'],
    ['겨울', '눈사람'],
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
        await popup({ icon: '⚠️', title: '앗, 문제가 생겼어요', message: err.message, button: '확인' });
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
      <div class="p-label">${label(r.total)}</div>
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
