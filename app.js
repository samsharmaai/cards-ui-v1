(() => {
  const LS_KEY = 'pd_saved_pass_v1';
  const LS_STATE = 'pd_progress_v1';
  const LS_THEME = 'pd_theme_v1';
  const LS_SYNC = 'pd_sync_cfg_v1';
  const LS_UI = 'pd_ui_state_v1';
  const LS_FONT = 'pd_font_scale_v1';
  const SYNC_FILENAME = 'cadence_sync_v1.json';
  const FIREBASE_PROJECT_ID = 'cadence-deck';
  const FIREBASE_COLLECTION = 'cadence';
  const IDLE_LIMIT_MS = 60000;

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
  let windowFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  let unsavedSecTicks = 0;

  function loadFontScale() {
    try {
      const v = Number(localStorage.getItem(LS_FONT));
      if (v === 0 || v === 1 || v === 2) return v;
    } catch (_) {}
    return 1; // Default to A+ comfort size
  }

  function applyFontScale(s) {
    document.body.classList.remove('fs-0', 'fs-1', 'fs-2');
    document.body.classList.add('fs-' + s);
  }

  function fontBtnLabel() {
    if (ui.fontScale === 0) return 'A';
    if (ui.fontScale === 2) return 'A++';
    return 'A+';
  }

  function fmtText(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }

  let ui = {
    tab: 'cards',
    deckIdx: 0,
    cardIdx: 0,
    flipped: false,
    duelSub: 'duel',
    duelFilter: 'ROUND10',
    duelRoundIds: [],
    duelIdx: 0,
    duelSessionPicks: {},
    duelRoundDone: false,
    duelCombo: 0,
    trigFilter: 'ALL',
    trigSearch: '',
    quizFilter: 'ALL',
    qIdx: 0,
    pIdx: 0,
    pView: 'step',
    pStep: 0,
    fontScale: loadFontScale(),
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

  applyFontScale(ui.fontScale);

  function saveUiState() {
    if (!DATA) return;
    try {
      localStorage.setItem(LS_UI, JSON.stringify({
        tab: ui.tab,
        deckIdx: ui.deckIdx,
        cardIdx: ui.cardIdx,
        duelSub: ui.duelSub,
        duelFilter: ui.duelFilter,
        duelRoundIds: ui.duelRoundIds,
        duelIdx: ui.duelIdx,
        trigFilter: ui.trigFilter,
        quizFilter: ui.quizFilter,
        qIdx: ui.qIdx,
        pIdx: ui.pIdx,
        pView: ui.pView,
        pStep: ui.pStep,
        timerOn: ui.timerOn
      }));
    } catch (_) {}
  }

  function loadSavedUiState() {
    try {
      const raw = localStorage.getItem(LS_UI);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  if (localStorage.getItem(LS_THEME) === 'light') {
    document.body.classList.add('light');
  }

  let swReg = null;
  let swReloading = false;
  if ('serviceWorker' in navigator) {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (swReloading) return;
      swReloading = true;
      try {
        if (DATA) {
          saveUiState();
          saveProgress(false);
        }
      } catch (_) {}
      window.location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then(reg => {
          swReg = reg;
          reg.update().catch(() => {});
        })
        .catch(() => {});
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
      doneRules: parsed.doneRules || {},
      donePrinciples: parsed.donePrinciples || {},
      doneDuels: parsed.doneDuels || {},
      trickyDuels: parsed.trickyDuels || {},
      answers: parsed.answers || {},
      missedQs: parsed.missedQs || {},
      doneDays: parsed.doneDays || {},
      dailyActivity: parsed.dailyActivity || {},
      dailySeconds: parsed.dailySeconds || {},
      cardMeta: parsed.cardMeta || {},
      ruleMeta: parsed.ruleMeta || {},
      principleMeta: parsed.principleMeta || {},
      duelMeta: parsed.duelMeta || {},
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

    // Timestamp-aware merge for completed rules
    Object.keys({ ...a.doneRules, ...b.doneRules, ...a.ruleMeta, ...b.ruleMeta }).forEach(k => {
      const ta = a.ruleMeta[k] || 0;
      const tb = b.ruleMeta[k] || 0;
      if (ta > tb) {
        if (a.doneRules[k]) out.doneRules[k] = true;
        out.ruleMeta[k] = ta;
      } else if (tb > ta) {
        if (b.doneRules[k]) out.doneRules[k] = true;
        out.ruleMeta[k] = tb;
      } else {
        if (a.doneRules[k] || b.doneRules[k]) out.doneRules[k] = true;
        if (ta) out.ruleMeta[k] = ta;
      }
    });

    // Timestamp-aware merge for understood principles
    Object.keys({ ...a.donePrinciples, ...b.donePrinciples, ...a.principleMeta, ...b.principleMeta }).forEach(k => {
      const ta = a.principleMeta[k] || 0;
      const tb = b.principleMeta[k] || 0;
      if (ta > tb) {
        if (a.donePrinciples[k]) out.donePrinciples[k] = true;
        out.principleMeta[k] = ta;
      } else if (tb > ta) {
        if (b.donePrinciples[k]) out.donePrinciples[k] = true;
        out.principleMeta[k] = tb;
      } else {
        if (a.donePrinciples[k] || b.donePrinciples[k]) out.donePrinciples[k] = true;
        if (ta) out.principleMeta[k] = ta;
      }
    });

    // Timestamp-aware merge for binary duels
    Object.keys({ ...a.doneDuels, ...b.doneDuels, ...a.trickyDuels, ...b.trickyDuels, ...a.duelMeta, ...b.duelMeta }).forEach(k => {
      const ta = a.duelMeta[k] || 0;
      const tb = b.duelMeta[k] || 0;
      if (ta > tb) {
        if (a.doneDuels[k]) out.doneDuels[k] = true;
        if (a.trickyDuels[k]) out.trickyDuels[k] = true;
        out.duelMeta[k] = ta;
      } else if (tb > ta) {
        if (b.doneDuels[k]) out.doneDuels[k] = true;
        if (b.trickyDuels[k]) out.trickyDuels[k] = true;
        out.duelMeta[k] = tb;
      } else {
        if (a.doneDuels[k] || b.doneDuels[k]) out.doneDuels[k] = true;
        if ((a.trickyDuels[k] || b.trickyDuels[k]) && !out.doneDuels[k]) out.trickyDuels[k] = true;
        if (ta) out.duelMeta[k] = ta;
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
    windowFocused = true;
  }

  ['pointerdown', 'touchstart', 'keydown', 'scroll'].forEach(evt => {
    window.addEventListener(evt, markUserInteraction, { passive: true, capture: true });
  });

  window.addEventListener('focus', () => {
    windowFocused = true;
    lastActiveAt = Date.now();
    if (DATA && syncCfg && (Date.now() - lastSyncPullAt > 20000)) {
      syncWithCloud({ silent: true });
    }
  });

  window.addEventListener('blur', () => {
    windowFocused = false;
    if (DATA) saveUiState();
    if (unsavedSecTicks > 0) saveProgress(false);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      windowFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      lastActiveAt = Date.now();
      if (swReg) swReg.update().catch(() => {});
      if (DATA && syncCfg && (Date.now() - lastSyncPullAt > 15000)) {
        syncWithCloud({ silent: true });
      }
    } else {
      windowFocused = false;
      if (DATA) saveUiState();
      if (unsavedSecTicks > 0) saveProgress(false);
      if (syncDirty && syncCfg) flushCloudPushKeepalive();
    }
  });

  window.addEventListener('pagehide', () => {
    if (DATA) saveUiState();
    if (unsavedSecTicks > 0) saveProgress(false);
    if (syncDirty && syncCfg) flushCloudPushKeepalive();
  });

  // Silent background study-time tracker (pauses immediately on tab switch, unfocused window, or 60s idle)
  setInterval(() => {
    if (!DATA) return;
    if (document.visibilityState !== 'visible') return;
    if (!windowFocused || (typeof document.hasFocus === 'function' && !document.hasFocus())) return;
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

  async function getFirebaseDocUrl() {
    const bytes = new TextEncoder().encode('cadence-sync-doc:' + SESSION_PASS.trim());
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIREBASE_COLLECTION}/${hex}`;
  }

  async function loadLegacyGistCfg() {
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

  async function pullLegacyGistOnce() {
    const legacy = await loadLegacyGistCfg();
    if (!legacy) return;
    try {
      const res = await fetch(`https://api.github.com/gists/${legacy.gistId}`, {
        cache: 'no-store',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${legacy.token}`
        }
      });
      if (!res.ok) return;
      const gist = await res.json();
      const content = gist.files && gist.files[SYNC_FILENAME] && gist.files[SYNC_FILENAME].content;
      if (content) {
        const remoteData = await decryptJsonWithPasscode(JSON.parse(content), SESSION_PASS);
        progress = mergeProgress(progress, remoteData);
        saveProgress(false);
      }
    } catch (_) {}
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
      const docUrl = await getFirebaseDocUrl();
      const encOut = await encryptWithPasscode(progress, SESSION_PASS, 100000);
      syncDirty = false;
      fetch(docUrl, {
        method: 'PATCH',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            payload: { stringValue: JSON.stringify(encOut) },
            updatedAt: { integerValue: String(Date.now()) }
          }
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
      const docUrl = await getFirebaseDocUrl();
      const getRes = await fetch(docUrl, { cache: 'no-store' });
      if (!getRes.ok && getRes.status !== 404) {
        throw new Error(`HTTP ${getRes.status}`);
      }

      const beforeSig = JSON.stringify([
        progress.doneCards,
        progress.flaggedCards,
        progress.doneRules,
        progress.donePrinciples,
        progress.doneDuels,
        progress.trickyDuels,
        progress.answers,
        progress.doneDays
      ]);

      if (getRes.ok) {
        const doc = await getRes.json();
        const payloadStr = doc && doc.fields && doc.fields.payload && doc.fields.payload.stringValue;
        if (payloadStr) {
          try {
            const remoteEnc = JSON.parse(payloadStr);
            const remoteData = await decryptJsonWithPasscode(remoteEnc, SESSION_PASS);
            progress = mergeProgress(progress, remoteData);
            saveProgress(false);
          } catch (_) {}
        }
      }

      const encOut = await encryptWithPasscode(progress, SESSION_PASS, 100000);
      const patchRes = await fetch(docUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            payload: { stringValue: JSON.stringify(encOut) },
            updatedAt: { integerValue: String(Date.now()) }
          }
        })
      });
      if (!patchRes.ok) throw new Error(`HTTP ${patchRes.status}`);

      const afterSig = JSON.stringify([
        progress.doneCards,
        progress.flaggedCards,
        progress.doneRules,
        progress.donePrinciples,
        progress.doneDuels,
        progress.trickyDuels,
        progress.answers,
        progress.doneDays
      ]);

      lastSyncPullAt = Date.now();
      ui.lastSyncedAt = Date.now();
      syncDirty = false;
      ui.syncStatus = 'ok';
      if (!silent) ui.syncMsg = '✓ Synced with Firebase!';

      if (isInitial && afterSig !== beforeSig) {
        const curCards = getActiveCards();
        if (typeof ui.deckIdx === 'number' && curCards[ui.cardIdx] && progress.doneCards[curCards[ui.cardIdx].id]) {
          const cardTarget = findCurrentTarget();
          ui.deckIdx = cardTarget.deckIdx;
          ui.cardIdx = cardTarget.cardIdx;
          ui.flipped = false;
        }
        const curQs = getActiveQuestions();
        if (ui.quizFilter !== 'MISSED' && curQs[ui.qIdx] && progress.answers[curQs[ui.qIdx].id] !== undefined) {
          const qt = findQuizResumeTarget();
          ui.quizFilter = qt.quizFilter;
          ui.qIdx = qt.qIdx;
        }
        if (DATA && Array.isArray(DATA.principles) && DATA.principles[ui.pIdx] && progress.donePrinciples[DATA.principles[ui.pIdx].id]) {
          const nextP = DATA.principles.findIndex(p => !progress.donePrinciples[p.id]);
          if (nextP !== -1) ui.pIdx = nextP;
        }
        saveUiState();
      }

      const activeId = document.activeElement && document.activeElement.id;
      const isTyping = activeId === 'trig-search' || activeId === 'manual-sync-input';
      if ((!silent || ui.showSyncDrawer || afterSig !== beforeSig) && !isTyping) {
        renderApp();
      } else {
        updateSyncHeaderBtn();
      }
    } catch (_) {
      ui.syncStatus = 'err';
      if (!silent) ui.syncMsg = 'Sync error — check connection or Firestore rules.';
      if (!silent || ui.showSyncDrawer) renderApp();
      else updateSyncHeaderBtn();
    } finally {
      syncInFlight = false;
    }
  }

  async function initSyncAfterUnlock() {
    if (!SESSION_PASS) return;
    pendingPairCode = null;
    syncCfg = { mode: 'firebase' };
    updateSyncHeaderBtn();
    await pullLegacyGistOnce();
    await syncWithCloud({ silent: true, isInitial: true });
  }

  function shuffleCopy(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function dealChillRound() {
    const all = (DATA && Array.isArray(DATA.duels)) ? DATA.duels : [];
    if (!all.length) {
      ui.duelRoundIds = [];
      ui.duelIdx = 0;
      ui.duelSessionPicks = {};
      ui.duelRoundDone = false;
      return;
    }
    const tricky = shuffleCopy(all.filter(d => !!progress.trickyDuels[d.id]));
    const unseen = shuffleCopy(all.filter(d => !progress.doneDuels[d.id] && !progress.trickyDuels[d.id]));
    const done = shuffleCopy(all.filter(d => !!progress.doneDuels[d.id] && !progress.trickyDuels[d.id]));
    const ordered = [
      ...tricky.slice(0, 3),
      ...unseen,
      ...tricky.slice(3),
      ...done
    ].slice(0, 10);

    ui.duelRoundIds = ordered.map(d => d.id);
    ui.duelIdx = 0;
    ui.duelSessionPicks = {};
    ui.duelRoundDone = false;
  }

  function getActiveDuels() {
    const all = (DATA && Array.isArray(DATA.duels)) ? DATA.duels : [];
    if (!all.length) return [];
    if (ui.duelFilter === 'ROUND10') {
      if (!Array.isArray(ui.duelRoundIds) || !ui.duelRoundIds.length) {
        dealChillRound();
      }
      const byId = {};
      all.forEach(d => { byId[d.id] = d; });
      const resolved = ui.duelRoundIds.map(id => byId[id]).filter(Boolean);
      if (!resolved.length) {
        dealChillRound();
        return ui.duelRoundIds.map(id => byId[id]).filter(Boolean);
      }
      return resolved;
    }
    if (ui.duelFilter === 'ALL') return all;
    if (ui.duelFilter === 'TRICKY') {
      return all.filter(d => !!progress.trickyDuels[d.id] || ui.duelSessionPicks[d.id] !== undefined);
    }
    return all.filter(d => d.sec === ui.duelFilter);
  }

  function getQuizSets() {
    if (!DATA || !Array.isArray(DATA.questions)) return [];
    const seen = new Set();
    const sets = [];
    DATA.questions.forEach(q => {
      const s = q.set || q.sec;
      if (s && !seen.has(s)) {
        seen.add(s);
        sets.push(s);
      }
    });
    return sets;
  }

  function findQuizResumeTarget() {
    if (!DATA || !Array.isArray(DATA.questions) || !DATA.questions.length) {
      return { quizFilter: 'ALL', qIdx: 0 };
    }
    const sets = getQuizSets();
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      const qs = DATA.questions.filter(q => (q.set || q.sec) === s);
      const openIdx = qs.findIndex(q => progress.answers[q.id] === undefined);
      if (openIdx !== -1) {
        return { quizFilter: s, qIdx: openIdx };
      }
    }
    return { quizFilter: 'ALL', qIdx: 0 };
  }

  function jumpToResumeTarget(restoreSavedUi = false) {
    const cardTarget = findCurrentTarget();
    const quizTarget = findQuizResumeTarget();
    ui.deckIdx = cardTarget.deckIdx;
    ui.cardIdx = cardTarget.cardIdx;
    ui.flipped = false;
    ui.quizFilter = quizTarget.quizFilter;
    ui.qIdx = quizTarget.qIdx;
    if (DATA && Array.isArray(DATA.principles) && DATA.principles.length) {
      const nextP = DATA.principles.findIndex(p => !progress.donePrinciples[p.id]);
      ui.pIdx = nextP !== -1 ? nextP : 0;
    }
    if (!ui.duelRoundIds || !ui.duelRoundIds.length) {
      dealChillRound();
    }

    if (restoreSavedUi) {
      const saved = loadSavedUiState();
      if (saved && typeof saved === 'object') {
        if (saved.tab === 'triggers') {
          ui.tab = 'duel';
        } else if (['cards', 'duel', 'quiz', 'principles'].includes(saved.tab)) {
          ui.tab = saved.tab;
        }
        if (saved.duelSub === 'duel' || saved.duelSub === 'rules') {
          ui.duelSub = saved.duelSub;
        }
        if (typeof saved.duelFilter === 'string') {
          ui.duelFilter = saved.duelFilter;
        }
        if (Array.isArray(saved.duelRoundIds) && saved.duelRoundIds.length) {
          ui.duelRoundIds = saved.duelRoundIds;
        }
        const activeDuels = getActiveDuels();
        if (typeof saved.duelIdx === 'number' && saved.duelIdx >= 0 && saved.duelIdx < activeDuels.length) {
          ui.duelIdx = saved.duelIdx;
        }
        if (typeof saved.timerOn === 'boolean') {
          ui.timerOn = saved.timerOn;
        }
        if (typeof saved.trigFilter === 'string') {
          ui.trigFilter = saved.trigFilter;
        }
        if (saved.deckIdx === 'flagged' || (typeof saved.deckIdx === 'number' && DATA.decks[saved.deckIdx])) {
          ui.deckIdx = saved.deckIdx;
          const cards = getActiveCards();
          if (typeof saved.cardIdx === 'number' && saved.cardIdx >= 0 && saved.cardIdx < cards.length) {
            ui.cardIdx = saved.cardIdx;
          }
        }
        if (typeof saved.pIdx === 'number' && DATA.principles && saved.pIdx >= 0 && saved.pIdx < DATA.principles.length) {
          ui.pIdx = saved.pIdx;
        }
        if (saved.pView === 'step' || saved.pView === 'full') {
          ui.pView = saved.pView;
        }
        if (typeof saved.pStep === 'number' && saved.pStep >= 0 && saved.pStep <= 3) {
          ui.pStep = saved.pStep;
        }
        const validSets = getQuizSets();
        if (saved.quizFilter === 'ALL' || saved.quizFilter === 'MISSED' || validSets.includes(saved.quizFilter)) {
          ui.quizFilter = saved.quizFilter;
          const qs = getActiveQuestions();
          if (typeof saved.qIdx === 'number' && saved.qIdx >= 0 && saved.qIdx < qs.length) {
            // If saved on ALL Q1 when Q1 is already answered, jump to next unanswered instead of Q1
            if (ui.quizFilter === 'ALL' && saved.qIdx === 0 && qs[0] && progress.answers[qs[0].id] !== undefined) {
              const openAll = qs.findIndex(item => progress.answers[item.id] === undefined);
              ui.qIdx = openAll !== -1 ? openAll : 0;
            } else {
              ui.qIdx = saved.qIdx;
            }
          }
        }
      }
    }
    saveUiState();
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
        jumpToResumeTarget(true);
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
    return DATA.questions.filter(q => (q.set || q.sec) === ui.quizFilter);
  }

  function startQuizTimerIfNeeded() {
    clearInterval(ui.timerHandle);
    if (ui.tab !== 'quiz' || !ui.timerOn) return;
    const qs = getActiveQuestions();
    const cur = qs[ui.qIdx];
    if (!cur || progress.answers[cur.id] !== undefined) return;
    ui.timerHandle = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!windowFocused || (typeof document.hasFocus === 'function' && !document.hasFocus())) return;
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

  function cycleFontScale() {
    ui.fontScale = (ui.fontScale + 1) % 3;
    try { localStorage.setItem(LS_FONT, String(ui.fontScale)); } catch (_) {}
    applyFontScale(ui.fontScale);
    const btn = document.getElementById('font-btn');
    if (btn) btn.textContent = fontBtnLabel();
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
      const allDone = DATA.questions.length > 0 && allAnswered === DATA.questions.length;
      const sets = getQuizSets();
      const activeQs = getActiveQuestions();
      const activeLabel = ui.quizFilter === 'ALL'
        ? 'All Sections'
        : (ui.quizFilter === 'MISSED' ? 'Missed Items' : ui.quizFilter);

      const qPillsHtml = activeQs.length
        ? `
          <div class="day-log-row" style="gap:8px;">
            <div style="font-size:12px;font-weight:800;color:var(--muted);letter-spacing:0.03em;">QUESTIONS IN ${activeLabel.toUpperCase()} (TAP TO JUMP)</div>
            <div class="q-jump-grid">
              ${activeQs.map((item, idx) => {
                const ans = progress.answers[item.id];
                let cls = 'q-jump-pill';
                let mark = '';
                if (ans !== undefined) {
                  if (ans === item.ans) { cls += ' done'; mark = '✓ '; }
                  else { cls += ' wrong'; mark = '✗ '; }
                }
                if (idx === ui.qIdx) cls += ' current';
                return `<button class="${cls}" data-pick-qidx="${idx}">${mark}${idx + 1}</button>`;
              }).join('')}
            </div>
          </div>
        `
        : '';

      const setRows = sets.map(s => {
        const list = DATA.questions.filter(q => (q.set || q.sec) === s);
        const ansCnt = list.filter(q => progress.answers[q.id] !== undefined).length;
        const complete = list.length > 0 && ansCnt === list.length;
        const active = ui.quizFilter === s;
        const prefix = complete ? '✓ ' : (active ? '▶ ' : '');
        return `
          <button class="picker-item ${active ? 'active' : ''} ${complete && !active ? 'done-item' : ''}" data-pick-qfilter="${s}">
            <div style="font-size:14.5px;font-weight:700;">${prefix}${s}</div>
            <span style="font-size:13px;font-weight:700;color:${complete ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">${ansCnt}/${list.length}</span>
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
              ${qPillsHtml}
              <button class="picker-item ${ui.quizFilter === 'ALL' ? 'active' : ''} ${allDone && ui.quizFilter !== 'ALL' ? 'done-item' : ''}" data-pick-qfilter="ALL">
                <div style="font-size:14.5px;font-weight:700;">${allDone ? '✓ ' : (ui.quizFilter === 'ALL' ? '▶ ' : '')}All Sections</div>
                <span style="font-size:13px;font-weight:700;color:${allDone ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">${allAnswered}/${DATA.questions.length}</span>
              </button>
              <button class="picker-item ${ui.quizFilter === 'MISSED' ? 'active' : ''}" data-pick-qfilter="MISSED">
                <div style="font-size:14.5px;font-weight:700;">${ui.quizFilter === 'MISSED' ? '▶ ' : ''}🔁 Missed Items</div>
                <span style="font-size:13px;font-weight:700;color:var(--muted);white-space:nowrap;">${missedCount}</span>
              </button>
              ${setRows}
            </div>
          </div>
        </div>
      `;
    }

    if (ui.picker === 'trig') {
      const secs = ['ALL', 'Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];
      const curTargets = DATA.triggers
        .map((t, idx) => ({ t, id: t.id || ('r_' + idx) }))
        .filter(item => ui.trigFilter === 'ALL' || item.t.sec === ui.trigFilter);
      const canMarkRulesDone = curTargets.some(item => !progress.doneRules[item.id]);

      const rows = secs.map(s => {
        const indices = [];
        DATA.triggers.forEach((t, idx) => {
          if (s === 'ALL' || t.sec === s) indices.push(t.id || ('r_' + idx));
        });
        const doneCnt = indices.filter(id => !!progress.doneRules[id]).length;
        const complete = indices.length > 0 && doneCnt === indices.length;
        const active = ui.trigFilter === s;
        const prefix = complete ? '✓ ' : (active ? '▶ ' : '');
        return `
          <button class="picker-item ${active ? 'active' : ''} ${complete && !active ? 'done-item' : ''}" data-pick-trigsec="${s}">
            <div style="font-size:14.5px;font-weight:700;">${prefix}${s === 'ALL' ? 'All Sections' : s}</div>
            <span style="font-size:13px;font-weight:700;color:${complete ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">${doneCnt}/${indices.length}</span>
          </button>
        `;
      }).join('');

      return `
        <div class="drawer-backdrop" id="picker-backdrop">
          <div class="drawer-sheet" role="dialog" aria-label="Filter Rules">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="font-size:18px;font-weight:800;">Filter Rules</div>
              <div style="display:flex;align-items:center;gap:7px;">
                ${canMarkRulesDone ? `<button class="icon-btn" id="mark-rules-btn" style="padding:7px 10px;font-size:12.5px;">✓ Mark ${ui.trigFilter === 'ALL' ? 'All' : ui.trigFilter} Done</button>` : ''}
                <button class="icon-btn" id="picker-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
              </div>
            </div>
            <div class="picker-list">
              ${rows}
            </div>
          </div>
        </div>
      `;
    }

    if (ui.picker === 'principle') {
      const list = DATA.principles || [];
      const doneCnt = list.filter(p => !!progress.donePrinciples[p.id]).length;
      const rows = list.map((p, idx) => {
        const done = !!progress.donePrinciples[p.id];
        const active = ui.pIdx === idx;
        const prefix = done ? '✓ ' : (active ? '▶ ' : '');
        return `
          <button class="picker-item ${active ? 'active' : ''} ${done && !active ? 'done-item' : ''}" data-pick-principle="${idx}">
            <div style="min-width:0;">
              <div style="font-size:14.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${prefix}${p.num}. ${p.title}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:2px;">${p.sec}</div>
            </div>
            <span style="font-size:13px;font-weight:700;color:${done ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">${done ? '✓' : '○'}</span>
          </button>
        `;
      }).join('');

      return `
        <div class="drawer-backdrop" id="picker-backdrop">
          <div class="drawer-sheet" role="dialog" aria-label="First Principles Modules">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="font-size:18px;font-weight:800;">First Principles (${doneCnt}/${list.length})</div>
              <button class="icon-btn" id="picker-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
            </div>
            <div class="picker-list">
              ${rows}
            </div>
          </div>
        </div>
      `;
    }

    if (ui.picker === 'duel') {
      const allDuels = DATA.duels || [];
      const doneTotal = allDuels.filter(d => !!progress.doneDuels[d.id]).length;
      const trickyTotal = allDuels.filter(d => !!progress.trickyDuels[d.id]).length;
      const secs = ['Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];

      const secRows = secs.map(s => {
        const list = allDuels.filter(d => d.sec === s);
        const cnt = list.filter(d => !!progress.doneDuels[d.id]).length;
        const complete = list.length > 0 && cnt === list.length;
        const active = ui.duelFilter === s;
        const prefix = complete ? '✓ ' : (active ? '▶ ' : '');
        return `
          <button class="picker-item ${active ? 'active' : ''} ${complete && !active ? 'done-item' : ''}" data-pick-duelfilter="${s}">
            <div style="font-size:14.5px;font-weight:700;">${prefix}${s}</div>
            <span style="font-size:13px;font-weight:700;color:${complete ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">${cnt}/${list.length}</span>
          </button>
        `;
      }).join('');

      return `
        <div class="drawer-backdrop" id="picker-backdrop">
          <div class="drawer-sheet" role="dialog" aria-label="Select Duel Mode">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="font-size:18px;font-weight:800;">⚔️ Quick Duel Mode</div>
              <div style="display:flex;align-items:center;gap:7px;">
                <button class="icon-btn" id="reshuffle-chill-btn" style="padding:7px 10px;font-size:12.5px;">↻ Fresh 10</button>
                <button class="icon-btn" id="picker-close-btn" aria-label="Close" style="padding:7px 11px;font-size:14px;">✕</button>
              </div>
            </div>
            <div class="picker-list">
              <button class="picker-item ${ui.duelFilter === 'ROUND10' ? 'active' : ''}" data-pick-duelfilter="ROUND10">
                <div>
                  <div style="font-size:14.5px;font-weight:700;">${ui.duelFilter === 'ROUND10' ? '▶ ' : ''}☕ 10-Pick Chill Round</div>
                  <div style="font-size:12px;color:var(--muted);margin-top:2px;">Bite-sized evening mix (unseen + tricky first)</div>
                </div>
                <span style="font-size:13px;font-weight:700;color:var(--primary);white-space:nowrap;">10 picks</span>
              </button>
              <button class="picker-item ${ui.duelFilter === 'TRICKY' ? 'active' : ''}" data-pick-duelfilter="TRICKY">
                <div style="font-size:14.5px;font-weight:700;">${ui.duelFilter === 'TRICKY' ? '▶ ' : ''}🔁 Tricky Picks</div>
                <span style="font-size:13px;font-weight:700;color:${trickyTotal ? 'var(--warn)' : 'var(--muted)'};white-space:nowrap;">${trickyTotal}</span>
              </button>
              <button class="picker-item ${ui.duelFilter === 'ALL' ? 'active' : ''} ${doneTotal === allDuels.length && allDuels.length > 0 && ui.duelFilter !== 'ALL' ? 'done-item' : ''}" data-pick-duelfilter="ALL">
                <div style="font-size:14.5px;font-weight:700;">${doneTotal === allDuels.length && allDuels.length > 0 ? '✓ ' : (ui.duelFilter === 'ALL' ? '▶ ' : '')}⚡ All Duels</div>
                <span style="font-size:13px;font-weight:700;color:${doneTotal === allDuels.length && allDuels.length > 0 ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">${doneTotal}/${allDuels.length}</span>
              </button>
              ${secRows}
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

    const autoSyncHtml = `
      <div class="day-log-row" style="gap:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span style="font-size:14.5px;font-weight:800;color:var(--success);">🟢 Firebase Auto-Sync Active</span>
          <span style="font-size:12.5px;font-weight:600;color:var(--muted);">${ui.syncStatus === 'syncing' ? 'Syncing...' : `Synced • ${lastTimeStr}`}</span>
        </div>
        <div style="font-size:13px;color:var(--muted);line-height:1.4;">
          Automatic across any phone or laptop — just open Cadence and enter your access key. No pairing links or extra keys needed.
        </div>
        <button class="primary-btn" id="sync-now-btn" style="padding:11px 10px;font-size:14px;width:100%;" ${ui.syncStatus === 'syncing' ? 'disabled' : ''}>
          ${ui.syncStatus === 'syncing' ? 'Syncing...' : '↻ Sync Now'}
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

          <button class="sec-btn" id="hard-refresh-btn" style="padding:10px;font-size:13.5px;width:100%;">↻ Check for App Update / Refresh</button>

          <div style="font-size:12px;color:var(--muted);line-height:1.4;">
            🔒 End-to-end encrypted locally with AES-256-GCM using your access key before leaving this device.
          </div>
        </div>
      </div>
    `;
  }

  async function forceAppRefresh() {
    if (swReloading) return;
    try {
      if (DATA) {
        saveUiState();
        saveProgress(false);
      }
      if (DATA && syncCfg && SESSION_PASS && navigator.onLine !== false) {
        await Promise.race([
          syncWithCloud({ silent: true }),
          new Promise(res => setTimeout(res, 2500))
        ]);
      }
      if (navigator.onLine !== false && 'caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if (swReg) {
        await swReg.update().catch(() => {});
      }
    } catch (_) {}
    swReloading = true;
    window.location.reload();
  }

  function renderApp() {
    if (!DATA) return renderLock();
    saveUiState();
    const root = document.getElementById('root');
    const totalCards = DATA.decks.reduce((s, d) => s + d.cards.length, 0);
    const totalDoneCards = DATA.decks.reduce((s, d) => s + deckDoneCount(d), 0);
    const stats = computeStreakStats();

    let mainHtml = '';
    if (ui.tab === 'cards') mainHtml = renderCardsTab();
    else if (ui.tab === 'duel' || ui.tab === 'triggers') mainHtml = renderDuelTab();
    else if (ui.tab === 'quiz') mainHtml = renderQuizTab();
    else mainHtml = renderPrinciplesTab();

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
          <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
            <button class="streak-chip ${stats.studiedToday ? '' : 'cold'}" id="streak-open-btn" title="Tap for daily log">
              <span id="streak-count-label">🔥 ${stats.streak}d</span>
            </button>
            <button class="icon-btn" id="sync-open-btn" title="Cross-device sync" style="${syncBtnStyle()}">${syncBtnLabel()}</button>
            <button class="icon-btn" id="font-btn" title="Text size (tap to cycle A / A+ / A++)" style="padding:7px 9px;font-weight:800;font-size:13px;">${fontBtnLabel()}</button>
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
            <button class="nav-tab ${ui.tab === 'duel' || ui.tab === 'triggers' ? 'active' : ''}" data-tab="duel">
              <span style="font-size:18px;">⚔️</span>
              <span>Duel</span>
            </button>
            <button class="nav-tab ${ui.tab === 'quiz' ? 'active' : ''}" data-tab="quiz">
              <span style="font-size:18px;">🎯</span>
              <span>Practice</span>
            </button>
            <button class="nav-tab ${ui.tab === 'principles' ? 'active' : ''}" data-tab="principles">
              <span style="font-size:18px;">🧠</span>
              <span>Principles</span>
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

        <div class="card-body">${fmtText(ui.flipped ? c.a : c.q)}</div>

        <div style="display:flex;flex-direction:column;gap:10px;">
          ${ui.flipped ? `<div class="card-tip"><strong>⚡ Key Rule:</strong> ${fmtText(c.tip)}</div>` : ''}
          <div style="text-align:center;font-size:13.5px;font-weight:600;color:var(--primary);">
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

  function renderDuelTab() {
    if (ui.duelSub === 'rules') {
      return renderTriggersTab();
    }

    const allDuels = DATA.duels || [];
    const doneTotal = allDuels.filter(d => !!progress.doneDuels[d.id]).length;
    const trickyCount = allDuels.filter(d => !!progress.trickyDuels[d.id]).length;
    const list = getActiveDuels();

    let dropLabel = '';
    if (ui.duelFilter === 'ROUND10') {
      dropLabel = `☕ Chill Round (${Math.min(ui.duelIdx + 1, Math.max(1, list.length))}/${list.length || 10})`;
    } else if (ui.duelFilter === 'TRICKY') {
      dropLabel = `🔁 Tricky Picks (${list.length})`;
    } else if (ui.duelFilter === 'ALL') {
      dropLabel = `⚡ All Duels (${doneTotal}/${allDuels.length})`;
    } else {
      const secDone = list.filter(d => !!progress.doneDuels[d.id]).length;
      const complete = list.length > 0 && secDone === list.length;
      dropLabel = `${complete ? '✓ ' : ''}${ui.duelFilter} (${secDone}/${list.length})`;
    }

    const comboHtml = ui.duelCombo >= 2
      ? `<span class="combo-pill">⚡ ${ui.duelCombo}x</span>`
      : '';

    const topBarHtml = `
      <div class="selector-bar">
        <button class="dropdown-btn" id="open-duel-picker">
          <span class="dropdown-btn-label">${dropLabel}</span>
          <span class="dropdown-caret">▾</span>
        </button>
        ${comboHtml}
        <button class="icon-btn" id="toggle-duel-rules-btn" style="padding:8.5px 11px;font-size:13.5px;font-weight:700;">📜 Rules</button>
      </div>
    `;

    if (ui.duelFilter === 'ROUND10' && ui.duelRoundDone && list.length > 0) {
      const roundHits = list.filter(item => ui.duelSessionPicks[item.id] === item.ans).length;
      return `
        ${topBarHtml}
        <div class="duel-prompt-card" style="gap:14px;">
          <div style="font-size:34px;line-height:1;">☕✨</div>
          <div style="font-size:22px;font-weight:800;">Chill Round Complete!</div>
          <div style="font-size:16px;color:var(--muted);line-height:1.5;max-width:420px;">
            You nailed <strong style="color:var(--success);">${roundHits}/${list.length}</strong> quick picks this round.<br/>
            Overall bank mastered: <strong>${doneTotal}/${allDuels.length}</strong>
          </div>
          <div style="display:flex;flex-direction:column;gap:9px;width:100%;max-width:320px;margin-top:4px;">
            <button class="primary-btn" id="duel-new-round-btn" style="padding:14px 16px;">⚡ Deal Another 10</button>
            ${trickyCount > 0 ? `<button class="sec-btn" id="duel-go-tricky-btn" style="padding:12px 14px;">🔁 Review ${trickyCount} Tricky ${trickyCount === 1 ? 'Pick' : 'Picks'}</button>` : ''}
          </div>
        </div>
      `;
    }

    if (!list.length) {
      return `
        ${topBarHtml}
        <div class="duel-prompt-card" style="gap:12px;">
          <div style="font-size:20px;font-weight:800;">✨ Zero tricky duels left!</div>
          <div style="color:var(--muted);font-size:15.5px;max-width:380px;">You’ve cleared every tricky binary pick. Ready for a fresh 10-card chill round?</div>
          <button class="primary-btn" id="duel-new-round-btn" style="padding:13px 18px;margin-top:4px;">☕ Deal 10-Pick Chill Round</button>
        </div>
      `;
    }

    if (ui.duelIdx >= list.length) ui.duelIdx = 0;
    const d = list[ui.duelIdx];
    const picked = ui.duelSessionPicks[d.id];
    const answered = picked !== undefined;
    const isMastered = !!progress.doneDuels[d.id];

    const dotsHtml = list.map((item, idx) => {
      let cls = 'cdot';
      const sPick = ui.duelSessionPicks[item.id];
      if (sPick !== undefined) {
        cls += sPick === item.ans ? ' done' : ' wrong';
      } else if (ui.duelFilter !== 'ROUND10' && progress.doneDuels[item.id]) {
        cls += ' done';
      }
      if (idx === ui.duelIdx) cls += ' current';
      return `<div class="${cls}" data-dueldot="${idx}"></div>`;
    }).join('');

    const tileCls = idx => {
      if (!answered) return 'duel-tile';
      if (idx === d.ans) return 'duel-tile win';
      if (idx === picked && idx !== d.ans) return 'duel-tile miss';
      return 'duel-tile dim';
    };

    const tileBadge = idx => {
      if (!answered) return '';
      if (idx === d.ans) return `<span style="font-size:12.5px;font-weight:800;color:var(--success);">✓ Pick</span>`;
      if (idx === picked) return `<span style="font-size:12px;font-weight:700;color:var(--warn);">Not quite</span>`;
      return '';
    };

    const feedbackHtml = answered
      ? `
        <div class="duel-feedback" style="border-color:${picked === d.ans ? 'var(--success)' : 'var(--warn)'};">
          <strong style="color:${picked === d.ans ? 'var(--success)' : 'var(--warn)'};">${picked === d.ans ? '✓ Spot on:' : '💡 Quick rule:'}</strong>
          <span style="margin-left:4px;">${fmtText(d.why)}</span>
        </div>
      `
      : '';

    let centerActionHtml = `<button class="sec-btn" disabled style="padding:14px 10px;opacity:0.7;">Tap A or B above</button>`;
    if (answered) {
      if (ui.duelFilter === 'ROUND10' && ui.duelIdx === list.length - 1) {
        centerActionHtml = `<button class="success-btn" id="duel-finish-round" style="padding:14px 10px;">🎉 Finish Round →</button>`;
      } else if (ui.duelIdx < list.length - 1) {
        centerActionHtml = `<button class="primary-btn" id="duel-next-main" style="padding:14px 10px;">Next Duel →</button>`;
      } else {
        centerActionHtml = `<button class="success-btn" id="duel-new-round-btn" style="padding:14px 10px;">☕ Deal Fresh 10 →</button>`;
      }
    }

    return `
      ${topBarHtml}
      <div class="card-dots">${dotsHtml}</div>

      <div class="duel-stage">
        <div class="duel-prompt-card ${isMastered ? 'done-card' : ''}">
          <span class="badge" style="${isMastered ? 'color:var(--success);' : ''}">${isMastered ? '✓ ' : ''}${d.sec} • ${ui.duelIdx + 1}/${list.length}</span>
          <div class="duel-prompt-text">${fmtText(d.prompt)}</div>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;">
          <div class="duel-tiles">
            <button class="${tileCls(0)}" data-duel-pick="0">
              <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:6px;">
                <span style="font-size:12px;font-weight:800;color:var(--muted);">A</span>
                ${tileBadge(0)}
              </div>
              <div class="duel-tile-label">${fmtText(d.a)}</div>
            </button>
            <button class="${tileCls(1)}" data-duel-pick="1">
              <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:6px;">
                <span style="font-size:12px;font-weight:800;color:var(--muted);">B</span>
                ${tileBadge(1)}
              </div>
              <div class="duel-tile-label">${fmtText(d.b)}</div>
            </button>
          </div>

          ${feedbackHtml}
        </div>
      </div>

      <div class="thumb-controls">
        <button class="sec-btn" id="duel-prev" style="padding:14px 10px;" ${ui.duelIdx === 0 ? 'disabled' : ''}>← Prev</button>
        ${centerActionHtml}
        <button class="sec-btn" id="duel-next" style="padding:14px 10px;" ${ui.duelIdx === list.length - 1 ? 'disabled' : ''}>Skip →</button>
      </div>
    `;
  }

  function renderTriggersTab() {
    const q = ui.trigSearch.toLowerCase().trim();
    const indexed = DATA.triggers.map((t, idx) => ({ t, idx, id: t.id || ('r_' + idx) }));
    const secScope = indexed.filter(item => ui.trigFilter === 'ALL' || item.t.sec === ui.trigFilter);
    const secDoneCnt = secScope.filter(item => !!progress.doneRules[item.id]).length;
    const secComplete = secScope.length > 0 && secDoneCnt === secScope.length;

    const list = secScope.filter(item => {
      if (!q) return true;
      return (item.t.cue + ' ' + item.t.pick + ' ' + item.t.avoid).toLowerCase().includes(q);
    });

    const secs = ['Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];
    const curSecPos = secs.indexOf(ui.trigFilter);
    const nextSec = curSecPos >= 0 && curSecPos < secs.length - 1 ? secs[curSecPos + 1] : null;

    const items = list.map(({ t, id }) => {
      const isDone = !!progress.doneRules[id];
      return `
        <div class="trigger-card" style="${isDone ? 'border-color:rgba(16,185,129,0.55);' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span class="badge" style="${isDone ? 'color:var(--success);' : ''}">${isDone ? '✓ ' : ''}${t.sec}</span>
            <button class="icon-btn" data-toggle-rule="${id}" style="padding:5px 10px;font-size:12.5px;${isDone ? 'border-color:rgba(16,185,129,0.55);color:var(--success);background:var(--success-bg);' : ''}">
              ${isDone ? '✓ Done' : '○ Mark Read'}
            </button>
          </div>
          <div class="rule-cue">“${fmtText(t.cue)}”</div>
          <div class="box-win">
            <div style="font-size:12.5px;font-weight:800;color:var(--success);margin-bottom:5px;">✅ PICK</div>
            <div class="rule-pick">${fmtText(t.pick)}</div>
          </div>
          <div class="box-avoid">
            <div style="font-size:12.5px;font-weight:800;color:var(--danger);margin-bottom:5px;">❌ AVOID</div>
            <div class="rule-avoid">${fmtText(t.avoid)}</div>
          </div>
        </div>
      `;
    }).join('');

    const footerActionHtml = !q && ui.trigFilter !== 'ALL'
      ? (secComplete
          ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;border-radius:15px;background:var(--success-bg);border:1px solid var(--success);">
               <span style="font-size:14px;font-weight:800;color:var(--success);">✓ ${ui.trigFilter} Rules Complete (${secDoneCnt}/${secScope.length})</span>
               ${nextSec ? `<button class="icon-btn" id="next-trigsec-btn" style="background:var(--success);border-color:var(--success);color:#fff;padding:7px 11px;font-size:13px;">Next: ${nextSec} →</button>` : ''}
             </div>`
          : `<button class="sec-btn" id="mark-rules-inline-btn" style="padding:12px;font-size:14.5px;">✓ Mark All ${ui.trigFilter} Rules Done (${secDoneCnt}/${secScope.length})</button>`)
      : '';

    const dropLabel = ui.trigFilter === 'ALL'
      ? `${secComplete ? '✓ ' : ''}All (${secDoneCnt}/${secScope.length})`
      : `${secComplete ? '✓ ' : ''}${ui.trigFilter} (${secDoneCnt}/${secScope.length})`;

    return `
      <div class="selector-bar">
        <button class="icon-btn" id="toggle-duel-rules-btn" style="padding:8.5px 11px;font-size:13.5px;font-weight:800;border-color:var(--primary);color:var(--primary);">⚔️ Duel</button>
        <input id="trig-search" class="text-input" placeholder="Search 50 rules..." value="${ui.trigSearch.replace(/"/g, '&quot;')}" style="flex:1;min-width:0;padding:8.5px 12px;font-size:15px;border-radius:12px;" />
        <button class="dropdown-btn" id="open-trig-picker" style="flex:0 0 auto;width:auto;${secComplete ? 'border-color:rgba(16,185,129,0.6);color:var(--success);' : ''}">
          <span class="dropdown-btn-label">${dropLabel}</span>
          <span class="dropdown-caret">▾</span>
        </button>
      </div>
      <div class="scroll-pane">
        ${items || '<div style="text-align:center;color:var(--muted);padding:32px 0;">No matching rules.</div>'}
        ${footerActionHtml}
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
          <div style="font-size:15.5px;color:var(--muted);">Any question you miss lands here automatically until you master it.</div>
        </div>
      `;
    }

    if (ui.qIdx >= qs.length) ui.qIdx = 0;
    const q = qs[ui.qIdx];
    const chosen = progress.answers[q.id];

    const answeredList = qs.filter(item => progress.answers[item.id] !== undefined);
    const rightCount = answeredList.filter(item => progress.answers[item.id] === item.ans).length;
    const setComplete = ui.quizFilter !== 'MISSED' && qs.length > 0 && answeredList.length === qs.length;
    const hasOpenAnywhere = DATA.questions.some(item => progress.answers[item.id] === undefined);
    const showResumeBtn = chosen !== undefined && ui.quizFilter !== 'MISSED' && hasOpenAnywhere;
    const m = Math.floor(ui.secLeft / 60);
    const s = String(ui.secLeft % 60).padStart(2, '0');

    const sets = getQuizSets();
    const curSecPos = sets.indexOf(ui.quizFilter);
    const nextQuizSec = curSecPos >= 0 && curSecPos < sets.length - 1 ? sets[curSecPos + 1] : null;

    const qProgressHtml = qs.length <= 20
      ? `<div class="card-dots">${qs.map((item, idx) => {
          let dCls = 'cdot';
          const ans = progress.answers[item.id];
          if (ans !== undefined) {
            dCls += (ans === item.ans) ? ' done' : ' wrong';
          }
          if (idx === ui.qIdx) dCls += ' current';
          return `<div class="${dCls}" data-qdot="${idx}"></div>`;
        }).join('')}</div>`
      : `<div style="flex-shrink:0;width:100%;height:6px;border-radius:99px;background:var(--surface-2);border:1px solid var(--border);overflow:hidden;">
           <div style="height:100%;width:${Math.round((answeredList.length / qs.length) * 100)}%;background:var(--success);transition:width .2s;"></div>
         </div>`;

    const optsHtml = q.opts.map((opt, idx) => {
      let cls = 'opt-btn';
      let prefix = '';
      if (chosen !== undefined) {
        if (idx === q.ans) { cls += ' correct'; prefix = '✅ '; }
        else if (idx === chosen) { cls += ' wrong'; prefix = '❌ '; }
      }
      return `<button class="${cls}" data-opt="${idx}">${prefix}${fmtText(opt)}</button>`;
    }).join('');

    const rightControlBtn = (ui.qIdx === qs.length - 1 && setComplete && nextQuizSec)
      ? `<button class="success-btn" id="next-qsec-btn" style="padding:14px 12px;">✓ Done • ${nextQuizSec} →</button>`
      : `<button class="primary-btn" id="q-next" style="padding:14px 12px;" ${ui.qIdx === qs.length - 1 ? 'disabled' : ''}>Next →</button>`;

    return `
      <div class="selector-bar">
        <button class="dropdown-btn" id="open-quiz-picker" style="${setComplete ? 'border-color:rgba(16,185,129,0.6);' : ''}">
          <span class="dropdown-btn-label" style="${setComplete ? 'color:var(--success);' : ''}">${setComplete ? '✓ ' : ''}${activeFilterLabel} • Q ${ui.qIdx + 1}/${qs.length}</span>
          <span class="dropdown-caret">▾</span>
        </button>
        ${showResumeBtn ? `<button class="icon-btn" id="jump-quiz-open-btn" style="padding:7px 9px;font-size:12.5px;border-color:var(--primary);color:var(--primary);">▶ Next</button>` : `<span style="font-size:13px;font-weight:700;color:${setComplete ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">✓ ${rightCount}/${answeredList.length}</span>`}
        <button class="icon-btn" id="toggle-timer" style="padding:7px 9px;font-size:12.5px;">
          <span id="timer-badge">${ui.timerOn ? `⏱ ${m}:${s}` : '⏱ Off'}</span>
        </button>
      </div>

      ${qProgressHtml}

      <div class="quiz-card" id="quiz-card-box" style="${setComplete ? 'border-color:rgba(16,185,129,0.45);' : ''}">
        <div class="quiz-q">${fmtText(q.q)}</div>
        <div style="display:flex;flex-direction:column;gap:9px;">
          ${optsHtml}
        </div>
        ${chosen !== undefined ? `
          <div class="card-tip">
            <strong>Why:</strong> ${fmtText(q.exp)}
            <div style="margin-top:10px;">
              <button class="icon-btn" id="retry-q" style="font-size:13px;padding:6px 10px;">Reset Question</button>
            </div>
          </div>
        ` : ''}
      </div>

      <div class="quiz-controls">
        <button class="sec-btn" id="q-prev" style="padding:14px 12px;" ${ui.qIdx === 0 ? 'disabled' : ''}>← Prev</button>
        ${rightControlBtn}
      </div>
    `;
  }

  function renderPrinciplesTab() {
    const list = DATA.principles || [];
    if (!list.length) return '';
    if (ui.pIdx >= list.length) ui.pIdx = 0;
    if (ui.pStep < 0 || ui.pStep > 3) ui.pStep = 0;

    const p = list[ui.pIdx];
    const isDone = !!progress.donePrinciples[p.id];
    const doneTotal = list.filter(item => !!progress.donePrinciples[item.id]).length;
    const allDone = doneTotal === list.length;
    const isStepView = ui.pView !== 'full';

    const dIdx = DATA.decks.findIndex(d => d.id === p.deckId);

    const pDotsHtml = list.map((item, idx) => {
      let dCls = 'cdot';
      if (progress.donePrinciples[item.id]) dCls += ' done';
      if (idx === ui.pIdx) dCls += ' current';
      return `<div class="${dCls}" data-pdot="${idx}"></div>`;
    }).join('');

    const groundTruthText = fmtText(p.groundTruth || p.intuition || '');
    const groundHtml = `
      <div class="principle-ground-box">
        <div class="principle-sec-label" style="color:var(--primary);">⚛️ FIRST PRINCIPLES (STRIP AWAY THE JARGON)</div>
        <div class="principle-body">${groundTruthText}</div>
      </div>
    `;

    const razorHtml = p.razor
      ? `
        <div class="principle-razor">
          <div class="principle-sec-label" style="color:var(--warn);">⚡ 5-SECOND MENTAL RAZOR</div>
          <div class="principle-razor-text">${fmtText(p.razor)}</div>
        </div>
      `
      : '';

    const pillarsInner = (p.pillars || []).map(pil => `
      <div class="principle-pillar">
        <div class="principle-pillar-title">${fmtText(pil.label)}</div>
        <div class="principle-pillar-desc">${fmtText(pil.desc)}</div>
      </div>
    `).join('');

    const buildUpHtml = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="principle-sec-label" style="color:var(--muted);margin-bottom:0;">🧱 BUILD IT UP FROM ZERO</div>
        ${pillarsInner}
      </div>
    `;

    const trapsInner = (p.traps || []).map(tr => `
      <div class="principle-trap-item">• ${fmtText(tr)}</div>
    `).join('');

    const trapsBoxHtml = `
      <div class="box-avoid" style="display:flex;flex-direction:column;gap:9px;">
        <div class="principle-sec-label" style="color:var(--danger);margin-bottom:0;">🪤 WHERE ANALOGY THINKING FAILS</div>
        ${trapsInner}
      </div>
    `;

    const stepLabels = ['1. Ground Truth', '2. 5s Razor', '3. Build Up', '4. Traps'];
    const stepPillsHtml = isStepView
      ? `<div class="p-step-bar">${stepLabels.map((lbl, idx) => `
          <button class="p-step-pill ${ui.pStep === idx ? 'active' : ''}" data-pstep="${idx}">${lbl}</button>
        `).join('')}</div>`
      : '';

    let contentBodyHtml = '';
    if (isStepView) {
      if (ui.pStep === 0) contentBodyHtml = groundHtml;
      else if (ui.pStep === 1) contentBodyHtml = razorHtml || groundHtml;
      else if (ui.pStep === 2) contentBodyHtml = buildUpHtml;
      else contentBodyHtml = trapsBoxHtml;
    } else {
      contentBodyHtml = `
        ${groundHtml}
        ${razorHtml}
        ${buildUpHtml}
        ${trapsBoxHtml}
      `;
    }

    const viewSwitchHtml = `
      <div class="p-view-toggle" role="group" aria-label="Principle reading view">
        <button class="p-view-btn ${isStepView ? 'active' : ''}" data-pview="step">📑 Steps</button>
        <button class="p-view-btn ${!isStepView ? 'active' : ''}" data-pview="full">📜 Full</button>
      </div>
    `;

    let bottomBarHtml = '';
    if (isStepView) {
      const prevDisabled = ui.pIdx === 0 && ui.pStep === 0;
      const prevLabel = ui.pStep > 0 ? '← Block' : '← Prev';
      const centerStepBtn = ui.pStep < 3
        ? `<button class="primary-btn" id="p-next-step" style="padding:14px 10px;">Next Block (${ui.pStep + 2}/4) →</button>`
        : `<button class="success-btn" id="p-got-it" style="padding:14px 10px;">${isDone ? (ui.pIdx < list.length - 1 ? '✓ Done • Next →' : '✓ Understood') : '✓ Got It • Next'}</button>`;
      bottomBarHtml = `
        <div class="thumb-controls">
          <button class="sec-btn" id="p-prev" style="padding:14px 10px;" ${prevDisabled ? 'disabled' : ''}>${prevLabel}</button>
          ${centerStepBtn}
          <button class="sec-btn" id="p-next" style="padding:14px 10px;" ${ui.pIdx === list.length - 1 ? 'disabled' : ''}>Mod →</button>
        </div>
      `;
    } else {
      bottomBarHtml = `
        <div class="thumb-controls">
          <button class="sec-btn" id="p-prev" style="padding:14px 10px;" ${ui.pIdx === 0 ? 'disabled' : ''}>← Prev</button>
          <button class="success-btn" id="p-got-it" style="padding:14px 10px;">${isDone ? (ui.pIdx < list.length - 1 ? '✓ Done • Next →' : '✓ Understood') : '✓ Got It • Next'}</button>
          <button class="sec-btn" id="p-next" style="padding:14px 10px;" ${ui.pIdx === list.length - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      `;
    }

    return `
      <div class="selector-bar">
        <button class="dropdown-btn" id="open-principle-picker" style="${allDone ? 'border-color:rgba(16,185,129,0.6);' : ''}">
          <span class="dropdown-btn-label" style="${isDone ? 'color:var(--success);' : ''}">${isDone ? '✓ ' : ''}${p.num}/${list.length} • ${p.title}</span>
          <span class="dropdown-caret">▾</span>
        </button>
        <span style="font-size:13px;font-weight:700;color:${allDone ? 'var(--success)' : 'var(--muted)'};white-space:nowrap;">✓ ${doneTotal}/${list.length}</span>
      </div>

      <div class="card-dots">${pDotsHtml}</div>

      <div class="quiz-card" id="principle-card-box" style="${isDone ? 'border-color:rgba(16,185,129,0.55);' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="badge" style="${isDone ? 'color:var(--success);' : ''}">${isDone ? '✓ ' : ''}Module ${p.num} • ${p.sec}</span>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            ${viewSwitchHtml}
            ${dIdx >= 0 ? `<button class="icon-btn" data-jump-deck="${dIdx}" style="padding:5px 9px;font-size:12.5px;">🗂 Deck →</button>` : ''}
            <button class="icon-btn" data-jump-qsec="${p.sec}" style="padding:5px 9px;font-size:12.5px;">🎯 Practice →</button>
          </div>
        </div>

        <div>
          <div class="principle-title">${fmtText(p.title)}</div>
          <div class="principle-sub">${fmtText(p.subtitle)}</div>
        </div>

        ${stepPillsHtml}
        ${contentBodyHtml}
      </div>

      ${bottomBarHtml}
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
    document.getElementById('font-btn')?.addEventListener('click', cycleFontScale);
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

    document.getElementById('sync-now-btn')?.addEventListener('click', () => {
      ui.syncMsg = '';
      syncWithCloud({ silent: false });
    });

    document.getElementById('hard-refresh-btn')?.addEventListener('click', forceAppRefresh);

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
    document.getElementById('open-duel-picker')?.addEventListener('click', () => {
      ui.picker = 'duel';
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
    document.getElementById('open-principle-picker')?.addEventListener('click', () => {
      ui.picker = 'principle';
      renderApp();
    });

    document.getElementById('reshuffle-chill-btn')?.addEventListener('click', () => {
      ui.duelFilter = 'ROUND10';
      dealChillRound();
      ui.picker = null;
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

    document.querySelectorAll('[data-pick-duelfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        const nextFilter = btn.dataset.pickDuelfilter;
        ui.duelFilter = nextFilter;
        if (nextFilter === 'ROUND10') {
          dealChillRound();
        } else {
          ui.duelSessionPicks = {};
          ui.duelRoundDone = false;
          const list = getActiveDuels();
          const firstOpen = list.findIndex(d => !progress.doneDuels[d.id]);
          ui.duelIdx = firstOpen !== -1 ? firstOpen : 0;
        }
        ui.picker = null;
        renderApp();
      });
    });

    document.querySelectorAll('[data-pick-qfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.quizFilter = btn.dataset.pickQfilter;
        const qs = getActiveQuestions();
        const firstUnanswered = qs.findIndex(item => progress.answers[item.id] === undefined);
        ui.qIdx = firstUnanswered !== -1 ? firstUnanswered : 0;
        ui.secLeft = 120;
        ui.picker = null;
        startQuizTimerIfNeeded();
        renderApp();
      });
    });

    document.querySelectorAll('[data-pick-qidx]').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.qIdx = Number(btn.dataset.pickQidx);
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

    document.querySelectorAll('[data-pick-principle]').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.pIdx = Number(btn.dataset.pickPrinciple);
        ui.pStep = 0;
        ui.picker = null;
        renderApp();
        requestAnimationFrame(() => {
          const box = document.getElementById('principle-card-box');
          if (box) box.scrollTop = 0;
        });
      });
    });

    const markVisibleRulesDone = () => {
      const now = Date.now();
      let newlyDone = 0;
      DATA.triggers.forEach((t, idx) => {
        if (ui.trigFilter === 'ALL' || t.sec === ui.trigFilter) {
          const rid = t.id || ('r_' + idx);
          if (!progress.doneRules[rid]) {
            progress.doneRules[rid] = true;
            progress.ruleMeta[rid] = now;
            newlyDone++;
          }
        }
      });
      if (newlyDone > 0) recordStudyAction(newlyDone);
      else saveProgress(true);
      ui.picker = null;
      renderApp();
    };

    document.getElementById('mark-rules-btn')?.addEventListener('click', markVisibleRulesDone);

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

    if (ui.tab === 'duel' || ui.tab === 'triggers') {
      document.getElementById('toggle-duel-rules-btn')?.addEventListener('click', () => {
        ui.duelSub = ui.duelSub === 'rules' ? 'duel' : 'rules';
        renderApp();
      });

      if (ui.duelSub === 'rules') {
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

        document.querySelectorAll('[data-toggle-rule]').forEach(btn => {
          btn.addEventListener('click', () => {
            const rid = btn.dataset.toggleRule;
            if (progress.doneRules[rid]) delete progress.doneRules[rid];
            else progress.doneRules[rid] = true;
            progress.ruleMeta[rid] = Date.now();
            if (progress.doneRules[rid]) recordStudyAction(1);
            else saveProgress(true);
            renderApp();
          });
        });

        document.getElementById('mark-rules-inline-btn')?.addEventListener('click', markVisibleRulesDone);

        document.getElementById('next-trigsec-btn')?.addEventListener('click', () => {
          const secs = ['Sec 1', 'Sec 2', 'Sec 3', 'Sec 4', 'Sec 5', 'Sec 6'];
          const pos = secs.indexOf(ui.trigFilter);
          if (pos >= 0 && pos < secs.length - 1) {
            ui.trigFilter = secs[pos + 1];
            renderApp();
          }
        });
      } else {
        document.querySelectorAll('[data-dueldot]').forEach(dot => {
          dot.addEventListener('click', () => {
            ui.duelIdx = Number(dot.dataset.dueldot);
            ui.duelRoundDone = false;
            renderApp();
          });
        });

        document.querySelectorAll('[data-duel-pick]').forEach(btn => {
          btn.addEventListener('click', () => {
            const list = getActiveDuels();
            const cur = list[ui.duelIdx];
            if (!cur || ui.duelSessionPicks[cur.id] !== undefined) return;
            const picked = Number(btn.dataset.duelPick);
            ui.duelSessionPicks[cur.id] = picked;
            progress.duelMeta[cur.id] = Date.now();
            if (picked === cur.ans) {
              progress.doneDuels[cur.id] = true;
              delete progress.trickyDuels[cur.id];
              ui.duelCombo = (ui.duelCombo || 0) + 1;
              try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {}
            } else {
              progress.trickyDuels[cur.id] = true;
              delete progress.doneDuels[cur.id];
              ui.duelCombo = 0;
              try { if (navigator.vibrate) navigator.vibrate([16, 40, 16]); } catch (_) {}
            }
            recordStudyAction(1);
            renderApp();
            requestAnimationFrame(() => {
              const stage = document.querySelector('.duel-stage');
              if (stage && stage.scrollHeight > stage.clientHeight) {
                stage.scrollTo({ top: stage.scrollHeight, behavior: 'smooth' });
              }
            });
          });
        });

        document.getElementById('duel-prev')?.addEventListener('click', () => {
          if (ui.duelIdx > 0) {
            ui.duelIdx--;
            renderApp();
          }
        });

        const stepNextDuel = () => {
          const list = getActiveDuels();
          if (ui.duelIdx < list.length - 1) {
            ui.duelIdx++;
            renderApp();
          }
        };
        document.getElementById('duel-next')?.addEventListener('click', stepNextDuel);
        document.getElementById('duel-next-main')?.addEventListener('click', stepNextDuel);

        document.getElementById('duel-finish-round')?.addEventListener('click', () => {
          ui.duelRoundDone = true;
          renderApp();
        });

        document.getElementById('duel-new-round-btn')?.addEventListener('click', () => {
          ui.duelFilter = 'ROUND10';
          dealChillRound();
          renderApp();
        });

        document.getElementById('duel-go-tricky-btn')?.addEventListener('click', () => {
          ui.duelFilter = 'TRICKY';
          ui.duelSessionPicks = {};
          ui.duelRoundDone = false;
          ui.duelIdx = 0;
          renderApp();
        });
      }
    }

    if (ui.tab === 'quiz') {
      document.querySelectorAll('[data-qdot]').forEach(dot => {
        dot.addEventListener('click', () => {
          ui.qIdx = Number(dot.dataset.qdot);
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

      document.getElementById('jump-quiz-open-btn')?.addEventListener('click', () => {
        const curQs = getActiveQuestions();
        const openInCur = curQs.findIndex(item => progress.answers[item.id] === undefined);
        if (openInCur !== -1) {
          ui.qIdx = openInCur;
        } else {
          const qt = findQuizResumeTarget();
          ui.quizFilter = qt.quizFilter;
          ui.qIdx = qt.qIdx;
        }
        ui.secLeft = 120;
        startQuizTimerIfNeeded();
        renderApp();
      });

      document.getElementById('next-qsec-btn')?.addEventListener('click', () => {
        const sets = getQuizSets();
        const pos = sets.indexOf(ui.quizFilter);
        if (pos >= 0 && pos < sets.length - 1) {
          ui.quizFilter = sets[pos + 1];
          const qs = getActiveQuestions();
          const firstUnanswered = qs.findIndex(item => progress.answers[item.id] === undefined);
          ui.qIdx = firstUnanswered !== -1 ? firstUnanswered : 0;
          ui.secLeft = 120;
          startQuizTimerIfNeeded();
          renderApp();
        }
      });
    }

    if (ui.tab === 'principles') {
      const scrollPrincipleTop = () => {
        requestAnimationFrame(() => {
          const box = document.getElementById('principle-card-box');
          if (box) box.scrollTop = 0;
        });
      };

      document.querySelectorAll('[data-pdot]').forEach(dot => {
        dot.addEventListener('click', () => {
          ui.pIdx = Number(dot.dataset.pdot);
          ui.pStep = 0;
          renderApp();
          scrollPrincipleTop();
        });
      });

      document.querySelectorAll('[data-pview]').forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.pview;
          if (mode === 'step' || mode === 'full') {
            ui.pView = mode;
            renderApp();
            scrollPrincipleTop();
          }
        });
      });

      document.querySelectorAll('[data-pstep]').forEach(btn => {
        btn.addEventListener('click', () => {
          ui.pStep = Number(btn.dataset.pstep);
          renderApp();
          scrollPrincipleTop();
        });
      });

      document.querySelectorAll('[data-jump-deck]').forEach(btn => {
        btn.addEventListener('click', () => {
          ui.deckIdx = Number(btn.dataset.jumpDeck);
          const firstOpen = DATA.decks[ui.deckIdx].cards.findIndex(c => !progress.doneCards[c.id]);
          ui.cardIdx = firstOpen !== -1 ? firstOpen : 0;
          ui.flipped = false;
          ui.tab = 'cards';
          renderApp();
        });
      });

      document.querySelectorAll('[data-jump-qsec]').forEach(btn => {
        btn.addEventListener('click', () => {
          const baseSec = btn.dataset.jumpQsec;
          const matchingSets = getQuizSets().filter(s => s === baseSec || s.startsWith(baseSec + ' •'));
          let chosenSet = matchingSets[0] || baseSec;
          for (let i = 0; i < matchingSets.length; i++) {
            const candidate = matchingSets[i];
            const hasOpen = DATA.questions.some(q => (q.set || q.sec) === candidate && progress.answers[q.id] === undefined);
            if (hasOpen) {
              chosenSet = candidate;
              break;
            }
          }
          ui.quizFilter = chosenSet;
          const qs = getActiveQuestions();
          const firstUnanswered = qs.findIndex(item => progress.answers[item.id] === undefined);
          ui.qIdx = firstUnanswered !== -1 ? firstUnanswered : 0;
          ui.secLeft = 120;
          ui.tab = 'quiz';
          startQuizTimerIfNeeded();
          renderApp();
        });
      });

      document.getElementById('p-next-step')?.addEventListener('click', () => {
        if (ui.pStep < 3) {
          ui.pStep++;
          renderApp();
          scrollPrincipleTop();
        }
      });

      document.getElementById('p-prev')?.addEventListener('click', () => {
        if (ui.pView !== 'full' && ui.pStep > 0) {
          ui.pStep--;
          renderApp();
          scrollPrincipleTop();
        } else if (ui.pIdx > 0) {
          ui.pIdx--;
          ui.pStep = ui.pView !== 'full' ? 3 : 0;
          renderApp();
          scrollPrincipleTop();
        }
      });

      document.getElementById('p-next')?.addEventListener('click', () => {
        const list = DATA.principles || [];
        if (ui.pIdx < list.length - 1) {
          ui.pIdx++;
          ui.pStep = 0;
          renderApp();
          scrollPrincipleTop();
        }
      });

      document.getElementById('p-got-it')?.addEventListener('click', () => {
        const list = DATA.principles || [];
        const cur = list[ui.pIdx];
        if (!cur) return;
        if (!progress.donePrinciples[cur.id]) {
          progress.donePrinciples[cur.id] = true;
          progress.principleMeta[cur.id] = Date.now();
          recordStudyAction(1);
        } else {
          saveProgress(false);
        }
        if (ui.pIdx < list.length - 1) {
          ui.pIdx++;
          ui.pStep = 0;
        }
        renderApp();
        scrollPrincipleTop();
      });
    }
  }

  // Pull-down-to-refresh (standalone PWA) + Horizontal swipe navigation
  let sx = 0, sy = 0;
  let ptrPossible = false, ptrScroller = null, ptrStartX = 0, ptrStartY = 0, ptrDist = 0;

  function getPtrIndicator() {
    let el = document.getElementById('ptr-indicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ptr-indicator';
      el.className = 'ptr-indicator';
      el.textContent = '↓ Pull down to refresh';
      document.body.appendChild(el);
    }
    return el;
  }

  function resetPtrIndicator() {
    const el = document.getElementById('ptr-indicator');
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%, -70px)';
    el.classList.remove('ready');
  }

  document.addEventListener('touchstart', e => {
    sx = e.changedTouches[0].screenX;
    sy = e.changedTouches[0].screenY;

    if (
      !swReloading &&
      !ui.showTimeDrawer &&
      !ui.showSyncDrawer &&
      !ui.picker &&
      e.touches.length === 1 &&
      e.target.tagName !== 'INPUT' &&
      e.target.tagName !== 'TEXTAREA' &&
      e.touches[0].clientY < window.innerHeight * 0.55
    ) {
      const scroller = e.target.closest
        ? e.target.closest('.scroll-pane, .duel-stage, .flashcard, .quiz-card, .lock-wrap')
        : null;
      if (!scroller || scroller.scrollTop <= 2) {
        ptrPossible = true;
        ptrScroller = scroller;
        ptrStartX = e.touches[0].clientX;
        ptrStartY = e.touches[0].clientY;
        ptrDist = 0;
        return;
      }
    }
    ptrPossible = false;
    ptrDist = 0;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!ptrPossible || swReloading || !e.touches.length) return;
    if (ptrScroller && ptrScroller.scrollTop > 2) {
      ptrPossible = false;
      ptrDist = 0;
      resetPtrIndicator();
      return;
    }
    const dx = e.touches[0].clientX - ptrStartX;
    const dy = e.touches[0].clientY - ptrStartY;
    if (dy < -6 || Math.abs(dx) > Math.abs(dy)) {
      ptrPossible = false;
      ptrDist = 0;
      resetPtrIndicator();
      return;
    }
    if (dy > 22 && dy > Math.abs(dx) * 1.6) {
      ptrDist = dy;
      const el = getPtrIndicator();
      const offset = Math.min((dy - 22) * 0.5, 48);
      el.style.opacity = String(Math.min(1, (dy - 22) / 45));
      el.style.transform = `translate(-50%, ${offset}px)`;
      if (dy >= 88) {
        el.textContent = '↻ Release to update';
        el.classList.add('ready');
      } else {
        el.textContent = '↓ Pull down to refresh';
        el.classList.remove('ready');
      }
    }
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    if (ptrPossible || ptrDist > 0) {
      ptrPossible = false;
      ptrDist = 0;
      resetPtrIndicator();
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (ptrPossible && ptrDist >= 88) {
      ptrPossible = false;
      ptrDist = 0;
      const el = getPtrIndicator();
      el.style.opacity = '1';
      el.style.transform = 'translate(-50%, 14px)';
      el.textContent = '↻ Updating...';
      el.classList.add('ready');
      forceAppRefresh();
      return;
    }
    if (ptrPossible || ptrDist > 0) {
      ptrPossible = false;
      ptrDist = 0;
      resetPtrIndicator();
    }

    if (!DATA || ui.showTimeDrawer || ui.showSyncDrawer || ui.picker) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const dx = e.changedTouches[0].screenX - sx;
    const dy = e.changedTouches[0].screenY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (ui.tab === 'cards') {
        const cards = getActiveCards();
        if (dx < 0 && ui.cardIdx < cards.length - 1) { ui.cardIdx++; ui.flipped = false; renderApp(); }
        else if (dx > 0 && ui.cardIdx > 0) { ui.cardIdx--; ui.flipped = false; renderApp(); }
      } else if ((ui.tab === 'duel' || ui.tab === 'triggers') && ui.duelSub === 'duel' && !ui.duelRoundDone) {
        const list = getActiveDuels();
        if (dx < 0 && ui.duelIdx < list.length - 1) { ui.duelIdx++; renderApp(); }
        else if (dx > 0 && ui.duelIdx > 0) { ui.duelIdx--; renderApp(); }
      } else if (ui.tab === 'quiz') {
        const qs = getActiveQuestions();
        if (dx < 0 && ui.qIdx < qs.length - 1) { ui.qIdx++; ui.secLeft = 120; startQuizTimerIfNeeded(); renderApp(); }
        else if (dx > 0 && ui.qIdx > 0) { ui.qIdx--; ui.secLeft = 120; startQuizTimerIfNeeded(); renderApp(); }
      } else if (ui.tab === 'principles') {
        const list = DATA.principles || [];
        if (dx < 0) {
          if (ui.pView !== 'full' && ui.pStep < 3) {
            ui.pStep++;
            renderApp();
            const box = document.getElementById('principle-card-box');
            if (box) box.scrollTop = 0;
          } else if (ui.pIdx < list.length - 1) {
            ui.pIdx++;
            ui.pStep = 0;
            renderApp();
            const box = document.getElementById('principle-card-box');
            if (box) box.scrollTop = 0;
          }
        } else if (dx > 0) {
          if (ui.pView !== 'full' && ui.pStep > 0) {
            ui.pStep--;
            renderApp();
            const box = document.getElementById('principle-card-box');
            if (box) box.scrollTop = 0;
          } else if (ui.pIdx > 0) {
            ui.pIdx--;
            ui.pStep = ui.pView !== 'full' ? 3 : 0;
            renderApp();
            const box = document.getElementById('principle-card-box');
            if (box) box.scrollTop = 0;
          }
        }
      }
    }
  }, { passive: true });

  document.addEventListener('keydown', e => {
    if (!DATA || ui.showTimeDrawer || ui.showSyncDrawer || ui.picker) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if ((ui.tab === 'duel' || ui.tab === 'triggers') && ui.duelSub === 'duel') {
      const k = e.key.toLowerCase();
      if (k === '1' || k === 'a') {
        const btnA = document.querySelector('[data-duel-pick="0"]');
        if (btnA) { e.preventDefault(); btnA.click(); }
      } else if (k === '2' || k === 'b') {
        const btnB = document.querySelector('[data-duel-pick="1"]');
        if (btnB) { e.preventDefault(); btnB.click(); }
      } else if (e.key === 'ArrowLeft') {
        const prevBtn = document.getElementById('duel-prev');
        if (prevBtn && !prevBtn.disabled) { e.preventDefault(); prevBtn.click(); }
      } else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        const advBtn =
          document.getElementById('duel-next-main') ||
          document.getElementById('duel-finish-round') ||
          (ui.duelRoundDone ? document.getElementById('duel-new-round-btn') : null) ||
          (e.key === 'ArrowRight' ? document.getElementById('duel-next') : null);
        if (advBtn && !advBtn.disabled) { e.preventDefault(); advBtn.click(); }
      }
    }
  });

  // Auto-unlock if saved on device
  (async () => {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      try {
        DATA = await unlockWithPasscode(saved);
        jumpToResumeTarget(true);
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
