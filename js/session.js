/**
 * session.js: organizer actions during a session. Editing players, fixed
 * partners, removing players, swaps, pairings and the manual waiting order.
 *
 *  - Fixed partner: two players who always play together.
 *  - Manual pairing: rearranging the players on one court, once.
 *  - Manual swap: swapping a court player with another court's player or a waiting player.
 * None of these count as a game or change stats or history.
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

  /** Where a player is on court ({ courtId, team, index }), or null. */
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

  /** `byId` is optional: pass a Map to speed up loops. */
  function partnerOf(state, p, byId = new Map(state.players.map(pl => [pl.id, pl]))) {
    const id = Queue.activePartnerId(p, byId, state.config.matchType);
    return id == null ? null : byId.get(id);
  }

  // ---------- manual waiting order ----------

  /** Remove ids that are no longer waiting; clear the order once it's empty. */
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

  /** `baseOrder` (optional): the order shown on screen. */
  function moveWaiting(state, id, delta, baseOrder) {
    const order = Array.isArray(baseOrder) && baseOrder.length ? baseOrder.slice() : waitingOrder(state).map(p => p.id);
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
    // An unchanged name is always allowed (old names may be longer than today's limit).
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

  /** Rename and/or set the fixed partner (id, null to remove, undefined to keep).
   *  Checks everything before changing anything. */
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

  /** Remove a player. They stay on record as "left" with their stats and can be restored.
   *  Returns { ok } or { ok: false, error }. */
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
    // Kept on record as "left" so the session shows everyone who played.
    p.active = false;
    p.leftAt = timeLabelNow();
    pruneOverride(state);
    return { ok: true };
  }

  function timeLabelNow() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // ---------- adding / restoring players mid-session ----------

  /** Put a new or returning player into the rotation level with whoever has played least,
   *  at the back of that group. Their visible stats don't change. */
  function joinRotation(state, p) {
    const others = state.players.filter(o => Queue.isActive(o) && o.id !== p.id);
    const baseline = others.length ? Math.min(...others.map(Queue.rotationGames)) : 0;
    p.queueGames = Math.max(Queue.rotationGames(p), baseline);
    p.lastActiveSeq = state.matchSeq;
  }

  function restorePlayer(state, id) {
    const p = playerById(state, id);
    if (!p || Queue.isActive(p)) return { ok: false, error: 'That player is already in the session.' };
    if (activeCount(state) >= Scheduler.MAX_PLAYERS) {
      return { ok: false, error: `A session can have at most ${Scheduler.MAX_PLAYERS} players.` };
    }
    const clash = state.players.find(o => o.id !== id && Queue.isActive(o)
      && Scheduler.normalizeName(o.name).toLowerCase() === Scheduler.normalizeName(p.name).toLowerCase());
    if (clash) return { ok: false, error: `Another active player is already named "${clash.name}". Rename them first.` };
    p.active = true;
    p.rejoinedAt = timeLabelNow();
    joinRotation(state, p);
    return { ok: true };
  }

  function activeCount(state) {
    return state.players.filter(Queue.isActive).length;
  }

  /** Add players by name (all checked first). A removed player's name brings them back.
   *  Returns { ok, added, restored } or { ok: false, errors }. */
  function addPlayers(state, rawNames) {
    const names = rawNames.map(Scheduler.normalizeName).filter(Boolean);
    const errors = [];
    if (!names.length) return { ok: false, errors: ['Enter at least one name.'] };

    const seen = new Set();
    const plan = []; // { name, restore: player or null }
    names.forEach(name => {
      const key = name.toLowerCase();
      if (name.length > Scheduler.MAX_NAME_LENGTH) {
        errors.push(`"${name}" is longer than ${Scheduler.MAX_NAME_LENGTH} characters.`);
        return;
      }
      if (seen.has(key)) {
        errors.push(`"${name}" is listed more than once.`);
        return;
      }
      seen.add(key);
      const match = state.players.find(p => Scheduler.normalizeName(p.name).toLowerCase() === key);
      if (match && Queue.isActive(match)) {
        errors.push(`"${match.name}" is already in this session.`);
        return;
      }
      plan.push({ name, restore: match || null });
    });
    if (activeCount(state) + plan.length > Scheduler.MAX_PLAYERS) {
      errors.push(`A session can have at most ${Scheduler.MAX_PLAYERS} players.`);
    }
    if (errors.length) return { ok: false, errors };

    const added = [];
    const restored = [];
    let nextId = state.players.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    plan.forEach(({ name, restore }) => {
      if (restore) {
        restore.active = true;
        restore.rejoinedAt = timeLabelNow();
        joinRotation(state, restore);
        restored.push(restore.name);
      } else {
        const p = Queue.createPlayer(nextId++, name);
        p.joinedAt = timeLabelNow(); // joined after the session started
        state.players.push(p);
        joinRotation(state, p);
        added.push(name);
      }
    });
    return { ok: true, added, restored };
  }

  // ---------- manual court changes ----------

  function copyTeams(m) {
    return { team1: m.team1.slice(), team2: m.team2.slice() };
  }

  /** Map of playerId -> "courtId:team" after applying `assignments`. */
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

  /** Fixed pairs this change would split up. Returns [[playerA, playerB], ...]. */
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

  /** Each court keeps its size, and no player is used twice or is inactive. */
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

  /** Plan a swap of two players (at least one on a court). Returns { assignments } or { error }. */
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

  /** Apply court changes. Clears the winner/score on changed courts and marks them as manual.
   *  Returns the changed court ids. */
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
    addPlayers,
    restorePlayer,
    fixedPairsSplitBy,
    planSwap,
    planPairing,
    applyAssignments,
  };
})();
