/**
 * scheduler.js
 */

const Scheduler = (() => {
  const PLAYERS_PER_MATCH = { singles: 2, doubles: 4 };
  const MAX_PLAYERS = 500;
  const MAX_COURTS = 50;
  const MAX_NAME_LENGTH = 40;

  function playersPerMatch(matchType) {
    return PLAYERS_PER_MATCH[matchType] || 4;
  }

  /**
   * Capitalize every word: "maria christine" / "MARIA CHRISTINE" -> "Maria Christine".
   * Parts split by hyphens/apostrophes are capitalized too ("anne-marie" ->
   * "Anne-Marie", "o'neil" -> "O'Neil"). A word typed in deliberate mixed case
   * keeps its inner capitals ("McDonald" stays "McDonald").
   */
  function capitalizeName(name) {
    return name.split(' ').map(word => word.split(/([-'’])/).map(part => {
      if (!part || /^[-'’]$/.test(part)) return part;
      const lower = part.toLocaleLowerCase();
      const upper = part.toLocaleUpperCase();
      // Keep inner capitals only when the word already starts with one
      // ("McDonald", "DeShawn"); "jAY" or "JAY" are tidied to "Jay".
      const startsUpper = part.charAt(0) !== part.charAt(0).toLocaleLowerCase();
      const base = part === upper || !startsUpper ? lower : part;
      return base.charAt(0).toLocaleUpperCase() + base.slice(1);
    }).join('')).join(' ');
  }

  /** One rule for names everywhere: trim, collapse inner whitespace, capitalize. */
  function normalizeName(name) {
    return capitalizeName(String(name == null ? '' : name).trim().replace(/\s+/g, ' '));
  }

  /**
   * Validate raw setup form values. Returns { valid, errors: string[] }.
   */
  function validateSetup({ numPlayers, numCourts, matchType, names }) {
    const errors = [];

    if (!Number.isFinite(numPlayers) || numPlayers <= 0) {
      errors.push('Number of players must be greater than 0.');
    } else if (numPlayers > MAX_PLAYERS) {
      errors.push(`Number of players can't be more than ${MAX_PLAYERS}.`);
    }
    if (!Number.isFinite(numCourts) || numCourts <= 0) {
      errors.push('Number of courts must be greater than 0.');
    } else if (numCourts > MAX_COURTS) {
      errors.push(`Number of courts can't be more than ${MAX_COURTS}.`);
    }

    const perMatch = playersPerMatch(matchType);
    if (Number.isFinite(numPlayers) && numPlayers > 0 && numPlayers < perMatch) {
      errors.push(`${matchType === 'singles' ? 'Singles' : 'Doubles'} requires at least ${perMatch} players.`);
    }

    if (Array.isArray(names) && Number.isFinite(numPlayers)) {
      const cleaned = names.slice(0, numPlayers).map(normalizeName);
      cleaned.forEach((n, i) => {
        if (!n) errors.push(`Player ${i + 1} needs a name.`);
        else if (n.length > MAX_NAME_LENGTH) errors.push(`Player ${i + 1}'s name must be ${MAX_NAME_LENGTH} characters or fewer.`);
      });
      const seen = new Map();
      cleaned.forEach((n, i) => {
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

  return { MAX_PLAYERS, MAX_COURTS, MAX_NAME_LENGTH, playersPerMatch, normalizeName, capitalizeName, validateSetup, computeCourtSetup };
})();
