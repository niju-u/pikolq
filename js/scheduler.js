// scheduler.js: name formatting, setup checks and court counts.

const Scheduler = (() => {
  const PLAYERS_PER_MATCH = { singles: 2, doubles: 4 };
  const MAX_PLAYERS = 500;
  const MAX_COURTS = 50;
  const MAX_NAME_LENGTH = 40;

  function playersPerMatch(matchType) {
    return PLAYERS_PER_MATCH[matchType] || 4;
  }

  /** Capitalize each word: "maria christine" -> "Maria Christine", "anne-marie" -> "Anne-Marie".
   *  Names typed like "McDonald" keep their capitals. */
  function capitalizeName(name) {
    return name.split(' ').map(word => word.split(/([-'’])/).map(part => {
      if (!part || /^[-'’]$/.test(part)) return part;
      const lower = part.toLocaleLowerCase();
      const upper = part.toLocaleUpperCase();
      // Keep inner capitals only if the word starts with one ("McDonald"); "jAY" becomes "Jay".
      const startsUpper = part.charAt(0) !== part.charAt(0).toLocaleLowerCase();
      const base = part === upper || !startsUpper ? lower : part;
      return base.charAt(0).toLocaleUpperCase() + base.slice(1);
    }).join('')).join(' ');
  }

  /** Clean up a name: trim, single spaces, capitalize. */
  function normalizeName(name) {
    return capitalizeName(String(name == null ? '' : name).trim().replace(/\s+/g, ' '));
  }

  /** Check the setup form values. Returns { valid, errors }. */
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

  /** How many courts can be filled, and how many players wait at the start. */
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
