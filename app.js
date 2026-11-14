(() => {
  const LS_KEY = 'pd_saved_pass_v1';
  const LS_STATE = 'pd_progress_v1';
  const LS_THEME = 'pd_theme_v1';
  const LS_SYNC = 'pd_sync_cfg_v1';
  const SYNC_FILENAME = 'cadence_sync_v1.json';
  const IDLE_LIMIT_MS = 90000;

  let pendingPairCode = null;
  if (window.location.hash && window.location.hash.includes('pair=')) {
    try {
      const params = new URLSearchParams(window.location.hash.slice(1));
      pendingPairCode = params.get('pair');
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (_) {}
  }

  let DATA = null;
  let SESSION_PASS = null;
  let syncCfg = null;
  let syncPushTimer = null;
  let syncInFlight = false;
  let lastSyncPullAt = 0;
  let syncDirty = false;

  let progress = loadProgress();
  let lastActiveAt = Date.now();
  let unsavedSecTicks = 0;

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
    didInitialResume: false,
    showTimeDrawer: false,
    showSyncDrawer: false,
    showPasteBox: false,
    syncStatus: 'idle',
    syncMsg: '',
    lastSyncedAt: 0,
    picker: null
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

  function formatCalmMinutes(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    if (s === 0) return '0m';
    if (s < 60) return '< 1m';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function formatDateHeading(dk, todayKey, yestKey) {
    const parts = dk.split('-').map(Number);
    const dt = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
    const label = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (dk === todayKey) return `Today • ${label}`;
    if (dk === yestKey) return `Yesterday • ${label}`;
    return label;
  }

  function normalizeProgress(parsed = {}) {
    return {
      flaggedCards: parsed.flaggedCards || {},
      doneCards: parsed.doneCards || {},
      answers: parsed.answers || {},
      missedQs: parsed.missedQs || {},
      doneDays: parsed.doneDays || {},
      dailyActivity: parsed.dailyActivity || {},
      dailySeconds: parsed.dailySeconds || {},
      cardMeta: parsed.cardMeta || {},
      qMeta: parsed.qMeta || {},
      dayMeta: parsed.dayMeta || {},
      lastDeckIdx: parsed.lastDeckIdx || 0,
      lastCardIdx: parsed.lastCardIdx || 0
    };
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) return normalizeProgress(JSON.parse(raw));
    } catch (_) {}
    return normalizeProgress({});
  }

  function mergeProgress(localRaw, remoteRaw) {
    const a = normalizeProgress(localRaw);
    const b = normalizeProgress(remoteRaw);
    const out = normalizeProgress({});

    // Union of mastered cards
    Object.keys({ ...a.doneCards, ...b.doneCards }).forEach(k => {
      if (a.doneCards[k] || b.doneCards[k]) out.doneCards[k] = true;
    });

    // Timestamp-aware merge for saved/flagged cards
    Object.keys({ ...a.flaggedCards, ...b.flaggedCards, ...a.cardMeta, ...b.cardMeta }).forEach(k => {
      const ta = a.cardMeta[k] || 0;
      const tb = b.cardMeta[k] || 0;
      if (ta > tb) {
        if (a.flaggedCards[k]) out.flaggedCards[k] = true;
        out.cardMeta[k] = ta;
      } else if (tb > ta) {
        if (b.flaggedCards[k]) out.flaggedCards[k] = true;
        out.cardMeta[k] = tb;
      } else {
        if (a.flaggedCards[k] || b.flaggedCards[k]) out.flaggedCards[k] = true;
        if (ta) out.cardMeta[k] = ta;
      }
    });

    // Timestamp-aware merge for practice answers & missed items
    Object.keys({ ...a.answers, ...b.answers, ...a.qMeta, ...b.qMeta }).forEach(k => {
      const ta = a.qMeta[k] || 0;
      const tb = b.qMeta[k] || 0;
      if (ta > tb) {
        if (a.answers[k] !== undefined) out.answers[k] = a.answers[k];
        if (a.missedQs[k]) out.missedQs[k] = true;
        out.qMeta[k] = ta;
      } else if (tb > ta) {
        if (b.answers[k] !== undefined) out.answers[k] = b.answers[k];
        if (b.missedQs[k]) out.missedQs[k] = true;
        out.qMeta[k] = tb;
      } else {
        const pick = a.answers[k] !== undefined ? a.answers[k] : b.answers[k];
        if (pick !== undefined) out.answers[k] = pick;
        if (a.missedQs[k] || b.missedQs[k]) out.missedQs[k] = true;
        if (ta) out.qMeta[k] = ta;
      }
    });

    // Timestamp-aware merge for plan checklist days
    Object.keys({ ...a.doneDays, ...b.doneDays, ...a.dayMeta, ...b.dayMeta }).forEach(k => {
      const ta = a.dayMeta[k] || 0;
      const tb = b.dayMeta[k] || 0;
      if (ta > tb) {
        if (a.doneDays[k]) out.doneDays[k] = true;
        out.dayMeta[k] = ta;
      } else if (tb > ta) {
        if (b.doneDays[k]) out.doneDays[k] = true;
        out.dayMeta[k] = tb;
      } else {
        if (a.doneDays[k] || b.doneDays[k]) out.doneDays[k] = true;
        if (ta) out.dayMeta[k] = ta;
      }
    });

    // Per-day max for study activity & background minutes
    Object.keys({ ...a.dailyActivity, ...b.dailyActivity }).forEach(dk => {
      const v = Math.max(a.dailyActivity[dk] || 0, b.dailyActivity[dk] || 0);
      if (v > 0) out.dailyActivity[dk] = v;
    });
    Object.keys({ ...a.dailySeconds, ...b.dailySeconds }).forEach(dk => {
      const v = Math.max(a.dailySeconds[dk] || 0, b.dailySeconds[dk] || 0);
      if (v > 0) out.dailySeconds[dk] = v;
    });

    return out;
  }

  function saveProgress(triggerCloud = false) {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify(progress));
      unsavedSecTicks = 0;
    } catch (_) {}
    if (triggerCloud && syncCfg) {
      syncDirty = true;
      scheduleCloudPush();
    }
  }

  function recordStudyAction(amount = 1) {
    const k = localDateKey();
    progress.dailyActivity[k] = (progress.dailyActivity[k] || 0) + amount;
    lastActiveAt = Date.now();
    saveProgress(true);
  }

  function isDayActive(dk) {
    const reps = (progress.dailyActivity && progress.dailyActivity[dk]) || 0;
    const secs = (progress.dailySeconds && progress.dailySeconds[dk]) || 0;
    return reps > 0 || secs >= 60;
  }

  function computeStreakStats() {
    const act = progress.dailyActivity || {};
    const secs = progress.dailySeconds || {};
    const today = new Date();
    const todayKey = localDateKey(today);
    const todayReps = act[todayKey] || 0;
    const todaySecs = secs[todayKey] || 0;
    const totalSecs = Object.values(secs).reduce((sum, v) => sum + (v || 0), 0);
    const studiedToday = isDayActive(todayKey);

    let streak = 0;
    let cursor = new Date(today);
    if (studiedToday) {
      while (isDayActive(localDateKey(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
    } else {
      cursor.setDate(cursor.getDate() - 1);
      while (isDayActive(localDateKey(cursor))) {
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
        dk,
        label: dayLetters[d.getDay()],
        lit: isDayActive(dk),
        isToday: i === 0
      });
    }

    return { streak, todayReps, todaySecs, totalSecs, studiedToday, week };
  }

  function markUserInteraction() {
    lastActiveAt = Date.now();
  }

  ['pointerdown', 'touchstart', 'keydown', 'scroll'].forEach(evt => {
    window.addEventListener(evt, markUserInteraction, { passive: true, capture: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastActiveAt = Date.now();
      if (DATA && syncCfg && (Date.now() - lastSyncPullAt > 15000)) {
        syncWithCloud({ silent: true });
      }
    } else {
      if (unsavedSecTicks > 0) saveProgress(false);
      if (syncDirty && syncCfg) flushCloudPushKeepalive();
    }
  });

  window.addEventListener('pagehide', () => {
    if (unsavedSecTicks > 0) saveProgress(false);
    if (syncDirty && syncCfg) flushCloudPushKeepalive();
  });

  // Silent background study-time tracker (never renders ticking seconds)
  setInterval(() => {
    if (!DATA) return;
    if (document.visibilityState !== 'visible') return;
    if ((Date.now() - lastActiveAt) >= IDLE_LIMIT_MS) return;

    const tk = localDateKey();
    const wasLit = isDayActive(tk);
    progress.dailySeconds[tk] = (progress.dailySeconds[tk] || 0) + 1;
    unsavedSecTicks++;
    if (unsavedSecTicks >= 5) saveProgress(false);

    const nowLit = isDayActive(tk);
    const todaySecs = progress.dailySeconds[tk];

    if (todaySecs % 60 === 0 && syncCfg) {
      syncDirty = true;
      scheduleCloudPush();
    }

    if (!wasLit && nowLit) {
      const stats = computeStreakStats();
      const chipEl = document.getElementById('streak-open-btn');
      const countEl = document.getElementById('streak-count-label');
      if (chipEl) chipEl.classList.remove('cold');
      if (countEl) countEl.textContent = `🔥 ${stats.streak}d`;
      const todayCircle = document.querySelector('.day-circle.today-ring');
      if (todayCircle) {
        todayCircle.classList.add('lit');
        todayCircle.textContent = '✓';
      }
      saveProgress(true);
    }

    if (ui.showTimeDrawer && todaySecs % 60 === 0) {
      const totalSecs = Object.values(progress.dailySeconds).reduce((s, v) => s + (v || 0), 0);
      const dToday = document.getElementById('drawer-today-time');
      const dTotal = document.getElementById('drawer-total-time');
      const rTime = document.getElementById('today-row-time');
      const rBar = document.getElementById('today-row-bar');
      if (dToday) dToday.textContent = formatCalmMinutes(todaySecs);
      if (dTotal) dTotal.textContent = formatCalmMinutes(totalSecs);
      if (rTime) rTime.textContent = formatCalmMinutes(todaySecs);
      if (rBar) rBar.style.width = `${Math.min(100, Math.round((todaySecs / 3600) * 100))}%`;
    }
  }, 1000);

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

  function scrollActivePickerIntoView() {
    requestAnimationFrame(() => {
      const activeItem = document.querySelector('.picker-item.active');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function toUrlCode(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function fromUrlCode(code) {
    let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(escape(atob(b64)));
  }

  async function deriveAesKey(passcode, saltBytes, iterations, usages) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(passcode.trim()),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  async function decryptJsonWithPasscode(payload, passcode) {
    const aesKey = await deriveAesKey(
      passcode,
      b64ToBytes(payload.salt),
      payload.iter || 100000,
      ['decrypt']
    );
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(payload.iv) },
      aesKey,
      b64ToBytes(payload.ct)
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  }

  async function encryptWithPasscode(obj, passcode, iterations = 100000) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await deriveAesKey(passcode, salt, iterations, ['encrypt']);
    const plainBytes = new TextEncoder().encode(JSON.stringify(obj));
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plainBytes);
    return {
      v: 1,
      iter: iterations,
      salt: bytesToB64(salt),
      iv: bytesToB64(iv),
      ct: bytesToB64(new Uint8Array(ctBuf))
    };
  }

  async function unlockWithPasscode(passcode) {
    const res = await fetch('./vault.json', { cache: 'no-cache' });
    const vault = await res.json();
    const data = await decryptJsonWithPasscode(vault, passcode);
    SESSION_PASS = passcode.trim();
    return data;
  }

  async function saveSyncCfgEncrypted(cfg) {
    if (!cfg || !SESSION_PASS) {
      localStorage.removeItem(LS_SYNC);
      return;
    }
    const enc = await encryptWithPasscode(cfg, SESSION_PASS, 100000);
    localStorage.setItem(LS_SYNC, JSON.stringify(enc));
  }

  async function loadSyncCfgDecrypted() {
    if (!SESSION_PASS) return null;
    try {
      const raw = localStorage.getItem(LS_SYNC);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const cfg = await decryptJsonWithPasscode(parsed, SESSION_PASS);
      if (cfg && cfg.token && cfg.gistId) return cfg;
    } catch (_) {}
    return null;
  }

  function syncBtnLabel() {
    if (!syncCfg) return '☁';
    if (ui.syncStatus === 'syncing') return '☁↻';
    if (ui.syncStatus === 'err') return '☁!';
    return '☁✓';
  }

  function syncBtnStyle() {
    if (!syncCfg) return 'padding:7px 9px;';
    if (ui.syncStatus === 'err') return 'padding:7px 9px;border-color:var(--danger);color:var(--danger);';
    return 'padding:7px 9px;border-color:rgba(16,185,129,0.55);color:var(--success);';
  }

  function updateSyncHeaderBtn() {
    const btn = document.getElementById('sync-open-btn');
    if (!btn) return;
    btn.textContent = syncBtnLabel();
    btn.setAttribute('style', syncBtnStyle());
  }

  function scheduleCloudPush() {
    if (!syncCfg || !SESSION_PASS) return;
    clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(() => {
      syncWithCloud({ silent: true });
    }, 2800);
  }

  async function flushCloudPushKeepalive() {
    if (!syncCfg || !SESSION_PASS || syncInFlight) return;
    try {
      const encOut = await encryptWithPasscode(progress, SESSION_PASS, 100000);
      syncDirty = false;
      fetch(`https://api.github.com/gists/${syncCfg.gistId}`, {
        method: 'PATCH',
        keepalive: true,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${syncCfg.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          files: { [SYNC_FILENAME]: { content: JSON.stringify(encOut) } }
        })
      }).catch(() => { syncDirty = true; });
    } catch (_) {}
  }

  async function syncWithCloud({ silent = false, isInitial = false } = {}) {
    if (!syncCfg || !SESSION_PASS || syncInFlight) return;
    clearTimeout(syncPushTimer);
    syncInFlight = true;
    ui.syncStatus = 'syncing';
    if (!silent || ui.showSyncDrawer) renderApp();
    else updateSyncHeaderBtn();

    try {
      const getRes = await fetch(`https://api.github.com/gists/${syncCfg.gistId}`, {
        cache: 'no-store',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${syncCfg.token}`
        }
      });
      if (!getRes.ok) throw new Error(`HTTP ${getRes.status}`);
      const gist = await getRes.json();

      const beforeSig = JSON.stringify([
        progress.doneCards,
        progress.flaggedCards,
        progress.answers,
        progress.doneDays
      ]);

      const remoteContent = gist.files && gist.files[SYNC_FILENAME] && gist.files[SYNC_FILENAME].content;
      if (remoteContent) {
        try {
          const remoteEnc = JSON.parse(remoteContent);
          const remoteData = await decryptJsonWithPasscode(remoteEnc, SESSION_PASS);
          progress = mergeProgress(progress, remoteData);
          saveProgress(false);
        } catch (_) {}
      }

      const encOut = await encryptWithPasscode(progress, SESSION_PASS, 100000);
      const patchRes = await fetch(`https://api.github.com/gists/${syncCfg.gistId}`, {
        method: 'PATCH',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${syncCfg.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          files: { [SYNC_FILENAME]: { content: JSON.stringify(encOut) } }
        })
      });
      if (!patchRes.ok) throw new Error(`HTTP ${patchRes.status}`);

      const afterSig = JSON.stringify([
        progress.doneCards,
        progress.flaggedCards,
        progress.answers,
        progress.doneDays
      ]);

      lastSyncPullAt = Date.now();
      ui.lastSyncedAt = Date.now();
      syncDirty = false;
      ui.syncStatus = 'ok';

      if (isInitial && afterSig !== beforeSig) {
        jumpToResumeTarget();
      }

      const activeId = document.activeElement && document.activeElement.id;
      const isTyping = activeId === 'trig-search' || activeId === 'sync-key-input' || activeId === 'manual-sync-input';
      if ((!silent || ui.showSyncDrawer || afterSig !== beforeSig) && !isTyping) {
        renderApp();
      } else {
        updateSyncHeaderBtn();
      }
    } catch (_) {
      ui.syncStatus = 'err';
      if (!silent) ui.syncMsg = 'Sync error — check key or connection.';
      if (!silent || ui.showSyncDrawer) renderApp();
      else updateSyncHeaderBtn();
    } finally {
      syncInFlight = false;
    }
  }

  async function setupCloudSync(rawInput) {
    const trimmed = (rawInput || '').trim();
    if (!trimmed || !SESSION_PASS) return;

    ui.syncStatus = 'syncing';
    ui.syncMsg = 'Connecting encrypted sync...';
    renderApp();

    try {
      let pairCode = null;
      if (trimmed.includes('#pair=')) {
        const hashPart = trimmed.split('#')[1] || '';
        pairCode = new URLSearchParams(hashPart).get('pair');
      } else if (trimmed.startsWith('PAIR1:')) {
        pairCode = trimmed.slice(6).trim();
      }

      if (pairCode) {
        const encObj = JSON.parse(fromUrlCode(pairCode));
        const decoded = await decryptJsonWithPasscode(encObj, SESSION_PASS);
        if (!decoded || !decoded.t || !decoded.g) throw new Error('Bad pairing code');
        syncCfg = { token: decoded.t, gistId: decoded.g };
        await saveSyncCfgEncrypted(syncCfg);
        ui.syncMsg = '✓ Device paired & synced!';
        await syncWithCloud({ silent: false, isInitial: true });
        return;
      }

      const token = trimmed;
      const listRes = await fetch('https://api.github.com/gists?per_page=50', {
        cache: 'no-store',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`
        }
      });
      if (!listRes.ok) throw new Error('Invalid token');
      const gists = await listRes.json();
      const existing = Array.isArray(gists)
        ? gists.find(g => g && g.files && g.files[SYNC_FILENAME])
        : null;

      let gistId = existing ? existing.id : null;
      if (!gistId) {
        const encInit = await encryptWithPasscode(progress, SESSION_PASS, 100000);
        const createRes = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            description: 'Cadence encrypted workspace sync',
            public: false,
            files: {
              [SYNC_FILENAME]: { content: JSON.stringify(encInit) }
            }
          })
        });
        if (!createRes.ok) throw new Error('Could not create gist');
        const created = await createRes.json();
        gistId = created.id;
      }

      syncCfg = { token, gistId };
      await saveSyncCfgEncrypted(syncCfg);
      ui.syncMsg = '✓ Auto-Sync active! Copy your Pairing Link below to connect other devices in 1 tap.';
      await syncWithCloud({ silent: false, isInitial: true });
    } catch (_) {
      ui.syncStatus = 'err';
      ui.syncMsg = 'Could not connect — ensure your GitHub key has the "gist" scope.';
      renderApp();
    }
  }

  async function initSyncAfterUnlock() {
    if (!SESSION_PASS) return;
    if (pendingPairCode) {
      const code = pendingPairCode;
      pendingPairCode = null;
      ui.showSyncDrawer = true;
      await setupCloudSync('PAIR1:' + code);
      return;
    }
    syncCfg = await loadSyncCfgDecrypted();
    if (syncCfg) {
      updateSyncHeaderBtn();
      syncWithCloud({ silent: true, isInitial: true });
    }
  }

  function jumpToResumeTarget() {
    const target = findCurrentTarget();
    ui.deckIdx = target.deckIdx;
    ui.cardIdx = target.cardIdx;
    ui.flipped = false;
  }

  function renderLock(errMsg = '') {
    const root = document.getElementById('root');
    const pairBanner = pendingPairCode
      ? `<div style="background:var(--surface-2);border:1px solid var(--primary);border-radius:12px;padding:10px 12px;font-size:13.5px;color:var(--text);">🔗 <strong>Pairing link detected.</strong> Enter your access key to unlock and link cross-device sync automatically.</div>`
      : '';
    root.innerHTML = `
      <div class="lock-wrap">
        <div class="lock-card">
          <div style="display:flex;align-items:center;gap:13px;">
            <img src="icon-192.png?v=10" alt="Cadence" style="width:52px;height:52px;border-radius:14px;border:1px solid var(--border);flex-shrink:0;" />
            <div>
              <div style="font-size:24px;font-weight:800;letter-spacing:-0.02em;">Cadence</div>
              <div style="font-size:14.5px;color:var(--muted);margin-top:3px;">Enter your private access key to unlock your personal workspace.</div>
            </div>
          </div>
          ${pairBanner}
          <form id="unlock-form" style="display:flex;flex-direction:column;gap:14px;">
            <input id="pass-input" type="password" class="text-input" placeholder="Access key" autocomplete="current-password" required />
            <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--muted);">
              <input id="remember-chk" type="checkbox" checked style="width:18px;height:18px;" />
              Remember on this device
            </label>
            ${errMsg ? `<div style="color:var(--danger);font-size:14px;font-weight:600;">${errMsg}</div>` : ''}
            <button id="unlock-btn" type="submit" class="primary-btn">Unlock Cadence</button>
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
        renderApp();
        initSyncAfterUnlock();
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
    saveProgress(false);
    localStorage.removeItem(LS_KEY);
    DATA = null;
    SESSION_PASS = null;
    syncCfg = null;
    ui.showTimeDrawer = false;
    ui.showSyncDrawer = false;
    ui.picker = null;
    clearTimeout(syncPushTimer);
    clearInterval(ui.timerHandle);
    renderLock();
  }

  function renderTimeDrawer(stats) {
    if (!ui.showTimeDrawer) return '';
    const today = new Date();
    const todayKey = localDateKey(today);
    const yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    const yestKey = localDateKey(yest);

    const weekHtml = stats.week.map(w => `
      <div class="day-dot">
        <span>${w.label}</span>
        <div class="day-circle ${w.lit ? 'lit' : ''} ${w.isToday ? 'today-ring' : ''}">
          ${w.lit ? '✓' : ''}
        </div>
      </div>
    `).join('');

    const dateSet = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dateSet.add(localDateKey(d));
    }
    Object.keys(progress.dailySeconds || {}).forEach(k => dateSet.add(k));
    Object.keys(progress.dailyActivity || {}).forEach(k => dateSet.add(k));

    const sortedDays = Array.from(dateSet).sort((a, b) => b.localeCompare(a));

    const dayRowsHtml = sortedDays.map(dk => {
      const secs = (progress.dailySeconds && progress.dailySeconds[dk]) || 0;
      const reps = (progress.dailyActivity && progress.dailyActivity[dk]) || 0;
      const pct = Math.min(100, Math.round((secs / 3600) * 100));
      const isToday = dk === todayKey;
      const repsTag = reps > 0 ? ` • ${reps} ${reps === 1 ? 'item' : 'items'}` : '';
      return `
        <div class="day-log-row">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span style="font-size:14px;font-weight:${isToday ? '800' : '600'};color:${isToday ? 'var(--text)' : 'var(--muted)'};">
              ${formatDateHeading(dk, todayKey, yestKey)}
            </span>
            <span style="font-size:13.5px;font-weight:700;">
              <span ${isToday ? 'id="today-row-time"' : ''}>${formatCalmMinutes(secs)}</span><span style="color:var(--muted);font-weight:600;">${repsTag}</span>
            </span>
          </div>
          <div class="day-log-bar-track">
            <div class="day-log-bar-fill" ${isToday ? 'id="today-row-bar"' : ''} style="width:${pct}%;"></div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="drawer-backdrop" id="time-drawer-backdrop">
        <div class="drawer-sheet" role="dialog" aria-label="Daily Streak & Log">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <div style="font-size:18px;font-weight:800;">🔥 Daily Streak & Log</div>
            <button class="icon-btn" id="drawer-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
          </div>

          <div class="drawer-stat-grid">
            <div class="drawer-stat-box">
              <span class="drawer-stat-label">TODAY</span>
              <span class="drawer-stat-val" id="drawer-today-time" style="color:var(--primary);">${formatCalmMinutes(stats.todaySecs)}</span>
            </div>
            <div class="drawer-stat-box">
              <span class="drawer-stat-label">STREAK</span>
              <span class="drawer-stat-val" style="color:var(--warn);">🔥 ${stats.streak}d</span>
            </div>
            <div class="drawer-stat-box">
              <span class="drawer-stat-label">TOTAL</span>
              <span class="drawer-stat-val" id="drawer-total-time">${formatCalmMinutes(stats.totalSecs)}</span>
            </div>
          </div>

          <div class="drawer-week-box">
            <div class="week-dots">${weekHtml}</div>
          </div>

          <div style="font-size:12.5px;color:var(--muted);">
            Quietly logged in the background while you study.
          </div>

          <div style="font-size:13px;font-weight:800;color:var(--muted);margin-top:2px;">
            BY DAY
          </div>

          <div class="day-log-list">
            ${dayRowsHtml}
          </div>
        </div>
      </div>
    `;
  }

  function renderPickerDrawer() {
    if (!ui.picker) return '';

    if (ui.picker === 'deck') {
      const flaggedTotal = Object.values(progress.flaggedCards).filter(Boolean).length;
      const curDeck = ui.deckIdx === 'flagged' ? null : DATA.decks[ui.deckIdx];
      const canMarkDone = curDeck && !isDeckComplete(curDeck);

      const deckItems = DATA.decks.map((d, idx) => {
        const doneCnt = deckDoneCount(d);
        const complete = doneCnt === d.cards.length;
        const active = ui.deckIdx === idx;
        const prefix = complete ? '✓ ' : (active ? '▶ ' : '');
        return `
          <button class="picker-item ${active ? 'active' : ''} ${complete && !active ? 'done-item' : ''}" data-pick-deck="${idx}">
            <div style="min-width:0;">
              <div style="font-size:14.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${prefix}${d.days} • ${d.title}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:2px;">${d.phase}</div>
            </div>
            <span style="font-size:13px;font-weight:700;color:${complete ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">${doneCnt}/${d.cards.length}</span>
          </button>
        `;
      }).join('');

      const savedItem = `
        <button class="picker-item ${ui.deckIdx === 'flagged' ? 'active' : ''}" data-pick-deck="flagged">
          <div style="font-size:14.5px;font-weight:700;">⭐ Saved Review Pile</div>
          <span style="font-size:13px;font-weight:700;color:var(--muted);white-space:nowrap;">${flaggedTotal}</span>
        </button>
      `;

      return `
        <div class="drawer-backdrop" id="picker-backdrop">
          <div class="drawer-sheet" role="dialog" aria-label="Select Day or Deck">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="font-size:18px;font-weight:800;">Select Day / Deck</div>
              <div style="display:flex;align-items:center;gap:7px;">
                ${canMarkDone ? `<button class="icon-btn" id="mark-deck-btn" style="padding:7px 10px;font-size:12.5px;">✓ Mark Deck Done</button>` : ''}
                <button class="icon-btn" id="picker-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
              </div>
            </div>
            <div class="picker-list">
              ${deckItems}
              ${savedItem}
            </div>
          </div>
        </div>
      `;
    }

    if (ui.picker === 'quiz') {
      const missedCount = Object.values(progress.missedQs).filter(Boolean).length;
      const allAnswered = DATA.questions.filter(q => progress.answers[q.id] !== undefined).length;
      const secs = ['Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];

      const secRows = secs.map(s => {
        const list = DATA.questions.filter(q => q.sec === s);
        const ansCnt = list.filter(q => progress.answers[q.id] !== undefined).length;
        const active = ui.quizFilter === s;
        return `
          <button class="picker-item ${active ? 'active' : ''}" data-pick-qfilter="${s}">
            <div style="font-size:14.5px;font-weight:700;">${active ? '▶ ' : ''}${s}</div>
            <span style="font-size:13px;font-weight:700;color:var(--muted);white-space:nowrap;">${ansCnt}/${list.length}</span>
          </button>
        `;
      }).join('');

      return `
        <div class="drawer-backdrop" id="picker-backdrop">
          <div class="drawer-sheet" role="dialog" aria-label="Select Practice Set">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="font-size:18px;font-weight:800;">Select Practice Set</div>
              <button class="icon-btn" id="picker-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
            </div>
            <div class="picker-list">
              <button class="picker-item ${ui.quizFilter === 'ALL' ? 'active' : ''}" data-pick-qfilter="ALL">
                <div style="font-size:14.5px;font-weight:700;">${ui.quizFilter === 'ALL' ? '▶ ' : ''}All Sections</div>
                <span style="font-size:13px;font-weight:700;color:var(--muted);white-space:nowrap;">${allAnswered}/${DATA.questions.length}</span>
              </button>
              <button class="picker-item ${ui.quizFilter === 'MISSED' ? 'active' : ''}" data-pick-qfilter="MISSED">
                <div style="font-size:14.5px;font-weight:700;">${ui.quizFilter === 'MISSED' ? '▶ ' : ''}🔁 Missed Items</div>
                <span style="font-size:13px;font-weight:700;color:var(--muted);white-space:nowrap;">${missedCount}</span>
              </button>
              ${secRows}
            </div>
          </div>
        </div>
      `;
    }

    if (ui.picker === 'trig') {
      const secs = ['ALL', 'Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];
      const rows = secs.map(s => {
        const count = s === 'ALL' ? DATA.triggers.length : DATA.triggers.filter(t => t.sec === s).length;
        const active = ui.trigFilter === s;
        return `
          <button class="picker-item ${active ? 'active' : ''}" data-pick-trigsec="${s}">
            <div style="font-size:14.5px;font-weight:700;">${active ? '▶ ' : ''}${s === 'ALL' ? 'All Sections' : s}</div>
            <span style="font-size:13px;font-weight:700;color:var(--muted);white-space:nowrap;">${count}</span>
          </button>
        `;
      }).join('');

      return `
        <div class="drawer-backdrop" id="picker-backdrop">
          <div class="drawer-sheet" role="dialog" aria-label="Filter Rules">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="font-size:18px;font-weight:800;">Filter Rules</div>
              <button class="icon-btn" id="picker-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
            </div>
            <div class="picker-list">
              ${rows}
            </div>
          </div>
        </div>
      `;
    }

    return '';
  }

  function renderSyncDrawer() {
    if (!ui.showSyncDrawer) return '';

    const lastTimeStr = ui.lastSyncedAt
      ? new Date(ui.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'Ready';

    const msgBanner = ui.syncMsg
      ? `<div style="background:var(--surface-2);border:1px solid ${ui.syncStatus === 'err' ? 'var(--danger)' : 'var(--primary)'};border-radius:12px;padding:10px 12px;font-size:13.5px;line-height:1.4;color:${ui.syncStatus === 'err' ? 'var(--danger)' : 'var(--text)'};">${ui.syncMsg}</div>`
      : '';

    const autoSyncHtml = syncCfg
      ? `
        <div class="day-log-row" style="gap:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span style="font-size:14.5px;font-weight:800;color:var(--success);">🟢 Auto-Sync Active</span>
            <span style="font-size:12.5px;font-weight:600;color:var(--muted);">${ui.syncStatus === 'syncing' ? 'Syncing...' : `Synced • ${lastTimeStr}`}</span>
          </div>
          <div style="font-size:13px;color:var(--muted);line-height:1.4;">
            Cards, saved items, practice answers, checklist days, and daily streaks merge automatically across your devices.
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <button class="primary-btn" id="sync-now-btn" style="padding:11px 10px;font-size:14px;" ${ui.syncStatus === 'syncing' ? 'disabled' : ''}>
              ${ui.syncStatus === 'syncing' ? 'Syncing...' : '↻ Sync Now'}
            </button>
            <button class="sec-btn" id="copy-pair-btn" style="padding:11px 10px;font-size:14px;">
              🔗 Pairing Link
            </button>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:2px;">
            <span style="font-size:12px;color:var(--muted);">Open Pairing Link on another device for 1-tap setup.</span>
            <button class="icon-btn" id="sync-disconnect-btn" style="padding:5px 9px;font-size:12px;color:var(--danger);border-color:rgba(239,68,68,0.4);">Disconnect</button>
          </div>
        </div>
      `
      : `
        <div class="day-log-row" style="gap:10px;">
          <div style="font-size:14.5px;font-weight:800;">☁ Automatic Cross-Device Sync</div>
          <div style="font-size:13px;color:var(--muted);line-height:1.42;">
            One-time 20-second setup using a private, encrypted GitHub Gist on your own account:
          </div>
          <a href="https://github.com/settings/tokens/new?scopes=gist&description=Cadence+Sync" target="_blank" rel="noopener noreferrer" class="sec-btn" style="display:block;text-align:center;text-decoration:none;padding:11px 12px;font-size:14px;">
            1. Create Free Gist Key on GitHub ↗
          </a>
          <div style="font-size:12px;color:var(--muted);line-height:1.35;">
            On GitHub, scroll down &amp; tap <strong>Generate token</strong>, then paste the <code>ghp_...</code> key (or a Pairing Link from another device) below:
          </div>
          <input id="sync-key-input" type="password" class="text-input" placeholder="Paste ghp_... key or Pairing Link" style="padding:11px 13px;font-size:14.5px;border-radius:12px;" autocomplete="off" />
          <button class="primary-btn" id="sync-connect-btn" style="padding:12px;font-size:15px;" ${ui.syncStatus === 'syncing' ? 'disabled' : ''}>
            ${ui.syncStatus === 'syncing' ? 'Connecting...' : '2. Enable Auto-Sync'}
          </button>
        </div>
      `;

    const pasteBoxHtml = ui.showPasteBox
      ? `
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px;">
          <input id="manual-sync-input" type="text" class="text-input" placeholder="Paste SYNC1:... code here" style="padding:10px 12px;font-size:14px;border-radius:11px;" autocomplete="off" />
          <button class="success-btn" id="apply-manual-sync-btn" style="padding:11px;font-size:14.5px;">Merge Imported Progress</button>
        </div>
      `
      : '';

    return `
      <div class="drawer-backdrop" id="sync-drawer-backdrop">
        <div class="drawer-sheet" role="dialog" aria-label="Cross-Device Sync">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <div style="font-size:18px;font-weight:800;">☁ Cross-Device Sync</div>
            <button class="icon-btn" id="sync-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
          </div>

          ${msgBanner}
          ${autoSyncHtml}

          <div class="day-log-row" style="gap:9px;">
            <div style="font-size:13.5px;font-weight:800;color:var(--muted);">INSTANT TRANSFER (NO KEY NEEDED)</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <button class="sec-btn" id="copy-manual-sync-btn" style="padding:10px;font-size:13.5px;">📤 Copy Sync Code</button>
              <button class="sec-btn" id="toggle-paste-sync-btn" style="padding:10px;font-size:13.5px;">📥 Paste Sync Code</button>
            </div>
            ${pasteBoxHtml}
          </div>

          <div style="font-size:12px;color:var(--muted);line-height:1.4;">
            🔒 End-to-end encrypted locally with AES-256-GCM using your access key before leaving this device.
          </div>
        </div>
      </div>
    `;
  }

  function renderApp() {
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
          <div style="display:flex;align-items:center;gap:9px;min-width:0;">
            <img src="icon-192.png?v=10" alt="" style="width:30px;height:30px;border-radius:8px;border:1px solid var(--border);flex-shrink:0;" />
            <div style="min-width:0;">
              <div class="brand-title">${DATA.appTitle}</div>
              <div class="brand-sub">${totalDoneCards}/${totalCards} cards mastered</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <button class="streak-chip ${stats.studiedToday ? '' : 'cold'}" id="streak-open-btn" title="Tap for daily log">
              <span id="streak-count-label">🔥 ${stats.streak}d</span>
            </button>
            <button class="icon-btn" id="sync-open-btn" title="Cross-device sync" style="${syncBtnStyle()}">${syncBtnLabel()}</button>
            <button class="icon-btn" id="theme-btn" aria-label="Toggle theme" style="padding:7px 9px;">◐</button>
            <button class="icon-btn" id="lock-btn" aria-label="Lock" style="padding:7px 9px;">🔒</button>
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

        ${renderTimeDrawer(stats)}
        ${renderSyncDrawer()}
        ${renderPickerDrawer()}
      </div>
    `;

    bindEvents();
    if (ui.picker) scrollActivePickerIntoView();
  }

  function renderCardsTab() {
    const flaggedTotal = Object.values(progress.flaggedCards).filter(Boolean).length;
    const resumeTarget = findCurrentTarget();
    const onResumeDeck = ui.deckIdx === resumeTarget.deckIdx;
    const curDeck = ui.deckIdx === 'flagged' ? null : DATA.decks[ui.deckIdx];
    const deckAllDone = curDeck ? isDeckComplete(curDeck) : false;
    const nextDeckExists = curDeck && ui.deckIdx < DATA.decks.length - 1;

    const selectorLabel = curDeck
      ? `${deckAllDone ? '✓ ' : ''}${curDeck.days}: ${curDeck.title} (${deckDoneCount(curDeck)}/${curDeck.cards.length})`
      : `⭐ Saved (${flaggedTotal})`;

    const rightActionHtml = !onResumeDeck
      ? `<button class="icon-btn" id="jump-current-btn" style="padding:8px 10px;font-size:12.5px;border-color:var(--primary);color:var(--primary);">▶ ${DATA.decks[resumeTarget.deckIdx].days}</button>`
      : (deckAllDone && nextDeckExists
          ? `<button class="icon-btn" id="next-deck-btn" style="background:var(--success);border-color:var(--success);color:#fff;font-size:12.5px;padding:8px 10px;">Next: ${DATA.decks[ui.deckIdx + 1].days} →</button>`
          : '');

    const selectorBarHtml = `
      <div class="selector-bar">
        <button class="dropdown-btn" id="open-deck-picker">
          <span class="dropdown-btn-label">${selectorLabel}</span>
          <span class="dropdown-caret">▾</span>
        </button>
        ${rightActionHtml}
      </div>
    `;

    const cards = getActiveCards();
    if (!cards.length) {
      return `
        ${selectorBarHtml}
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

    const dotsHtml = cards.map((item, idx) => {
      let dCls = 'cdot';
      if (progress.doneCards[item.id]) dCls += ' done';
      if (idx === ui.cardIdx) dCls += ' current';
      return `<div class="${dCls}" data-dot="${idx}"></div>`;
    }).join('');

    const centerBtnHtml = ui.flipped
      ? `<button class="success-btn" id="card-got-it" style="padding:14px 10px;">${isCardDone ? '✓ Done • Next →' : '✓ Got It • Next'}</button>`
      : `<button class="primary-btn" id="card-flip" style="padding:14px 10px;">Reveal Answer</button>`;

    return `
      ${selectorBarHtml}

      <div class="card-dots">${dotsHtml}</div>

      <div class="flashcard ${isCardDone ? 'card-done' : ''}" id="flashcard-box">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span class="badge">${isCardDone ? '✓ ' : ''}${c.tag}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:13px;font-weight:700;color:var(--muted);">${ui.cardIdx + 1}/${cards.length}</span>
            <button class="icon-btn" id="flag-card-btn" style="padding:5px 10px;font-size:13px;">
              ${isFlagged ? '⭐ Saved' : '☆ Save'}
            </button>
          </div>
        </div>

        <div class="card-body">${ui.flipped ? c.a : c.q}</div>

        <div style="display:flex;flex-direction:column;gap:10px;">
          ${ui.flipped ? `<div class="card-tip"><strong>⚡ Key Rule:</strong> ${c.tip}</div>` : ''}
          <div style="text-align:center;font-size:13px;font-weight:600;color:var(--primary);">
            ${ui.flipped ? '👆 Tap card for prompt • Or tap Got It below' : '👆 Tap anywhere on card to flip'}
          </div>
        </div>
      </div>

      <div class="thumb-controls">
        <button class="sec-btn" id="card-prev" style="padding:14px 10px;" ${ui.cardIdx === 0 ? 'disabled' : ''}>← Prev</button>
        ${centerBtnHtml}
        <button class="sec-btn" id="card-next" style="padding:14px 10px;" ${ui.cardIdx === cards.length - 1 ? 'disabled' : ''}>Skip →</button>
      </div>
    `;
  }

  function renderTriggersTab() {
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
      <div class="selector-bar">
        <input id="trig-search" class="text-input" placeholder="Search rules..." value="${ui.trigSearch.replace(/"/g, '&quot;')}" style="flex:1;padding:8.5px 12px;font-size:15px;border-radius:12px;" />
        <button class="dropdown-btn" id="open-trig-picker" style="flex:0 0 auto;width:auto;">
          <span class="dropdown-btn-label">${ui.trigFilter === 'ALL' ? `All (${DATA.triggers.length})` : ui.trigFilter}</span>
          <span class="dropdown-caret">▾</span>
        </button>
      </div>
      <div class="scroll-pane">
        ${items || '<div style="text-align:center;color:var(--muted);padding:32px 0;">No matching rules.</div>'}
      </div>
    `;
  }

  function renderQuizTab() {
    const missedCount = Object.values(progress.missedQs).filter(Boolean).length;
    const qs = getActiveQuestions();

    const activeFilterLabel = ui.quizFilter === 'ALL'
      ? 'All Sections'
      : (ui.quizFilter === 'MISSED' ? `🔁 Missed (${missedCount})` : ui.quizFilter);

    if (!qs.length) {
      return `
        <div class="selector-bar">
          <button class="dropdown-btn" id="open-quiz-picker">
            <span class="dropdown-btn-label">${activeFilterLabel}</span>
            <span class="dropdown-caret">▾</span>
          </button>
        </div>
        <div class="quiz-card" style="justify-content:center;align-items:center;text-align:center;padding:36px 20px;">
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
      <div class="selector-bar">
        <button class="dropdown-btn" id="open-quiz-picker">
          <span class="dropdown-btn-label">${activeFilterLabel} • Q ${ui.qIdx + 1}/${qs.length}</span>
          <span class="dropdown-caret">▾</span>
        </button>
        <span style="font-size:12.5px;font-weight:700;color:var(--muted);white-space:nowrap;">✓ ${rightCount}/${answeredList.length}</span>
        <button class="icon-btn" id="toggle-timer" style="padding:7px 9px;font-size:12.5px;">
          <span id="timer-badge">${ui.timerOn ? `⏱ ${m}:${s}` : '⏱ Off'}</span>
        </button>
      </div>

      <div class="quiz-card" id="quiz-card-box">
        <div class="quiz-q">${q.q}</div>
        <div style="display:flex;flex-direction:column;gap:9px;">
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

      <div class="quiz-controls">
        <button class="sec-btn" id="q-prev" style="padding:14px 12px;" ${ui.qIdx === 0 ? 'disabled' : ''}>← Prev</button>
        <button class="primary-btn" id="q-next" style="padding:14px 12px;" ${ui.qIdx === qs.length - 1 ? 'disabled' : ''}>Next →</button>
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
      <div class="trigger-card" style="flex-shrink:0;padding:13px 15px;gap:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:15.5px;font-weight:700;">Checklist Progress</span>
          <span style="font-size:15.5px;font-weight:800;color:var(--primary);">${pct}% (${doneCount}/${DATA.plan.length})</span>
        </div>
        <div style="width:100%;height:9px;border-radius:99px;background:var(--surface-2);overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:var(--primary);transition:width .2s;"></div>
        </div>
      </div>
      <div class="scroll-pane">
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
      saveProgress(false);
    }

    if (ui.cardIdx < cards.length - 1) {
      ui.cardIdx++;
      ui.flipped = false;
      renderApp();
    } else {
      ui.flipped = false;
      renderApp();
    }
  }

  function bindEvents() {
    document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
    document.getElementById('lock-btn')?.addEventListener('click', lockNow);

    const openDrawer = () => {
      saveProgress(false);
      ui.picker = null;
      ui.showSyncDrawer = false;
      ui.showTimeDrawer = true;
      renderApp();
    };
    document.getElementById('streak-open-btn')?.addEventListener('click', openDrawer);

    document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
      ui.showTimeDrawer = false;
      renderApp();
    });

    document.getElementById('time-drawer-backdrop')?.addEventListener('click', e => {
      if (e.target.id === 'time-drawer-backdrop') {
        ui.showTimeDrawer = false;
        renderApp();
      }
    });

    // Cross-Device Sync Drawer handlers
    document.getElementById('sync-open-btn')?.addEventListener('click', () => {
      saveProgress(false);
      ui.picker = null;
      ui.showTimeDrawer = false;
      ui.syncMsg = '';
      ui.showSyncDrawer = true;
      renderApp();
    });

    document.getElementById('sync-close-btn')?.addEventListener('click', () => {
      ui.showSyncDrawer = false;
      ui.showPasteBox = false;
      renderApp();
    });

    document.getElementById('sync-drawer-backdrop')?.addEventListener('click', e => {
      if (e.target.id === 'sync-drawer-backdrop') {
        ui.showSyncDrawer = false;
        ui.showPasteBox = false;
        renderApp();
      }
    });

    document.getElementById('sync-connect-btn')?.addEventListener('click', () => {
      const inp = document.getElementById('sync-key-input');
      if (inp && inp.value.trim()) {
        setupCloudSync(inp.value.trim());
      }
    });

    document.getElementById('sync-now-btn')?.addEventListener('click', () => {
      ui.syncMsg = '';
      syncWithCloud({ silent: false });
    });

    document.getElementById('copy-pair-btn')?.addEventListener('click', async () => {
      if (!syncCfg || !SESSION_PASS) return;
      try {
        const encPair = await encryptWithPasscode({ t: syncCfg.token, g: syncCfg.gistId }, SESSION_PASS, 100000);
        const code = toUrlCode(JSON.stringify(encPair));
        const link = `${window.location.origin}${window.location.pathname}#pair=${code}`;
        await navigator.clipboard.writeText(link);
        ui.syncMsg = '✓ Pairing Link copied! Open it on your other device for 1-tap encrypted sync.';
        renderApp();
      } catch (_) {
        ui.syncMsg = 'Could not copy automatically — check clipboard permissions.';
        renderApp();
      }
    });

    document.getElementById('sync-disconnect-btn')?.addEventListener('click', () => {
      syncCfg = null;
      localStorage.removeItem(LS_SYNC);
      ui.syncStatus = 'idle';
      ui.syncMsg = 'Disconnected auto-sync on this device.';
      renderApp();
    });

    document.getElementById('copy-manual-sync-btn')?.addEventListener('click', async () => {
      if (!SESSION_PASS) return;
      try {
        const encSnap = await encryptWithPasscode(progress, SESSION_PASS, 100000);
        const snapCode = 'SYNC1:' + toUrlCode(JSON.stringify(encSnap));
        await navigator.clipboard.writeText(snapCode);
        ui.syncMsg = '✓ Encrypted Sync Code copied! Tap "Paste Sync Code" on your other device.';
        renderApp();
      } catch (_) {
        ui.syncMsg = 'Could not copy Sync Code to clipboard.';
        renderApp();
      }
    });

    document.getElementById('toggle-paste-sync-btn')?.addEventListener('click', () => {
      ui.showPasteBox = !ui.showPasteBox;
      ui.syncMsg = '';
      renderApp();
    });

    document.getElementById('apply-manual-sync-btn')?.addEventListener('click', async () => {
      const inp = document.getElementById('manual-sync-input');
      const raw = (inp ? inp.value : '').trim();
      if (!raw || !SESSION_PASS) return;
      if (raw.includes('#pair=') || raw.startsWith('PAIR1:')) {
        await setupCloudSync(raw);
        return;
      }
      try {
        const clean = raw.startsWith('SYNC1:') ? raw.slice(6).trim() : raw;
        const encObj = JSON.parse(fromUrlCode(clean));
        const remoteProg = await decryptJsonWithPasscode(encObj, SESSION_PASS);
        progress = mergeProgress(progress, remoteProg);
        saveProgress(true);
        jumpToResumeTarget();
        ui.showPasteBox = false;
        ui.syncStatus = 'ok';
        ui.syncMsg = '✓ Progress merged across devices!';
        renderApp();
      } catch (_) {
        ui.syncStatus = 'err';
        ui.syncMsg = 'Invalid Sync Code — copy a fresh code from your other device.';
        renderApp();
      }
    });

    // Picker open / close / select handlers
    document.getElementById('open-deck-picker')?.addEventListener('click', () => {
      ui.picker = 'deck';
      renderApp();
    });
    document.getElementById('open-quiz-picker')?.addEventListener('click', () => {
      ui.picker = 'quiz';
      renderApp();
    });
    document.getElementById('open-trig-picker')?.addEventListener('click', () => {
      ui.picker = 'trig';
      renderApp();
    });

    document.getElementById('picker-close-btn')?.addEventListener('click', () => {
      ui.picker = null;
      renderApp();
    });
    document.getElementById('picker-backdrop')?.addEventListener('click', e => {
      if (e.target.id === 'picker-backdrop') {
        ui.picker = null;
        renderApp();
      }
    });

    document.querySelectorAll('[data-pick-deck]').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.deckIdx = btn.dataset.pickDeck === 'flagged' ? 'flagged' : Number(btn.dataset.pickDeck);
        if (typeof ui.deckIdx === 'number') {
          const firstOpen = DATA.decks[ui.deckIdx].cards.findIndex(c => !progress.doneCards[c.id]);
          ui.cardIdx = firstOpen !== -1 ? firstOpen : 0;
        } else {
          ui.cardIdx = 0;
        }
        ui.flipped = false;
        ui.picker = null;
        renderApp();
      });
    });

    document.querySelectorAll('[data-pick-qfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.quizFilter = btn.dataset.pickQfilter;
        ui.qIdx = 0;
        ui.secLeft = 120;
        ui.picker = null;
        startQuizTimerIfNeeded();
        renderApp();
      });
    });

    document.querySelectorAll('[data-pick-trigsec]').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.trigFilter = btn.dataset.pickTrigsec;
        ui.picker = null;
        renderApp();
      });
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
      else saveProgress(true);
      ui.picker = null;
      renderApp();
    });

    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.tab = btn.dataset.tab;
        ui.picker = null;
        ui.secLeft = 120;
        startQuizTimerIfNeeded();
        renderApp();
      });
    });

    if (ui.tab === 'cards') {
      document.querySelectorAll('[data-dot]').forEach(dot => {
        dot.addEventListener('click', () => {
          ui.cardIdx = Number(dot.dataset.dot);
          ui.flipped = false;
          renderApp();
        });
      });

      document.getElementById('jump-current-btn')?.addEventListener('click', () => {
        jumpToResumeTarget();
        renderApp();
      });

      document.getElementById('next-deck-btn')?.addEventListener('click', () => {
        if (typeof ui.deckIdx === 'number' && ui.deckIdx < DATA.decks.length - 1) {
          ui.deckIdx++;
          const firstOpen = DATA.decks[ui.deckIdx].cards.findIndex(c => !progress.doneCards[c.id]);
          ui.cardIdx = firstOpen !== -1 ? firstOpen : 0;
          ui.flipped = false;
          renderApp();
        }
      });

      document.getElementById('flag-card-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const cards = getActiveCards();
        const cur = cards[ui.cardIdx];
        if (!cur) return;
        if (progress.flaggedCards[cur.id]) delete progress.flaggedCards[cur.id];
        else progress.flaggedCards[cur.id] = true;
        progress.cardMeta[cur.id] = Date.now();
        saveProgress(true);
        renderApp();
      });

      document.getElementById('flashcard-box')?.addEventListener('click', () => {
        ui.flipped = !ui.flipped;
        renderApp();
      });

      document.getElementById('card-flip')?.addEventListener('click', () => {
        ui.flipped = true;
        renderApp();
      });

      document.getElementById('card-got-it')?.addEventListener('click', completeCurrentCardAndAdvance);

      document.getElementById('card-prev')?.addEventListener('click', () => {
        if (ui.cardIdx > 0) { ui.cardIdx--; ui.flipped = false; renderApp(); }
      });

      document.getElementById('card-next')?.addEventListener('click', () => {
        const cards = getActiveCards();
        if (ui.cardIdx < cards.length - 1) { ui.cardIdx++; ui.flipped = false; renderApp(); }
      });
    }

    if (ui.tab === 'triggers') {
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
          progress.qMeta[cur.id] = Date.now();
          recordStudyAction(1);
          clearInterval(ui.timerHandle);
          renderApp();
          requestAnimationFrame(() => {
            const box = document.getElementById('quiz-card-box');
            if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
          });
        });
      });

      document.getElementById('retry-q')?.addEventListener('click', () => {
        const qs = getActiveQuestions();
        const cur = qs[ui.qIdx];
        if (!cur) return;
        delete progress.answers[cur.id];
        progress.qMeta[cur.id] = Date.now();
        saveProgress(true);
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
          if (progress.doneDays[d]) delete progress.doneDays[d];
          else progress.doneDays[d] = true;
          progress.dayMeta[d] = Date.now();
          if (progress.doneDays[d]) recordStudyAction(1);
          else saveProgress(true);
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
    if (!DATA || ui.showTimeDrawer || ui.showSyncDrawer || ui.picker) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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

  // Auto-unlock if saved on device
  (async () => {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      try {
        DATA = await unlockWithPasscode(saved);
        jumpToResumeTarget();
        ui.didInitialResume = true;
        startQuizTimerIfNeeded();
        renderApp();
        initSyncAfterUnlock();
        return;
      } catch (_) {
        localStorage.removeItem(LS_KEY);
      }
    }
    renderLock();
  })();
})();
