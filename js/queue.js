/**
 * queue.js: decides who plays next and makes the teams.
 *
 * How the next players are picked:
 *  1. Fairness: fewest games first, then longest wait.
 *  2. Variety: among players tied on games, pick the group with the fewest
 *     repeat partners and opponents. Randomness only breaks ties.
 *  3. Rest: nobody plays two games in a row. Someone who just finished sits out
 *     at least one match, unless there aren't enough rested players to fill the court.
 *     Exception: if the rested players are exactly the group that last played together,
 *     one of them is swapped with a player who just finished (max 2 games in a row).
 *
 * Also:
 *  - Removed players are never picked.
 *  - A manual order puts those players first, in that exact order.
 *  - Fixed partners always play together on the same team, and wait for
 *    whichever of them is further back in line.
 */

const Queue = (() => {
  function createPlayer(id, name) {
    return {
      id,
      name,
      active: true,
      fixedPartnerId: null,
      gamesPlayed: 0,
      queueGames: 0, // games counted for rotation (not reset by Clear History)
      wins: 0,
      losses: 0,
      lastActiveSeq: 0,
      lastPlayedSeq: null, // match number when they last finished a game
      streak: 0, // games played in a row without sitting out
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

  /** True if p finished a game and no match has ended since, so p should rest. */
  function justPlayed(p, currentSeq) {
    return Number.isInteger(p.lastPlayedSeq) && p.lastPlayedSeq >= currentSeq;
  }

  /** Games used for rotation (uses gamesPlayed for old saves). */
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

  /** Waiting players in the order they'll be called. `manualOrder` (optional) puts those ids first. */
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

  /** Id of p's fixed partner if they can play together right now, otherwise null. */
  function activePartnerId(p, byId, matchType) {
    if (matchType !== 'doubles' || p.fixedPartnerId == null) return null;
    const q = byId.get(p.fixedPartnerId);
    return q && isActive(q) && q.fixedPartnerId === p.id ? q.id : null;
  }

  /** Group waiting players into singles and fixed pairs, in order.
   *  A pair waits for its later member. A player whose partner is on court is skipped. */
  function buildUnits(waitingOrder, matchType, byId) {
    const index = new Map(waitingOrder.map((p, i) => [p.id, i]));
    const units = [];
    waitingOrder.forEach((p, i) => {
      const partnerId = activePartnerId(p, byId, matchType);
      if (partnerId == null) units.push([p]);
      else if (!index.has(partnerId)) return; // partner is on court: wait together
      else if (index.get(partnerId) < i) units.push([byId.get(partnerId), p]); // use the later member's place
    });
    return units;
  }

  /** The next `perMatch` players in exact waiting order (used for manual order
   *  and as the fair starting point). Returns players, or null. */
  function selectPlayers(waitingOrder, perMatch, matchType, byId, allowPartial = false) {
    const units = buildUnits(waitingOrder, matchType, byId);

    if (allowPartial) {
      const selected = [];
      units.forEach(u => {
        if (selected.length + u.length <= perMatch) selected.push(...u);
      });
      return selected;
    }

    // 2. Find the earliest group that exactly fills the court, skipping as few players as possible.
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

  // Repeat costs: a repeat partner costs more than a repeat opponent. Repeats in the last 8 matches cost extra.
  const PARTNER_REPEAT = 120;
  const PARTNER_RECENT = 20;
  const OPPONENT_REPEAT = 40;
  const OPPONENT_RECENT = 8;
  const RECENT_WINDOW = 8;
  // Cost per match of waiting, among tied players. Higher = shorter waits, lower = more mixing.
  const WAIT_WEIGHT = 200;
  // When mixing locked groups, cost of each player who goes straight back on.
  const MIX_BACK_TO_BACK = 60;
  // When mixing locked groups, cost of picking someone with an extra game over someone with fewer.
  const MIX_EXTRA_GAME = 40;
  // Mixing limits: games spread allowed before mixing, and players swapped per mix.
  const MIX_MAX_SPREAD = 2;
  const MIX_MAX_SWAPS = 1;
  // How many tied players/pairs to consider when looking for variety.
  const POOL_CAP = 14;

  function isFixedPair(a, b) {
    return a.fixedPartnerId === b.id && b.fixedPartnerId === a.id;
  }

  function teammatePenalty(p1, p2, currentSeq) {
    if (isFixedPair(p1, p2)) return 0; // fixed partners don't count as a repeat
    return historyPenalty(p1.teammates[p2.id], currentSeq, PARTNER_REPEAT, RECENT_WINDOW, PARTNER_RECENT);
  }

  function opponentPenalty(p1, p2, currentSeq) {
    return historyPenalty(p1.opponents[p2.id], currentSeq, OPPONENT_REPEAT, RECENT_WINDOW, OPPONENT_RECENT);
  }

  /** Seeded random numbers, so the same match always breaks ties the same way. */
  function makeRng(seed) {
    let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** True if no fixed pair is split onto different teams. */
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

  /** Variety cost of a line-up: repeat partners + repeat opponents. */
  function lineupCost(team1, team2, currentSeq) {
    let cost = 0;
    if (team1.length === 2) cost += teammatePenalty(team1[0], team1[1], currentSeq);
    if (team2.length === 2) cost += teammatePenalty(team2[0], team2[1], currentSeq);
    team1.forEach(pa => team2.forEach(pb => { cost += opponentPenalty(pa, pb, currentSeq); }));
    return cost;
  }

  /** Best way to split players into two teams, keeping fixed pairs together. Returns { team1, team2, cost }. */
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
      const key = cost + rng() * 0.5; // only breaks ties
      if (!best || key < best.key) best = { ...c, cost, key };
    });
    // Randomly pick which side is Team 1
    if (rng() < 0.5) return { team1: best.team2, team2: best.team1, cost: best.cost };
    return { team1: best.team1, team2: best.team2, cost: best.cost };
  }

  /** Old version kept for compatibility: best split, no side swap. */
  function buildTeams(selected, matchType, currentSeq) {
    const s = bestSplit(selected, matchType, currentSeq, () => 0);
    return { team1: s.team1, team2: s.team2 };
  }

  /** Pick who plays next (see top of file). Returns { team1, team2 }, or null if there aren't enough players. */
  function chooseMatch(waitingOrder, perMatch, matchType, byId, currentSeq, rng) {
    const info = buildUnits(waitingOrder, matchType, byId).map(u => ({
      u,
      size: u.length,
      level: Math.max(...u.map(rotationGames)),
      wait: Math.min(...u.map(p => currentSeq - p.lastActiveSeq)),
      jitter: rng(),
    }));
    // Fairness order: fewest games, then longest wait; random among exact ties
    info.sort((a, b) => a.level - b.level || b.wait - a.wait || a.jitter - b.jitter);

    // The strictly fair group, used as the starting point.
    const baseline = fillExactly(info, perMatch);
    if (!baseline) return null;
    const level = Math.max(...baseline.map(i => i.level));
    const mandatory = baseline.filter(i => i.level < level); // players below the level must play
    const need = perMatch - mandatory.reduce((s, i) => s + i.size, 0);
    // Only players tied on games compete on variety, so games stay as even as before.
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

  /** First set of units (in order) that adds up to exactly `need` players. */
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

  /** Seed based on the next match number, so "Next to play" matches the real pick. */
  function seedFor(seed) {
    return (Number(seed) || 0) * 7919 + 17;
  }

  /** True if these players all last played in the same match, so sending them on again repeats it. */
  function playedTogetherLast(group) {
    const seq = group[0].lastPlayedSeq;
    if (!Number.isInteger(seq) || group.some(p => p.lastPlayedSeq !== seq)) return false;
    const met = (a, b) => [a.teammates[b.id], a.opponents[b.id]].some(r => r && r.lastSeq === seq);
    return group.every((a, i) => group.slice(i + 1).every(b => met(a, b)));
  }

  /**
   * Exactly one court's worth is rested and they're the group that last played together,
   * so the same groups would keep alternating. Mix them with players who just finished, if:
   *  - games are within 2 across the session (a game in progress counts),
   *  - only one player is swapped (one back-to-back, one extra wait),
   *  - nobody goes to 3 games in a row,
   *  - no fixed partners are involved (they're kept simple: no mixing).
   * Prefers the fewest back-to-backs and the fewest repeat partners/opponents.
   */
  function mixLockedGroup(players, rested, fullOrder, perMatch, matchType, busyIds, currentSeq, rng) {
    if (!playedTogetherLast(rested)) return null;
    const games = players.filter(isActive).map(p => rotationGames(p) + (busyIds.has(p.id) ? 1 : 0));
    if (Math.max(...games) - Math.min(...games) > MIX_MAX_SPREAD) return null;
    const candidates = fullOrder.filter(p => !justPlayed(p, currentSeq) || (p.streak || 0) < 2);
    if (candidates.some(p => p.fixedPartnerId != null)) return null;
    const minGames = Math.min(...candidates.map(rotationGames));
    const restedIds = new Set(rested.map(p => p.id));

    let best = null;
    const chosen = [];
    (function search(start) {
      if (chosen.length === perMatch) {
        if (chosen.every(p => restedIds.has(p.id))) return; // that's the same group again
        const split = bestSplit(chosen.slice(), matchType, currentSeq, rng);
        const backToBack = chosen.filter(p => justPlayed(p, currentSeq)).length;
        if (backToBack > MIX_MAX_SWAPS) return;
        const extraGames = chosen.reduce((s, p) => s + rotationGames(p) - minGames, 0);
        const key = split.cost + backToBack * MIX_BACK_TO_BACK + extraGames * MIX_EXTRA_GAME + rng() * 0.5;
        if (!best || key < best.key) best = { team1: split.team1, team2: split.team2, key };
        return;
      }
      for (let k = start; k < candidates.length; k++) {
        chosen.push(candidates[k]);
        search(k + 1);
        chosen.pop();
      }
    })(0);
    return best && { team1: best.team1, team2: best.team2 };
  }

  /** The match the next free court would get. Used by generateMatch and "Next to play". */
  function planNext(players, busyIds, matchType, currentSeq, manualOrder, seed) {
    const perMatch = matchType === 'doubles' ? 4 : 2;
    const byId = new Map(players.map(p => [p.id, p]));
    const fullOrder = getWaitingOrder(players, busyIds, currentSeq, manualOrder);
    // Rest rule: players who just finished go to the back and are only used if needed.
    const rested = fullOrder.filter(p => !justPlayed(p, currentSeq));
    // If some must go straight back on: fewest games first, then the shortest run of games in a row
    const tired = fullOrder.filter(p => justPlayed(p, currentSeq))
      .sort((a, b) => rotationGames(a) - rotationGames(b) || (a.streak || 0) - (b.streak || 0) || comparePriority(a, b, currentSeq));
    const waitingOrder = rested.concat(tired);
    const result = plan => ({ plan, waitingOrder, byId, perMatch });

    const rng = makeRng(seedFor(seed));
    if (hasManualOrder(manualOrder) && rested.some(p => manualOrder.includes(p.id))) {
      // Follow the organizer's order exactly (rested players only); teams are still mixed.
      const selected = selectPlayers(rested, perMatch, matchType, byId);
      if (selected) {
        const split = bestSplit(selected, matchType, currentSeq, rng);
        return result({ team1: split.team1, team2: split.team2 });
      }
    } else {
      if (!hasManualOrder(manualOrder) && rested.length === perMatch && fullOrder.length > perMatch) {
        const plan = mixLockedGroup(players, rested, fullOrder, perMatch, matchType, busyIds, currentSeq, rng);
        if (plan) return result(plan);
      }
      const plan = chooseMatch(rested, perMatch, matchType, byId, currentSeq, rng);
      if (plan) return result(plan);
    }
    // Not enough rested players: take every rested player, then as few who just played as needed.
    if (rested.length === fullOrder.length) return result(null);
    const selected = selectPlayers(waitingOrder, perMatch, matchType, byId);
    if (!selected) return result(null);
    const split = bestSplit(selected, matchType, currentSeq, rng);
    return result({ team1: split.team1, team2: split.team2 });
  }

  /** Ids of the players first in line for the next free court. */
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

  function commitMatch(players, { courtId, team1, team2, winner, team1Score, team2Score, startSeq }, currentSeq) {
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
        // Went straight from their last game into this one? Then the run continues.
        const continued = Number.isInteger(startSeq) && justPlayed(p, startSeq);
        p.streak = continued ? (Number.isInteger(p.streak) ? p.streak : 1) + 1 : 1;
        p.lastActiveSeq = currentSeq;
        p.lastPlayedSeq = currentSeq;
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
    justPlayed,
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
