/* Hero + footer wiring (shared look with the sister site, Pickleball Tournaments). */
(function () {
  'use strict';

  // Sister site link. Leave empty until Pickleball Tournaments is live; the links stay hidden
  // in production while it's empty. On local dev hosts (.test / localhost) the Laragon copy is used.
  const TOURNAMENTS_URL = 'https://tournament.pikolq.run.place/';
  const DEV_TOURNAMENTS_URL = 'http://pickleballbracket.test/';

  const host = location.hostname;
  const isDev = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.test');
  const tournamentsUrl = TOURNAMENTS_URL || (isDev ? DEV_TOURNAMENTS_URL : '');
  if (tournamentsUrl) {
    document.querySelectorAll('[data-tournaments-link]').forEach(a => { a.href = tournamentsUrl; a.hidden = false; });
    document.querySelectorAll('[data-tournaments-item]').forEach(li => { li.hidden = false; });
  }

  // ---------- Light / dark theme ----------
  const THEME_KEY = 'pikolq-theme';
  const root = document.documentElement;
  const themeBtn = document.getElementById('btn-theme');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const savedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } };

  function applyTheme(theme) {
    const dark = theme === 'dark';
    root.setAttribute('data-theme', theme);
    if (themeMeta) themeMeta.setAttribute('content', dark ? '#1E1626' : '#F3EDF7');
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', String(dark));
      themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }
  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  if (themeBtn) themeBtn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode: choice lasts this visit */ }
  });
  // Follow the device setting until the person picks a theme themselves.
  systemDark.addEventListener('change', e => { if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light'); });

  // Print / PDF export always uses the light colours.
  let themeBeforePrint = null;
  window.addEventListener('beforeprint', () => { themeBeforePrint = root.getAttribute('data-theme'); root.setAttribute('data-theme', 'light'); });
  window.addEventListener('afterprint', () => { if (themeBeforePrint) applyTheme(themeBeforePrint); themeBeforePrint = null; });

  document.querySelectorAll('[data-year]').forEach(n => { n.textContent = new Date().getFullYear(); });

  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const toTop = () => window.scrollTo({ top: 0, behavior: reduce() ? 'auto' : 'smooth' });
  document.querySelectorAll('[data-footer-top]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); toTop(); }));

  // The footer has its own "Back to top" button, so hide the floating one while the footer shows.
  const footer = document.querySelector('.site-footer');
  if (footer && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => document.body.classList.toggle('footer-in-view', entry.isIntersecting))
      .observe(footer);
  }

  const scrollToEl = node => {
    const header = document.querySelector('.app-header');
    const top = node.getBoundingClientRect().top + window.scrollY - (header ? header.offsetHeight : 0) - 12;
    window.scrollTo({ top, behavior: reduce() ? 'auto' : 'smooth' });
  };

  /** Scroll to the new-session form, opening it first if sessions are showing. */
  function startSession() {
    const setup = document.getElementById('setup-view');
    if (!setup) return;
    const newBtn = document.getElementById('btn-new-session');
    if (setup.hidden && newBtn) newBtn.click();
    scrollToEl(setup);
    const first = setup.querySelector('input');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), reduce() ? 0 : 450);
  }

  // "Back to the courts": the sessions list (the link is only shown while sessions are running).
  document.querySelectorAll('[data-footer-courts]').forEach(b => b.addEventListener('click', () => {
    const list = document.getElementById('sessions-toolbar');
    if (list && !list.hidden) scrollToEl(list); else toTop();
  }));

  const heroStart = document.getElementById('hero-start');
  if (heroStart) heroStart.addEventListener('click', e => { e.preventDefault(); startSession(); });
  document.querySelectorAll('[data-footer-new]').forEach(b => b.addEventListener('click', startSession));
})();
