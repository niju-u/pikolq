/**
 * session.js
 * DOM-free organizer operations on the live session state:
 * player edits, fixed partners, removal, manual swaps / pairings and the
 * temporary manual waiting order.
 *
 * Three distinct concepts:
 *  - Fixed partner: a standing partnership the automatic matchmaking respects.
 *  - Manual pairing: a one-off rearrangement of the players on one court.
 *  - Manual swap: exchanging a court player with another court's player or a
 *    waiting player.
 * None of these record a game, touch stats or create history entries.
 */

const Session = (() => {
  const MAX_NAME_LENGTH = Scheduler.MAX_NAME_LENGTH;
  const TEAMS = ['team1', 'team2'];

  // ---------- lookups ----------

  function playerById(state, id) {
    return state.players.find(p => p.id === id) || null;
  }

  function busyIds(state) {
    const ids = new Set();
    state.courts.forEach(c => {
      if (!c.activeMatch) return;
      c.activeMatch.team1.forEach(id => ids.add(id));
      c.activeMatch.team2.forEach(id => ids.add(id));
    });
    return ids;
  }

  /** Where a player is on court: { courtId, team, index } or null if not playing. */
  function locate(state, id) {
    for (const court of state.courts) {
      const m = court.activeMatch;
      if (!m) continue;
      for (const team of TEAMS) {
        const index = m[team].indexOf(id);
        if (index !== -1) return { courtId: court.id, team, index };
      }
    }
    return null;
  }

  function waitingOrder(state) {
    return Queue.getWaitingOrder(state.players, busyIds(state), state.matchSeq, state.waitOverride);
  }

  /** `byId` is optional; pass a prebuilt Map when calling in a loop. */
  function partnerOf(state, p, byId = new Map(state.players.map(pl => [pl.id, pl]))) {
    const id = Queue.activePartnerId(p, byId, state.config.matchType);
    return id == null ? null : byId.get(id);
  }

  // ---------- manual waiting order ----------

  /** Drop ids that are no longer waiting; clear the override once it is used up. */
  function pruneOverride(state) {
    if (!Array.isArray(state.waitOverride)) {
      state.waitOverride = null;
      return;
    }
    const busy = busyIds(state);
    const kept = [...new Set(state.waitOverride)].filter(id => {
      const p = playerById(state, id);
      return p && Queue.isActive(p) && !busy.has(id);
    });
    state.waitOverride = kept.length ? kept : null;
  }

  function moveWaiting(state, id, delta) {
    const order = waitingOrder(state).map(p => p.id);
    const i = order.indexOf(id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= order.length) return false;
    [order[i], order[j]] = [order[j], order[i]];
    state.waitOverride = order;
    return true;
  }

  function resetWaitingOrder(state) {
    state.waitOverride = null;
  }

  // ---------- player edits ----------

  function validateName(state, id, raw) {
    const name = Scheduler.normalizeName(raw);
    if (!name) return { error: 'Name cannot be empty.' };
    const current = playerById(state, id);
    // An unchanged name is always allowed (e.g. a long name saved before the
    // length limit existed must not block editing the partner).
    if (current && name === Scheduler.normalizeName(current.name)) return { name: current.name };
    if (name.length > MAX_NAME_LENGTH) return { error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
    const key = name.toLowerCase();
    const clash = state.players.find(p => p.id !== id && Scheduler.normalizeName(p.name).toLowerCase() === key);
    if (clash) {
      return { error: `"${name}" is already used${Queue.isActive(clash) ? '' : ' by a removed player'}. Names must be unique.` };
    }
    return { name };
  }

  function validatePartner(state, p, partnerId) {
    if (partnerId == null) return null;
    if (state.config.matchType !== 'doubles') return 'Fixed partners only apply in Doubles.';
    if (partnerId === p.id) return 'A player cannot be their own partner.';
    const q = playerById(state, partnerId);
    if (!q || !Queue.isActive(q)) return 'That partner is not in this session.';
    if (q.fixedPartnerId != null && q.fixedPartnerId !== p.id) {
      const other = playerById(state, q.fixedPartnerId);
      return `${q.name} already has a fixed partner${other ? ` (${other.name})` : ''}. Remove that partnership first.`;
    }
    return null;
  }

  function clearPartner(state, p) {
    if (p.fixedPartnerId != null) {
      const q = playerById(state, p.fixedPartnerId);
      if (q && q.fixedPartnerId === p.id) q.fixedPartnerId = null;
    }
    p.fixedPartnerId = null;
  }

  /**
   * Rename and/or set the fixed partner (partnerId: id, null to remove,
   * undefined to leave unchanged). Validates everything before changing anything.
   */
  function updatePlayer(state, id, { name, partnerId }) {
    const p = playerById(state, id);
    if (!p || !Queue.isActive(p)) return { ok: false, errors: ['Player not found in this session.'] };

    const errors = [];
    const nameCheck = validateName(state, id, name);
    if (nameCheck.error) errors.push(nameCheck.error);
    const partnerError = partnerId === undefined ? null : validatePartner(state, p, partnerId);
    if (partnerError) errors.push(partnerError);
    if (errors.length) return { ok: false, errors };

    p.name = nameCheck.name;
    if (partnerId !== undefined && partnerId !== p.fixedPartnerId) {
      clearPartner(state, p);
      if (partnerId != null) {
        const q = playerById(state, partnerId);
        p.fixedPartnerId = q.id;
        q.fixedPartnerId = p.id;
      }
    }
    return { ok: true };
  }

  /** Soft-remove: keeps the player record so history and stats stay intact. */
  function removePlayer(state, id) {
    const p = playerById(state, id);
    if (!p || !Queue.isActive(p)) return { ok: false, error: 'Player not found in this session.' };
    const loc = locate(state, id);
    if (loc) {
      return {
        ok: false,
        error: `${p.name} is playing on Court ${loc.courtId}. Swap them out or complete the match before removing them.`,
      };
    }
    clearPartner(state, p);
    p.active = false;
    pruneOverride(state);
    return { ok: true };
  }

  // ---------- manual court changes ----------

  function copyTeams(m) {
    return { team1: m.team1.slice(), team2: m.team2.slice() };
  }

  /** Map of playerId -> "courtId:team" with `assignments` (Map courtId -> teams) applied. */
  function teamKeyMap(state, assignments) {
    const map = new Map();
    state.courts.forEach(c => {
      const m = assignments && assignments.has(c.id) ? assignments.get(c.id) : c.activeMatch;
      if (!m) return;
      TEAMS.forEach(t => m[t].forEach(id => map.set(id, `${c.id}:${t}`)));
    });
    return map;
  }

  function pairStatus(map, a, b) {
    const ka = map.get(a);
    const kb = map.get(b);
    if (ka && kb) return ka === kb ? 'together' : 'apart';
    return 'off-court';
  }

  /**
   * Fixed pairs this change would separate: pairs that were team-mates and no
   * longer are, or that would newly end up on courts on different teams.
   * Returns [[playerA, playerB], ...].
   */
  function fixedPairsSplitBy(state, assignments) {
    if (state.config.matchType !== 'doubles') return [];
    const before = teamKeyMap(state, null);
    const after = teamKeyMap(state, assignments);
    const byId = new Map(state.players.map(p => [p.id, p]));
    const splits = [];
    state.players.forEach(p => {
      const qid = Queue.activePartnerId(p, byId, 'doubles');
      if (qid == null || p.id > qid) return;
      const b = pairStatus(before, p.id, qid);
      const a = pairStatus(after, p.id, qid);
      if ((b === 'together' && a !== 'together') || (a === 'apart' && b !== 'apart')) {
        splits.push([p, byId.get(qid)]);
      }
    });
    return splits;
  }

  /** Every court keeps its size, and no player appears twice or is inactive. */
  function validateAssignments(state, assignments) {
    const perTeam = Scheduler.playersPerMatch(state.config.matchType) / 2;
    for (const [courtId, teams] of assignments) {
      const court = state.courts.find(c => c.id === courtId);
      if (!court || !court.activeMatch) return `Court ${courtId} has no match in progress.`;
      if (!TEAMS.every(t => Array.isArray(teams[t]) && teams[t].length === perTeam)) {
        return `Court ${courtId} must have ${perTeam} player${perTeam === 1 ? '' : 's'} per team.`;
      }
    }
    const seen = new Set();
    for (const court of state.courts) {
      const m = assignments.has(court.id) ? assignments.get(court.id) : court.activeMatch;
      if (!m) continue;
      for (const id of m.team1.concat(m.team2)) {
        const p = playerById(state, id);
        if (!p || !Queue.isActive(p)) return 'A selected player is no longer in the session.';
        if (seen.has(id)) return `${p.name} cannot be on two courts or twice on one court.`;
        seen.add(id);
      }
    }
    return null;
  }

  /**
   * Plan a swap of two players. At least one must be on a court; the other may
   * be on a different court or waiting. Returns { assignments } or { error }.
   */
  function planSwap(state, idA, idB) {
    if (idA == null || idB == null) return { error: 'Choose two players to swap.' };
    if (idA === idB) return { error: 'Choose two different players.' };
    const locA = locate(state, idA);
    const locB = locate(state, idB);
    if (!locA && !locB) return { error: 'At least one of the players must be on a court.' };
    if (locA && locB && locA.courtId === locB.courtId) {
      return { error: 'Both players are on the same court. Use Edit Pairing to rearrange a court.' };
    }
    for (const [id, loc] of [[idA, locA], [idB, locB]]) {
      const p = playerById(state, id);
      if (!p || !Queue.isActive(p)) return { error: 'A selected player is no longer in the session.' };
      if (!loc && !waitingOrder(state).some(w => w.id === id)) return { error: `${p.name} is not waiting.` };
    }

    const assignments = new Map();
    const teamsFor = courtId => {
      if (!assignments.has(courtId)) {
        assignments.set(courtId, copyTeams(state.courts.find(c => c.id === courtId).activeMatch));
      }
      return assignments.get(courtId);
    };
    if (locA) teamsFor(locA.courtId)[locA.team][locA.index] = idB;
    if (locB) teamsFor(locB.courtId)[locB.team][locB.index] = idA;

    const error = validateAssignments(state, assignments);
    return error ? { error } : { assignments };
  }

  /** Plan a rearrangement of the same players on one court. */
  function planPairing(state, courtId, team1, team2) {
    const court = state.courts.find(c => c.id === courtId);
    if (!court || !court.activeMatch) return { error: `Court ${courtId} has no match in progress.` };
    const current = court.activeMatch.team1.concat(court.activeMatch.team2).slice().sort((a, b) => a - b);
    const proposed = team1.concat(team2).slice().sort((a, b) => a - b);
    if (current.length !== proposed.length || current.some((id, i) => id !== proposed[i])) {
      return { error: 'Edit Pairing can only rearrange the players already on this court.' };
    }
    const assignments = new Map([[courtId, { team1: team1.slice(), team2: team2.slice() }]]);
    const error = validateAssignments(state, assignments);
    return error ? { error } : { assignments };
  }

  function sameTeams(a, b) {
    return TEAMS.every(t => a[t].length === b[t].length && a[t].every((id, i) => id === b[t][i]));
  }

  /**
   * Apply planned court changes. Clears any selected winner / typed score on
   * changed courts (the line-up changed) and marks them as manually adjusted.
   * Returns the ids of courts that actually changed.
   */
  function applyAssignments(state, assignments) {
    const error = validateAssignments(state, assignments);
    if (error) throw new Error(error);
    const changed = [];
    assignments.forEach((teams, courtId) => {
      const m = state.courts.find(c => c.id === courtId).activeMatch;
      if (sameTeams(m, teams)) return;
      m.team1 = teams.team1.slice();
      m.team2 = teams.team2.slice();
      m.winner = null;
      m.team1ScoreInput = '';
      m.team2ScoreInput = '';
      m.manual = true;
      changed.push(courtId);
    });
    pruneOverride(state);
    return changed;
  }

  return {
    MAX_NAME_LENGTH,
    playerById,
    busyIds,
    locate,
    waitingOrder,
    partnerOf,
    pruneOverride,
    moveWaiting,
    resetWaitingOrder,
    updatePlayer,
    removePlayer,
    fixedPairsSplitBy,
    planSwap,
    planPairing,
    applyAssignments,
  };
})();
