// app.js: main app. Runs the setup and session screens, saves, and draws the page.

const App = (() => {
  const el = {};
  const SESSION_VERSION = 2;

  function blankState() {
    return {
      version: SESSION_VERSION,
      phase: 'session',
      name: '', // shown in the session header and PDF
      startedMs: 0, // exact moment the session started (date and time shown in the session header)
      startedAt: '', // clock time the session started (shown next to the original players)
      config: null, // { numPlayers, numCourts, matchType, perMatch, activeCourts, idleCourts }
      players: [],
      courts: [],
      history: [],
      matchSeq: 0,
      nextMatchId: 1,
      waitOverride: null, // manual waiting order (player ids), or null
      strictRest: false, // true: nobody goes straight back on court (the same group may repeat)
    };
  }

  // Every session on the page has a context: { id, state, el, root }.
  // The session code below works on `state` and `el`; activate(ctx) points them at one session.
  const contexts = new Map();
  let active = null;
  let state = blankState();

  function activate(ctx) {
    if (!ctx || active === ctx) return;
    active = ctx;
    state = ctx.state;
    Object.assign(el, ctx.el);
  }

  let draft = {
    numPlayers: 8,
    numCourts: 2,
    matchType: 'doubles',
    names: [],
    sessionName: '',
  };

  let modal = null; // set while the pop-up is open
  const MAX_SESSION_NAME = 40;
  const HISTORY_PAGE = 50; // matches drawn in the history list at first

  // Voice announcements use the browser's built-in speech (no libraries). null if unsupported.
  const speech = ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) ? window.speechSynthesis : null;
  const speechLang = /^en/i.test(navigator.language || '') ? navigator.language : 'en-US';
  let voiceOn = Storage.getPref('voice', '1') === '1';

  // ---------- init ----------

  function init() {
    Icons.hydrate(document);
    cacheEls();
    bindEvents();
    renderVoiceButton();

    Storage.migrateLegacy();
    // Open each session on its own, so one that fails can't hide the others (its saved data is left alone)
    Storage.listSessions().forEach(entry => {
      try {
        openSavedSession(entry.id);
      } catch (err) {
        console.error('Could not open a saved session.', err);
      }
    });

    const savedDraft = Storage.loadDraft();
    if (savedDraft) draft = Object.assign(draft, savedDraft);
    renderSetup();
    showView(contexts.size ? 'sessions' : 'setup');

    // If another tab changes saved data, use its version instead of overwriting it.
    Storage.onChangedElsewhere(onChangedElsewhere);
  }

  /** Load a saved session and add it to the page. Returns its context, or null if it's broken. */
  function openSavedSession(id) {
    const saved = Storage.loadSession(id);
    if (!saved || !isValidSession(saved)) {
      if (saved) console.warn('Discarding saved session: unrecognised or corrupted data.');
      Storage.deleteSession(id);
      return null;
    }
    const ctx = addSessionToPage(id, migrateSession(saved));
    // Saved before start times were kept: use the time the session was created
    if (!state.startedMs) {
      const entry = Storage.listSessions().find(s => s.id === id);
      if (entry && Number.isFinite(entry.createdAt) && entry.createdAt > 0) {
        state.startedMs = entry.createdAt;
        if (!state.startedAt) state.startedAt = Session.timeLabelNow(new Date(entry.createdAt));
      }
    }
    // Refill courts cleared during repair, then save the fixed session.
    fillIdleCourts();
    persist();
    renderSession();
    return ctx;
  }

  function onChangedElsewhere(change) {
    if (change.type === 'cleared') {
      [...contexts.values()].forEach(ctx => removeSessionFromPage(ctx));
      showToast('All sessions were deleted in another tab.');
      return;
    }
    if (change.type === 'list') {
      // Pick up sessions added or deleted in another tab
      const ids = new Set(Storage.listSessions().map(s => s.id));
      [...contexts.values()].filter(ctx => !ids.has(ctx.id)).forEach(ctx => removeSessionFromPage(ctx));
      ids.forEach(id => { if (!contexts.has(id)) openSavedSession(id); });
      return;
    }

    const ctx = contexts.get(change.id);
    if (!ctx) return; // a new session; the list change adds it
    if (modal && modal.ctx === ctx) closeModal(); // that pop-up used old data
    if (change.session && isValidSession(change.session)) {
      ctx.state = migrateSession(change.session);
      ctx.state.phase = 'session';
      if (active === ctx) state = ctx.state;
      activate(ctx);
      renderSession();
    } else {
      removeSessionFromPage(ctx);
      showToast('A session was deleted in another tab.');
    }
  }

  // ---------- sessions on the page ----------

  /** Copy the session template, wire up its buttons, and make it the active session. */
  function addSessionToPage(id, sessionState) {
    const root = el.sessionTemplate.content.firstElementChild.cloneNode(true);
    Icons.hydrate(root);
    const ctx = { id, state: sessionState, root, el: {} };
    const get = name => root.querySelector(`[data-el="${name}"]`);
    Object.assign(ctx.el, {
      headName: get('head-name'),
      headStarted: get('head-started'),
      headStatus: get('head-status'),
      headPlaying: get('head-playing'),
      sessionMeta: get('session-meta'),
      btnRename: get('btn-rename'),
      printCourts: get('print-courts'),
      printPlayerCount: get('print-player-count'),
      printPlayerNames: get('print-player-names'),
      courtsGrid: get('courts-grid'),
      waitingList: get('waiting-list'),
      queueMode: get('queue-mode'),
      btnResetOrder: get('btn-reset-order'),
      strictRest: get('strict-rest'),
      btnAnnounce: get('btn-announce'),
      btnAnnouncePlaying: get('btn-announce-playing'),
      btnVoiceSettings: get('btn-voice-settings'),
      statsBody: get('stats-body'),
      statsCards: get('stats-cards'),
      statsHead: get('stats-table').querySelector('thead tr'),
      historyCard: get('history-card'),
      historyList: get('history-list'),
      historyPrintBody: get('history-print-body'),
      pmCount: get('pm-count'),
      pmHint: get('pm-hint'),
      pmList: get('pm-list'),
      btnAddPlayers: get('btn-add-players'),
      btnExportPdf: get('btn-export-pdf'),
      btnExportStatsPdf: get('btn-export-stats-pdf'),
      btnClearHistory: get('btn-clear-history'),
      btnReset: get('btn-reset'),
    });
    // These sections only update the page when their HTML actually changes (faster).
    [ctx.el.sessionMeta, ctx.el.printPlayerNames, ctx.el.courtsGrid, ctx.el.queueMode, ctx.el.waitingList,
      ctx.el.pmList, ctx.el.statsBody, ctx.el.statsHead, ctx.el.statsCards, ctx.el.historyList,
      ctx.el.headPlaying].forEach(cacheHtml);

    // Remember whether each session is expanded on this device
    root.open = Storage.getPref(`open_${id}`, '1') === '1';
    root.addEventListener('toggle', () => {
      Storage.setPref(`open_${id}`, root.open ? '1' : '0');
      renderSessionsToolbar();
    });

    bindSessionEvents(ctx);
    contexts.set(id, ctx);
    el.sessionsList.appendChild(root);
    activate(ctx);
    return ctx;
  }

  function removeSessionFromPage(ctx) {
    if (modal && modal.ctx === ctx) closeModal();
    ctx.root.remove();
    contexts.delete(ctx.id);
    if (active === ctx) {
      active = null;
      state = blankState();
    }
    if (!contexts.size) {
      // Keep anything already typed into the new-session form
      if (el.setupView.hidden) resetSetupForm();
      showView('setup');
    } else {
      renderSessionsToolbar();
    }
  }

  /** Run a session's event handler with that session active. */
  function on(ctx, node, type, handler) {
    node.addEventListener(type, e => {
      activate(ctx);
      handler(e);
    });
  }

  function bindSessionEvents(ctx) {
    const e = ctx.el;
    on(ctx, e.btnRename, 'click', ev => {
      ev.preventDefault(); // don't also open/close the session
      openRenameSessionModal();
    });
    on(ctx, e.courtsGrid, 'click', onCourtsGridClick);
    on(ctx, e.courtsGrid, 'input', onCourtsGridInput);
    on(ctx, e.waitingList, 'click', onWaitingListClick);
    on(ctx, e.strictRest, 'change', () => {
      state.strictRest = e.strictRest.checked;
      persist();
      renderSession();
      showToast(state.strictRest
        ? 'Strict rest is on. Nobody plays twice in a row unless there aren’t enough players to rest.'
        : 'Strict rest is off. Groups are mixed up more, so someone may play two in a row now and then.');
    });
    on(ctx, e.btnResetOrder, 'click', () => {
      Session.resetWaitingOrder(state);
      commitChange();
    });
    e.btnAnnounce.hidden = !speech;
    on(ctx, e.btnAnnounce, 'click', announceNextUp);
    e.btnAnnouncePlaying.hidden = !speech;
    on(ctx, e.btnAnnouncePlaying, 'click', announcePlaying);
    e.btnVoiceSettings.hidden = !speech;
    on(ctx, e.btnVoiceSettings, 'click', openVoiceModal);
    on(ctx, e.pmList, 'click', ev => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.playerId, 10);
      if (btn.dataset.action === 'manage-player') openManagePlayerModal(id);
      else if (btn.dataset.action === 'restore-player') onRestorePlayer(id);
    });
    on(ctx, e.btnAddPlayers, 'click', openAddPlayersModal);
    on(ctx, e.historyList, 'click', ev => {
      if (!ev.target.closest('[data-action="more-history"]')) return;
      active.historyLimit = (active.historyLimit || HISTORY_PAGE) + 100;
      renderHistory();
    });
    on(ctx, e.btnExportPdf, 'click', exportPdf);
    on(ctx, e.btnExportStatsPdf, 'click', exportStatsPdf);
    on(ctx, e.btnClearHistory, 'click', onClearHistory);
    on(ctx, e.btnReset, 'click', onResetSession);
  }

  function cacheHtml(node) {
    let last = null;
    Object.defineProperty(node, 'html', {
      configurable: true,
      get: () => last,
      set: v => { if (v !== last) { last = v; node.innerHTML = v; } },
    });
  }

  let toastTimer = null;
  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('is-visible');
      setTimeout(() => { el.toast.hidden = true; }, 250);
    }, 3500);
  }

  function isValidSession(s) {
    if (!s || typeof s !== 'object') return false;
    const c = s.config;
    if (!c || !['singles', 'doubles'].includes(c.matchType)) return false;
    if (!Number.isInteger(c.numCourts) || !Number.isInteger(c.perMatch)) return false;
    if (!Array.isArray(s.players) || !s.players.length) return false;
    if (!Array.isArray(s.courts) || !Array.isArray(s.history)) return false;
    if (!Number.isInteger(s.matchSeq) || !Number.isInteger(s.nextMatchId)) return false;
    const ids = new Set();
    const playersOk = s.players.every(p => p && Number.isInteger(p.id) && typeof p.name === 'string'
      && Number.isInteger(p.gamesPlayed) && p.teammates && p.opponents && !ids.has(p.id) && ids.add(p.id));
    if (!playersOk) return false;
    const teamOk = t => Array.isArray(t) && t.every(id => ids.has(id));
    return s.courts.every(ct => ct && Number.isInteger(ct.id)
      && (ct.activeMatch == null || (teamOk(ct.activeMatch.team1) && teamOk(ct.activeMatch.team2))));
  }

  /** Update old saved sessions and fix broken data so the app doesn't crash. */
  function migrateSession(s) {
    const int = (v, fallback = 0) => (Number.isInteger(v) && v >= 0 ? v : fallback);
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

    s.players.forEach(p => {
      if (typeof p.active !== 'boolean') p.active = true;
      if (!Number.isInteger(p.fixedPartnerId)) p.fixedPartnerId = null;
      ['gamesPlayed', 'wins', 'losses', 'lastActiveSeq', 'pointsScored', 'pointsAgainst', 'scoredGames']
        .forEach(k => { p[k] = int(p[k]); });
      p.queueGames = int(p.queueGames, p.gamesPlayed);
      // Sessions saved before the rest rule: assume their last activity was their last game
      if (!Number.isInteger(p.lastPlayedSeq)) p.lastPlayedSeq = p.gamesPlayed > 0 ? p.lastActiveSeq : null;
      p.streak = int(p.streak);
      if (!Number.isInteger(p.holdUntilSeq)) delete p.holdUntilSeq;
      if (!Number.isInteger(p.lastCourtId)) p.lastCourtId = null;
      p.teammates = obj(p.teammates);
      p.name = Scheduler.normalizeName(p.name) || p.name; // capitalize names from old saves
      ['joinedAt', 'leftAt', 'rejoinedAt'].forEach(k => { if (typeof p[k] !== 'string') delete p[k]; });
      if (Array.isArray(p.log)) p.log = p.log.filter(x => x && (x.e === 'left' || x.e === 'rejoined') && typeof x.at === 'string');
      else delete p.log;
      p.opponents = obj(p.opponents);
    });

    const ids = new Set(s.players.map(p => p.id));
    const validTeam = t => Array.isArray(t) && t.length > 0 && t.every(id => ids.has(id));
    const score = v => (Number.isInteger(v) && v >= 0 ? v : null);
    s.history = s.history
      .filter(h => h && typeof h === 'object' && validTeam(h.team1) && validTeam(h.team2) && (h.winner === 'team1' || h.winner === 'team2'))
      .map((h, i) => {
        const t1 = score(h.team1Score);
        const t2 = score(h.team2Score);
        const both = t1 != null && t2 != null;
        return Object.assign(h, {
          number: Number.isInteger(h.number) && h.number > 0 ? h.number : i + 1,
          timeLabel: typeof h.timeLabel === 'string' ? h.timeLabel : '',
          courtId: Number.isInteger(h.courtId) ? h.courtId : 0,
          team1Score: both ? t1 : null,
          team2Score: both ? t2 : null,
          team1Names: Array.isArray(h.team1Names) ? h.team1Names.map(n => (typeof n === 'string' ? Scheduler.normalizeName(n) || n : n)) : undefined,
          team2Names: Array.isArray(h.team2Names) ? h.team2Names.map(n => (typeof n === 'string' ? Scheduler.normalizeName(n) || n : n)) : undefined,
          manual: !!h.manual,
        });
      });

    const perTeam = Scheduler.playersPerMatch(s.config.matchType) / 2;
    const onCourt = new Set();
    s.courts.forEach(c => {
      const m = c.activeMatch;
      if (!m) return;
      const all = (m.team1 || []).concat(m.team2 || []);
      const ok = m.team1.length === perTeam && m.team2.length === perTeam
        && new Set(all).size === all.length          // no one twice on this court
        && all.every(id => !onCourt.has(id));         // no one on two courts
      if (!ok) {
        c.activeMatch = null;
        c.idleReason = 'Waiting for enough players to free up.';
        return;
      }
      all.forEach(id => onCourt.add(id));
      if (m.winner !== 'team1' && m.winner !== 'team2') m.winner = null;
      m.team1ScoreInput = typeof m.team1ScoreInput === 'string' ? m.team1ScoreInput : '';
      m.team2ScoreInput = typeof m.team2ScoreInput === 'string' ? m.team2ScoreInput : '';
      m.manual = !!m.manual;
    });
    const byId = new Map(s.players.map(p => [p.id, p]));
    s.players.forEach(p => {
      if (p.fixedPartnerId == null) return;
      const q = byId.get(p.fixedPartnerId);
      if (!q || q.id === p.id || q.fixedPartnerId !== p.id || !p.active || !q.active) p.fixedPartnerId = null;
    });
    s.players.forEach(p => {
      // Also remove the other half of any partnership broken above
      const q = byId.get(p.fixedPartnerId);
      if (p.fixedPartnerId != null && (!q || q.fixedPartnerId !== p.id)) p.fixedPartnerId = null;
    });
    if (!Array.isArray(s.waitOverride) || !s.waitOverride.every(Number.isInteger)) s.waitOverride = null;
    s.strictRest = s.strictRest === true;
    s.startedAt = typeof s.startedAt === 'string' ? s.startedAt : '';
    s.startedMs = Number.isFinite(s.startedMs) && s.startedMs > 0 ? s.startedMs : 0;
    s.name = typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, MAX_SESSION_NAME) : 'Session';
    s.version = SESSION_VERSION;
    return s;
  }

  function cacheEls() {
    el.setupView = document.getElementById('setup-view');
    el.sessionsList = document.getElementById('sessions-list');
    el.sessionTemplate = document.getElementById('session-template');
    el.sessionsToolbar = document.getElementById('sessions-toolbar');
    el.sessionsCount = document.getElementById('sessions-count');
    el.btnToggleAll = document.getElementById('btn-toggle-all');
    el.btnNewSession = document.getElementById('btn-new-session');
    el.btnVoice = document.getElementById('btn-voice');
    el.btnCancelSetup = document.getElementById('btn-cancel-setup');
    el.inputSessionName = document.getElementById('input-session-name');

    el.form = document.getElementById('setup-form');
    el.inputPlayers = document.getElementById('input-players');
    el.inputCourts = document.getElementById('input-courts');
    el.matchTypeToggle = document.getElementById('match-type-toggle');
    el.calcPreview = document.getElementById('calc-preview');
    el.playerNameGrid = document.getElementById('player-name-inputs');
    el.setupErrors = document.getElementById('setup-errors');
    el.setupStatus = document.getElementById('setup-status');
    el.namesCount = document.getElementById('names-count');
    el.namesProgressBar = document.getElementById('names-progress-bar');

    el.modal = document.getElementById('modal');
    el.modalTitle = document.getElementById('modal-title');
    el.modalBody = document.getElementById('modal-body');
    el.modalError = document.getElementById('modal-error');
    el.modalSave = document.getElementById('modal-save');
    el.modalCancel = document.getElementById('modal-cancel');
    el.modalX = document.getElementById('modal-x');
    el.toast = document.getElementById('toast');

    el.header = document.querySelector('.app-header');
  }

  function bindEvents() {
    el.btnNewSession.addEventListener('click', startNewSession);
    el.btnVoice.addEventListener('click', toggleVoice);
    el.btnCancelSetup.addEventListener('click', () => showView('sessions'));
    el.btnToggleAll.addEventListener('click', () => {
      const open = ![...contexts.values()].some(ctx => ctx.root.open);
      contexts.forEach(ctx => { ctx.root.open = open; });
    });
    el.inputSessionName.addEventListener('input', saveDraftFromForm);

    el.inputPlayers.addEventListener('input', onPlayerCountChange);
    el.inputCourts.addEventListener('input', () => {
      saveDraftFromForm();
      updateCalcPreview();
    });

    el.matchTypeToggle.addEventListener('click', e => {
      const btn = e.target.closest('.segmented-btn');
      if (!btn) return;
      [...el.matchTypeToggle.children].forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      saveDraftFromForm();
      updateCalcPreview();
    });

    el.playerNameGrid.addEventListener('input', () => {
      saveDraftFromForm();
      updateNameStatus();
    });
    // Capitalize names when the field loses focus ("maria christine" -> "Maria Christine")
    el.playerNameGrid.addEventListener('focusout', e => {
      const input = e.target.closest('.player-name-input');
      if (!input) return;
      const formatted = Scheduler.normalizeName(input.value);
      if (formatted !== input.value) {
        input.value = formatted;
        saveDraftFromForm();
        updateNameStatus();
      }
    });
    el.modalBody.addEventListener('focusout', e => {
      if (e.target.id === 'm-name') {
        e.target.value = Scheduler.normalizeName(e.target.value);
      } else if (e.target.id === 'm-new-names') {
        e.target.value = e.target.value.split(/\r?\n/).map(line => Scheduler.normalizeName(line)).join('\n');
      }
    });
    el.form.addEventListener('click', onStepperClick);
    el.form.addEventListener('submit', onGenerateQueue);

    // Shrink the header after scrolling. Show the back-to-top button further down.
    const header = el.header;
    const toTop = document.getElementById('btn-to-top');

    // Keep the spacer matched to the header height while it's expanded.
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        if (!header.classList.contains('is-condensed')) setHeaderSpace(header.offsetHeight);
      }).observe(header);
    }
    window.addEventListener('resize', syncHeaderSpace, { passive: true });

    // Only update the page when something changed.
    const syncScroll = () => {
      const y = window.scrollY;
      const condensed = header.classList.contains('is-condensed');
      if (!condensed && y > 48) header.classList.add('is-condensed');
      else if (condensed && y < 4) header.classList.remove('is-condensed');
      const showTop = y > Math.max(400, window.innerHeight * 0.75);
      if (toTop.classList.contains('is-visible') !== showTop) {
        toTop.classList.toggle('is-visible', showTop);
        toTop.tabIndex = showTop ? 0 : -1;
      }
    };
    // Re-check the spacer after the header animation ends.
    header.addEventListener('transitionend', e => {
      if (e.target === header || e.target.classList.contains('header-inner')) syncHeaderSpace();
    });
    window.addEventListener('scroll', syncScroll, { passive: true });
    window.addEventListener('resize', syncScroll, { passive: true });
    syncScroll();
    toTop.addEventListener('click', () => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });

    // Pop-up handlers run with the pop-up's session active
    el.modalBody.addEventListener('input', () => { if (modal && modal.onChange) { activate(modal.ctx); modal.onChange(); } });
    el.modalBody.addEventListener('change', () => { if (modal && modal.onChange) { activate(modal.ctx); modal.onChange(); } });
    el.modalBody.addEventListener('click', e => {
      const btn = e.target.closest('[data-modal-action]');
      if (btn && modal && modal.onAction) { activate(modal.ctx); modal.onAction(btn.dataset.modalAction); }
    });
    el.modalSave.addEventListener('click', onModalSave);
    el.modalCancel.addEventListener('click', closeModal);
    el.modalX.addEventListener('click', closeModal);
    // The close event arrives late; ignore it if another pop-up has opened since.
    el.modal.addEventListener('close', () => { if (!el.modal.open) modal = null; });
    // Only close if the click started and ended on the backdrop (so selecting text doesn't close it).
    let pressStartedOnBackdrop = false;
    el.modal.addEventListener('pointerdown', e => { pressStartedOnBackdrop = e.target === el.modal; });
    el.modal.addEventListener('click', e => {
      if (e.target === el.modal && pressStartedOnBackdrop) closeModal();
      pressStartedOnBackdrop = false;
    });

    // On phones and tablets (where pull-to-reload is turned off), tapping the logo reloads the page.
    // Everything is saved as you go, so nothing is lost.
    const brand = el.header.querySelector('.brand');
    const touchScreen = window.matchMedia('(pointer: coarse), (max-width: 767px)');
    const syncBrand = () => {
      brand.toggleAttribute('data-reload', touchScreen.matches);
      if (touchScreen.matches) {
        brand.setAttribute('role', 'button');
        brand.setAttribute('tabindex', '0');
        brand.setAttribute('aria-label', 'Reload the page');
      } else {
        ['role', 'tabindex', 'aria-label'].forEach(a => brand.removeAttribute(a));
      }
    };
    syncBrand();
    touchScreen.addEventListener('change', syncBrand);
    brand.addEventListener('click', () => { if (touchScreen.matches) window.location.reload(); });
    brand.addEventListener('keydown', e => {
      if (touchScreen.matches && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); window.location.reload(); }
    });

    // No pinch-zoom: iPhone and iPad Safari ignore "user-scalable=no", so stop their pinch gesture directly
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(type => document.addEventListener(type, e => e.preventDefault()));

    window.addEventListener('beforeprint', preparePrint);
    window.addEventListener('afterprint', finishPrint);
  }

  /** 'setup' shows the new-session form; 'sessions' shows every session. */
  function showView(view) {
    el.setupView.hidden = view !== 'setup';
    el.sessionsList.hidden = view !== 'sessions';
    document.body.classList.toggle('is-session', view === 'sessions');
    renderSessionsToolbar();
    syncHeaderSpace();
  }

  // ---------- header spacer ----------

  function setHeaderSpace(px) {
    document.documentElement.style.setProperty('--header-h', `${Math.ceil(px)}px`);
  }

  /** Set the page spacer to the header's full height, even when the header is shrunk. */
  function syncHeaderSpace() {
    const header = el.header;
    if (!header) return;
    const condensed = header.classList.contains('is-condensed');
    if (!condensed) {
      setHeaderSpace(header.offsetHeight);
      return;
    }
    header.classList.add('is-measuring');
    header.classList.remove('is-condensed');
    const full = header.offsetHeight;
    header.classList.add('is-condensed');
    void header.offsetHeight; // re-apply the shrunk styles before turning animations back on
    header.classList.remove('is-measuring');
    setHeaderSpace(full);
  }

  // ---------- setup form ----------

  function currentMatchType() {
    const activeBtn = el.matchTypeToggle.querySelector('.segmented-btn.active');
    return activeBtn ? activeBtn.dataset.value : 'doubles';
  }

  function readDraftFromForm() {
    const names = [...el.playerNameGrid.querySelectorAll('.player-name-input')].map(i => i.value);
    return {
      numPlayers: parseInt(el.inputPlayers.value, 10),
      numCourts: parseInt(el.inputCourts.value, 10),
      matchType: currentMatchType(),
      names,
      sessionName: el.inputSessionName.value,
    };
  }

  function saveDraftFromForm() {
    draft = readDraftFromForm();
    Storage.saveDraft(draft);
  }

  function onPlayerCountChange() {
    renderPlayerNameInputs();
    saveDraftFromForm();
    updateCalcPreview();
  }

  function renderPlayerNameInputs() {
    const count = Math.max(0, Math.min(Scheduler.MAX_PLAYERS, parseInt(el.inputPlayers.value, 10) || 0));
    const existing = [...el.playerNameGrid.querySelectorAll('.player-name-input')].map(i => i.value);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const wrap = document.createElement('label');
      wrap.className = 'player-name-field';
      wrap.innerHTML = `<span class="player-name-index">${i + 1}</span>`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'player-name-input';
      input.placeholder = `Player ${i + 1} name`;
      input.autocomplete = 'off';
      input.maxLength = Scheduler.MAX_NAME_LENGTH;
      input.value = existing[i] || '';
      wrap.appendChild(input);
      frag.appendChild(wrap);
    }
    el.playerNameGrid.innerHTML = '';
    el.playerNameGrid.appendChild(frag);
    updateNameStatus();
  }

  /** Live feedback while typing names (highlights, "x of N named", ready status). Does not validate. */
  function updateNameStatus() {
    const fields = [...el.playerNameGrid.querySelectorAll('.player-name-field')];
    const names = fields.map(f => Scheduler.normalizeName(f.querySelector('.player-name-input').value));
    const counts = new Map();
    names.forEach(n => { if (n) counts.set(n.toLowerCase(), (counts.get(n.toLowerCase()) || 0) + 1); });

    let filled = 0;
    let dupes = 0;
    fields.forEach((f, i) => {
      const n = names[i];
      const isDup = !!n && counts.get(n.toLowerCase()) > 1;
      f.classList.toggle('is-filled', !!n && !isDup);
      f.classList.toggle('is-dup', isDup);
      if (n) filled += 1;
      if (isDup) dupes += 1;
    });

    const total = fields.length;
    el.namesCount.textContent = `${filled} of ${total} named`;
    el.namesProgressBar.style.width = total ? `${Math.round((filled / total) * 100)}%` : '0%';
    el.namesProgressBar.parentElement.classList.toggle('is-complete', total > 0 && filled === total && !dupes);

    const missing = total - filled;
    let status;
    if (!total) status = `<span class="status-wait">${Icons.svg('alert')}Enter the number of players</span>`;
    else if (dupes) status = `<span class="status-bad">${Icons.svg('alert')}Fix duplicate names</span>`;
    else if (missing) status = `<span class="status-wait">${Icons.svg('users')}${missing} name${missing === 1 ? '' : 's'} to go</span>`;
    else status = `<span class="status-ok">${Icons.svg('check')}All set, ready to start</span>`;
    el.setupStatus.innerHTML = status;
  }

  function updateCalcPreview() {
    const d = readDraftFromForm();
    if (!d.numPlayers || !d.numCourts) {
      el.calcPreview.innerHTML = '';
      return;
    }
    const setup = Scheduler.computeCourtSetup(d);

    let note = '';
    if (setup.idleCourts > 0) {
      note = `<p class="calc-note">${Icons.svg('alert')}<span>Only <strong>${setup.activeCourts}</strong> of ${d.numCourts} court${d.numCourts === 1 ? '' : 's'} can start with ${d.numPlayers} players — the rest wait for players to free up.</span></p>`;
    }

    const tile = (value, label, mod = '') => `<div class="calc-tile${mod}"><strong>${value}</strong><span>${label}</span></div>`;
    el.calcPreview.innerHTML = `
      <div class="calc-tiles">
        ${tile(setup.activeCourts, `Court${setup.activeCourts === 1 ? '' : 's'} in use`)}
        ${tile(setup.playingAtStart, 'Playing')}
        ${tile(setup.waitingAtStart, 'Waiting', setup.waitingAtStart ? ' is-waiting' : '')}
      </div>
      <p class="calc-text">Matches finish one at a time — no fixed rounds or session length. Record each result as it happens.</p>
      ${note}
    `;
  }

  /** -/+ buttons next to the number inputs. */
  function onStepperClick(e) {
    const btn = e.target.closest('[data-step]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.target);
    const min = input.min === '' ? 1 : Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    const next = Math.min(max, Math.max(min, (parseInt(input.value, 10) || 0) + Number(btn.dataset.step)));
    if (String(next) === input.value) return;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onGenerateQueue(e) {
    e.preventDefault();
    const d = readDraftFromForm();
    const validation = Scheduler.validateSetup(d);

    if (!validation.valid) {
      el.setupErrors.hidden = false;
      // Show the first few problems, so a long list doesn't bury the form
      const MAX_SHOWN = 6;
      const shown = validation.errors.slice(0, MAX_SHOWN);
      const hidden = validation.errors.length - shown.length;
      if (hidden > 0) shown.push(`…and ${hidden} more. Fix these first.`);
      el.setupErrors.innerHTML = shown.map(msg => `<div class="error-item">${escapeHtml(msg)}</div>`).join('');
      el.setupErrors.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    el.setupErrors.hidden = true;
    el.setupErrors.innerHTML = '';

    const setup = Scheduler.computeCourtSetup(d);

    const fresh = blankState();
    fresh.name = (d.sessionName || '').trim().slice(0, MAX_SESSION_NAME) || defaultSessionName();
    fresh.startedMs = Date.now();
    fresh.startedAt = Session.timeLabelNow(new Date(fresh.startedMs));
    const ctx = addSessionToPage(Storage.newId(), fresh);
    ctx.root.open = true;
    state.config = { numPlayers: d.numPlayers, numCourts: d.numCourts, matchType: d.matchType, ...setup };
    state.players = generatePlayers(d.names.slice(0, d.numPlayers));
    state.courts = generateCourts(d.numCourts);
    state.history = [];
    state.matchSeq = 0;
    state.nextMatchId = 1;
    state.waitOverride = null;

    state.courts.forEach(court => generateMatchForCourt(court));

    Storage.clearDraft();
    persist();
    renderSession();
    resetSetupForm();
    showView('sessions');
    ctx.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- match logic (no page updates) ----------

  function generatePlayers(names) {
    return names.map((name, i) => Queue.createPlayer(i + 1, Scheduler.normalizeName(name)));
  }

  function generateCourts(numCourts) {
    return Array.from({ length: numCourts }, (_, i) => ({ id: i + 1, activeMatch: null, idleReason: null }));
  }

  function getBusyPlayerIds() {
    return Session.busyIds(state);
  }

  function generateMatchForCourt(court) {
    const busyIds = getBusyPlayerIds();
    const plan = Queue.generateMatch(state.players, busyIds, state.config.matchType, state.matchSeq, state.waitOverride, state.nextMatchId, { strictRest: state.strictRest });
    if (!plan) {
      court.activeMatch = null;
      court.idleReason = 'Waiting for enough players to free up.';
      return false;
    }
    court.idleReason = null;
    court.activeMatch = {
      matchId: state.nextMatchId++,
      startSeq: state.matchSeq, // used to spot players going straight from one game to the next
      team1: plan.team1,
      team2: plan.team2,
      winner: null,
      team1ScoreInput: '',
      team2ScoreInput: '',
      manual: false,
    };
    // Remove players from the manual order once they've been called.
    Session.pruneOverride(state);
    return true;
  }

  /** Start matches on any empty courts that can be filled. Returns the court ids. */
  function fillIdleCourts() {
    const filled = [];
    state.courts.forEach(court => {
      if (!court.activeMatch && generateMatchForCourt(court)) filled.push(court.id);
    });
    return filled;
  }

  /** After any organizer change: clean up, fill courts, save, redraw. */
  function commitChange(flashCourtIds = []) {
    Session.pruneOverride(state);
    const filled = fillIdleCourts();
    persist();
    renderSession();
    flashCourtIds.concat(filled).forEach(flashCourtUpdate);
  }

  // ---------- match lifecycle ----------

  function onCourtsGridClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const courtId = parseInt(target.dataset.courtId, 10);
    const court = state.courts.find(c => c.id === courtId);
    if (!court || !court.activeMatch) return;

    const action = target.dataset.action;
    if (action === 'select-winner') {
      selectWinner(court, target.dataset.team);
    } else if (action === 'change-winner') {
      court.activeMatch.winner = null;
      persist();
      renderSession();
    } else if (action === 'complete-match') {
      onCompleteMatch(court);
    } else if (action === 'open-swap') {
      openSwapModal(court);
    } else if (action === 'open-pairing') {
      openPairingModal(court);
    }
  }

  function onCourtsGridInput(e) {
    const input = e.target.closest('[data-role="score-input"]');
    if (!input) return;
    const courtId = parseInt(input.dataset.courtId, 10);
    const court = state.courts.find(c => c.id === courtId);
    if (!court || !court.activeMatch) return;

    if (input.dataset.team === 'team1') court.activeMatch.team1ScoreInput = input.value;
    else court.activeMatch.team2ScoreInput = input.value;
    persist();
  }

  function selectWinner(court, team) {
    court.activeMatch.winner = team;
    persist();
    renderSession();
  }

  function onCompleteMatch(court) {
    const m = court.activeMatch;
    if (!m || !m.winner) return;

    const t1raw = (m.team1ScoreInput || '').trim();
    const t2raw = (m.team2ScoreInput || '').trim();
    let team1Score = null;
    let team2Score = null;

    if (t1raw !== '' || t2raw !== '') {
      if (t1raw === '' || t2raw === '') {
        alert('Enter both scores, or leave both blank.');
        return;
      }
      const n1 = Number(t1raw);
      const n2 = Number(t2raw);
      if (!Number.isInteger(n1) || !Number.isInteger(n2) || n1 < 0 || n2 < 0) {
        alert('Scores must be whole numbers of 0 or more.');
        return;
      }
      if (n1 === n2) {
        alert('Scores can\'t be tied. Correct the score, or leave both blank.');
        return;
      }
      team1Score = n1;
      team2Score = n2;

      const higherTeam = team1Score > team2Score ? 'team1' : 'team2';
      if (higherTeam !== m.winner) {
        const higherLabel = higherTeam === 'team1' ? 'Team 1' : 'Team 2';
        const winnerLabel = m.winner === 'team1' ? 'Team 1' : 'Team 2';
        const proceed = confirm(`${higherLabel} has the higher score. Are you sure ${winnerLabel} won?`);
        if (!proceed) return;
      }
    }

    recordMatch(court, { team1Score, team2Score });
  }

  function recordMatch(court, { team1Score, team2Score }) {
    const m = court.activeMatch;
    state.matchSeq += 1;
    const currentSeq = state.matchSeq;

    Queue.commitMatch(
      state.players,
      { courtId: court.id, team1: m.team1, team2: m.team2, winner: m.winner, team1Score, team2Score, startSeq: m.startSeq },
      currentSeq
    );

    const now = new Date();
    state.history.push({
      number: state.history.length + 1,
      dateISO: localDateISO(now),
      timeLabel: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      courtId: court.id,
      matchType: state.config.matchType,
      team1: m.team1,
      team2: m.team2,
      // Save names as they were at match time, so renaming doesn't change history.
      team1Names: m.team1.map(playerName),
      team2Names: m.team2.map(playerName),
      winner: m.winner,
      team1Score,
      team2Score,
      manual: !!m.manual,
    });

    court.activeMatch = null;
    generateMatchForCourt(court);
    const filled = fillIdleCourts();

    persist();
    renderSession();
    [court.id].concat(filled).forEach(flashCourtUpdate);
    const score = team1Score == null ? null : (m.winner === 'team1' ? [team1Score, team2Score] : [team2Score, team1Score]);
    announceResult(m[m.winner], score);
  }

  // ---------- voice announcements ----------

  /** "A", "A and B", "A, B, and C". */
  function joinNames(names) {
    if (names.length <= 2) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }

  // Each session has its own announcer voice (saved on this device). Until one is chosen, it uses
  // Microsoft Mark if the device has it, otherwise the browser's default voice.
  const VOICE_NAME = 'Microsoft Mark';
  const VOICE_RATE = 1;
  const VOICE_PITCH = 1.6;
  // Voices have no gender field, so female voices are picked out by common names
  const FEMALE_VOICE_HINT = /zira|aria|jenny|samantha|\bava\b|zoe|allison|susan|hazel|sonia|libby|michelle|karen|moira|tessa|fiona|victoria|female/i;

  /** The active session's saved voice name, '' for the device default, or null if none was chosen. */
  function sessionVoiceName() {
    return active ? Storage.getPref(`voice_${active.id}`, null) : null;
  }

  /** Find a voice by name. '' means the device default; a missing voice falls back to Microsoft Mark. */
  function findVoice(name) {
    // The voice list can fill in after the page loads, so look it up each time
    if (name === '') return null;
    const voices = speech.getVoices();
    return voices.find(v => v.name === name) || voices.find(v => v.name.includes(VOICE_NAME)) || null;
  }

  // Lines are spoken one at a time from our own queue, so a line can be followed by a pause.
  const speechQueue = [];
  let speechBusy = false;
  let speechRun = 0; // changes when speech is stopped, so old lines don't carry on

  function stopSpeaking() {
    speechQueue.length = 0;
    speechBusy = false;
    speechRun += 1;
    if (speech) speech.cancel();
  }

  /** Add lines to speak: [{ text, pause }] where pause is milliseconds of silence after the line.
   *  The voice is the active session's, fixed now so a later session switch doesn't change it. */
  function speakLines(lines, interrupt = false, voiceName = sessionVoiceName()) {
    if (!speech) return;
    if (interrupt) stopSpeaking();
    speechQueue.push(...lines.filter(l => l && l.text).map(l => ({ voiceName, ...l })));
    if (!speechBusy) speakNextLine();
  }

  function speakNextLine() {
    const line = speechQueue.shift();
    if (!line) {
      speechBusy = false;
      return;
    }
    speechBusy = true;
    const run = speechRun;
    let done = false;
    const finish = () => {
      if (done || run !== speechRun) return;
      done = true;
      setTimeout(() => { if (run === speechRun) speakNextLine(); }, line.pause || 0);
    };
    const utterance = new SpeechSynthesisUtterance(line.text);
    const voice = findVoice(line.voiceName);
    if (voice) utterance.voice = voice;
    utterance.lang = voice ? voice.lang : speechLang;
    utterance.rate = VOICE_RATE;
    utterance.pitch = VOICE_PITCH;
    utterance.onend = finish;
    utterance.onerror = finish;
    speech.speak(utterance);
    // Some browsers never report the end of a line; don't let the queue get stuck
    setTimeout(finish, 3000 + line.text.length * 150);
  }

  /** When a match is completed: the winners, and the score if one was recorded. This is the only automatic
   *  announcement (and only when the voice toggle is on). `score` is [winner's score, other score] or null. */
  function announceResult(winnerIds, score) {
    if (!voiceOn || !speech) return;
    const winners = joinNames(winnerIds.map(playerName));
    speakLines([{ text: `Congratulations to the winners, ${winners}.${score ? ` The score was ${score[0]} to ${score[1]}.` : ''}` }]);
  }

  /** Say who is in the next match: the highlighted "Next to play" players who are waiting, plus anyone
   *  playing right now who will go straight back on. Works even when Voice is off, since it's an explicit tap. */
  function announceNextUp() {
    if (!speech) return;
    const busyIds = getBusyPlayerIds();
    const { order, nextCount } = callOrder(busyIds);
    const waiting = order.slice(0, nextCount).map(p => p.name);
    const nextMatch = forecastNextMatch(busyIds);
    const again = state.players.filter(p => nextMatch.has(p.id) && busyIds.has(p.id));
    if (!waiting.length && !again.length) {
      showToast('No one is waiting right now.');
      return;
    }

    let text = waiting.length ? `Next up, please get ready: ${joinNames(waiting)}.` : 'Next up:';
    if (again.length) {
      const courts = [...new Set(again.map(p => Session.locate(state, p.id).courtId))];
      const where = courts.length === 1 ? `Court ${courts[0]}` : 'court';
      const who = joinNames(again.map(p => p.name));
      text += `${waiting.length ? ' Also' : ''} ${who}, who ${again.length === 1 ? 'is' : 'are'} playing on ${where} now and will play again.`;
    }
    speakLines([{ text }], true);
  }

  /** Say who is playing on each court right now. Works even when Voice is off, since it's an explicit tap. */
  function announcePlaying() {
    if (!speech) return;
    const side = ids => joinNames(ids.map(playerName));
    const lines = state.courts
      .filter(c => c.activeMatch)
      .map(c => ({ text: `Court ${c.id}: ${side(c.activeMatch.team1)}, versus ${side(c.activeMatch.team2)}.`, pause: 500 }));
    if (!lines.length) {
      showToast('No matches are in progress.');
      return;
    }
    lines.unshift({ text: 'Currently playing.', pause: 400 });
    speakLines(lines, true);
  }

  /** Pick this session's announcer voice, with a Test button. Saved on this device only. */
  function openVoiceModal() {
    if (!speech) return;
    const voices = speech.getVoices();
    if (!voices.length) {
      showToast('No voices found on this device yet. Try again in a moment.');
      return;
    }
    const saved = sessionVoiceName();
    const currentVoice = saved === '' ? null : findVoice(saved);
    let selected = currentVoice ? currentVoice.name : '';
    // Start with all languages shown only if the current voice isn't English
    let showAll = !!currentVoice && !/^en/i.test(currentVoice.lang);

    const buildOptions = () => {
      const english = voices.filter(v => /^en/i.test(v.lang));
      const list = showAll || !english.length ? voices : english;
      const opt = v => `<option value="${escapeHtml(v.name)}"${v.name === selected ? ' selected' : ''}>${escapeHtml(v.name)}</option>`;
      const female = list.filter(v => FEMALE_VOICE_HINT.test(v.name));
      const other = list.filter(v => !FEMALE_VOICE_HINT.test(v.name));
      return `<option value=""${selected === '' ? ' selected' : ''}>Device default voice</option>`
        + (female.length ? `<optgroup label="Female voices (guessed from the name)">${female.map(opt).join('')}</optgroup>` : '')
        + (other.length ? `<optgroup label="Other voices">${other.map(opt).join('')}</optgroup>` : '');
    };

    openModal({
      title: 'Announcer Voice',
      saveLabel: 'Save Voice',
      body: `
        <div class="modal-stack">
          <label class="field">
            <span class="field-label">Voice for “${escapeHtml(state.name)}”</span>
            <select id="m-voice">${buildOptions()}</select>
          </label>
          <label class="choice">
            <input type="checkbox" id="m-voice-all" ${showAll ? 'checked' : ''} />
            <span class="choice-name">Show voices for all languages</span>
          </label>
          <button type="button" class="btn btn-secondary" data-modal-action="test-voice">${Icons.svg('volume')}Test voice</button>
          <p class="hint">Every session can have its own voice. Your choice is saved on this device only, and each device has its own voices.</p>
        </div>`,
      onChange: () => {
        const select = q('#m-voice');
        selected = select.value;
        const wantAll = q('#m-voice-all').checked;
        if (wantAll !== showAll) {
          showAll = wantAll;
          select.innerHTML = buildOptions();
          select.value = selected; // may not exist in a shorter list; falls back to the first option
          selected = select.value;
        }
      },
      onAction: action => {
        if (action !== 'test-voice') return;
        const [a, b] = state.players.filter(Queue.isActive).map(p => p.name);
        const who = b ? `${a} and ${b}` : (a || 'the team');
        speakLines([{ text: `Congratulations to the winners, ${who}. The score was 11 to 7.` }], true, q('#m-voice').value);
      },
      onSave: () => {
        const name = q('#m-voice').value;
        Storage.setPref(`voice_${active.id}`, name);
        stopSpeaking();
        showToast(`Voice for “${state.name}”: ${name || 'device default'}.`);
        return null;
      },
    });
  }

  function renderVoiceButton() {
    el.btnVoice.setAttribute('aria-pressed', String(voiceOn));
    el.btnVoice.innerHTML = `${Icons.svg(voiceOn ? 'volume' : 'volumeOff')}Winner voice ${voiceOn ? 'on' : 'off'}`;
    el.btnVoice.hidden = !speech;
  }

  function toggleVoice() {
    voiceOn = !voiceOn;
    Storage.setPref('voice', voiceOn ? '1' : '0');
    if (!voiceOn) stopSpeaking();
    renderVoiceButton();
    // Speaking on this tap also lets phones (iOS) allow later announcements
    if (voiceOn) speakLines([{ text: 'Winner announcements on.' }], true);
  }

  function flashCourtUpdate(courtId) {
    const cardEl = el.courtsGrid.querySelector(`.court-card[data-court-id="${courtId}"]`);
    if (!cardEl) return;
    cardEl.classList.add('court-flash');
    setTimeout(() => cardEl.classList.remove('court-flash'), 700);
  }

  // ---------- waiting list ----------

  function onWaitingListClick(e) {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const id = parseInt(btn.dataset.playerId, 10);
    // Move within the order shown on screen (the actual call order)
    const shown = callOrder().order.map(p => p.id);
    if (Session.moveWaiting(state, id, parseInt(btn.dataset.move, 10), shown)) commitChange();
  }

  // ---------- modal ----------

  function openModal({ title, body, saveLabel = 'Save Changes', canSave = true, onChange, onSave, onAction }) {
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = body;
    el.modalSave.textContent = saveLabel;
    el.modalSave.hidden = !canSave;
    el.modalCancel.textContent = canSave ? 'Cancel' : 'Close';
    hideModalError();
    modal = { ctx: active, onChange, onSave, onAction };
    if (!el.modal.open) el.modal.showModal();
    if (onChange) onChange();
    const first = el.modalBody.querySelector('input:not([type="hidden"]), select');
    if (first) first.focus();
  }

  function closeModal() {
    if (el.modal.open) el.modal.close();
    modal = null;
    hideModalError();
  }

  function showModalError(msg) {
    el.modalError.hidden = false;
    el.modalError.innerHTML = [].concat(msg).map(m => `<div class="error-item">${escapeHtml(m)}</div>`).join('');
  }

  function hideModalError() {
    el.modalError.hidden = true;
    el.modalError.innerHTML = '';
  }

  function onModalSave() {
    if (!modal || !modal.onSave) return closeModal();
    activate(modal.ctx);
    const error = modal.onSave();
    if (error) showModalError(error);
    else closeModal();
  }

  function q(selector) {
    return el.modalBody.querySelector(selector);
  }

  function splitWarning(splits) {
    return splits.map(([a, b]) => `${a.name} & ${b.name}`).join(', ');
  }

  // ---------- player management ----------

  function playerStatus(p) {
    if (!Queue.isActive(p)) return { key: 'removed', label: p.leftAt ? `Left · ${p.leftAt}` : 'Removed' };
    const loc = renderCache ? renderCache.loc.get(p.id) : Session.locate(state, p.id);
    if (loc) return { key: 'playing', label: `Playing · Court ${loc.courtId}` };
    const pos = renderCache
      ? renderCache.waitPos.get(p.id)
      : Session.waitingOrder(state).findIndex(w => w.id === p.id) + 1;
    return { key: 'waiting', label: `Waiting · #${pos}` };
  }

  function openManagePlayerModal(id) {
    const p = Session.playerById(state, id);
    if (!p || !Queue.isActive(p)) return;
    const doubles = state.config.matchType === 'doubles';
    const loc = Session.locate(state, p.id);

    const others = state.players
      .filter(o => Queue.isActive(o) && o.id !== p.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    const partnerOptions = others.map(o => {
      const taken = o.fixedPartnerId != null && o.fixedPartnerId !== p.id;
      const takenBy = taken ? Session.playerById(state, o.fixedPartnerId) : null;
      return `<option value="${o.id}" ${o.id === p.fixedPartnerId ? 'selected' : ''} ${taken ? 'disabled' : ''}>${escapeHtml(o.name)}${takenBy ? ` (paired with ${escapeHtml(takenBy.name)})` : ''}</option>`;
    }).join('');

    const partnerField = doubles
      ? `<label class="field">
          <span class="field-label">Fixed partner</span>
          <select id="m-partner">
            <option value="">No fixed partner</option>
            ${partnerOptions}
          </select>
          <span class="hint">Fixed partners are always on the same team and rotate together. They get no head start: the pair is called when the partner further down the queue would be.${loc ? ' A change here takes effect from their next match.' : ''}</span>
        </label>`
      : '<p class="hint">Fixed partners only apply in Doubles sessions.</p>';

    const removeBlock = loc
      ? `<button type="button" class="btn btn-danger-ghost" disabled>Remove from session</button>
         <p class="hint">${escapeHtml(p.name)} is playing on Court ${loc.courtId}. Swap them out or complete the match before removing them.</p>`
      : `<button type="button" class="btn btn-danger-ghost" data-modal-action="remove">${Icons.svg('trash')}Remove from session</button>
         <p class="hint">They stay on the session record (marked as left, with the time), keeping their stats and match history. You can restore them later.</p>`;

    openModal({
      title: `Manage ${p.name}`,
      body: `
        <div class="modal-stack">
          <label class="field">
            <span class="field-label">Name</span>
            <input type="text" id="m-name" maxlength="${Session.MAX_NAME_LENGTH}" value="${escapeHtml(p.name)}" autocomplete="off" />
            <span class="hint">${p.gamesPlayed} game${p.gamesPlayed === 1 ? '' : 's'} played · ${p.wins}W ${p.losses}L — kept when renaming.</span>
          </label>
          ${partnerField}
          <div class="modal-danger">${removeBlock}</div>
        </div>`,
      onSave: () => {
        const partnerSel = q('#m-partner');
        const partnerId = partnerSel ? (partnerSel.value === '' ? null : parseInt(partnerSel.value, 10)) : undefined;
        const result = Session.updatePlayer(state, p.id, { name: q('#m-name').value, partnerId });
        if (!result.ok) return result.errors;
        commitChange();
        return null;
      },
      onAction: action => {
        if (action !== 'remove') return;
        const partnerNote = p.fixedPartnerId != null ? ' and their fixed partnership ends' : '';
        const question = `Remove ${p.name} from the session?\n\nThey leave the waiting list${partnerNote}. They stay on the session record with their stats and match history, and you can restore them later.`;
        if (!confirm(question)) return;
        const result = Session.removePlayer(state, p.id);
        if (!result.ok) return showModalError(result.error);
        closeModal();
        commitChange();
        showToast(`${p.name} was removed. Use Restore to bring them back.`);
      },
    });
  }

  // ---------- add / restore players mid-session ----------

  function openAddPlayersModal() {
    if (state.phase !== 'session') return;
    const doubles = state.config.matchType === 'doubles';
    openModal({
      title: 'Add Players',
      saveLabel: 'Add Players',
      body: `
        <div class="modal-stack">
          <label class="field">
            <span class="field-label">Names <span class="field-label-note">(one per line)</span></span>
            <textarea id="m-new-names" rows="4" autocomplete="off" placeholder="e.g. Kiara&#10;Simba"></textarea>
          </label>
          <div class="preview-box" id="m-add-preview" aria-live="polite"></div>
          <p class="hint">New players join the rotation level with whoever has played least. They play after the current “Next to play” group, so they don’t jump the queue. Their stats start at 0.${doubles ? ' You can set a fixed partner from their ⋮ menu afterwards.' : ''} Typing the name of a removed player restores them with their stats.</p>
        </div>`,
      onChange: () => {
        hideModalError();
        const lines = q('#m-new-names').value.split(/\r?\n|,/).map(Scheduler.normalizeName).filter(Boolean);
        const preview = q('#m-add-preview');
        if (!lines.length) {
          preview.innerHTML = '<div class="preview-note">Type one or more names.</div>';
          return;
        }
        const removedByKey = new Map(state.players.filter(p => !Queue.isActive(p))
          .map(p => [Scheduler.normalizeName(p.name).toLowerCase(), p]));
        preview.innerHTML = `<div class="preview-title">Will add ${lines.length} player${lines.length === 1 ? '' : 's'}</div>`
          + lines.map(n => {
            const back = removedByKey.get(n.toLowerCase());
            return `<div class="preview-line">${escapeHtml(n)}${back ? ' <span class="preview-note">(restored, keeps their stats)</span>' : ''}</div>`;
          }).join('');
      },
      onSave: () => {
        const names = q('#m-new-names').value.split(/\r?\n|,/);
        const result = Session.addPlayers(state, names);
        if (!result.ok) return result.errors;
        commitChange();
        const parts = [];
        if (result.added.length) parts.push(`Added ${result.added.join(', ')}`);
        if (result.restored.length) parts.push(`Restored ${result.restored.join(', ')}`);
        showToast(`${parts.join('. ')}.`);
        return null;
      },
    });
  }

  function onRestorePlayer(id) {
    const p = Session.playerById(state, id);
    if (!p) return;
    const result = Session.restorePlayer(state, id);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    commitChange();
    showToast(`${p.name} is back in the rotation.`);
  }

  // ---------- manual swap ----------

  function teamLabel(team) {
    return team === 'team1' ? 'Team 1' : 'Team 2';
  }

  function matchLine(teams, highlight) {
    const fmt = ids => ids.map(id => {
      const n = escapeHtml(playerName(id));
      return highlight.has(id) ? `<mark>${n}</mark>` : n;
    }).join(' + ');
    return `${fmt(teams.team1)} <span class="vs-inline">vs</span> ${fmt(teams.team2)}`;
  }

  function overrideRow(id) {
    return `<label class="override-row" id="${id}-row" hidden>
      <input type="checkbox" id="${id}" />
      <span><strong>Override fixed partnership for this match only.</strong> <span id="${id}-names"></span> The partnership stays in place for future matches.</span>
    </label>`;
  }

  function updateOverrideRow(id, splits) {
    const row = q(`#${id}-row`);
    row.hidden = !splits.length;
    if (splits.length) q(`#${id}-names`).textContent = `This separates ${splitWarning(splits)}.`;
    else q(`#${id}`).checked = false;
  }

  function openSwapModal(court) {
    const m = court.activeMatch;
    const ownIds = m.team1.concat(m.team2);
    const sourceRadios = ownIds.map((id, i) => {
      const loc = Session.locate(state, id);
      return `<label class="choice">
        <input type="radio" name="swap-from" value="${id}" ${i === 0 ? 'checked' : ''} />
        <span class="choice-name">${escapeHtml(playerName(id))}${partnerBadge(id)}</span>
        <span class="choice-tag">${teamLabel(loc.team)}</span>
      </label>`;
    }).join('');

    const groups = [];
    state.courts.forEach(c => {
      if (c.id === court.id || !c.activeMatch) return;
      const opts = c.activeMatch.team1.concat(c.activeMatch.team2)
        .map(id => `<option value="${id}">${escapeHtml(playerName(id))} — ${teamLabel(Session.locate(state, id).team)}</option>`).join('');
      groups.push(`<optgroup label="Court ${c.id}">${opts}</optgroup>`);
    });
    const waiting = Session.waitingOrder(state);
    if (waiting.length) {
      groups.push(`<optgroup label="Waiting list">${waiting.map((w, i) => `<option value="${w.id}">#${i + 1} ${escapeHtml(w.name)}</option>`).join('')}</optgroup>`);
    }

    if (!groups.length) {
      openModal({
        title: `Swap Players · Court ${court.id}`,
        body: '<p class="empty-note">There is no one on another court or in the waiting list to swap with.</p>',
        canSave: false,
      });
      return;
    }

    let plan = null;
    let splits = [];
    openModal({
      title: `Swap Players · Court ${court.id}`,
      saveLabel: 'Swap Players',
      body: `
        <div class="modal-stack">
          <div class="field">
            <span class="field-label">Player on Court ${court.id}</span>
            <div class="choice-list">${sourceRadios}</div>
          </div>
          <label class="field">
            <span class="field-label">Swap with</span>
            <select id="m-swap-to">${groups.join('')}</select>
          </label>
          <div class="preview-box" id="m-preview" aria-live="polite"></div>
          ${overrideRow('m-override')}
          <p class="hint">A swap is not a game: no result, stats or history are recorded${m.winner ? ', and the winner already picked on this court is cleared' : ''}.</p>
        </div>`,
      onChange: () => {
        hideModalError();
        const fromId = parseInt((q('input[name="swap-from"]:checked') || {}).value, 10);
        const toId = parseInt(q('#m-swap-to').value, 10);
        plan = Session.planSwap(state, fromId, toId);
        if (plan.error) {
          q('#m-preview').innerHTML = `<div class="preview-error">${escapeHtml(plan.error)}</div>`;
          splits = [];
        } else {
          const lines = [];
          plan.assignments.forEach((teams, cid) => {
            lines.push(`<div class="preview-line"><span class="preview-court">Court ${cid}</span> ${matchLine(teams, new Set([fromId, toId]))}</div>`);
          });
          if (!Session.locate(state, toId)) {
            lines.push(`<div class="preview-line preview-note">${escapeHtml(playerName(fromId))} goes back to the waiting list.</div>`);
          }
          q('#m-preview').innerHTML = `<div class="preview-title">After the swap</div>${lines.join('')}`;
          splits = Session.fixedPairsSplitBy(state, plan.assignments);
        }
        updateOverrideRow('m-override', splits);
      },
      onSave: () => {
        if (!plan || plan.error) return plan ? plan.error : 'Choose two players to swap.';
        if (splits.length && !q('#m-override').checked) {
          return `This swap separates fixed partners ${splitWarning(splits)}. Tick the override box to continue, or choose someone else.`;
        }
        const changed = Session.applyAssignments(state, plan.assignments);
        commitChange(changed);
        return null;
      },
    });
  }

  // ---------- manual pairing ----------

  function openPairingModal(court) {
    const m = court.activeMatch;
    const doubles = state.config.matchType === 'doubles';
    const current = { team1: m.team1.slice(), team2: m.team2.slice() };

    let arrangements;
    if (doubles) {
      const [a, b, c, d] = m.team1.concat(m.team2);
      arrangements = [
        { team1: [a, b], team2: [c, d] },
        { team1: [a, c], team2: [b, d] },
        { team1: [a, d], team2: [b, c] },
      ];
    } else {
      arrangements = [current];
    }

    const arrangementCards = doubles
      ? arrangements.map((arr, i) => {
        const splitsHere = Session.fixedPairsSplitBy(state, new Map([[court.id, arr]]));
        return `<label class="choice choice-arrangement">
          <input type="radio" name="arrangement" value="${i}" ${i === 0 ? 'checked' : ''} />
          <span class="choice-name">${matchLine(arr, new Set())}</span>
          ${i === 0 ? '<span class="choice-tag">Current</span>' : ''}
          ${splitsHere.length ? '<span class="choice-tag tag-warn">Splits fixed pair</span>' : ''}
        </label>`;
      }).join('')
      : '';

    let proposed = current;
    let splits = [];
    openModal({
      title: `Edit Pairing · Court ${court.id}`,
      body: `
        <div class="modal-stack">
          ${doubles ? `<div class="field"><span class="field-label">Who partners with whom</span><div class="choice-list">${arrangementCards}</div></div>` : ''}
          <label class="choice">
            <input type="checkbox" id="m-swap-sides" ${doubles ? '' : 'checked'} />
            <span class="choice-name">${doubles ? 'Swap sides (Team 1 ⇄ Team 2)' : 'Exchange the two players (Team 1 ⇄ Team 2)'}</span>
          </label>
          <div class="field">
            <span class="field-label">Preview</span>
            <div class="court-teams preview-teams" id="m-preview"></div>
          </div>
          ${overrideRow('m-override')}
          <p class="hint">Rearranging is not a game: no result, stats or history are recorded${m.winner ? ', and the winner already picked on this court is cleared' : ''}.</p>
        </div>`,
      onChange: () => {
        hideModalError();
        const idx = doubles ? parseInt(q('input[name="arrangement"]:checked').value, 10) : 0;
        const base = arrangements[idx];
        proposed = q('#m-swap-sides').checked ? { team1: base.team2, team2: base.team1 } : base;
        const changed = new Set(proposed.team1.filter(id => !current.team1.includes(id))
          .concat(proposed.team2.filter(id => !current.team2.includes(id))));
        const teamBox = (label, ids) => `
          <div class="team-box">
            <div class="team-label"><span>${label}</span>${isFixedPairTeam(ids) ? `<span class="pair-tag">${Icons.svg('link')}Fixed pair</span>` : ''}</div>
            <div class="team-names">${ids.map(id => `<span>${changed.has(id) ? `<mark>${escapeHtml(playerName(id))}</mark>` : escapeHtml(playerName(id))}</span>`).join('')}</div>
          </div>`;
        q('#m-preview').innerHTML = `${teamBox('Team 1', proposed.team1)}<div class="vs-badge">VS</div>${teamBox('Team 2', proposed.team2)}`;
        splits = Session.fixedPairsSplitBy(state, new Map([[court.id, proposed]]));
        updateOverrideRow('m-override', splits);
      },
      onSave: () => {
        const plan = Session.planPairing(state, court.id, proposed.team1, proposed.team2);
        if (plan.error) return plan.error;
        if (splits.length && !q('#m-override').checked) {
          return `This pairing separates fixed partners ${splitWarning(splits)}. Tick the override box to continue, or choose another pairing.`;
        }
        const changed = Session.applyAssignments(state, plan.assignments);
        if (changed.length) commitChange(changed);
        return null;
      },
    });
  }

  // ---------- reset / clear ----------

  function onClearHistory() {
    if (!confirm('Clear the match history and player stats?\n\nMatches in progress are kept, and the rotation still remembers who has played more, so the queue stays fair. This cannot be undone.')) return;
    state.history = [];
    // Clearing history resets the stats shown, but keeps rotation data so turns stay fair.
    state.players.forEach(p => {
      p.gamesPlayed = 0;
      p.wins = 0;
      p.losses = 0;
      p.pointsScored = 0;
      p.pointsAgainst = 0;
      p.scoredGames = 0;
    });
    persist();
    renderSession();
  }

  function onResetSession() {
    if (!confirm(`Delete "${state.name}"? This removes its players, courts, stats and match history. Other sessions aren't affected.`)) return;
    const ctx = active;
    Storage.deleteSession(ctx.id);
    removeSessionFromPage(ctx);
    showToast(`Deleted "${ctx.state.name}".`);
  }

  /** Clear the new-session form back to its defaults. */
  function resetSetupForm() {
    draft = { numPlayers: 8, numCourts: 2, matchType: 'doubles', names: [], sessionName: '' };
    el.form.reset();
    el.setupErrors.hidden = true;
    el.setupErrors.innerHTML = '';
    renderSetup();
  }

  let saveWarned = false;
  function persist() {
    if (!active) return;
    if (Storage.saveSession(active.id, state)) {
      saveWarned = false;
    } else if (!saveWarned) {
      // Tell the organizer once, so they know a refresh would lose recent changes
      saveWarned = true;
      showToast('Couldn’t save: this browser’s storage is full or blocked. Changes will be lost if you refresh.');
    }
  }

  // ---------- multiple sessions ----------

  /** "Session N", using the first number no other session has. */
  function defaultSessionName() {
    const taken = new Set(Storage.listSessions().map(s => (s.name || '').toLowerCase()));
    let n = 1;
    while (taken.has(`session ${n}`)) n++;
    return `Session ${n}`;
  }

  function renderSessionsToolbar() {
    const count = contexts.size;
    const settingUp = !el.setupView.hidden;
    el.sessionsToolbar.hidden = count === 0;
    el.sessionsCount.textContent = count;
    el.btnNewSession.hidden = settingUp;
    el.btnVoice.hidden = !speech || settingUp;
    el.btnToggleAll.hidden = settingUp || count < 2;
    el.btnToggleAll.textContent = [...contexts.values()].some(ctx => ctx.root.open) ? 'Collapse all' : 'Expand all';
    el.btnCancelSetup.hidden = count === 0;
  }

  /** Show the new-session form. Existing sessions keep running. */
  function startNewSession() {
    closeModal();
    showView('setup');
    window.scrollTo({ top: 0 });
  }

  function openRenameSessionModal() {
    openModal({
      title: 'Rename Session',
      saveLabel: 'Save Name',
      body: `
        <div class="field">
          <label class="field-label" for="m-session-name">Session name</label>
          <input type="text" id="m-session-name" maxlength="${MAX_SESSION_NAME}" value="${escapeHtml(state.name)}" autocomplete="off" />
        </div>`,
      onSave: () => {
        const name = q('#m-session-name').value.trim();
        if (!name) return 'Enter a session name.';
        state.name = name;
        persist();
        renderSession();
        return null;
      },
    });
  }

  // ---------- rendering: setup ----------

  function renderSetup() {
    el.inputSessionName.value = draft.sessionName || '';
    el.inputSessionName.placeholder = defaultSessionName();
    el.inputPlayers.value = draft.numPlayers;
    el.inputCourts.value = draft.numCourts;
    [...el.matchTypeToggle.children].forEach(btn => btn.classList.toggle('active', btn.dataset.value === draft.matchType));
    renderPlayerNameInputs();
    if (draft.names && draft.names.length) {
      const inputs = el.playerNameGrid.querySelectorAll('.player-name-input');
      inputs.forEach((input, i) => {
        if (draft.names[i]) input.value = draft.names[i];
      });
    }
    updateNameStatus();
    updateCalcPreview();
  }

  // ---------- rendering: session ----------

  /** Lookups built once per redraw so large groups stay fast. */
  let renderCache = null;

  function buildRenderCache() {
    const byId = new Map(state.players.map(p => [p.id, p]));
    const partner = new Map();
    state.players.forEach(p => {
      const q = Session.partnerOf(state, p, byId);
      if (q) partner.set(p.id, q);
    });
    const waitPos = new Map(Session.waitingOrder(state).map((p, i) => [p.id, i + 1]));
    const loc = new Map();
    state.courts.forEach(c => {
      const m = c.activeMatch;
      if (!m) return;
      ['team1', 'team2'].forEach(t => m[t].forEach(id => loc.set(id, { courtId: c.id, team: t })));
    });
    return { byId, partner, waitPos, loc };
  }

  function partnerFor(p) {
    return renderCache ? (renderCache.partner.get(p.id) || null) : Session.partnerOf(state, p);
  }

  function playerName(id) {
    const p = renderCache ? renderCache.byId.get(id) : state.players.find(pl => pl.id === id);
    return p ? p.name : '?';
  }

  function teamNames(ids) {
    return ids.map(playerName).join(' + ');
  }

  /** Name used at match time, plus the current name if it changed. */
  function historyNames(ids, snapshot) {
    return ids.map((id, i) => {
      const now = playerName(id);
      const then = Array.isArray(snapshot) && typeof snapshot[i] === 'string' ? snapshot[i] : now;
      return then === now ? then : `${then} (now ${now})`;
    }).join(' + ');
  }

  function partnerBadge(id) {
    const p = renderCache ? renderCache.byId.get(id) : Session.playerById(state, id);
    const partner = p && partnerFor(p);
    return partner
      ? `<span class="link-badge" title="Fixed partner: ${escapeHtml(partner.name)}" aria-label="Fixed partner: ${escapeHtml(partner.name)}">${Icons.svg('link')}</span>`
      : '';
  }

  function isFixedPairTeam(ids) {
    if (ids.length !== 2) return false;
    const p = renderCache ? renderCache.byId.get(ids[0]) : Session.playerById(state, ids[0]);
    const partner = p && partnerFor(p);
    return !!partner && partner.id === ids[1];
  }

  function activeCount() {
    return state.players.filter(Queue.isActive).length;
  }

  function plural(n, word) {
    return `${word}${n === 1 ? '' : 's'}`;
  }

  function renderSession() {
    renderCache = buildRenderCache();
    try {
      renderSessionHead();
      renderMeta();
      renderCourts();
      renderQueue();
      renderPlayers();
      renderStats();
      renderHistory();
    } finally {
      renderCache = null;
    }
    renderSessionsToolbar();
  }

  /** Session header: name plus a one-line status, readable while collapsed. */
  function renderSessionHead() {
    const playing = state.courts.filter(ct => ct.activeMatch).length;
    const waiting = Session.waitingOrder(state).length;
    const matches = state.history.length;
    el.headName.textContent = state.name;
    // When the session started: date and time (hidden if unknown)
    const started = state.startedMs ? new Date(state.startedMs) : null;
    el.headStarted.hidden = !started;
    el.headStarted.textContent = started
      ? `Started ${started.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })} · ${Session.timeLabelNow(started)}`
      : '';
    el.headStatus.textContent = [
      `${playing} ${plural(playing, 'court')} playing`,
      `${waiting} waiting`,
      `${matches} ${matches === 1 ? 'match' : 'matches'} played`,
    ].join(' · ');

    // Who's on each court right now
    const names = ids => ids.map(id => {
      const p = renderCache ? renderCache.byId.get(id) : Session.playerById(state, id);
      return escapeHtml(p ? p.name : '?');
    }).join(' &amp; ');
    el.headPlaying.html = state.courts.map(ct => {
      const m = ct.activeMatch;
      const match = m
        ? `<span class="hp-team">${names(m.team1)}</span><span class="hp-vs">vs</span><span class="hp-team">${names(m.team2)}</span>`
        : '<span class="hp-empty">Waiting for players</span>';
      return `<li><span class="hp-court">Court ${ct.id}</span>${match}</li>`;
    }).join('');
  }

  function renderMeta() {
    const c = state.config;
    const count = activeCount();
    const doubles = c.matchType === 'doubles';
    const pairs = state.players.filter(p => partnerFor(p)).length / 2;
    const chip = (iconName, value, label) => `
      <div class="summary-chip">
        <span class="summary-icon">${Icons.svg(iconName)}</span>
        <span class="summary-text"><strong>${value}</strong><span>${label}</span></span>
      </div>`;
    el.sessionMeta.html =
      chip('users', count, plural(count, 'Player')) +
      chip('court', c.numCourts, plural(c.numCourts, 'Court')) +
      chip('trophy', doubles ? 'Doubles' : 'Singles', 'Match Type') +
      (doubles ? chip('link', pairs, plural(pairs, 'Fixed Pair')) : '');

    // Print list: everyone who played (players who left are marked)
    const roster = pdfRoster();
    const leftCount = roster.filter(r => r.left).length;
    el.printCourts.textContent = `${c.numCourts} Court${c.numCourts === 1 ? '' : 's'}`;
    el.printPlayerCount.textContent = leftCount ? `${roster.length} · ${leftCount} left` : roster.length;
    // more players = more columns, filled top to bottom
    const n = roster.length;
    const cols = PdfExport.playerColumns(n);
    el.printPlayerNames.style.setProperty('--cols', cols);
    el.printPlayerNames.style.setProperty('--rows', Math.max(1, Math.ceil(n / cols)));
    el.printPlayerNames.html = roster
      .map((r, i) => `<li class="${r.left ? 'is-left' : ''}"><span class="pp-num">${i + 1}</span><span class="pp-name">${escapeHtml(r.name)}${r.note ? ` <span class="pp-note">${escapeHtml(r.note)}</span>` : ''}</span></li>`)
      .join('');
  }

  /** When a player started, joined, left and came back, e.g. "Started 9:05 AM · Left 10:40 AM".
   *  `lower` gives "started 9:05 AM · left 10:40 AM" for the PDF notes. */
  function timelineText(p, lower = false) {
    return Session.playerTimeline(state, p)
      .map(item => `${lower ? item.label.toLowerCase() : item.label} ${item.at}`)
      .join(' · ');
  }

  /** Player list for the PDF: in join order, with when each started, joined, left or came back. */
  function pdfRoster() {
    return state.players.slice().sort((a, b) => a.id - b.id).map(p => ({
      name: p.name,
      note: timelineText(p, true),
      left: !Queue.isActive(p),
    }));
  }

  // ---- courts ----

  function renderCourts() {
    el.courtsGrid.dataset.count = String(state.courts.length);
    el.courtsGrid.html = state.courts.map(renderCourtCard).join('');
  }

  function renderTeam(ids, team, m, isDoubles) {
    const fixed = isDoubles && isFixedPairTeam(ids);
    const isWinner = m.winner === team;
    const isLoser = !!m.winner && !isWinner;
    const label = team === 'team1' ? 'Team 1' : 'Team 2';
    return `
      <div class="team-box${isWinner ? ' is-winner' : ''}${isLoser ? ' is-loser' : ''}">
        <div class="team-label">
          <span>${label}</span>
          ${fixed ? `<span class="pair-tag" title="Fixed partners">${Icons.svg('link')}Fixed pair</span>` : ''}
          ${isWinner ? `<span class="winner-tag">${Icons.svg('trophy')}Winner</span>` : ''}
        </div>
        <div class="team-names">${ids.map(id => `<span>${escapeHtml(playerName(id))}</span>`).join('')}</div>
      </div>`;
  }

  function renderCourtCard(court) {
    const head = badges => `
      <div class="court-head">
        <span class="court-tab">Court ${court.id}</span>
        <span class="court-badges">${badges}</span>
      </div>`;

    if (!court.activeMatch) {
      return `
        <article class="court-card is-idle" data-court-id="${court.id}">
          ${head('<span class="badge badge-neutral">Open</span>')}
          <div class="court-idle">
            <span class="court-idle-icon">${Icons.svg('hourglass')}</span>
            <div>
              <strong>Court available</strong>
              <p>${escapeHtml(court.idleReason || 'Waiting for the next players.')}</p>
            </div>
          </div>
        </article>`;
    }

    const m = court.activeMatch;
    const isDoubles = state.config.matchType === 'doubles';
    const hasWinner = !!m.winner;
    const status = hasWinner
      ? `<span class="badge badge-success">${Icons.svg('check')}Winner selected</span>`
      : '<span class="badge badge-warning"><span class="badge-dot"></span>In Progress</span>';
    const adjusted = m.manual
      ? '<span class="badge badge-plum" title="Players or pairings were changed by the organizer">Adjusted</span>'
      : '';

    const teams = `
      <div class="court-teams">
        ${renderTeam(m.team1, 'team1', m, isDoubles)}
        <div class="vs-badge" aria-label="versus">VS</div>
        ${renderTeam(m.team2, 'team2', m, isDoubles)}
      </div>`;

    let decision;
    if (!hasWinner) {
      decision = `
        <div class="court-decision">
          <span class="decision-label">Who won?</span>
          <button type="button" class="btn btn-win" data-action="select-winner" data-court-id="${court.id}" data-team="team1">${Icons.svg('trophy')}Team 1 Wins</button>
          <button type="button" class="btn btn-win" data-action="select-winner" data-court-id="${court.id}" data-team="team2">${Icons.svg('trophy')}Team 2 Wins</button>
        </div>`;
    } else {
      const winnerLabel = m.winner === 'team1' ? 'Team 1' : 'Team 2';
      // The winning team's score box comes first, so you type their score first
      const scoreField = team => `
            <label class="score-field${m.winner === team ? ' is-winner' : ''}">
              <span>${team === 'team1' ? 'Team 1' : 'Team 2'}${m.winner === team ? ' · Winner' : ''}</span>
              <input type="number" min="0" inputmode="numeric" data-role="score-input" data-court-id="${court.id}" data-team="${team}" value="${escapeHtml(team === 'team1' ? m.team1ScoreInput : m.team2ScoreInput)}" placeholder="–" />
            </label>`;
      const scoreFields = (m.winner === 'team1' ? ['team1', 'team2'] : ['team2', 'team1']).map(scoreField).join('');
      decision = `
        <div class="court-decision is-decided">
          <div class="decided-row">
            <span class="decided-label">${Icons.svg('trophy')}${winnerLabel} wins</span>
            <button type="button" class="link-btn" data-action="change-winner" data-court-id="${court.id}">Change winner</button>
          </div>
          <div class="score-label">Final score <span>(optional)</span></div>
          <div class="score-inputs">
            ${scoreFields}
          </div>
          <button type="button" class="btn btn-primary btn-block" data-action="complete-match" data-court-id="${court.id}">${Icons.svg('check')}Complete Match</button>
        </div>`;
    }

    const tools = `
      <div class="court-tools">
        <button type="button" class="btn btn-secondary btn-tool" data-action="open-swap" data-court-id="${court.id}">${Icons.svg('swap')}Swap Players</button>
        <button type="button" class="btn btn-secondary btn-tool" data-action="open-pairing" data-court-id="${court.id}">${Icons.svg('pencil')}Edit Pairing</button>
      </div>`;

    return `
      <article class="court-card${hasWinner ? ' is-decided' : ''}" data-court-id="${court.id}">
        ${head(adjusted + status)}
        <div class="court-body">
          ${teams}
          ${decision}
          ${tools}
        </div>
      </article>`;
  }

  // ---- waiting queue ----

  /** "Next to play": pretend the earliest match ends and run the same pick the app will use.
   *  Everyone in that next match, including players on court now who would go straight back on. */
  function forecastNextMatch(busyIds) {
    const live = state.courts.filter(c => c.activeMatch);
    const { matchType } = state.config;
    // Empty courts fill as soon as they can, so the next pick always comes after a match ends.
    // With no match in progress, there's nothing to predict.
    if (!live.length) {
      return Queue.nextUpIds(state.players, busyIds, matchType, state.matchSeq, state.waitOverride, state.nextMatchId, { strictRest: state.strictRest });
    }
    const finishing = live.reduce((a, b) => (b.activeMatch.matchId < a.activeMatch.matchId ? b : a)).activeMatch;
    const players = JSON.parse(JSON.stringify(state.players));
    const seq = state.matchSeq + 1;
    Queue.commitMatch(players, { courtId: 0, team1: finishing.team1, team2: finishing.team2, winner: 'team1', team1Score: null, team2Score: null, startSeq: finishing.startSeq }, seq);
    const stillBusy = new Set([...busyIds].filter(id => !finishing.team1.includes(id) && !finishing.team2.includes(id)));
    return Queue.nextUpIds(players, stillBusy, matchType, seq, state.waitOverride, state.nextMatchId, { strictRest: state.strictRest });
  }

  /** The "Next to play" highlight: only players who are waiting right now. */
  function forecastNextUp(busyIds) {
    return new Set([...forecastNextMatch(busyIds)].filter(id => !busyIds.has(id)));
  }

  /** Waiting list in the order players will be called: "Next to play" first, then everyone else. */
  function callOrder(busyIds = getBusyPlayerIds()) {
    const waiting = Session.waitingOrder(state);
    const nextUp = forecastNextUp(busyIds);
    const next = waiting.filter(p => nextUp.has(p.id));
    const rest = waiting.filter(p => !nextUp.has(p.id));
    return { order: next.concat(rest), nextCount: next.length };
  }

  function renderQueue() {
    const busyIds = getBusyPlayerIds();
    const { order: waiting, nextCount } = callOrder(busyIds);
    const manual = new Set(state.waitOverride || []);

    el.btnResetOrder.hidden = !state.waitOverride;
    el.strictRest.checked = !!state.strictRest;
    el.queueMode.className = `queue-mode${state.waitOverride ? ' is-manual' : ''}`;
    el.queueMode.html = state.waitOverride
      ? `${Icons.svg('hand')}<span><strong>Manual order (temporary).</strong> Players tagged “Manual” go first, in this order, until they are called to a court. Anyone finishing a match rejoins after them in automatic order. Fixed pairs are still called together.</span>`
      : `${Icons.svg('clock')}<span>Automatic order: fewest games first, then longest wait. Players who just finished rest first. Use the arrows to override temporarily.</span>`;

    if (!waiting.length) {
      el.waitingList.html = '<p class="empty-note">Everyone is currently playing.</p>';
      return;
    }

    const waitsFor = p => {
      const partner = partnerFor(p);
      return partner && busyIds.has(partner.id) ? partner : null;
    };
    const row = (p, i) => `
      <li class="queue-row${manual.has(p.id) ? ' is-manual' : ''}">
        <span class="queue-num">${i + 1}</span>
        <span class="queue-name">${escapeHtml(p.name)}${partnerBadge(p.id)}</span>
        ${waitsFor(p) ? `<span class="queue-tag tag-partner" title="Fixed partners are called together">Waits for ${escapeHtml(waitsFor(p).name)}</span>` : ''}
        ${manual.has(p.id) ? '<span class="queue-tag">Manual</span>' : ''}
        <span class="queue-move">
          <button type="button" class="icon-btn" data-move="-1" data-player-id="${p.id}" aria-label="Move ${escapeHtml(p.name)} up" ${i === 0 ? 'disabled' : ''}>${Icons.svg('arrowUp')}</button>
          <button type="button" class="icon-btn" data-move="1" data-player-id="${p.id}" aria-label="Move ${escapeHtml(p.name)} down" ${i === waiting.length - 1 ? 'disabled' : ''}>${Icons.svg('arrowDown')}</button>
        </span>
      </li>`;

    const indexed = waiting.map((p, i) => [p, i]);
    const next = indexed.slice(0, nextCount);
    const rest = indexed.slice(nextCount);

    el.waitingList.html = `
      ${next.length ? `
        <div class="queue-next">
          <div class="queue-next-title">${Icons.svg('star')}Next to play</div>
          <ol class="queue-list">${next.map(([p, i]) => row(p, i)).join('')}</ol>
        </div>` : ''}
      ${rest.length ? `<ol class="queue-list">${rest.map(([p, i]) => row(p, i)).join('')}</ol>` : ''}`;
  }

  // ---- player management ----

  function renderPlayers() {
    const doubles = state.config.matchType === 'doubles';
    const count = activeCount();
    el.pmCount.textContent = `${count} ${plural(count, 'Player')}`;
    el.pmHint.textContent = doubles
      ? 'Add latecomers anytime. Use a player’s ⋮ menu to rename, set a fixed partner, or remove them.'
      : 'Add latecomers anytime. Use a player’s ⋮ menu to rename or remove them.';

    const statusBadge = { playing: 'badge-success', waiting: 'badge-lavender', removed: 'badge-neutral' };
    el.pmList.html = state.players
      .slice()
      .sort((a, b) => (Queue.isActive(b) - Queue.isActive(a)) || a.id - b.id)
      .map(p => {
        const status = playerStatus(p);
        const partner = partnerFor(p);
        const partnerLine = !doubles ? '' : partner
          ? `<div class="pm-partner has-partner">${Icons.svg('link')}Partner: ${escapeHtml(partner.name)}</div>`
          : '<div class="pm-partner">No fixed partner</div>';
        const action = Queue.isActive(p)
          ? `<button type="button" class="icon-btn pm-more" data-action="manage-player" data-player-id="${p.id}" aria-label="Manage ${escapeHtml(p.name)}" title="Rename, partner, remove">${Icons.svg('more')}</button>`
          : `<button type="button" class="btn btn-secondary btn-sm pm-restore" data-action="restore-player" data-player-id="${p.id}" aria-label="Restore ${escapeHtml(p.name)}">${Icons.svg('reset')}Restore</button>`;
        return `
          <li class="pm-card is-${status.key}">
            <div class="pm-top">
              <span class="pm-name">${escapeHtml(p.name)}</span>
              ${action}
            </div>
            <div class="pm-meta">
              <span class="badge ${statusBadge[status.key]}">${status.label}</span>
              <span class="pm-games">${p.gamesPlayed} ${plural(p.gamesPlayed, 'game')}</span>
            </div>
            ${timelineText(p) ? `<div class="pm-times">${Icons.svg('clock')}${escapeHtml(timelineText(p))}</div>` : ''}
            ${partnerLine}
          </li>`;
      })
      .join('');
  }

  // ---- statistics ----

  function winRateBadge(p) {
    if (p.gamesPlayed === 0) return '<span class="rate rate-none">—</span>';
    const pct = Math.round((p.wins / p.gamesPlayed) * 100);
    return `<span class="rate ${pct >= 50 ? 'rate-high' : 'rate-low'}">${pct}%</span>`;
  }

  /** Everyone who played (including players who left), most games first. Used by the table and the PDF. */
  function statsPlayers() {
    return state.players
      .slice()
      .sort((a, b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name));
  }

  function renderStats() {
    const anyScores = state.players.some(p => p.scoredGames > 0);
    const players = statsPlayers();
    const removedTag = p => (Queue.isActive(p) ? '' : ` <span class="muted-tag">left${p.leftAt ? ` ${escapeHtml(p.leftAt)}` : ''}</span>`);
    const pts = (p, key) => (p.scoredGames > 0 ? p[key] : '—');

    // Desktop/tablet table
    el.statsBody.html = players.map(p => `
      <tr>
        <td class="player-name-cell">${escapeHtml(p.name)}${removedTag(p)}</td>
        <td class="num">${p.gamesPlayed}</td>
        <td class="num">${p.wins}</td>
        <td class="num">${p.losses}</td>
        <td class="num">${winRateBadge(p)}</td>
        ${anyScores ? `<td class="num">${pts(p, 'pointsScored')}</td><td class="num">${pts(p, 'pointsAgainst')}</td>` : ''}
      </tr>`).join('');
    const extraHeaders = anyScores ? '<th class="num">Pts For</th><th class="num">Pts Against</th>' : '';
    el.statsHead.html =
      `<th>Player</th><th class="num">Games</th><th class="num">Wins</th><th class="num">Losses</th><th class="num">Win Rate</th>${extraHeaders}`;

    // Phone cards: main numbers first, points in an expandable row
    el.statsCards.html = players.map(p => `
      <article class="stat-card">
        <div class="stat-card-name">${escapeHtml(p.name)}${removedTag(p)}</div>
        <dl class="stat-grid">
          <div><dt>Games</dt><dd>${p.gamesPlayed}</dd></div>
          <div><dt>Wins</dt><dd>${p.wins}</dd></div>
          <div><dt>Losses</dt><dd>${p.losses}</dd></div>
          <div><dt>Win rate</dt><dd>${winRateBadge(p)}</dd></div>
        </dl>
        ${anyScores ? `
          <details class="stat-more">
            <summary>Points ${Icons.svg('chevronDown')}</summary>
            <dl class="stat-grid stat-grid-2">
              <div><dt>Pts for</dt><dd>${pts(p, 'pointsScored')}</dd></div>
              <div><dt>Pts against</dt><dd>${pts(p, 'pointsAgainst')}</dd></div>
            </dl>
          </details>` : ''}
      </article>`).join('');
  }

  // ---- history ----

  /** PDF list: one row per match, oldest first (match #1 at the top). */
  function renderHistoryPrint() {
    if (!state.history.length) {
      el.historyPrintBody.innerHTML = '<tr><td colspan="7" class="hp-empty">No matches completed yet.</td></tr>';
      return;
    }
    el.historyPrintBody.innerHTML = state.history
      .slice()
      .map(h => {
        const t1 = historyNames(h.team1, h.team1Names);
        const t2 = historyNames(h.team2, h.team2Names);
        const w1 = h.winner === 'team1';
        const score = h.team1Score == null
          ? '<span class="hp-muted">Not recorded</span>'
          : `${h.team1Score}–${h.team2Score}`;
        return `
          <tr>
            <td class="hp-num">${h.number}</td>
            <td class="hp-time">${escapeHtml(h.timeLabel)}${h.manual ? '<span class="hp-note">Adjusted line-up</span>' : ''}</td>
            <td class="hp-court">${h.courtId}</td>
            <td class="${w1 ? 'hp-win' : 'hp-lose'}">${escapeHtml(t1)}</td>
            <td class="${w1 ? 'hp-lose' : 'hp-win'}">${escapeHtml(t2)}</td>
            <td class="hp-winner">${escapeHtml(w1 ? t1 : t2)}</td>
            <td class="hp-score">${score}</td>
          </tr>`;
      })
      .join('');
  }

  function renderHistory() {
    // The print list is built right before printing, not on every change
    if (!state.history.length) {
      el.historyList.html = '<p class="empty-note">No matches completed yet.</p>';
      return;
    }
    // Only the latest matches are drawn, so the page stays quick in long sessions ("Show older matches" adds more).
    // The PDF and the print list always include every match.
    const shown = Math.min(state.history.length, active.historyLimit || HISTORY_PAGE);
    const older = state.history.length - shown;
    const cards = state.history
      .slice(-shown)
      .reverse()
      .map((h, idx) => {
        const t1 = historyNames(h.team1, h.team1Names);
        const t2 = historyNames(h.team2, h.team2Names);
        const w1 = h.winner === 'team1';
        const hasScore = h.team1Score != null;
        const scoreLabel = hasScore ? `${h.team1Score}–${h.team2Score}` : 'Not recorded';
        return `
          <article class="history-card${idx === 0 ? ' is-latest' : ''}">
            <div class="history-top">
              <span class="history-num">#${h.number}</span>
              <span class="history-meta">Court ${h.courtId} · ${escapeHtml(h.timeLabel)}</span>
              ${idx === 0 ? '<span class="badge badge-lavender">Latest</span>' : ''}
              ${h.manual ? '<span class="badge badge-plum" title="Line-up was adjusted by the organizer">Adjusted line-up</span>' : ''}
            </div>
            <div class="history-teams">
              <div class="history-team${w1 ? ' is-winner' : ''}">${w1 ? Icons.svg('trophy') : ''}<span>${escapeHtml(t1)}</span></div>
              <div class="history-vs">vs</div>
              <div class="history-team${w1 ? '' : ' is-winner'}">${w1 ? '' : Icons.svg('trophy')}<span>${escapeHtml(t2)}</span></div>
            </div>
            <div class="history-foot">
              <span class="history-winner" title="Winner: ${escapeHtml(w1 ? t1 : t2)}">Winner: ${escapeHtml(w1 ? t1 : t2)}</span>
              <span class="score-pill${hasScore ? '' : ' is-empty'}">${scoreLabel}</span>
            </div>
          </article>`;
      })
      .join('');
    el.historyList.html = cards + (older > 0
      ? `<button type="button" class="btn btn-secondary btn-sm history-more" data-action="more-history">Show older matches (${older} more)</button>`
      : '');
  }

  // ---------- export ----------

  /** Export PDF: builds the file with js/pdf.js so it looks the same on every device.
   *  If that fails (e.g. offline), opens the print dialog instead. */
  let exporting = false;
  async function exportPdf() {
    if (exporting || !active) return;
    exporting = true;
    const ctx = active;
    const btn = el.btnExportPdf;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${Icons.svg('printer')}Preparing…`;
    try {
      await PdfExport.generate(buildPdfData());
    } catch (err) {
      console.warn('PDF export failed, using the print dialog instead.', err);
      showToast('Couldn’t create the PDF here, opening the print dialog instead.');
      activate(ctx);
      window.print();
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
      exporting = false;
    }
  }

  /** What every PDF needs: session details and the sponsor images. */
  function pdfBase() {
    const c = state.config;
    return {
      sessionName: state.name,
      dateLabel: localDateISO(new Date()),
      courts: c.numCourts,
      matchType: c.matchType === 'doubles' ? 'Doubles' : 'Singles',
      sponsorUrl: document.querySelector('a.sponsor').href,
      logoUrl: 'img/pickle-sa-balay.webp',
      watermarkUrl: 'img/pickle-sa-balay-badge.webp',
    };
  }

  /** Export the player statistics as a PDF (same look as the match history PDF). */
  let exportingStats = false;
  async function exportStatsPdf() {
    if (exportingStats || !active) return;
    exportingStats = true;
    const btn = el.btnExportStatsPdf;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${Icons.svg('printer')}Preparing…`;
    try {
      await PdfExport.generateStats(buildStatsPdfData());
    } catch (err) {
      console.warn('Statistics PDF export failed.', err);
      showToast('Couldn’t create the PDF. Check your internet connection and try again.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
      exportingStats = false;
    }
  }

  /** Data for the statistics PDF: the same rows and order as the Player Statistics table. */
  function buildStatsPdfData() {
    const hasScores = state.players.some(p => p.scoredGames > 0);
    return {
      ...pdfBase(),
      matches: state.history.length,
      hasScores,
      stats: statsPlayers().map(p => {
        const left = !Queue.isActive(p);
        const pct = p.gamesPlayed > 0 ? Math.round((p.wins / p.gamesPlayed) * 100) : null;
        return {
          name: p.name,
          games: p.gamesPlayed,
          wins: p.wins,
          losses: p.losses,
          winRate: pct == null ? '—' : `${pct}%`,
          winRatePct: pct,
          ptsFor: p.scoredGames > 0 ? p.pointsScored : '—',
          ptsAgainst: p.scoredGames > 0 ? p.pointsAgainst : '—',
          left,
          note: timelineText(p, true),
        };
      }),
    };
  }

  /** Data for the PDF, oldest match first (match #1 at the top). */
  function buildPdfData() {
    return {
      ...pdfBase(),
      players: pdfRoster(),
      history: state.history.slice().map(h => ({
        number: h.number,
        time: h.timeLabel || '',
        court: h.courtId,
        team1: historyNames(h.team1, h.team1Names),
        team2: historyNames(h.team2, h.team2Names),
        winner: h.winner,
        score: h.team1Score == null ? null : `${h.team1Score}–${h.team2Score}`,
        manual: !!h.manual,
      })),
    };
  }

  /** Runs before any print: opens the history section and sets a dated title
   *  (used as the PDF file name). Both are undone after printing. */
  let printRestore = null;
  function preparePrint() {
    if (printRestore || !active) return;
    renderHistoryPrint(); // build the print list now
    const block = active.root;
    const historyDetails = el.historyCard;
    const originalTitle = document.title;
    const wasOpen = [block.open, historyDetails.open];
    block.open = true;
    historyDetails.open = true;
    block.classList.add('print-target');
    document.body.classList.add('is-printing-session');
    document.title = `Pickleball Match History - ${state.name} - ${localDateISO(new Date())}`;
    printRestore = () => {
      document.title = originalTitle;
      [block.open, historyDetails.open] = wasOpen;
      block.classList.remove('print-target');
      document.body.classList.remove('is-printing-session');
      printRestore = null;
    };
  }

  function finishPrint() {
    if (printRestore) printRestore();
  }

  /** Today's date as YYYY-MM-DD in local time. */
  function localDateISO(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---------- utils ----------

  function escapeHtml(str) {
    // Safe for text and attribute values.
    return (str == null ? '' : String(str))
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
