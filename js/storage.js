/**
 * storage.js
 * Thin localStorage wrapper. Knows nothing about the queue algorithm.
 */

const Storage = (() => {
  const KEY = 'pbq_session_v1';
  const DRAFT_KEY = 'pbq_setup_draft_v1';

  function saveSession(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not save session to localStorage', e);
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('Could not load session from localStorage', e);
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(KEY);
  }

  function saveDraft(draft) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
      console.warn('Could not save draft to localStorage', e);
    }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
  }

  return { saveSession, loadSession, clearSession, saveDraft, loadDraft, clearDraft };
})();
