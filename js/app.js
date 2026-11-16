/**
 * app.js
 */

const App = (() => {
  const el = {};
  const SESSION_VERSION = 2;

  const state = {
    version: SESSION_VERSION,
    phase: 'setup', // 'setup' | 'session'
    config: null, // { numPlayers, numCourts, matchType, perMatch, activeCourts, idleCourts }
    players: [],
    courts: [],
    history: [],
    matchSeq: 0,
    nextMatchId: 1,
    waitOverride: null, // temporary manual waiting order (player ids) or null
  };

  let draft = {
    numPlayers: 8,
    numCourts: 2,
    matchType: 'doubles',
    names: [],
  };

  let modal = null; // { onChange, onSave, onAction } while the dialog is open

  // ---------- init ----------

  function init() {
    Icons.hydrate(document);
    cacheEls();
    bindEvents();

    const saved = Storage.loadSession();
    if (saved && !isValidSession(saved)) {
      console.warn('Discarding saved session: unrecognised or corrupted data.');
      Storage.clearSession();
    }
    if (saved && isValidSession(saved)) {
      applySavedSession(saved);
      // A court whose damaged line-up was cleared during repair gets refilled,
      // and the repaired session is saved so the damage doesn't come back.
      fillIdleCourts();
      persist();
      showView('session');
      renderSession();
    } else {
      const savedDraft = Storage.loadDraft();
      if (savedDraft) draft = Object.assign(draft, savedDraft);
      showView('setup');
      renderSetup();
    }

    // Keep tabs in step: if another tab/window changes the session, follow it
    // instead of later overwriting its changes with this tab's older copy.
    Storage.onSessionChangedElsewhere(onSessionChangedElsewhere);
  }

  function applySavedSession(saved) {
    Object.assign(state, migrateSession(saved));
    state.phase = 'session';
  }

  function onSessionChangedElsewhere(saved) {
    closeModal(); // any open dialog was based on the old state
    if (saved && isValidSession(saved)) {
      applySavedSession(saved);
      showView('session');
      renderSession();
      showToast('Updated with changes made in another tab.');
    } else if (state.phase === 'session') {
      // The session was reset in another tab
      resetToSetup();
      showToast('The session was reset in another tab.');
    }
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

  /**
   * Upgrade older saved sessions (v1 had no removal, partners or manual order)
   * and repair damaged data so one bad record can never break the app:
   * bad numbers become 0, unusable history entries are dropped, broken court
   * line-ups are cleared (the court is refilled automatically).
   */
  function migrateSession(s) {
    const int = (v, fallback = 0) => (Number.isInteger(v) && v >= 0 ? v : fallback);
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

    s.players.forEach(p => {
      if (typeof p.active !== 'boolean') p.active = true;
      if (!Number.isInteger(p.fixedPartnerId)) p.fixedPartnerId = null;
      ['gamesPlayed', 'wins', 'losses', 'lastActiveSeq', 'pointsScored', 'pointsAgainst', 'scoredGames']
        .forEach(k => { p[k] = int(p[k]); });
      p.queueGames = int(p.queueGames, p.gamesPlayed);
      if (!Number.isInteger(p.lastCourtId)) p.lastCourtId = null;
      p.teammates = obj(p.teammates);
      p.name = Scheduler.normalizeName(p.name) || p.name; // capitalize names from older saves
      ['joinedAt', 'leftAt', 'rejoinedAt'].forEach(k => { if (typeof p[k] !== 'string') delete p[k]; });
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
        && new Set(all).size === all.length          // nobody twice on this court
        && all.every(id => !onCourt.has(id));         // nobody on two courts
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
      // second pass: drop the other half of any partnership broken above
      const q = byId.get(p.fixedPartnerId);
      if (p.fixedPartnerId != null && (!q || q.fixedPartnerId !== p.id)) p.fixedPartnerId = null;
    });
    if (!Array.isArray(s.waitOverride) || !s.waitOverride.every(Number.isInteger)) s.waitOverride = null;
    s.version = SESSION_VERSION;
    return s;
  }

  function cacheEls() {
    el.setupView = document.getElementById('setup-view');
    el.sessionView = document.getElementById('session-view');

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

    el.sessionMeta = document.getElementById('session-meta');
    el.printCourts = document.getElementById('print-courts');
    el.printPlayerCount = document.getElementById('print-player-count');
    el.printPlayerNames = document.getElementById('print-player-names');
    el.courtsGrid = document.getElementById('courts-grid');
    el.waitingList = document.getElementById('waiting-list');
    el.queueMode = document.getElementById('queue-mode');
    el.btnResetOrder = document.getElementById('btn-reset-order');
    el.statsBody = document.getElementById('stats-body');
    el.statsCards = document.getElementById('stats-cards');
    el.historyList = document.getElementById('history-list');
    el.historyPrintBody = document.getElementById('history-print-body');
    el.pmCount = document.getElementById('pm-count');
    el.pmHint = document.getElementById('pm-hint');
    el.pmList = document.getElementById('pm-list');

    el.btnExportPdf = document.getElementById('btn-export-pdf');
    el.btnClearHistory = document.getElementById('btn-clear-history');
    el.btnReset = document.getElementById('btn-reset');

    el.modal = document.getElementById('modal');
    el.modalTitle = document.getElementById('modal-title');
    el.modalBody = document.getElementById('modal-body');
    el.modalError = document.getElementById('modal-error');
    el.modalSave = document.getElementById('modal-save');
    el.modalCancel = document.getElementById('modal-cancel');
    el.modalX = document.getElementById('modal-x');
    el.toast = document.getElementById('toast');
    el.statsHead = document.getElementById('stats-table').querySelector('thead tr');

    // Sections redrawn on every change get a cached `.html` setter: the DOM is
    // only touched when the markup actually changed (keeps big sessions fast).
    [el.sessionMeta, el.printPlayerNames, el.courtsGrid, el.queueMode, el.waitingList,
      el.pmList, el.statsBody, el.statsHead, el.statsCards, el.historyList].forEach(node => {
      let last = null;
      Object.defineProperty(node, 'html', {
        configurable: true,
        get: () => last,
        set: v => { if (v !== last) { last = v; node.innerHTML = v; } },
      });
    });
    el.header = document.querySelector('.app-header');
  }

  function bindEvents() {
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
    // Capitalize a name once the organizer leaves the field ("maria christine" -> "Maria Christine")
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

    // Fixed header (CSS) condenses once the page is scrolled. The page keeps a
    // spacer of the header's full height, so condensing never moves content.
    // The back-to-top button appears once the page is scrolled well down.
    const header = el.header;
    const toTop = document.getElementById('btn-to-top');

    // While expanded, track the header's height continuously (content changes,
    // expand animation). While condensed, leave the spacer alone.
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        if (!header.classList.contains('is-condensed')) setHeaderSpace(header.offsetHeight);
      }).observe(header);
    }
    window.addEventListener('resize', syncHeaderSpace, { passive: true });

    // Only touch the DOM when the state actually changes.
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
    // When the expand/condense animation finishes, re-check the spacer.
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

    el.courtsGrid.addEventListener('click', onCourtsGridClick);
    el.courtsGrid.addEventListener('input', onCourtsGridInput);

    el.waitingList.addEventListener('click', onWaitingListClick);
    el.btnResetOrder.addEventListener('click', () => {
      Session.resetWaitingOrder(state);
      commitChange();
    });
    el.pmList.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.playerId, 10);
      if (btn.dataset.action === 'manage-player') openManagePlayerModal(id);
      else if (btn.dataset.action === 'restore-player') onRestorePlayer(id);
    });
    document.getElementById('btn-add-players').addEventListener('click', openAddPlayersModal);

    el.btnExportPdf.addEventListener('click', exportPdf);
    el.btnClearHistory.addEventListener('click', onClearHistory);
    el.btnReset.addEventListener('click', onResetSession);

    el.modalBody.addEventListener('input', () => modal && modal.onChange && modal.onChange());
    el.modalBody.addEventListener('change', () => modal && modal.onChange && modal.onChange());
    el.modalBody.addEventListener('click', e => {
      const btn = e.target.closest('[data-modal-action]');
      if (btn && modal && modal.onAction) modal.onAction(btn.dataset.modalAction);
    });
    el.modalSave.addEventListener('click', onModalSave);
    el.modalCancel.addEventListener('click', closeModal);
    el.modalX.addEventListener('click', closeModal);
    el.modal.addEventListener('close', () => { modal = null; });
    // Close on a backdrop click only if the press also STARTED on the backdrop;
    // otherwise selecting text in a field and releasing outside would close it.
    let pressStartedOnBackdrop = false;
    el.modal.addEventListener('pointerdown', e => { pressStartedOnBackdrop = e.target === el.modal; });
    el.modal.addEventListener('click', e => {
      if (e.target === el.modal && pressStartedOnBackdrop) closeModal();
      pressStartedOnBackdrop = false;
    });

    window.addEventListener('beforeprint', preparePrint);
    window.addEventListener('afterprint', finishPrint);
  }

  function showView(view) {
    el.setupView.hidden = view !== 'setup';
    el.sessionView.hidden = view !== 'session';
    el.sessionMeta.hidden = view !== 'session';
    document.body.classList.toggle('is-session', view === 'session');
    syncHeaderSpace();
  }

  // ---------- header spacer ----------

  function setHeaderSpace(px) {
    document.documentElement.style.setProperty('--header-h', `${Math.ceil(px)}px`);
  }

  /**
   * Reserve the header's FULL (expanded) height at the top of the page, even
   * if it is currently condensed: briefly measure it expanded with transitions
   * off, then restore. Happens within one frame, so nothing visibly changes.
   */
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
    void header.offsetHeight; // apply the condensed styles again before re-enabling transitions
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

  /**
   * Display-only feedback while typing names: filled/duplicate highlighting,
   * "x of N named" progress and the ready status by the Generate button.
   * Validation on submit (Scheduler.validateSetup) is unchanged.
   */
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

  /** −/+ buttons beside the number inputs; fire 'input' so the normal handlers run. */
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
      el.setupErrors.innerHTML = validation.errors.map(msg => `<div class="error-item">${escapeHtml(msg)}</div>`).join('');
      el.setupErrors.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    el.setupErrors.hidden = true;
    el.setupErrors.innerHTML = '';

    const setup = Scheduler.computeCourtSetup(d);

    state.version = SESSION_VERSION;
    state.config = { numPlayers: d.numPlayers, numCourts: d.numCourts, matchType: d.matchType, ...setup };
    state.players = generatePlayers(d.names.slice(0, d.numPlayers));
    state.courts = generateCourts(d.numCourts);
    state.history = [];
    state.matchSeq = 0;
    state.nextMatchId = 1;
    state.waitOverride = null;

    state.courts.forEach(court => generateMatchForCourt(court));

    state.phase = 'session';
    Storage.clearDraft();
    persist();
    showView('session');
    renderSession();
  }

  // ---------- core generators (reusable, DOM-free) ----------

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
    const plan = Queue.generateMatch(state.players, busyIds, state.config.matchType, state.matchSeq, state.waitOverride, state.nextMatchId);
    if (!plan) {
      court.activeMatch = null;
      court.idleReason = 'Waiting for enough players to free up.';
      return false;
    }
    court.idleReason = null;
    court.activeMatch = {
      matchId: state.nextMatchId++,
      team1: plan.team1,
      team2: plan.team2,
      winner: null,
      team1ScoreInput: '',
      team2ScoreInput: '',
      manual: false,
    };
    // Players who were manually ordered and have now been called leave the override.
    Session.pruneOverride(state);
    return true;
  }

  /** Start a match on any empty court that can now be filled. Returns filled court ids. */
  function fillIdleCourts() {
    const filled = [];
    state.courts.forEach(court => {
      if (!court.activeMatch && generateMatchForCourt(court)) filled.push(court.id);
    });
    return filled;
  }

  /** Common tail of every organizer edit: tidy state, fill free courts, save, redraw. */
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
      { courtId: court.id, team1: m.team1, team2: m.team2, winner: m.winner, team1Score, team2Score },
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
      // Names as they were when the match was played, so renames never rewrite history.
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
    modal = { onChange, onSave, onAction };
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
          <p class="hint">New players join the rotation level with whoever has played least, behind the people already waiting, so they don’t jump the queue. Their stats start at 0.${doubles ? ' You can set a fixed partner from their ⋮ menu afterwards.' : ''} Typing the name of a removed player restores them with their stats.</p>
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
    // Displayed stats are derived from history, so they are reset with it.
    // Rotation data is NOT: queueGames, lastActiveSeq, matchSeq and the
    // partner/opponent memory are kept so fairness continues as before.
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
    if (!confirm('Reset the session? This clears all players, courts, stats, and match history.')) return;
    Storage.clearSession();
    Storage.clearDraft();
    resetToSetup();
  }

  /** Return to a blank setup screen (storage is handled by the caller). */
  function resetToSetup() {
    closeModal();
    state.phase = 'setup';
    state.config = null;
    state.players = [];
    state.courts = [];
    state.history = [];
    state.matchSeq = 0;
    state.nextMatchId = 1;
    state.waitOverride = null;
    draft = { numPlayers: 8, numCourts: 2, matchType: 'doubles', names: [] };

    el.sessionMeta.html = '';
    el.printCourts.textContent = '';
    el.printPlayerCount.textContent = '';
    el.printPlayerNames.html = '';
    el.courtsGrid.html = '';
    el.waitingList.html = '';
    el.queueMode.textContent = '';
    el.btnResetOrder.hidden = true;
    el.statsBody.html = '';
    el.statsCards.html = '';
    el.pmList.html = '';
    el.statsHead.html =
      '<th>Player</th><th>Games</th><th>Wins</th><th>Losses</th><th>Win Rate</th>';
    el.historyList.html = '';
    el.historyPrintBody.innerHTML = '';
    ['stats-card', 'history-card', 'players-card'].forEach(id => {
      const card = document.getElementById(id);
      if (card) card.open = true;
    });

    el.form.reset();
    el.inputPlayers.value = draft.numPlayers;
    el.inputCourts.value = draft.numCourts;
    [...el.matchTypeToggle.children].forEach(btn => btn.classList.toggle('active', btn.dataset.value === draft.matchType));
    renderPlayerNameInputs();
    updateCalcPreview();
    showView('setup');
  }

  function persist() {
    Storage.saveSession(state);
  }

  // ---------- rendering: setup ----------

  function renderSetup() {
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

  /**
   * Lookups built once per full redraw (instead of once per player), which
   * keeps large groups (hundreds of players) responsive. Outside a redraw the
   * helpers fall back to computing directly.
   */
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

  /** History names: the name used at the time, plus the current name if it has changed. */
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
    const metaBefore = el.sessionMeta.html;
    renderCache = buildRenderCache();
    try {
      renderMeta();
      renderCourts();
      renderQueue();
      renderPlayers();
      renderStats();
      renderHistory();
    } finally {
      renderCache = null;
    }
    // Re-measure the header only when the summary chips actually changed
    if (el.sessionMeta.html !== metaBefore) syncHeaderSpace();
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

    // Print list: everyone who took part (players who left are marked)
    const roster = pdfRoster();
    const leftCount = roster.filter(r => r.left).length;
    el.printCourts.textContent = `${c.numCourts} Court${c.numCourts === 1 ? '' : 's'}`;
    el.printPlayerCount.textContent = leftCount ? `${roster.length} · ${leftCount} left` : roster.length;
    // more players -> more columns, filled top-to-bottom
    const n = roster.length;
    const cols = PdfExport.playerColumns(n);
    el.printPlayerNames.style.setProperty('--cols', cols);
    el.printPlayerNames.style.setProperty('--rows', Math.max(1, Math.ceil(n / cols)));
    el.printPlayerNames.html = roster
      .map((r, i) => `<li class="${r.left ? 'is-left' : ''}"><span class="pp-num">${i + 1}</span><span class="pp-name">${escapeHtml(r.name)}${r.note ? ` <span class="pp-note">${escapeHtml(r.note)}</span>` : ''}</span></li>`)
      .join('');
  }

  /** Session roster for print/PDF: join order, with joined/left notes. */
  function pdfRoster() {
    return state.players.slice().sort((a, b) => a.id - b.id).map(p => {
      const left = !Queue.isActive(p);
      let note = '';
      if (left) note = p.leftAt ? `left ${p.leftAt}` : 'left';
      else if (p.rejoinedAt) note = `rejoined ${p.rejoinedAt}`;
      else if (p.joinedAt) note = `joined ${p.joinedAt}`;
      return { name: p.name, note, left };
    });
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
      decision = `
        <div class="court-decision is-decided">
          <div class="decided-row">
            <span class="decided-label">${Icons.svg('trophy')}${winnerLabel} wins</span>
            <button type="button" class="link-btn" data-action="change-winner" data-court-id="${court.id}">Change winner</button>
          </div>
          <div class="score-label">Final score <span>(optional)</span></div>
          <div class="score-inputs">
            <label class="score-field">
              <span>Team 1</span>
              <input type="number" min="0" inputmode="numeric" data-role="score-input" data-court-id="${court.id}" data-team="team1" value="${escapeHtml(m.team1ScoreInput)}" placeholder="–" />
            </label>
            <label class="score-field">
              <span>Team 2</span>
              <input type="number" min="0" inputmode="numeric" data-role="score-input" data-court-id="${court.id}" data-team="team2" value="${escapeHtml(m.team2ScoreInput)}" placeholder="–" />
            </label>
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

  /**
   * "Next to play" forecast. The next pick happens right after a match ends,
   * so simulate exactly that: the match that started
   * earliest finishes (the result doesn't matter to matchmaking), its players
   * rejoin with updated games/history, and the same pick is run with the same
   * seed the real one will use.
   */
  function forecastNextUp(busyIds) {
    const live = state.courts.filter(c => c.activeMatch);
    const { matchType } = state.config;
    // Empty courts are refilled the moment that becomes possible, so any court
    // still empty now can't be filled yet: the next pick always follows a match
    // ending. Only with no match in progress at all is there nothing to simulate.
    if (!live.length) {
      return Queue.nextUpIds(state.players, busyIds, matchType, state.matchSeq, state.waitOverride, state.nextMatchId);
    }
    const finishing = live.reduce((a, b) => (b.activeMatch.matchId < a.activeMatch.matchId ? b : a)).activeMatch;
    const players = JSON.parse(JSON.stringify(state.players));
    const seq = state.matchSeq + 1;
    Queue.commitMatch(players, { courtId: 0, team1: finishing.team1, team2: finishing.team2, winner: 'team1', team1Score: null, team2Score: null }, seq);
    const stillBusy = new Set([...busyIds].filter(id => !finishing.team1.includes(id) && !finishing.team2.includes(id)));
    const ids = Queue.nextUpIds(players, stillBusy, matchType, seq, state.waitOverride, state.nextMatchId);
    // Only highlight people who are actually waiting right now
    return new Set([...ids].filter(id => !busyIds.has(id)));
  }

  /**
   * The waiting list in the order people will actually be called: the
   * forecast "Next to play" group first, then everyone else in rotation order.
   * Numbers and the ↑ ↓ arrows both use this order, so what you see is what
   * happens.
   */
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
    el.queueMode.className = `queue-mode${state.waitOverride ? ' is-manual' : ''}`;
    el.queueMode.html = state.waitOverride
      ? `${Icons.svg('hand')}<span><strong>Manual order (temporary).</strong> Players tagged “Manual” go first, in this order, until they are called to a court. Anyone finishing a match rejoins after them in automatic order. Fixed pairs are still called together.</span>`
      : `${Icons.svg('clock')}<span>Automatic order: fewest games first, then longest wait. Use the arrows to override temporarily.</span>`;

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
              ${p.rejoinedAt && Queue.isActive(p) ? `<span class="pm-games">· Rejoined ${escapeHtml(p.rejoinedAt)}</span>`
                : p.joinedAt ? `<span class="pm-games">· Joined ${escapeHtml(p.joinedAt)}</span>` : ''}
            </div>
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

  function renderStats() {
    const anyScores = state.players.some(p => p.scoredGames > 0);
    const players = state.players
      .slice() // everyone who took part, including players who left
      .sort((a, b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name));
    const removedTag = p => (Queue.isActive(p) ? '' : ` <span class="muted-tag">left${p.leftAt ? ` ${escapeHtml(p.leftAt)}` : ''}</span>`);
    const pts = (p, key) => (p.scoredGames > 0 ? p[key] : '—');

    // Desktop / tablet table
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

    // Mobile cards: key numbers first, points tucked into an expandable row
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

  /** PDF-only list view: one row per match, newest first (same order as the cards). */
  function renderHistoryPrint() {
    if (!state.history.length) {
      el.historyPrintBody.innerHTML = '<tr><td colspan="7" class="hp-empty">No matches completed yet.</td></tr>';
      return;
    }
    el.historyPrintBody.innerHTML = state.history
      .slice()
      .reverse()
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
    // The print-only list is built just before printing (preparePrint), not on every change
    if (!state.history.length) {
      el.historyList.html = '<p class="empty-note">No matches completed yet.</p>';
      return;
    }
    el.historyList.html = state.history
      .slice()
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
  }

  // ---------- export ----------

  /**
   * Vanilla-JS PDF export: prints a stripped-down, paper-friendly view
   * (player stats + match history only) via the browser's native
   * "Save as PDF" print destination — no PDF library required.
   */
  /**
   * Export PDF builds the file directly (js/pdf.js), so it looks the same on
   * phones and computers and has no browser header/footer (page address/date).
   * If the PDF tool can't load (e.g. offline), fall back to the print dialog;
   * Ctrl+P / the browser menu still use the print stylesheet.
   */
  let exporting = false;
  async function exportPdf() {
    if (exporting || state.phase !== 'session') return;
    exporting = true;
    const btn = el.btnExportPdf;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${Icons.svg('printer')}Preparing…`;
    try {
      await PdfExport.generate(buildPdfData());
    } catch (err) {
      console.warn('PDF export failed, using the print dialog instead.', err);
      showToast('Couldn’t create the PDF here, opening the print dialog instead.');
      window.print();
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
      exporting = false;
    }
  }

  /** Everything the PDF needs, in display order (history newest first, as on screen). */
  function buildPdfData() {
    const c = state.config;
    return {
      dateLabel: localDateISO(new Date()),
      courts: c.numCourts,
      matchType: c.matchType === 'doubles' ? 'Doubles' : 'Singles',
      players: pdfRoster(),
      history: state.history.slice().reverse().map(h => ({
        number: h.number,
        time: h.timeLabel || '',
        court: h.courtId,
        team1: historyNames(h.team1, h.team1Names),
        team2: historyNames(h.team2, h.team2Names),
        winner: h.winner,
        score: h.team1Score == null ? null : `${h.team1Score}–${h.team2Score}`,
        manual: !!h.manual,
      })),
      sponsorUrl: document.querySelector('a.sponsor').href,
      logoUrl: 'img/pickle-sa-balay.webp',
      watermarkUrl: 'img/pickle-sa-balay-badge.webp',
    };
  }

  /**
   * Runs for EVERY print (Export PDF button, Ctrl+P, browser menu): opens the
   * history section (a collapsed <details> would print empty) and sets a dated
   * title, which browsers use as the PDF file name. afterprint restores both.
   */
  let printRestore = null;
  function preparePrint() {
    if (printRestore || state.phase !== 'session') return;
    renderHistoryPrint(); // build the print-only list now
    const historyDetails = document.getElementById('history-card');
    const originalTitle = document.title;
    const wasOpen = historyDetails.open;
    historyDetails.open = true;
    document.title = `Pickleball Match History - ${localDateISO(new Date())}`;
    printRestore = () => {
      document.title = originalTitle;
      historyDetails.open = wasOpen;
      printRestore = null;
    };
  }

  function finishPrint() {
    if (printRestore) printRestore();
  }

  /** YYYY-MM-DD in the device's own time zone (toISOString would give UTC). */
  function localDateISO(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---------- utils ----------

  function escapeHtml(str) {
    // Safe for both element content and quoted attribute values.
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
