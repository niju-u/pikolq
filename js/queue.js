/**
 * queue.js
 * Automatic rotation + team-building. DOM-free.
 *
 * Rotation order (unchanged): fewest games played, then longest wait, then id.
 * Extensions:
 *  - Removed players (active === false) never enter the queue.
 *  - A temporary manual order (list of player ids) can be pinned to the front
 *    of the waiting order; everyone else follows in automatic order.
 *  - Doubles fixed partners are selected as one unit, ranked at the position of
 *    the LOWER-priority partner (so pairing up never jumps the queue), and are
 *    always placed on the same team.
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
  function selectPlayers(waitingOrder, perMatch, matchType, byId, allowPartial = false) {
    // 1. Group into units (single players or fixed pairs), in priority order.
    const index = new Map(waitingOrder.map((p, i) => [p.id, i]));
    const units = [];
    waitingOrder.forEach((p, i) => {
      const partnerId = activePartnerId(p, byId, matchType);
      if (partnerId == null) units.push([p]);
      else if (!index.has(partnerId)) return; // partner is on a court: wait together
      else if (index.get(partnerId) < i) units.push([byId.get(partnerId), p]); // ranked at later member
    });

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

  function teammatePenalty(p1, p2, currentSeq) {
    return historyPenalty(p1.teammates[p2.id], currentSeq, 50, 6, 25);
  }

  function opponentPenalty(p1, p2, currentSeq) {
    return historyPenalty(p1.opponents[p2.id], currentSeq, 30, 6, 15);
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

  function buildTeams(selected, matchType, currentSeq) {
    if (matchType === 'singles') {
      return { team1: [selected[0]], team2: [selected[1]] };
    }

    const [p0, p1, p2, p3] = selected;
    const combos = [
      { team1: [p0, p1], team2: [p2, p3] },
      { team1: [p0, p2], team2: [p1, p3] },
      { team1: [p0, p3], team2: [p1, p2] },
    ];
    const allowed = combos.filter(c => keepsFixedPairs(c.team1, c.team2, matchType));
    const candidates = allowed.length ? allowed : combos;

    let best = null;
    let bestCost = Infinity;
    candidates.forEach(combo => {
      let cost = teammatePenalty(combo.team1[0], combo.team1[1], currentSeq);
      cost += teammatePenalty(combo.team2[0], combo.team2[1], currentSeq);
      combo.team1.forEach(pa => {
        combo.team2.forEach(pb => {
          cost += opponentPenalty(pa, pb, currentSeq);
        });
      });
      if (cost < bestCost) {
        bestCost = cost;
        best = combo;
      }
    });

    return best;
  }

  /**
   * Ids of the waiting players first in line for the next free court
   * (fewer than a full match if not enough are waiting yet).
   */
  function nextUpIds(players, busyIds, matchType, currentSeq, manualOrder) {
    const perMatch = matchType === 'doubles' ? 4 : 2;
    const byId = new Map(players.map(p => [p.id, p]));
    const waitingOrder = getWaitingOrder(players, busyIds, currentSeq, manualOrder);
    const selected = selectPlayers(waitingOrder, perMatch, matchType, byId, true);
    return new Set(selected.map(p => p.id));
  }

  function generateMatch(players, busyIds, matchType, currentSeq, manualOrder) {
    const perMatch = matchType === 'doubles' ? 4 : 2;
    const byId = new Map(players.map(p => [p.id, p]));
    const waitingOrder = getWaitingOrder(players, busyIds, currentSeq, manualOrder);
    const selected = selectPlayers(waitingOrder, perMatch, matchType, byId);
    if (!selected) return null;

    const teams = buildTeams(selected, matchType, currentSeq);

    return {
      team1: teams.team1.map(p => p.id),
      team2: teams.team2.map(p => p.id),
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
    nextUpIds,
    generateMatch,
    commitMatch,
  };
})();
