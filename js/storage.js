/**
 * storage.js: saves and loads sessions in localStorage.
 * Each session is saved under its own key, plus a list of all sessions.
 * If the browser blocks storage, the app still works but can't save.
 */

const Storage = (() => {
  const LEGACY_KEY = 'pbq_session_v1';   // single session, before multiple sessions existed
  const LIST_KEY = 'pbq_sessions_v1';    // [{ id, name, createdAt }]
  const SESSION_PREFIX = 'pbq_s_';       // + id
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

  // ---------- session list ----------

  function listSessions() {
    const list = parse(safe(() => localStorage.getItem(LIST_KEY), null, 'load the session list'));
    return Array.isArray(list) ? list.filter(s => s && typeof s.id === 'string') : rebuildList();
  }

  /** The list is missing or damaged: find the saved sessions by their keys so they aren't lost. */
  function rebuildList() {
    const found = [];
    safe(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(SESSION_PREFIX)) continue;
        const saved = parse(localStorage.getItem(key));
        // The real creation time is unknown here, so leave it out rather than guess
        found.push({ id: key.slice(SESSION_PREFIX.length), name: (saved && typeof saved.name === 'string') ? saved.name : '', createdAt: null });
      }
    }, undefined);
    if (found.length) writeList(found);
    return found;
  }

  function writeList(list) {
    safe(() => localStorage.setItem(LIST_KEY, JSON.stringify(list)), undefined, 'save the session list');
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Move the old single saved session into the session list (runs once). */
  function migrateLegacy() {
    const raw = safe(() => localStorage.getItem(LEGACY_KEY), null);
    if (!raw) return;
    const old = parse(raw);
    if (old) {
      const id = newId();
      const name = (old.name && String(old.name)) || 'Session 1';
      old.name = name;
      safe(() => localStorage.setItem(SESSION_PREFIX + id, JSON.stringify(old)), undefined, 'move the old session');
      writeList([...listSessions(), { id, name, createdAt: Date.now() }]);
    }
    safe(() => localStorage.removeItem(LEGACY_KEY), undefined);
  }

  // ---------- one session ----------

  /** Save a session. Adds it to the list if it's new, and keeps its name in sync.
   *  Returns false if the browser refused to save (storage full or blocked). */
  function saveSession(id, state) {
    const saved = safe(() => { localStorage.setItem(SESSION_PREFIX + id, JSON.stringify(state)); return true; }, false, 'save the session');
    const list = listSessions();
    const entry = list.find(s => s.id === id);
    if (!entry) writeList([...list, { id, name: state.name || '', createdAt: Date.now() }]);
    else if (entry.name !== state.name) { entry.name = state.name || ''; writeList(list); }
    return saved;
  }

  function loadSession(id) {
    if (!id) return null;
    return parse(safe(() => localStorage.getItem(SESSION_PREFIX + id), null, 'load the session'));
  }

  function deleteSession(id) {
    safe(() => localStorage.removeItem(SESSION_PREFIX + id), undefined, 'delete the session');
    writeList(listSessions().filter(s => s.id !== id));
    safe(() => localStorage.removeItem(`pbq_pref_open_${id}`), undefined);
    safe(() => localStorage.removeItem(`pbq_pref_voice_${id}`), undefined);
  }

  // ---------- setup draft ----------

  function saveDraft(draft) {
    safe(() => localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)), undefined, 'save the setup draft');
  }

  function loadDraft() {
    return parse(safe(() => localStorage.getItem(DRAFT_KEY), null, 'load the setup draft'));
  }

  function clearDraft() {
    safe(() => localStorage.removeItem(DRAFT_KEY), undefined, 'clear the setup draft');
  }

  /** Tell the app when another tab changes saved data.
   *  callback({ type: 'session', id, session }) | ({ type: 'list' }) | ({ type: 'cleared' }) */
  function onChangedElsewhere(callback) {
    window.addEventListener('storage', e => {
      if (e.storageArea !== localStorage) return;
      if (e.key === null) callback({ type: 'cleared' }); // all storage was cleared
      else if (e.key === LIST_KEY) callback({ type: 'list' });
      else if (e.key.startsWith(SESSION_PREFIX)) {
        callback({ type: 'session', id: e.key.slice(SESSION_PREFIX.length), session: parse(e.newValue) });
      }
    });
  }

  /** Small per-device settings (e.g. collapsed sections). */
  const PREF_PREFIX = 'pbq_pref_';
  function getPref(name, fallback = null) {
    const raw = safe(() => localStorage.getItem(PREF_PREFIX + name), null);
    return raw == null ? fallback : raw;
  }
  function setPref(name, value) {
    safe(() => localStorage.setItem(PREF_PREFIX + name, String(value)), undefined);
  }

  return {
    newId, migrateLegacy, listSessions, saveSession, loadSession, deleteSession,
    saveDraft, loadDraft, clearDraft, onChangedElsewhere, getPref, setPref,
  };
})();
