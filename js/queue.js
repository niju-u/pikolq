/**
 * queue.js
 * Automatic rotation + team-building. DOM-free.
 *
 * Who plays next — two layers:
 *  1. Fairness (unchanged rule): fewest games first, then longest wait. Anyone
 *     below the current "games level" MUST be in the next match.
 *  2. Variety: among players tied at that level, every combination of the best
 *     candidates is scored and the one with the fewest repeat partners and
 *     opponents wins (new combinations first, recent repeats weigh more), with
 *     a small preference for longer waits. Randomness (seeded per match, so the
 *     "Next to play" preview matches what is generated) only breaks ties.
 *
 * Also:
 *  - Removed players (active === false) never enter the queue.
 *  - A temporary manual order pins players to the front; while it is active
 *    the organizer's order is followed exactly (teams are still varied).
 *  - Doubles fixed partners are one unit, ranked at their LOWER-priority
 *    member (no queue jumping), always on the same team; their opponents vary.
 */

const Queue = (() => {
  function createPlayer(id, name) {
    return {
      id,
      name,
      active: true,
      fixedPartnerId: null,
      gamesPlayed: 0,
      queueGames: 0, // games counted for rotation; survives "Clear History"
      wins: 0,
      losses: 0,
      lastActiveSeq: 0,
      lastCourtId: null,
      pointsScored: 0,
      pointsAgainst: 0,
      scoredGames: 0,
      teammates: {},
      opponents: {},
    };
  }

  function isActive(p) {
    return p.active !== false;
  }

  /** Games used for rotation (falls back to gamesPlayed for very old saves). */
  function rotationGames(p) {
    return Number.isInteger(p.queueGames) ? p.queueGames : p.gamesPlayed;
  }

  function comparePriority(a, b, currentSeq) {
    const ga = rotationGames(a);
    const gb = rotationGames(b);
    if (ga !== gb) return ga - gb;

    const waitA = currentSeq - a.lastActiveSeq;
    const waitB = currentSeq - b.lastActiveSeq;
    if (waitA !== waitB) return waitB - waitA;

    return a.id - b.id;
  }

  /**
   * Waiting players in the order they will be called.
   * `manualOrder` (optional) is a list of player ids pinned to the front.
   */
  function getWaitingOrder(players, busyIds, currentSeq, manualOrder) {
    const auto = players
      .filter(p => isActive(p) && !busyIds.has(p.id))
      .slice()
      .sort((a, b) => comparePriority(a, b, currentSeq));

    if (!Array.isArray(manualOrder) || !manualOrder.length) return auto;

    const remaining = new Map(auto.map(p => [p.id, p]));
    const front = [];
    manualOrder.forEach(id => {
      const p = remaining.get(id);
      if (p) {
        front.push(p);
        remaining.delete(id);
      }
    });
    return front.concat(auto.filter(p => remaining.has(p.id)));
  }

  /**
   * Id of p's fixed partner if the partnership is active and applies
   * (doubles only, mutual, partner still in the session); otherwise null.
   */
  function activePartnerId(p, byId, matchType) {
    if (matchType !== 'doubles' || p.fixedPartnerId == null) return null;
    const q = byId.get(p.fixedPartnerId);
    return q && isActive(q) && q.fixedPartnerId === p.id ? q.id : null;
  }

  /**
   * Pick the next `perMatch` players from the waiting order, keeping fixed
   * partners together. Returns an array of players, or null if no full match
   * can be formed yet.
   */
  /**
   * Group waiting players into units (single players or fixed pairs) in
   * priority order. A pair is ranked at its later member; a player whose
   * partner is on a court is left out (they wait to play together).
   */
  function buildUnits(waitingOrder, matchType, byId) {
    const index = new Map(waitingOrder.map((p, i) => [p.id, i]));
    const units = [];
    waitingOrder.forEach((p, i) => {
      const partnerId = activePartnerId(p, byId, matchType);
      if (partnerId == null) units.push([p]);
      else if (!index.has(partnerId)) return; // partner is on a court: wait together
      else if (index.get(partnerId) < i) units.push([byId.get(partnerId), p]); // ranked at later member
    });
    return units;
  }

  /**
   * Strict-order selection: the next `perMatch` players exactly as the waiting
   * order lists them (used while a manual order is active, and as the fairness
   * baseline for the variety search). Returns players, or null.
   */
  function selectPlayers(waitingOrder, perMatch, matchType, byId, allowPartial = false) {
    const units = buildUnits(waitingOrder, matchType, byId);

    if (allowPartial) {
      const selected = [];
      units.forEach(u => {
        if (selected.length + u.length <= perMatch) selected.push(...u);
      });
      return selected;
    }

    // 2. Highest-priority combination of units that exactly fills the court.
    //    Same result as plain greedy whenever greedy works; otherwise it skips
    //    the fewest/lowest-ranked units needed (e.g. 3 singles ahead of a pair).
    const singlesFrom = new Array(units.length + 1).fill(0);
    const pairsFrom = new Array(units.length + 1).fill(0);
    for (let i = units.length - 1; i >= 0; i--) {
      singlesFrom[i] = singlesFrom[i + 1] + (units[i].length === 1 ? 1 : 0);
      pairsFrom[i] = pairsFrom[i + 1] + (units[i].length === 2 ? 1 : 0);
    }
    const feasible = (i, need) => {
      for (let pairs = Math.min(pairsFrom[i], Math.floor(need / 2)); pairs >= 0; pairs--) {
        if (need - pairs * 2 <= singlesFrom[i]) return true;
      }
      return false;
    };
    function search(i, need) {
      if (need === 0) return [];
      if (i >= units.length || !feasible(i, need)) return null;
      const u = units[i];
      if (u.length <= need) {
        const rest = search(i + 1, need - u.length);
        if (rest) return u.concat(rest);
      }
      return search(i + 1, need);
    }
    return search(0, perMatch);
  }

  function historyPenalty(rec, currentSeq, countWeight, recencyWindow, recencyWeight) {
    if (!rec) return 0;
    const recency = Math.max(0, recencyWindow - (currentSeq - rec.lastSeq));
    return rec.count * countWeight + recency * recencyWeight;
  }

  // Variety weights: a repeat partner costs more than a repeat opponent, and a
  // recent repeat (within the last 8 matches) costs extra.
  const PARTNER_REPEAT = 120;
  const PARTNER_RECENT = 20;
  const OPPONENT_REPEAT = 40;
  const OPPONENT_RECENT = 8;
  const RECENT_WINDOW = 8;
  // Among tied candidates, each match less of waiting costs this much.
  // Tuned by simulation for SHORT WAITS: longest sit-outs match the old strict
  // rotation in most setups, while variety still decides among players who
  // have waited equally long. Lower = more mixing, higher = less waiting.
  const WAIT_WEIGHT = 200;
  // How many tied candidates (units) are considered for the variety search.
  const POOL_CAP = 14;

  function isFixedPair(a, b) {
    return a.fixedPartnerId === b.id && b.fixedPartnerId === a.id;
  }

  function teammatePenalty(p1, p2, currentSeq) {
    if (isFixedPair(p1, p2)) return 0; // their permanent partnership is not a "repeat"
    return historyPenalty(p1.teammates[p2.id], currentSeq, PARTNER_REPEAT, RECENT_WINDOW, PARTNER_RECENT);
  }

  function opponentPenalty(p1, p2, currentSeq) {
    return historyPenalty(p1.opponents[p2.id], currentSeq, OPPONENT_REPEAT, RECENT_WINDOW, OPPONENT_RECENT);
  }

  /** Small seeded RNG (mulberry32) so a given match always resolves ties the same way. */
  function makeRng(seed) {
    let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** True if no mutual fixed pair among these players is split across teams. */
  function keepsFixedPairs(team1, team2, matchType) {
    if (matchType !== 'doubles') return true;
    const all = team1.concat(team2);
    const byId = new Map(all.map(p => [p.id, p]));
    return [team1, team2].every(team =>
      team.every(p => {
        const partnerId = activePartnerId(p, byId, matchType);
        return partnerId == null || team.some(t => t.id === partnerId);
      })
    );
  }

  /** Variety cost of one line-up: repeat partners + repeat opponents. */
  function lineupCost(team1, team2, currentSeq) {
    let cost = 0;
    if (team1.length === 2) cost += teammatePenalty(team1[0], team1[1], currentSeq);
    if (team2.length === 2) cost += teammatePenalty(team2[0], team2[1], currentSeq);
    team1.forEach(pa => team2.forEach(pb => { cost += opponentPenalty(pa, pb, currentSeq); }));
    return cost;
  }

  /**
   * Best way to split the chosen players into two teams (never separating a
   * fixed pair). Returns { team1, team2, cost }. `rng` breaks exact ties.
   */
  function bestSplit(selected, matchType, currentSeq, rng = Math.random) {
    let combos;
    if (matchType === 'singles') {
      combos = [{ team1: [selected[0]], team2: [selected[1]] }];
    } else {
      const [p0, p1, p2, p3] = selected;
      combos = [
        { team1: [p0, p1], team2: [p2, p3] },
        { team1: [p0, p2], team2: [p1, p3] },
        { team1: [p0, p3], team2: [p1, p2] },
      ];
      const allowed = combos.filter(c => keepsFixedPairs(c.team1, c.team2, matchType));
      if (allowed.length) combos = allowed;
    }
    let best = null;
    combos.forEach(c => {
      const cost = lineupCost(c.team1, c.team2, currentSeq);
      const key = cost + rng() * 0.5; // tie-break only
      if (!best || key < best.key) best = { ...c, cost, key };
    });
    // Randomly decide which side is "Team 1" (purely cosmetic variety)
    if (rng() < 0.5) return { team1: best.team2, team2: best.team1, cost: best.cost };
    return { team1: best.team1, team2: best.team2, cost: best.cost };
  }

  /** Kept for compatibility: best split without the side swap. */
  function buildTeams(selected, matchType, currentSeq) {
    const s = bestSplit(selected, matchType, currentSeq, () => 0);
    return { team1: s.team1, team2: s.team2 };
  }

  /**
   * Variety-aware choice of who plays next (see header). Returns
   * { team1, team2 } of players, or null if no full match can be formed.
   */
  function chooseMatch(waitingOrder, perMatch, matchType, byId, currentSeq, rng) {
    const info = buildUnits(waitingOrder, matchType, byId).map(u => ({
      u,
      size: u.length,
      level: Math.max(...u.map(rotationGames)),
      wait: Math.min(...u.map(p => currentSeq - p.lastActiveSeq)),
      jitter: rng(),
    }));
    // Fairness order: lowest games level first, then longest wait; random among exact ties
    info.sort((a, b) => a.level - b.level || b.wait - a.wait || a.jitter - b.jitter);

    // Fairness baseline: the strictly-fair feasible group (same rule as before).
    const baseline = fillExactly(info, perMatch);
    if (!baseline) return null;
    const level = Math.max(...baseline.map(i => i.level));
    const mandatory = baseline.filter(i => i.level < level); // below the level: must play
    const need = perMatch - mandatory.reduce((s, i) => s + i.size, 0);
    // Only players tied at the current games level compete on variety, so the
    // games-played spread stays exactly as fair as the strict rotation.
    const pool = info.filter(i => i.level === level).slice(0, POOL_CAP);
    const maxWait = Math.max(...pool.map(i => i.wait));
    const fixedPlayers = mandatory.flatMap(i => i.u);

    let best = null;
    const chosen = [];
    (function search(start, size) {
      if (size === need) {
        const players = fixedPlayers.concat(...chosen.map(i => i.u));
        const split = bestSplit(players, matchType, currentSeq, rng);
        const waitCost = chosen.reduce((s, i) => s + (maxWait - i.wait) * WAIT_WEIGHT, 0);
        const key = split.cost + waitCost + rng() * 0.5;
        if (!best || key < best.key) best = { team1: split.team1, team2: split.team2, key };
        return;
      }
      for (let k = start; k < pool.length; k++) {
        if (size + pool[k].size > need) continue;
        chosen.push(pool[k]);
        search(k + 1, size + pool[k].size);
        chosen.pop();
      }
    })(0, 0);

    if (best) return { team1: best.team1, team2: best.team2 };
    const fallback = baseline.flatMap(i => i.u);
    const split = bestSplit(fallback, matchType, currentSeq, rng);
    return { team1: split.team1, team2: split.team2 };
  }

  /** First combination of units (in order) whose sizes add up to exactly `need`. */
  function fillExactly(info, need) {
    const out = [];
    (function search(i, left) {
      if (left === 0) return true;
      if (i >= info.length) return false;
      if (info[i].size <= left) {
        out.push(info[i]);
        if (search(i + 1, left - info[i].size)) return true;
        out.pop();
      }
      return search(i + 1, left);
    })(0, need);
    return out.reduce((s, i) => s + i.size, 0) === need ? out : null;
  }

  function hasManualOrder(manualOrder) {
    return Array.isArray(manualOrder) && manualOrder.length > 0;
  }

  /**
   * Seed for a given match. It depends only on the upcoming match number, so
   * the "Next to play" preview (worked out while the current match is still
   * being played) uses the same tie-breaks as the real pick made right after.
   */
  function seedFor(seed) {
    return (Number(seed) || 0) * 7919 + 17;
  }

  /**
   * The match the next free court would get. Shared by generateMatch and the
   * "Next to play" preview so they agree.
   */
  function planNext(players, busyIds, matchType, currentSeq, manualOrder, seed) {
    const perMatch = matchType === 'doubles' ? 4 : 2;
    const byId = new Map(players.map(p => [p.id, p]));
    const waitingOrder = getWaitingOrder(players, busyIds, currentSeq, manualOrder);
    const rng = makeRng(seedFor(seed));
    if (hasManualOrder(manualOrder) && waitingOrder.some(p => manualOrder.includes(p.id))) {
      // Organizer's explicit order is followed exactly; teams are still varied.
      const selected = selectPlayers(waitingOrder, perMatch, matchType, byId);
      if (!selected) return { plan: null, waitingOrder, byId, perMatch };
      const split = bestSplit(selected, matchType, currentSeq, rng);
      return { plan: { team1: split.team1, team2: split.team2 }, waitingOrder, byId, perMatch };
    }
    return { plan: chooseMatch(waitingOrder, perMatch, matchType, byId, currentSeq, rng), waitingOrder, byId, perMatch };
  }

  /**
   * Ids of the waiting players first in line for the next free court
   * (fewer than a full match if not enough are waiting yet).
   */
  function nextUpIds(players, busyIds, matchType, currentSeq, manualOrder, seed) {
    const { plan, waitingOrder, byId, perMatch } = planNext(players, busyIds, matchType, currentSeq, manualOrder, seed);
    if (plan) return new Set(plan.team1.concat(plan.team2).map(p => p.id));
    const partial = selectPlayers(waitingOrder, perMatch, matchType, byId, true);
    return new Set(partial.map(p => p.id));
  }

  function generateMatch(players, busyIds, matchType, currentSeq, manualOrder, seed) {
    const { plan } = planNext(players, busyIds, matchType, currentSeq, manualOrder, seed);
    if (!plan) return null;
    return {
      team1: plan.team1.map(p => p.id),
      team2: plan.team2.map(p => p.id),
    };
  }

  function commitMatch(players, { courtId, team1, team2, winner, team1Score, team2Score }, currentSeq) {
    const byId = new Map(players.map(p => [p.id, p]));
    const team1Players = team1.map(id => byId.get(id));
    const team2Players = team2.map(id => byId.get(id));
    const hasScore = Number.isFinite(team1Score) && Number.isFinite(team2Score);

    function applyResult(teamPlayers, isWinner, ownScore, oppScore) {
      teamPlayers.forEach(p => {
        p.queueGames = rotationGames(p) + 1; // read before gamesPlayed changes
        p.gamesPlayed += 1;
        if (isWinner) p.wins += 1;
        else p.losses += 1;
        p.lastActiveSeq = currentSeq;
        p.lastCourtId = courtId;
        if (hasScore) {
          p.pointsScored += ownScore;
          p.pointsAgainst += oppScore;
          p.scoredGames += 1;
        }
      });
    }

    applyResult(team1Players, winner === 'team1', team1Score, team2Score);
    applyResult(team2Players, winner === 'team2', team2Score, team1Score);

    function addHistory(p, otherId, key) {
      if (!p[key][otherId]) p[key][otherId] = { count: 0, lastSeq: -99 };
      p[key][otherId].count += 1;
      p[key][otherId].lastSeq = currentSeq;
    }

    if (team1Players.length === 2) {
      addHistory(team1Players[0], team1Players[1].id, 'teammates');
      addHistory(team1Players[1], team1Players[0].id, 'teammates');
    }
    if (team2Players.length === 2) {
      addHistory(team2Players[0], team2Players[1].id, 'teammates');
      addHistory(team2Players[1], team2Players[0].id, 'teammates');
    }
    team1Players.forEach(pa => {
      team2Players.forEach(pb => {
        addHistory(pa, pb.id, 'opponents');
        addHistory(pb, pa.id, 'opponents');
      });
    });
  }

  return {
    createPlayer,
    isActive,
    rotationGames,
    comparePriority,
    getWaitingOrder,
    activePartnerId,
    selectPlayers,
    keepsFixedPairs,
    buildTeams,
    bestSplit,
    chooseMatch,
    lineupCost,
    nextUpIds,
    generateMatch,
    commitMatch,
  };
})();
