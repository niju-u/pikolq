/**
 * queue.js
 */

const Queue = (() => {
  function createPlayer(id, name) {
    return {
      id,
      name,
      gamesPlayed: 0,
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

  function comparePriority(a, b, currentSeq) {
    if (a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;

    const waitA = currentSeq - a.lastActiveSeq;
    const waitB = currentSeq - b.lastActiveSeq;
    if (waitA !== waitB) return waitB - waitA;

    return a.id - b.id;
  }

  function getWaitingOrder(players, busyIds, currentSeq) {
    return players
      .filter(p => !busyIds.has(p.id))
      .slice()
      .sort((a, b) => comparePriority(a, b, currentSeq));
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

    let best = null;
    let bestCost = Infinity;
    combos.forEach(combo => {
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
  
  function generateMatch(players, busyIds, matchType, currentSeq) {
    const perMatch = matchType === 'doubles' ? 4 : 2;
    const waitingOrder = getWaitingOrder(players, busyIds, currentSeq);
    if (waitingOrder.length < perMatch) return null;

    const selected = waitingOrder.slice(0, perMatch);
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
    comparePriority,
    getWaitingOrder,
    buildTeams,
    generateMatch,
    commitMatch,
  };
})();
