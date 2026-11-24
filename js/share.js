/**
 * share.js: talks to the shared-sessions database (Supabase), using only the functions in
 * supabase/shared-sessions.sql. No library needed: each call is one POST to /rest/v1/rpc/<name>.
 *
 *   Share.enabled                      true when share-config.js is filled in
 *   Share.share(state, passcode)       -> { code, version, expires_at } | { error }
 *   Share.get(code, sinceVersion)      -> { state, version, expires_at } | { unchanged, ... } | { missing }
 *   Share.checkPasscode(code, pass)    -> { ok, state, version, expires_at } | { denied } | { locked } | { missing }
 *   Share.update(code, pass, state, baseVersion)
 *                                      -> { version, expires_at } | { conflict, state, version, ... } | { denied } | { locked } | { missing }
 *   Share.stop(code, pass)             -> { ok } | { denied } | { locked } | { missing }
 * Network problems throw, so callers can try again later.
 */
const Share = (() => {
  const cfg = window.PBQ_SHARE_CONFIG || {};
  const base = String(cfg.url || '').replace(/\/+$/, '');
  const key = String(cfg.anonKey || '');
  const enabled = !!(base && key);

  // Codes use letters and digits that can't be mixed up (no 0/O or 1/I/L)
  const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
  const cleanCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isCode = code => CODE_RE.test(cleanCode(code));

  /** New publishable keys (sb_publishable_...) go in the apikey header only; older anon keys (JWTs) also as a Bearer token. */
  function authHeaders() {
    const h = { apikey: key, 'Content-Type': 'application/json' };
    if (/^eyJ/.test(key)) h.Authorization = `Bearer ${key}`;
    return h;
  }

  async function rpc(name, args) {
    if (!enabled) throw new Error('Sharing is not set up.');
    const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(args),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Share server error ${res.status}`);
    return res.json();
  }

  /** A random passcode of 6 digits (people can type their own instead). */
  function randomPasscode() {
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    return String(n[0] % 1000000).padStart(6, '0');
  }

  /** Link that opens the join box with the code filled in (the passcode is never put in links).
   *  On the site it's short, like pikolq.run.place/ABC123 (404.html sends it to the join box).
   *  Local test servers have no 404 page, so they get the #join= form the page reads directly. */
  function joinLink(code) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    return local
      ? `${location.origin}${location.pathname}#join=${cleanCode(code)}`
      : `${location.origin}/${cleanCode(code)}`;
  }

  return {
    enabled,
    cleanCode,
    isCode,
    randomPasscode,
    joinLink,
    share: (state, pass) => rpc('share_session', { p_state: state, p_pass: pass }),
    get: (code, since = 0) => rpc('get_shared_session', { p_code: cleanCode(code), p_since: since }),
    checkPasscode: (code, pass) => rpc('check_share_passcode', { p_code: cleanCode(code), p_pass: pass }),
    update: (code, pass, state, baseVersion) =>
      rpc('update_shared_session', { p_code: cleanCode(code), p_pass: pass, p_state: state, p_base_version: baseVersion }),
    stop: (code, pass) => rpc('stop_sharing_session', { p_code: cleanCode(code), p_pass: pass }),
  };
})();
