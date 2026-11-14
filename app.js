(() => {
  const LS_KEY = 'pd_saved_pass_v1';
  const LS_STATE = 'pd_progress_v1';
  const LS_THEME = 'pd_theme_v1';
  const DAILY_GOAL = 10;

  let DATA = null;
  let progress = loadProgress();

  let ui = {
    tab: 'cards',
    deckIdx: 0,
    cardIdx: 0,
    flipped: false,
    trigFilter: 'ALL',
    trigSearch: '',
    quizFilter: 'ALL',
    qIdx: 0,
    timerOn: true,
    secLeft: 120,
    timerHandle: null,
    didInitialResume: false
  };

  if (localStorage.getItem(LS_THEME) === 'light') {
    document.body.classList.add('light');
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(() => {});
    });
  }

  function localDateKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function loadProgress() {
    const defaults = {
      flaggedCards: {},
      doneCards: {},
      answers: {},
      missedQs: {},
      doneDays: {},
      dailyActivity: {},
      lastDeckIdx: 0,
      lastCardIdx: 0
    };
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          ...defaults,
          ...parsed,
          flaggedCards: parsed.flaggedCards || {},
          doneCards: parsed.doneCards || {},
          answers: parsed.answers || {},
          missedQs: parsed.missedQs || {},
          doneDays: parsed.doneDays || {},
          dailyActivity: parsed.dailyActivity || {}
        };
      }
    } catch (_) {}
    return defaults;
  }

  function saveProgress() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify(progress));
    } catch (_) {}
  }

  function recordStudyAction(amount = 1) {
    const k = localDateKey();
    progress.dailyActivity[k] = (progress.dailyActivity[k] || 0) + amount;
    saveProgress();
  }

  function computeStreakStats() {
    const act = progress.dailyActivity || {};
    const today = new Date();
    const todayKey = localDateKey(today);
    const todayReps = act[todayKey] || 0;

    let streak = 0;
    let cursor = new Date(today);
    if ((act[todayKey] || 0) > 0) {
      while ((act[localDateKey(cursor)] || 0) > 0) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
    } else {
      cursor.setDate(cursor.getDate() - 1);
      while ((act[localDateKey(cursor)] || 0) > 0) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
    }

    const dayLetters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dk = localDateKey(d);
      week.push({
        label: dayLetters[d.getDay()],
        lit: (act[dk] || 0) > 0,
        isToday: i === 0
      });
    }

    return { streak, todayReps, studiedToday: todayReps > 0, week };
  }

  function isDeckComplete(deck) {
    return deck.cards.length > 0 && deck.cards.every(c => !!progress.doneCards[c.id]);
  }

  function deckDoneCount(deck) {
    return deck.cards.filter(c => !!progress.doneCards[c.id]).length;
  }

  function findCurrentTarget() {
    if (!DATA) return { deckIdx: 0, cardIdx: 0 };
    for (let d = 0; d < DATA.decks.length; d++) {
      const cards = DATA.decks[d].cards;
      const firstUnfinished = cards.findIndex(c => !progress.doneCards[c.id]);
      if (firstUnfinished !== -1) {
        return { deckIdx: d, cardIdx: firstUnfinished };
      }
    }
    return { deckIdx: DATA.decks.length - 1, cardIdx: 0 };
  }

  function scrollActivePillIntoView() {
    requestAnimationFrame(() => {
      const activePill = document.querySelector('#deck-pill-row .pill.active');
      if (activePill) {
        activePill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  async function unlockWithPasscode(passcode) {
    const res = await fetch('./vault.json', { cache: 'no-cache' });
    const vault = await res.json();
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(passcode.trim()),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64ToBytes(vault.salt),
        iterations: vault.iter,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(vault.iv) },
      aesKey,
      b64ToBytes(vault.ct)
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  }

  function jumpToResumeTarget() {
    const target = findCurrentTarget();
    ui.deckIdx = target.deckIdx;
    ui.cardIdx = target.cardIdx;
    ui.flipped = false;
  }

  function renderLock(errMsg = '') {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="lock-wrap">
        <div class="lock-card">
          <div>
            <div style="font-size:24px;font-weight:800;">Pocket Deck</div>
            <div style="font-size:15px;color:var(--muted);margin-top:6px;">Enter your private access key to decrypt local deck data.</div>
          </div>
          <form id="unlock-form" style="display:flex;flex-direction:column;gap:14px;">
            <input id="pass-input" type="password" class="text-input" placeholder="Access key" autocomplete="current-password" required />
            <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--muted);">
              <input id="remember-chk" type="checkbox" checked style="width:18px;height:18px;" />
              Remember on this phone
            </label>
            ${errMsg ? `<div style="color:var(--danger);font-size:14px;font-weight:600;">${errMsg}</div>` : ''}
            <button id="unlock-btn" type="submit" class="primary-btn">Unlock Deck</button>
          </form>
        </div>
      </div>
    `;
    document.getElementById('unlock-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = document.getElementById('unlock-btn');
      const val = document.getElementById('pass-input').value;
      const remember = document.getElementById('remember-chk').checked;
      btn.disabled = true;
      btn.textContent = 'Decrypting...';
      try {
        DATA = await unlockWithPasscode(val);
        if (remember) localStorage.setItem(LS_KEY, val.trim());
        jumpToResumeTarget();
        ui.didInitialResume = true;
        startQuizTimerIfNeeded();
        renderApp(true);
      } catch (_) {
        renderLock('Invalid access key. Please check and try again.');
      }
    });
  }

  function getActiveCards() {
    if (ui.deckIdx === 'flagged') {
      const list = [];
      DATA.decks.forEach(d => d.cards.forEach(c => {
        if (progress.flaggedCards[c.id]) list.push({ ...c, deckTitle: d.days });
      }));
      return list;
    }
    const deck = DATA.decks[ui.deckIdx] || DATA.decks[0];
    return deck.cards;
  }

  function getActiveQuestions() {
    if (ui.quizFilter === 'ALL') return DATA.questions;
    if (ui.quizFilter === 'MISSED') {
      return DATA.questions.filter(q => progress.missedQs[q.id]);
    }
    return DATA.questions.filter(q => q.sec === ui.quizFilter);
  }

  function startQuizTimerIfNeeded() {
    clearInterval(ui.timerHandle);
    if (ui.tab !== 'quiz' || !ui.timerOn) return;
    const qs = getActiveQuestions();
    const cur = qs[ui.qIdx];
    if (!cur || progress.answers[cur.id] !== undefined) return;
    ui.timerHandle = setInterval(() => {
      if (ui.secLeft > 0) {
        ui.secLeft--;
        const el = document.getElementById('timer-badge');
        if (el) {
          const m = Math.floor(ui.secLeft / 60);
          const s = String(ui.secLeft % 60).padStart(2, '0');
          el.textContent = `⏱ ${m}:${s}`;
          el.style.color = ui.secLeft <= 20 ? 'var(--danger)' : 'var(--muted)';
        }
      }
    }, 1000);
  }

  function toggleTheme() {
    document.body.classList.toggle('light');
    localStorage.setItem(LS_THEME, document.body.classList.contains('light') ? 'light' : 'dark');
  }

  function lockNow() {
    localStorage.removeItem(LS_KEY);
    DATA = null;
    clearInterval(ui.timerHandle);
    renderLock();
  }

  function renderStreakBanner(stats) {
    const weekHtml = stats.week.map(w => `
      <div class="day-dot">
        <span>${w.label}</span>
        <div class="day-circle ${w.lit ? 'lit' : ''} ${w.isToday ? 'today-ring' : ''}">
          ${w.lit ? '✓' : ''}
        </div>
      </div>
    `).join('');

    return `
      <div class="streak-banner">
        <div class="week-dots">${weekHtml}</div>
      </div>
    `;
  }

  function renderApp(scrollPill = false) {
    if (!DATA) return renderLock();
    const root = document.getElementById('root');
    const totalCards = DATA.decks.reduce((s, d) => s + d.cards.length, 0);
    const totalDoneCards = DATA.decks.reduce((s, d) => s + deckDoneCount(d), 0);
    const stats = computeStreakStats();

    let mainHtml = '';
    if (ui.tab === 'cards') mainHtml = renderCardsTab();
    else if (ui.tab === 'triggers') mainHtml = renderTriggersTab();
    else if (ui.tab === 'quiz') mainHtml = renderQuizTab();
    else mainHtml = renderPlanTab();

    root.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div>
            <div class="brand-title">${DATA.appTitle}</div>
            <div class="brand-sub">${totalDoneCards}/${totalCards} cards mastered</div>
          </div>
          <div style="display:flex;align-items:center;gap:7px;">
            <div class="streak-chip ${stats.studiedToday ? '' : 'cold'}" title="Daily Streak">
              🔥 ${stats.streak}d
            </div>
            <button class="icon-btn" id="theme-btn" aria-label="Toggle theme">☀/☾</button>
            <button class="icon-btn" id="lock-btn" aria-label="Lock">🔒</button>
          </div>
        </header>

        ${renderStreakBanner(stats)}

        <main class="main-area">
          ${mainHtml}
        </main>

        <nav class="bottom-nav">
          <div class="bottom-nav-inner">
            <button class="nav-tab ${ui.tab === 'cards' ? 'active' : ''}" data-tab="cards">
              <span style="font-size:18px;">🗂</span>
              <span>Cards</span>
            </button>
            <button class="nav-tab ${ui.tab === 'triggers' ? 'active' : ''}" data-tab="triggers">
              <span style="font-size:18px;">⚡</span>
              <span>Rules</span>
            </button>
            <button class="nav-tab ${ui.tab === 'quiz' ? 'active' : ''}" data-tab="quiz">
              <span style="font-size:18px;">🎯</span>
              <span>Practice</span>
            </button>
            <button class="nav-tab ${ui.tab === 'plan' ? 'active' : ''}" data-tab="plan">
              <span style="font-size:18px;">📅</span>
              <span>Plan</span>
            </button>
          </div>
        </nav>
      </div>
    `;

    bindEvents();
    if (scrollPill && ui.tab === 'cards') scrollActivePillIntoView();
  }

  function renderCardsTab() {
    const flaggedTotal = Object.values(progress.flaggedCards).filter(Boolean).length;
    const resumeTarget = findCurrentTarget();
    const onResumeDeck = ui.deckIdx === resumeTarget.deckIdx;

    const pills = DATA.decks.map((d, idx) => {
      const doneCnt = deckDoneCount(d);
      const complete = doneCnt === d.cards.length;
      let cls = 'pill';
      if (ui.deckIdx === idx) cls += ' active';
      else if (complete) cls += ' done-deck';
      const prefix = complete ? '✓ ' : '';
      return `
        <button class="${cls}" data-deck="${idx}">
          ${prefix}${d.days} (${doneCnt}/${d.cards.length})
        </button>
      `;
    }).join('') + `
      <button class="pill ${ui.deckIdx === 'flagged' ? 'active' : ''}" data-deck="flagged">
        ⭐ Saved (${flaggedTotal})
      </button>
    `;

    const cards = getActiveCards();
    if (!cards.length) {
      return `
        <div class="pill-scroll" id="deck-pill-row">${pills}</div>
        <div class="flashcard" style="justify-content:center;align-items:center;text-align:center;">
          <div style="font-size:18px;font-weight:700;">No saved cards yet</div>
          <div style="color:var(--muted);font-size:15px;">Tap ☆ Save on any tough card to keep it in your review pile.</div>
        </div>
      `;
    }

    if (ui.cardIdx >= cards.length) ui.cardIdx = 0;
    const c = cards[ui.cardIdx];
    const isFlagged = !!progress.flaggedCards[c.id];
    const isCardDone = !!progress.doneCards[c.id];
    const curDeck = ui.deckIdx === 'flagged' ? null : DATA.decks[ui.deckIdx];
    const deckAllDone = curDeck ? isDeckComplete(curDeck) : false;

    const dotsHtml = cards.map((item, idx) => {
      let dCls = 'cdot';
      if (progress.doneCards[item.id]) dCls += ' done';
      if (idx === ui.cardIdx) dCls += ' current';
      return `<div class="${dCls}" data-dot="${idx}"></div>`;
    }).join('');

    const deckHeaderLeft = curDeck
      ? `${curDeck.days}: ${curDeck.title}`
      : 'Saved Review Pile';

    const jumpBtnHtml = !onResumeDeck
      ? `<button class="icon-btn" id="jump-current-btn" style="padding:5px 10px;font-size:12px;border-color:var(--primary);color:var(--primary);">▶ Jump to Current (${DATA.decks[resumeTarget.deckIdx].days})</button>`
      : (curDeck && !deckAllDone
          ? `<button class="icon-btn" id="mark-deck-btn" style="padding:5px 10px;font-size:12px;">✓ Mark All ${cards.length} Done</button>`
          : (curDeck && deckAllDone
              ? `<span style="font-size:12.5px;font-weight:700;color:var(--success);">✓ Deck Completed</span>`
              : ''));

    const nextDeckExists = curDeck && ui.deckIdx < DATA.decks.length - 1;
    const bannerHtml = deckAllDone && nextDeckExists ? `
      <div class="complete-banner">
        <div style="font-size:14px;font-weight:700;color:var(--success);">🎉 ${curDeck.days} Complete!</div>
        <button class="icon-btn" id="next-deck-btn" style="background:var(--success);border-color:var(--success);color:#fff;font-size:13px;padding:7px 12px;">
          Next: ${DATA.decks[ui.deckIdx + 1].days} →
        </button>
      </div>
    ` : '';

    const centerBtnHtml = ui.flipped
      ? `<button class="success-btn" id="card-got-it" style="padding:15px 10px;">${isCardDone ? '✓ Done • Next →' : '✓ Got It • Next'}</button>`
      : `<button class="primary-btn" id="card-flip" style="padding:15px 10px;">Reveal Answer</button>`;

    return `
      <div class="pill-scroll" id="deck-pill-row">${pills}</div>

      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:13px;font-weight:700;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${deckHeaderLeft}
        </span>
        ${jumpBtnHtml}
      </div>

      <div class="card-dots">${dotsHtml}</div>

      ${bannerHtml}

      <div class="flashcard ${isCardDone ? 'card-done' : ''}" id="flashcard-box">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span class="badge">${isCardDone ? '✓ ' : ''}${c.tag}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:13px;font-weight:700;color:var(--muted);">${ui.cardIdx + 1}/${cards.length}</span>
            <button class="icon-btn" id="flag-card-btn" style="padding:5px 10px;font-size:13.5px;">
              ${isFlagged ? '⭐ Saved' : '☆ Save'}
            </button>
          </div>
        </div>

        <div class="card-body">${ui.flipped ? c.a : c.q}</div>

        <div style="display:flex;flex-direction:column;gap:11px;">
          ${ui.flipped ? `<div class="card-tip"><strong>⚡ Key Rule:</strong> ${c.tip}</div>` : ''}
          <div style="text-align:center;font-size:13.5px;font-weight:600;color:var(--primary);">
            ${ui.flipped ? '👆 Tap card for prompt • Or tap Got It below' : '👆 Tap anywhere on card to flip'}
          </div>
        </div>
      </div>

      <div class="thumb-controls">
        <button class="sec-btn" id="card-prev" ${ui.cardIdx === 0 ? 'disabled' : ''}>← Prev</button>
        ${centerBtnHtml}
        <button class="sec-btn" id="card-next" ${ui.cardIdx === cards.length - 1 ? 'disabled' : ''}>Skip →</button>
      </div>
    `;
  }

  function renderTriggersTab() {
    const secs = ['ALL', 'Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];
    const secPills = secs.map(s => `
      <button class="pill ${ui.trigFilter === s ? 'active' : ''}" data-trigsec="${s}">
        ${s === 'ALL' ? `All (${DATA.triggers.length})` : s}
      </button>
    `).join('');

    const q = ui.trigSearch.toLowerCase().trim();
    const list = DATA.triggers.filter(t => {
      if (ui.trigFilter !== 'ALL' && t.sec !== ui.trigFilter) return false;
      if (!q) return true;
      return (t.cue + ' ' + t.pick + ' ' + t.avoid).toLowerCase().includes(q);
    });

    const items = list.map(t => `
      <div class="trigger-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="badge">${t.sec}</span>
        </div>
        <div style="font-size:16.5px;font-weight:700;line-height:1.42;">“${t.cue}”</div>
        <div class="box-win">
          <div style="font-size:12px;font-weight:800;color:var(--success);margin-bottom:4px;">✅ PICK</div>
          <div style="font-size:15.5px;line-height:1.4;font-weight:600;">${t.pick}</div>
        </div>
        <div class="box-avoid">
          <div style="font-size:12px;font-weight:800;color:var(--danger);margin-bottom:4px;">❌ AVOID</div>
          <div style="font-size:14.5px;line-height:1.4;color:var(--muted);">${t.avoid}</div>
        </div>
      </div>
    `).join('');

    return `
      <input id="trig-search" class="text-input" placeholder="Filter rules..." value="${ui.trigSearch.replace(/"/g, '&quot;')}" style="padding:13px 15px;font-size:16px;" />
      <div class="pill-scroll">${secPills}</div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${items || '<div style="text-align:center;color:var(--muted);padding:32px 0;">No matching rules.</div>'}
      </div>
    `;
  }

  function renderQuizTab() {
    const missedCount = Object.values(progress.missedQs).filter(Boolean).length;
    const filters = [
      { id: 'ALL', label: `All (${DATA.questions.length})` },
      { id: 'MISSED', label: `🔁 Missed (${missedCount})` },
      { id: 'Sec 1', label: 'Sec 1' },
      { id: 'Sec 2', label: 'Sec 2' },
      { id: 'Sec 3', label: 'Sec 3' },
      { id: 'Sec 4', label: 'Sec 4' },
      { id: 'Sec 5', label: 'Sec 5' },
      { id: 'Sec 6', label: 'Sec 6' }
    ];

    const filterHtml = filters.map(f => `
      <button class="pill ${ui.quizFilter === f.id ? 'active' : ''}" data-qfilter="${f.id}">${f.label}</button>
    `).join('');

    const qs = getActiveQuestions();
    if (!qs.length) {
      return `
        <div class="pill-scroll">${filterHtml}</div>
        <div class="quiz-card" style="text-align:center;padding:36px 20px;">
          <div style="font-size:18px;font-weight:700;">Zero missed items right now! 🎉</div>
          <div style="font-size:15px;color:var(--muted);">Any question you miss lands here automatically until you master it.</div>
        </div>
      `;
    }

    if (ui.qIdx >= qs.length) ui.qIdx = 0;
    const q = qs[ui.qIdx];
    const chosen = progress.answers[q.id];

    const answeredList = qs.filter(item => progress.answers[item.id] !== undefined);
    const rightCount = answeredList.filter(item => progress.answers[item.id] === item.ans).length;
    const m = Math.floor(ui.secLeft / 60);
    const s = String(ui.secLeft % 60).padStart(2, '0');

    const optsHtml = q.opts.map((opt, idx) => {
      let cls = 'opt-btn';
      let prefix = '';
      if (chosen !== undefined) {
        if (idx === q.ans) { cls += ' correct'; prefix = '✅ '; }
        else if (idx === chosen) { cls += ' wrong'; prefix = '❌ '; }
      }
      return `<button class="${cls}" data-opt="${idx}">${prefix}${opt}</button>`;
    }).join('');

    return `
      <div class="pill-scroll">${filterHtml}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:13.5px;color:var(--muted);">
        <span><strong>${ui.qIdx + 1}/${qs.length}</strong> • ${q.sec} • Score: ${rightCount}/${answeredList.length}</span>
        <button class="icon-btn" id="toggle-timer" style="padding:5px 10px;font-size:13px;">
          <span id="timer-badge">${ui.timerOn ? `⏱ ${m}:${s}` : '⏱ Off'}</span>
        </button>
      </div>

      <div class="quiz-card">
        <div class="quiz-q">${q.q}</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${optsHtml}
        </div>
        ${chosen !== undefined ? `
          <div class="card-tip">
            <strong>Why:</strong> ${q.exp}
            <div style="margin-top:10px;">
              <button class="icon-btn" id="retry-q" style="font-size:13px;padding:6px 10px;">Reset Question</button>
            </div>
          </div>
        ` : ''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:auto;">
        <button class="sec-btn" id="q-prev" ${ui.qIdx === 0 ? 'disabled' : ''}>← Prev</button>
        <button class="primary-btn" id="q-next" ${ui.qIdx === qs.length - 1 ? 'disabled' : ''} style="padding:15px;">Next →</button>
      </div>
    `;
  }

  function renderPlanTab() {
    const doneCount = Object.keys(progress.doneDays).filter(k => progress.doneDays[k]).length;
    const pct = Math.round((doneCount / DATA.plan.length) * 100);

    const rows = DATA.plan.map(p => {
      const done = !!progress.doneDays[p.day];
      const dIdx = DATA.decks.findIndex(d => d.id === p.deckId);
      const linkedDeck = dIdx >= 0 ? DATA.decks[dIdx] : null;
      const deckBadge = linkedDeck && isDeckComplete(linkedDeck) ? ' • ✓ Cards Done' : '';
      return `
        <div class="plan-item ${done ? 'done' : ''}">
          <div class="plan-check" data-day="${p.day}">${done ? '✓' : ''}</div>
          <div style="flex:1;cursor:pointer;" data-day="${p.day}">
            <div style="font-size:12.5px;font-weight:700;color:var(--muted);">Day ${p.day} • ${p.date} • ${p.phase}${deckBadge}</div>
            <div class="plan-topic" style="font-size:15.5px;font-weight:600;margin-top:3px;line-height:1.38;">${p.topic}</div>
          </div>
          ${dIdx >= 0 ? `<button class="icon-btn" data-open-deck="${dIdx}" style="padding:7px 10px;font-size:12.5px;align-self:center;">Deck →</button>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="trigger-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:16px;font-weight:700;">Checklist Progress</span>
          <span style="font-size:16px;font-weight:800;color:var(--primary);">${pct}% (${doneCount}/${DATA.plan.length})</span>
        </div>
        <div style="width:100%;height:10px;border-radius:99px;background:var(--surface-2);overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:var(--primary);transition:width .2s;"></div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${rows}
      </div>
    `;
  }

  function completeCurrentCardAndAdvance() {
    const cards = getActiveCards();
    const cur = cards[ui.cardIdx];
    if (!cur) return;
    if (!progress.doneCards[cur.id]) {
      progress.doneCards[cur.id] = true;
      recordStudyAction(1);
    } else {
      saveProgress();
    }

    if (ui.cardIdx < cards.length - 1) {
      ui.cardIdx++;
      ui.flipped = false;
      renderApp(false);
    } else {
      ui.flipped = false;
      renderApp(true);
    }
  }

  function bindEvents() {
    document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
    document.getElementById('lock-btn')?.addEventListener('click', lockNow);

    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.tab = btn.dataset.tab;
        ui.secLeft = 120;
        startQuizTimerIfNeeded();
        renderApp(ui.tab === 'cards');
      });
    });

    if (ui.tab === 'cards') {
      document.querySelectorAll('[data-deck]').forEach(btn => {
        btn.addEventListener('click', () => {
          ui.deckIdx = btn.dataset.deck === 'flagged' ? 'flagged' : Number(btn.dataset.deck);
          if (typeof ui.deckIdx === 'number') {
            const firstOpen = DATA.decks[ui.deckIdx].cards.findIndex(c => !progress.doneCards[c.id]);
            ui.cardIdx = firstOpen !== -1 ? firstOpen : 0;
          } else {
            ui.cardIdx = 0;
          }
          ui.flipped = false;
          renderApp(true);
        });
      });

      document.querySelectorAll('[data-dot]').forEach(dot => {
        dot.addEventListener('click', () => {
          ui.cardIdx = Number(dot.dataset.dot);
          ui.flipped = false;
          renderApp(false);
        });
      });

      document.getElementById('jump-current-btn')?.addEventListener('click', () => {
        jumpToResumeTarget();
        renderApp(true);
      });

      document.getElementById('mark-deck-btn')?.addEventListener('click', () => {
        const cards = getActiveCards();
        let newlyDone = 0;
        cards.forEach(c => {
          if (!progress.doneCards[c.id]) {
            progress.doneCards[c.id] = true;
            newlyDone++;
          }
        });
        if (newlyDone > 0) recordStudyAction(newlyDone);
        else saveProgress();
        renderApp(true);
      });

      document.getElementById('next-deck-btn')?.addEventListener('click', () => {
        if (typeof ui.deckIdx === 'number' && ui.deckIdx < DATA.decks.length - 1) {
          ui.deckIdx++;
          const firstOpen = DATA.decks[ui.deckIdx].cards.findIndex(c => !progress.doneCards[c.id]);
          ui.cardIdx = firstOpen !== -1 ? firstOpen : 0;
          ui.flipped = false;
          renderApp(true);
        }
      });

      document.getElementById('flag-card-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const cards = getActiveCards();
        const cur = cards[ui.cardIdx];
        if (!cur) return;
        progress.flaggedCards[cur.id] = !progress.flaggedCards[cur.id];
        saveProgress();
        renderApp(false);
      });

      document.getElementById('flashcard-box')?.addEventListener('click', () => {
        ui.flipped = !ui.flipped;
        renderApp(false);
      });

      document.getElementById('card-flip')?.addEventListener('click', () => {
        ui.flipped = true;
        renderApp(false);
      });

      document.getElementById('card-got-it')?.addEventListener('click', completeCurrentCardAndAdvance);

      document.getElementById('card-prev')?.addEventListener('click', () => {
        if (ui.cardIdx > 0) { ui.cardIdx--; ui.flipped = false; renderApp(false); }
      });

      document.getElementById('card-next')?.addEventListener('click', () => {
        const cards = getActiveCards();
        if (ui.cardIdx < cards.length - 1) { ui.cardIdx++; ui.flipped = false; renderApp(false); }
      });
    }

    if (ui.tab === 'triggers') {
      document.querySelectorAll('[data-trigsec]').forEach(btn => {
        btn.addEventListener('click', () => {
          ui.trigFilter = btn.dataset.trigsec;
          renderApp();
        });
      });
      const input = document.getElementById('trig-search');
      if (input) {
        input.addEventListener('input', e => {
          const pos = e.target.selectionStart;
          ui.trigSearch = e.target.value;
          renderApp();
          const nextInput = document.getElementById('trig-search');
          if (nextInput) {
            nextInput.focus();
            nextInput.setSelectionRange(pos, pos);
          }
        });
      }
    }

    if (ui.tab === 'quiz') {
      document.querySelectorAll('[data-qfilter]').forEach(btn => {
        btn.addEventListener('click', () => {
          ui.quizFilter = btn.dataset.qfilter;
          ui.qIdx = 0;
          ui.secLeft = 120;
          startQuizTimerIfNeeded();
          renderApp();
        });
      });

      document.getElementById('toggle-timer')?.addEventListener('click', () => {
        ui.timerOn = !ui.timerOn;
        ui.secLeft = 120;
        startQuizTimerIfNeeded();
        renderApp();
      });

      document.querySelectorAll('[data-opt]').forEach(btn => {
        btn.addEventListener('click', () => {
          const qs = getActiveQuestions();
          const cur = qs[ui.qIdx];
          if (!cur || progress.answers[cur.id] !== undefined) return;
          const picked = Number(btn.dataset.opt);
          progress.answers[cur.id] = picked;
          if (picked !== cur.ans) progress.missedQs[cur.id] = true;
          else delete progress.missedQs[cur.id];
          recordStudyAction(1);
          clearInterval(ui.timerHandle);
          renderApp();
        });
      });

      document.getElementById('retry-q')?.addEventListener('click', () => {
        const qs = getActiveQuestions();
        const cur = qs[ui.qIdx];
        if (!cur) return;
        delete progress.answers[cur.id];
        saveProgress();
        ui.secLeft = 120;
        startQuizTimerIfNeeded();
        renderApp();
      });

      document.getElementById('q-prev')?.addEventListener('click', () => {
        if (ui.qIdx > 0) {
          ui.qIdx--;
          ui.secLeft = 120;
          startQuizTimerIfNeeded();
          renderApp();
        }
      });

      document.getElementById('q-next')?.addEventListener('click', () => {
        const qs = getActiveQuestions();
        if (ui.qIdx < qs.length - 1) {
          ui.qIdx++;
          ui.secLeft = 120;
          startQuizTimerIfNeeded();
          renderApp();
        }
      });
    }

    if (ui.tab === 'plan') {
      document.querySelectorAll('[data-day]').forEach(el => {
        el.addEventListener('click', () => {
          const d = el.dataset.day;
          progress.doneDays[d] = !progress.doneDays[d];
          if (progress.doneDays[d]) recordStudyAction(1);
          else saveProgress();
          renderApp();
        });
      });

      document.querySelectorAll('[data-open-deck]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          ui.deckIdx = Number(btn.dataset.openDeck);
          const firstOpen = DATA.decks[ui.deckIdx].cards.findIndex(c => !progress.doneCards[c.id]);
          ui.cardIdx = firstOpen !== -1 ? firstOpen : 0;
          ui.flipped = false;
          ui.tab = 'cards';
          renderApp(true);
        });
      });
    }
  }

  // Horizontal swipe navigation
  let sx = 0, sy = 0;
  document.addEventListener('touchstart', e => {
    sx = e.changedTouches[0].screenX;
    sy = e.changedTouches[0].screenY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!DATA) return;
    if (e.target.closest('.pill-scroll') || e.target.tagName === 'INPUT') return;
    const dx = e.changedTouches[0].screenX - sx;
    const dy = e.changedTouches[0].screenY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (ui.tab === 'cards') {
        const cards = getActiveCards();
        if (dx < 0 && ui.cardIdx < cards.length - 1) { ui.cardIdx++; ui.flipped = false; renderApp(false); }
        else if (dx > 0 && ui.cardIdx > 0) { ui.cardIdx--; ui.flipped = false; renderApp(false); }
      } else if (ui.tab === 'quiz') {
        const qs = getActiveQuestions();
        if (dx < 0 && ui.qIdx < qs.length - 1) { ui.qIdx++; ui.secLeft = 120; startQuizTimerIfNeeded(); renderApp(); }
        else if (dx > 0 && ui.qIdx > 0) { ui.qIdx--; ui.secLeft = 120; startQuizTimerIfNeeded(); renderApp(); }
      }
    }
  }, { passive: true });

  // Auto-unlock if saved on phone
  (async () => {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      try {
        DATA = await unlockWithPasscode(saved);
        jumpToResumeTarget();
        ui.didInitialResume = true;
        startQuizTimerIfNeeded();
        renderApp(true);
        return;
      } catch (_) {
        localStorage.removeItem(LS_KEY);
      }
    }
    renderLock();
  })();
})();
