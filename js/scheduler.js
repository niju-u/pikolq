/**
 * scheduler.js
 */

const Scheduler = (() => {
  const PLAYERS_PER_MATCH = { singles: 2, doubles: 4 };

  function playersPerMatch(matchType) {
    return PLAYERS_PER_MATCH[matchType] || 4;
  }

  /**
   * Validate raw setup form values. Returns { valid, errors: string[] }.
   */
  function validateSetup({ numPlayers, numCourts, matchType, names }) {
    const errors = [];

    if (!Number.isFinite(numPlayers) || numPlayers <= 0) {
      errors.push('Number of players must be greater than 0.');
    }
    if (!Number.isFinite(numCourts) || numCourts <= 0) {
      errors.push('Number of courts must be greater than 0.');
    }

    const perMatch = playersPerMatch(matchType);
    if (Number.isFinite(numPlayers) && numPlayers > 0 && numPlayers < perMatch) {
      errors.push(`${matchType === 'singles' ? 'Singles' : 'Doubles'} requires at least ${perMatch} players.`);
    }

    if (Array.isArray(names) && Number.isFinite(numPlayers)) {
      const trimmed = names.slice(0, numPlayers).map(n => (n || '').trim());
      trimmed.forEach((n, i) => {
        if (!n) errors.push(`Player ${i + 1} needs a name.`);
      });
      const seen = new Map();
      trimmed.forEach((n, i) => {
        if (!n) return;
        const key = n.toLowerCase();
        if (seen.has(key)) {
          errors.push(`Duplicate player name "${n}" (players ${seen.get(key) + 1} and ${i + 1}).`);
        } else {
          seen.set(key, i);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * How many courts can actually be filled with the given player count,
   * and how many sit waiting the moment the session starts.
   */
  function computeCourtSetup({ numPlayers, numCourts, matchType }) {
    const perMatch = playersPerMatch(matchType);
    const maxSimultaneousMatches = Math.floor(numPlayers / perMatch);
    const activeCourts = Math.max(0, Math.min(numCourts, maxSimultaneousMatches));
    const idleCourts = Math.max(0, numCourts - activeCourts);
    const playingAtStart = activeCourts * perMatch;
    const waitingAtStart = Math.max(0, numPlayers - playingAtStart);

    return { perMatch, activeCourts, idleCourts, playingAtStart, waitingAtStart };
  }

  return { playersPerMatch, validateSetup, computeCourtSetup };
})();
