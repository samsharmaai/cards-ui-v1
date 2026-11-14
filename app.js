(() => {
  const LS_KEY = 'pd_saved_pass_v1';
  const LS_STATE = 'pd_progress_v1';
  const LS_THEME = 'pd_theme_v1';

  let DATA = null;
  let progress = loadProgress();

  let ui = {
    tab: 'cards', // 'cards' | 'triggers' | 'quiz' | 'plan'
    deckIdx: 0,   // 0..decks.length-1 or 'flagged'
    cardIdx: 0,
    flipped: false,
    trigFilter: 'ALL',
    trigSearch: '',
    quizFilter: 'ALL', // 'ALL' | 'MISSED' | 'Sec 1'..
    qIdx: 0,
    timerOn: true,
    secLeft: 120,
    timerHandle: null
  };

  if (localStorage.getItem(LS_THEME) === 'light') {
    document.body.classList.add('light');
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { flaggedCards: {}, answers: {}, missedQs: {}, doneDays: {} };
  }

  function saveProgress() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify(progress));
    } catch (_) {}
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
        startQuizTimerIfNeeded();
        renderApp();
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

  function renderApp() {
    if (!DATA) return renderLock();
    const root = document.getElementById('root');
    const doneCount = Object.keys(progress.doneDays).filter(k => progress.doneDays[k]).length;

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
            <div class="brand-sub">${doneCount}/${DATA.plan.length} done • Tap or swipe</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="icon-btn" id="theme-btn" aria-label="Toggle theme">☀/☾</button>
            <button class="icon-btn" id="lock-btn" aria-label="Lock">🔒</button>
          </div>
        </header>

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
  }

  function renderCardsTab() {
    const flaggedTotal = Object.values(progress.flaggedCards).filter(Boolean).length;
    const pills = DATA.decks.map((d, idx) => `
      <button class="pill ${ui.deckIdx === idx ? 'active' : ''}" data-deck="${idx}">
        ${d.days}: ${d.title}
      </button>
    `).join('') + `
      <button class="pill ${ui.deckIdx === 'flagged' ? 'active' : ''}" data-deck="flagged">
        ⭐ Review (${flaggedTotal})
      </button>
    `;

    const cards = getActiveCards();
    if (!cards.length) {
      return `
        <div class="pill-scroll">${pills}</div>
        <div class="flashcard" style="justify-content:center;align-items:center;text-align:center;">
          <div style="font-size:18px;font-weight:700;">No flagged cards yet</div>
          <div style="color:var(--muted);font-size:15px;">Tap ⭐ on any tough card to add it to your quick review pile.</div>
        </div>
      `;
    }

    if (ui.cardIdx >= cards.length) ui.cardIdx = 0;
    const c = cards[ui.cardIdx];
    const isFlagged = !!progress.flaggedCards[c.id];
    const deckMeta = ui.deckIdx === 'flagged'
      ? 'Flagged Review Pile'
      : `${DATA.decks[ui.deckIdx].phase} • ${DATA.decks[ui.deckIdx].domain}`;

    return `
      <div class="pill-scroll">${pills}</div>
      <div style="font-size:13px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;">
        <span>${deckMeta}</span>
        <span style="font-weight:700;">${ui.cardIdx + 1} / ${cards.length}</span>
      </div>

      <div class="flashcard" id="flashcard-box">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
          <span class="badge">${c.tag}</span>
          <button class="icon-btn" id="flag-card-btn" style="padding:6px 11px;font-size:15px;">
            ${isFlagged ? '⭐ Saved' : '☆ Save'}
          </button>
        </div>

        <div class="card-body">${ui.flipped ? c.a : c.q}</div>

        <div style="display:flex;flex-direction:column;gap:12px;">
          ${ui.flipped ? `<div class="card-tip"><strong>⚡ Key Rule:</strong> ${c.tip}</div>` : ''}
          <div style="text-align:center;font-size:14px;font-weight:600;color:var(--primary);">
            ${ui.flipped ? '👆 Tap card to see prompt' : '👆 Tap anywhere on card to reveal answer'}
          </div>
        </div>
      </div>

      <div class="thumb-controls">
        <button class="sec-btn" id="card-prev" ${ui.cardIdx === 0 ? 'disabled' : ''}>← Prev</button>
        <button class="primary-btn" id="card-flip" style="padding:15px 12px;">${ui.flipped ? 'Prompt' : 'Flip Card'}</button>
        <button class="sec-btn" id="card-next" ${ui.cardIdx === cards.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>
    `;
  }

  function renderTriggersTab() {
    const secs = ['ALL', 'Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];
    const secPills = secs.map(s => `
      <button class="pill ${ui.trigFilter === s ? 'active' : ''}" data-trigsec="${s}">
        ${s === 'ALL' ? 'All (${DATA.triggers.length})' : s}
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
        ${items || '<div style="text-align:center;color:var(--muted);padding:32px 0;">No matching triggers.</div>'}
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
          <div style="font-size:18px;font-weight:700;">Zero missed questions right now! 🎉</div>
          <div style="font-size:15px;color:var(--muted);">Any scenario you miss automatically lands here until you get it right.</div>
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
              <button class="icon-btn" id="retry-q" style="font-size:13px;padding:6px 10px;">Reset This Question</button>
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
      return `
        <div class="plan-item ${done ? 'done' : ''}" data-day="${p.day}">
          <div class="plan-check">${done ? '✓' : ''}</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:700;color:var(--muted);">Day ${p.day} • ${p.date} • ${p.phase}</div>
            <div class="plan-topic" style="font-size:16px;font-weight:600;margin-top:3px;line-height:1.4;">${p.topic}</div>
          </div>
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

  function bindEvents() {
    document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
    document.getElementById('lock-btn')?.addEventListener('click', lockNow);

    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.tab = btn.dataset.tab;
        ui.secLeft = 120;
        startQuizTimerIfNeeded();
        renderApp();
      });
    });

    if (ui.tab === 'cards') {
      document.querySelectorAll('[data-deck]').forEach(btn => {
        btn.addEventListener('click', () => {
          ui.deckIdx = btn.dataset.deck === 'flagged' ? 'flagged' : Number(btn.dataset.deck);
          ui.cardIdx = 0;
          ui.flipped = false;
          renderApp();
        });
      });

      document.getElementById('flag-card-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const cards = getActiveCards();
        const cur = cards[ui.cardIdx];
        if (!cur) return;
        progress.flaggedCards[cur.id] = !progress.flaggedCards[cur.id];
        saveProgress();
        renderApp();
      });

      document.getElementById('flashcard-box')?.addEventListener('click', () => {
        ui.flipped = !ui.flipped;
        renderApp();
      });

      document.getElementById('card-flip')?.addEventListener('click', () => {
        ui.flipped = !ui.flipped;
        renderApp();
      });

      document.getElementById('card-prev')?.addEventListener('click', () => {
        if (ui.cardIdx > 0) { ui.cardIdx--; ui.flipped = false; renderApp(); }
      });

      document.getElementById('card-next')?.addEventListener('click', () => {
        const cards = getActiveCards();
        if (ui.cardIdx < cards.length - 1) { ui.cardIdx++; ui.flipped = false; renderApp(); }
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
          saveProgress();
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
      document.querySelectorAll('[data-day]').forEach(row => {
        row.addEventListener('click', () => {
          const d = row.dataset.day;
          progress.doneDays[d] = !progress.doneDays[d];
          saveProgress();
          renderApp();
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
        if (dx < 0 && ui.cardIdx < cards.length - 1) { ui.cardIdx++; ui.flipped = false; renderApp(); }
        else if (dx > 0 && ui.cardIdx > 0) { ui.cardIdx--; ui.flipped = false; renderApp(); }
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
        startQuizTimerIfNeeded();
        renderApp();
        return;
      } catch (_) {
        localStorage.removeItem(LS_KEY);
      }
    }
    renderLock();
  })();
})();
