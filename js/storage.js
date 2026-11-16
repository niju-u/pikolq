/**
 * storage.js
 * Thin localStorage wrapper. Knows nothing about the queue algorithm.
 *
 * Every access is guarded: when the browser blocks storage (some privacy
 * modes, embedded in-app browsers) the app keeps working, it just can't save.
 */

const Storage = (() => {
  const KEY = 'pbq_session_v1';
  const DRAFT_KEY = 'pbq_setup_draft_v1';

  function safe(fn, fallback, label) {
    try {
      return fn();
    } catch (e) {
      if (label) console.warn(`Storage unavailable: could not ${label}.`, e);
      return fallback;
    }
  }

  function parse(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn('Saved data is not valid JSON; ignoring it.', e);
      return null;
    }
  }

  function saveSession(state) {
    safe(() => localStorage.setItem(KEY, JSON.stringify(state)), undefined, 'save the session');
  }

  function loadSession() {
    return parse(safe(() => localStorage.getItem(KEY), null, 'load the session'));
  }

  function clearSession() {
    safe(() => localStorage.removeItem(KEY), undefined, 'clear the session');
  }

  function saveDraft(draft) {
    safe(() => localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)), undefined, 'save the setup draft');
  }

  function loadDraft() {
    return parse(safe(() => localStorage.getItem(DRAFT_KEY), null, 'load the setup draft'));
  }

  function clearDraft() {
    safe(() => localStorage.removeItem(DRAFT_KEY), undefined, 'clear the setup draft');
  }

  /**
   * Call `callback(sessionOrNull)` when ANOTHER tab/window changes the saved
   * session (the 'storage' event never fires in the tab that wrote it).
   */
  function onSessionChangedElsewhere(callback) {
    window.addEventListener('storage', e => {
      if (e.key === null) callback(null); // storage cleared entirely
      else if (e.key === KEY) callback(parse(e.newValue));
    });
  }

  /** Small per-device UI preferences (e.g. collapsed sections). */
  const PREF_PREFIX = 'pbq_pref_';
  function getPref(name, fallback = null) {
    const raw = safe(() => localStorage.getItem(PREF_PREFIX + name), null);
    return raw == null ? fallback : raw;
  }
  function setPref(name, value) {
    safe(() => localStorage.setItem(PREF_PREFIX + name, String(value)), undefined);
  }

  return { saveSession, loadSession, clearSession, saveDraft, loadDraft, clearDraft, onSessionChangedElsewhere, getPref, setPref };
})();
