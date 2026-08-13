/**
 * app.js
 */

const App = (() => {
  const el = {};

  const state = {
    phase: 'setup', // 'setup' | 'session'
    config: null, // { numPlayers, numCourts, matchType, perMatch, activeCourts, idleCourts }
    players: [],
    courts: [],
    history: [],
    matchSeq: 0,
    nextMatchId: 1,
  };

  let draft = {
    numPlayers: 8,
    numCourts: 2,
    matchType: 'doubles',
    names: [],
  };

  // ---------- init ----------

  function init() {
    cacheEls();
    bindEvents();

    const saved = Storage.loadSession();
    if (saved && saved.players && saved.players.length) {
      Object.assign(state, saved);
      state.phase = 'session';
      showView('session');
      renderSession();
    } else {
      const savedDraft = Storage.loadDraft();
      if (savedDraft) draft = Object.assign(draft, savedDraft);
      showView('setup');
      renderSetup();
    }
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

    el.sessionMeta = document.getElementById('session-meta');
    el.printCourts = document.getElementById('print-courts');
    el.printPlayerCount = document.getElementById('print-player-count');
    el.printPlayerNames = document.getElementById('print-player-names');
    el.courtsGrid = document.getElementById('courts-grid');
    el.waitingList = document.getElementById('waiting-list');
    el.statsBody = document.getElementById('stats-body');
    el.historyList = document.getElementById('history-list');

    el.btnExportPdf = document.getElementById('btn-export-pdf');
    el.btnClearHistory = document.getElementById('btn-clear-history');
    el.btnReset = document.getElementById('btn-reset');
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

    el.playerNameGrid.addEventListener('input', saveDraftFromForm);
    el.form.addEventListener('submit', onGenerateQueue);

    el.courtsGrid.addEventListener('click', onCourtsGridClick);
    el.courtsGrid.addEventListener('input', onCourtsGridInput);

    el.btnExportPdf.addEventListener('click', exportPdf);
    el.btnClearHistory.addEventListener('click', onClearHistory);
    el.btnReset.addEventListener('click', onResetSession);
  }

  function showView(view) {
    el.setupView.hidden = view !== 'setup';
    el.sessionView.hidden = view !== 'session';
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
    const count = Math.max(0, Math.min(500, parseInt(el.inputPlayers.value, 10) || 0));
    const existing = [...el.playerNameGrid.querySelectorAll('.player-name-input')].map(i => i.value);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const wrap = document.createElement('label');
      wrap.className = 'player-name-field';
      wrap.innerHTML = `<span class="player-name-index">${i + 1}.</span>`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'player-name-input';
      input.placeholder = `Player ${i + 1} name`;
      input.autocomplete = 'off';
      input.value = existing[i] || '';
      wrap.appendChild(input);
      frag.appendChild(wrap);
    }
    el.playerNameGrid.innerHTML = '';
    el.playerNameGrid.appendChild(frag);
  }

  function updateCalcPreview() {
    const d = readDraftFromForm();
    if (!d.numPlayers || !d.numCourts) {
      el.calcPreview.innerHTML = '';
      return;
    }
    const setup = Scheduler.computeCourtSetup(d);
    const perMatchLabel = d.matchType === 'doubles' ? '4 players/match' : '2 players/match';

    let note = '';
    if (setup.idleCourts > 0) {
      note = `<p class="calc-note">Only <strong>${setup.activeCourts}</strong> of ${d.numCourts} court${d.numCourts === 1 ? '' : 's'} can start with ${d.numPlayers} players — the rest wait for players to free up.</p>`;
    }

    el.calcPreview.innerHTML = `
      <p><strong>${setup.activeCourts}</strong> court${setup.activeCourts === 1 ? '' : 's'} start playing (${perMatchLabel}) →
      <strong>${setup.playingAtStart}</strong> playing, <strong>${setup.waitingAtStart}</strong> waiting.</p>
      <p>Matches complete one at a time — there's no fixed session length or round count. The organizer records each result as it happens.</p>
      ${note}
    `;
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

    state.config = { numPlayers: d.numPlayers, numCourts: d.numCourts, matchType: d.matchType, ...setup };
    state.players = generatePlayers(d.names.slice(0, d.numPlayers));
    state.courts = generateCourts(d.numCourts);
    state.history = [];
    state.matchSeq = 0;
    state.nextMatchId = 1;

    state.courts.forEach(court => generateMatchForCourt(court));

    state.phase = 'session';
    Storage.clearDraft();
    persist();
    showView('session');
    renderSession();
  }

  // ---------- core generators (reusable, DOM-free) ----------

  function generatePlayers(names) {
    return names.map((name, i) => Queue.createPlayer(i + 1, name.trim()));
  }

  function generateCourts(numCourts) {
    return Array.from({ length: numCourts }, (_, i) => ({ id: i + 1, activeMatch: null, idleReason: null }));
  }

  function getBusyPlayerIds() {
    const ids = new Set();
    state.courts.forEach(c => {
      if (!c.activeMatch) return;
      c.activeMatch.team1.forEach(id => ids.add(id));
      c.activeMatch.team2.forEach(id => ids.add(id));
    });
    return ids;
  }

  function generateMatchForCourt(court) {
    const busyIds = getBusyPlayerIds();
    const plan = Queue.generateMatch(state.players, busyIds, state.config.matchType, state.matchSeq);
    if (!plan) {
      court.activeMatch = null;
      court.idleReason = 'Waiting for enough players to free up.';
      return;
    }
    court.idleReason = null;
    court.activeMatch = {
      matchId: state.nextMatchId++,
      team1: plan.team1,
      team2: plan.team2,
      winner: null,
      team1ScoreInput: '',
      team2ScoreInput: '',
    };
  }

  // ---------- match lifecycle ----------

  function onCourtsGridClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const courtId = parseInt(target.dataset.courtId, 10);
    const court = state.courts.find(c => c.id === courtId);
    if (!court || !court.activeMatch) return;

    if (target.dataset.action === 'select-winner') {
      selectWinner(court, target.dataset.team);
    } else if (target.dataset.action === 'change-winner') {
      court.activeMatch.winner = null;
      persist();
      renderSession();
    } else if (target.dataset.action === 'complete-match') {
      onCompleteMatch(court);
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
      if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 < 0 || n2 < 0) {
        alert('Scores must be valid numbers.');
        return;
      }
      team1Score = n1;
      team2Score = n2;

      const higherTeam = team1Score === team2Score ? null : (team1Score > team2Score ? 'team1' : 'team2');
      if (higherTeam && higherTeam !== m.winner) {
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
      dateISO: now.toISOString().slice(0, 10),
      timeLabel: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      courtId: court.id,
      matchType: state.config.matchType,
      team1: m.team1,
      team2: m.team2,
      winner: m.winner,
      team1Score,
      team2Score,
    });

    court.activeMatch = null;
    generateMatchForCourt(court);

    persist();
    renderSession();
    flashCourtUpdate(court.id);
  }

  function flashCourtUpdate(courtId) {
    const cardEl = el.courtsGrid.querySelector(`.court-card[data-court-id="${courtId}"]`);
    if (!cardEl) return;
    cardEl.classList.add('court-flash');
    setTimeout(() => cardEl.classList.remove('court-flash'), 700);
  }

  // ---------- reset / clear ----------

  function onClearHistory() {
    if (!confirm('Are you sure you want to clear the match history? This cannot be undone.')) return;
    state.history = [];
    persist();
    renderHistory();
  }

  function onResetSession() {
    if (!confirm('Reset the session? This clears all players, courts, stats, and match history.')) return;
    Storage.clearSession();
    Storage.clearDraft();
    state.phase = 'setup';
    state.config = null;
    state.players = [];
    state.courts = [];
    state.history = [];
    state.matchSeq = 0;
    state.nextMatchId = 1;
    draft = { numPlayers: 8, numCourts: 2, matchType: 'doubles', names: [] };

    el.sessionMeta.innerHTML = '';
    el.printCourts.textContent = '';
    el.printPlayerCount.textContent = '';
    el.printPlayerNames.textContent = '';
    el.courtsGrid.innerHTML = '';
    el.waitingList.innerHTML = '';
    el.statsBody.innerHTML = '';
    document.getElementById('stats-table').querySelector('thead tr').innerHTML =
      '<th>Player</th><th>Games</th><th>Wins</th><th>Losses</th><th>Win Rate</th>';
    el.historyList.innerHTML = '';
    const statsCard = document.getElementById('stats-card');
    const historyCard = document.getElementById('history-card');
    if (statsCard) statsCard.open = true;
    if (historyCard) historyCard.open = true;

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
    updateCalcPreview();
  }

  // ---------- rendering: session ----------

  function playerName(id) {
    const p = state.players.find(pl => pl.id === id);
    return p ? p.name : '?';
  }

  function teamNames(ids) {
    return ids.map(playerName).join(' + ');
  }

  function renderSession() {
    renderMeta();
    renderCourts();
    renderQueue();
    renderStats();
    renderHistory();
  }

  function renderMeta() {
    const c = state.config;
    el.sessionMeta.innerHTML = `
      <span><strong>${c.numPlayers}</strong> Players</span>
      <span><strong>${c.numCourts}</strong> Court${c.numCourts === 1 ? '' : 's'}</span>
      <span><strong>${c.matchType === 'doubles' ? 'Doubles' : 'Singles'}</strong></span>
    `;
    el.printCourts.textContent = `${c.numCourts} Court${c.numCourts === 1 ? '' : 's'}`;
    el.printPlayerCount.textContent = c.numPlayers;
    el.printPlayerNames.textContent = state.players.map(p => p.name).join(', ');
  }

  function renderCourts() {
    el.courtsGrid.innerHTML = state.courts.map(renderCourtCard).join('');
  }

  function renderCourtCard(court) {
    if (!court.activeMatch) {
      return `
        <div class="court-card court-idle" data-court-id="${court.id}">
          <div class="court-header">
            <span>Court ${court.id}</span>
            <span class="court-status-pill status-open">Open</span>
          </div>
          <div class="idle-body">
            <div class="idle-icon" aria-hidden="true">⏳</div>
            <div class="idle-heading">Court Available</div>
            <div class="idle-text">${escapeHtml(court.idleReason || 'Waiting for the next players.')}</div>
          </div>
        </div>
      `;
    }

    const m = court.activeMatch;
    const isDoubles = state.config.matchType === 'doubles';
    const hasWinner = !!m.winner;
    const team1Class = hasWinner && m.winner === 'team1' ? 'team-winner' : '';
    const team2Class = hasWinner && m.winner === 'team2' ? 'team-winner' : '';
    const statusPill = hasWinner
      ? '<span class="court-status-pill status-decided">Winner Selected</span>'
      : '<span class="court-status-pill status-live">In Progress</span>';

    let body;
    if (!hasWinner) {
      body = `
        <div class="matchup">
          <div class="team ${team1Class}">${isDoubles ? '<div class="team-label">Team 1</div>' : ''}<div class="team-players">${escapeHtml(teamNames(m.team1))}</div></div>
          <div class="vs">VS</div>
          <div class="team ${team2Class}">${isDoubles ? '<div class="team-label">Team 2</div>' : ''}<div class="team-players">${escapeHtml(teamNames(m.team2))}</div></div>
        </div>
        <div class="who-won">
          <div class="who-won-label">Who Won?</div>
          <div class="who-won-buttons">
            <button type="button" class="btn btn-win" data-action="select-winner" data-court-id="${court.id}" data-team="team1">Team 1 Wins</button>
            <button type="button" class="btn btn-win" data-action="select-winner" data-court-id="${court.id}" data-team="team2">Team 2 Wins</button>
          </div>
        </div>
      `;
    } else {
      const winnerLabel = m.winner === 'team1' ? 'Team 1' : 'Team 2';
      body = `
        <div class="matchup">
          <div class="team ${team1Class}">${isDoubles ? '<div class="team-label">Team 1</div>' : ''}<div class="team-players">${escapeHtml(teamNames(m.team1))}</div></div>
          <div class="vs">VS</div>
          <div class="team ${team2Class}">${isDoubles ? '<div class="team-label">Team 2</div>' : ''}<div class="team-players">${escapeHtml(teamNames(m.team2))}</div></div>
        </div>
        <div class="winner-banner">🏆 ${winnerLabel} Wins!
          <button type="button" class="link-btn change-winner-btn" data-action="change-winner" data-court-id="${court.id}">Change winner</button>
        </div>
        <div class="score-section">
          <div class="score-section-label">Final Score <span>(Optional)</span></div>
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
          <button type="button" class="btn btn-primary btn-large" data-action="complete-match" data-court-id="${court.id}">Complete Match</button>
        </div>
      `;
    }

    return `
      <div class="court-card ${hasWinner ? 'court-decided' : ''}" data-court-id="${court.id}">
        <div class="court-header">
          <span>Court ${court.id}</span>
          ${statusPill}
        </div>
        ${body}
      </div>
    `;
  }

  function renderQueue() {
    const busyIds = getBusyPlayerIds();
    const waiting = Queue.getWaitingOrder(state.players, busyIds, state.matchSeq);
    const nextUpCount = state.config.perMatch;
    el.waitingList.innerHTML = waiting.length
      ? waiting.map((p, i) => `<li class="${i < nextUpCount ? 'next-up' : ''}">${escapeHtml(p.name)}</li>`).join('')
      : '<li class="empty-note">Everyone is currently playing.</li>';
  }

  function renderStats() {
    const anyScores = state.players.some(p => p.scoredGames > 0);
    const rows = state.players
      .slice()
      .sort((a, b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name))
      .map(p => {
        const winRate = p.gamesPlayed > 0 ? `${Math.round((p.wins / p.gamesPlayed) * 100)}%` : '—';
        const ptsFor = anyScores ? `<td data-label="Pts For">${p.scoredGames > 0 ? p.pointsScored : '—'}</td>` : '';
        const ptsAgainst = anyScores ? `<td data-label="Pts Against">${p.scoredGames > 0 ? p.pointsAgainst : '—'}</td>` : '';
        return `
          <tr>
            <td class="player-name-cell" data-label="Player">${escapeHtml(p.name)}</td>
            <td data-label="Games">${p.gamesPlayed}</td>
            <td data-label="Wins">${p.wins}</td>
            <td data-label="Losses">${p.losses}</td>
            <td data-label="Win Rate">${winRate}</td>
            ${ptsFor}${ptsAgainst}
          </tr>
        `;
      })
      .join('');

    const extraHeaders = anyScores ? '<th>Pts For</th><th>Pts Against</th>' : '';
    document.getElementById('stats-table').querySelector('thead tr').innerHTML = `
      <th>Player</th><th>Games</th><th>Wins</th><th>Losses</th><th>Win Rate</th>${extraHeaders}
    `;
    el.statsBody.innerHTML = rows;
  }

  function renderHistory() {
    if (!state.history.length) {
      el.historyList.innerHTML = '<div class="empty-note">No matches completed yet.</div>';
      return;
    }
    el.historyList.innerHTML = state.history
      .slice()
      .reverse()
      .map(h => {
        const winnerNames = teamNames(h.winner === 'team1' ? h.team1 : h.team2);
        const scoreLabel = h.team1Score == null ? 'Not Recorded' : `${h.team1Score}–${h.team2Score}`;
        return `
          <div class="history-card">
            <div class="history-card-top">
              <span class="history-num">#${h.number}</span>
              <span class="history-court">Court ${h.courtId}</span>
              <span class="history-time">${h.timeLabel}</span>
            </div>
            <div class="history-matchup">${escapeHtml(teamNames(h.team1))} <span class="vs-inline">vs</span> ${escapeHtml(teamNames(h.team2))}</div>
            <div class="history-result">
              <span class="history-winner">🏆 ${escapeHtml(winnerNames)}</span>
              <span class="history-score">${scoreLabel}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ---------- export ----------

  /**
   * Vanilla-JS PDF export: prints a stripped-down, paper-friendly view
   * (player stats + match history only) via the browser's native
   * "Save as PDF" print destination — no PDF library required.
   */
  function exportPdf() {
    const originalTitle = document.title;
    document.title = `Pickleball Match History - ${new Date().toISOString().slice(0, 10)}`;

    const historyDetails = document.getElementById('history-card');
    const wasOpen = historyDetails ? historyDetails.open : true;
    if (historyDetails) historyDetails.open = true;

    function restore() {
      document.title = originalTitle;
      if (historyDetails) historyDetails.open = wasOpen;
      window.removeEventListener('afterprint', restore);
    }
    window.addEventListener('afterprint', restore);

    window.print();
  }

  // ---------- utils ----------

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
