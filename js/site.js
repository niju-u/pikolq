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

  // ---------- Pixel scene (hero + footer): Pickle sa Balay's house, the pup playing fetch, a rally ----------
  // Colours match the Pickle sa Balay logo: cream-gold pup with golden ears, plum outline, lavender scarf and roof.
  const PUP = `<svg class="pxf-svg" viewBox="0 0 20 14" shape-rendering="crispEdges">
      <g class="pxf-tail"><rect class="d-shade" x="1" y="2" width="1" height="2"/><rect class="d-shade" x="2" y="3" width="1" height="2"/></g>
      <rect class="d-dark" x="2" y="5" width="12" height="7"/><rect class="d-coat" x="3" y="6" width="10" height="5"/>
      <rect class="d-shade" x="4" y="10" width="8" height="1"/>
      <g class="pxf-legs a"><rect class="d-coat" x="3" y="12" width="2" height="1"/><rect class="d-dark" x="3" y="13" width="2" height="1"/><rect class="d-coat" x="10" y="12" width="2" height="1"/><rect class="d-dark" x="10" y="13" width="2" height="1"/></g>
      <g class="pxf-legs b"><rect class="d-coat" x="5" y="12" width="2" height="1"/><rect class="d-dark" x="5" y="13" width="2" height="1"/><rect class="d-coat" x="12" y="12" width="2" height="1"/><rect class="d-dark" x="12" y="13" width="2" height="1"/></g>
      <rect class="d-dark" x="10" y="0" width="9" height="8"/><rect class="d-coat" x="11" y="1" width="7" height="6"/>
      <rect class="d-dark" x="18" y="3" width="2" height="4"/><rect class="d-coat" x="18" y="4" width="1" height="2"/><rect class="d-dark" x="19" y="4" width="1" height="1"/>
      <rect class="d-shade" x="11" y="2" width="2" height="4"/><rect class="d-dark" x="15" y="3" width="1" height="1"/>
      <rect class="d-tongue" x="17" y="7" width="1" height="2"/>
      <rect class="d-scarf" x="11" y="6" width="4" height="2"/><rect class="d-scarf" x="12" y="8" width="2" height="1"/><rect class="d-scarf2" x="12" y="9" width="1" height="1"/><rect class="d-heart" x="13" y="8" width="1" height="1"/>
    </svg>`;
  // Pickleball (6 x 6 pixels with holes): used by the pup and, smaller, by the players' rally
  const BALL_PIXELS = `<rect class="b-ball" x="1" y="0" width="4" height="1"/><rect class="b-ball" x="0" y="1" width="6" height="4"/><rect class="b-shade" x="1" y="5" width="4" height="1"/>
      <rect class="b-hole" x="1" y="2" width="1" height="1"/><rect class="b-hole" x="3" y="1" width="1" height="1"/><rect class="b-hole" x="4" y="3" width="1" height="1"/><rect class="b-hole" x="2" y="4" width="1" height="1"/>`;
  const BALL = `<svg class="pxf-svg" viewBox="0 0 6 6" shape-rendering="crispEdges">${BALL_PIXELS}</svg>`;
  // Small house, like the one in the Pickle sa Balay logo
  const HOUSE = `<svg class="pxf-svg" viewBox="0 0 24 20" shape-rendering="crispEdges">
      <rect class="h-roof" x="16" y="2" width="2" height="4"/>
      <rect class="h-roof" x="11" y="1" width="2" height="1"/><rect class="h-roof" x="9" y="2" width="6" height="1"/><rect class="h-roof" x="7" y="3" width="10" height="1"/>
      <rect class="h-roof" x="5" y="4" width="14" height="1"/><rect class="h-roof" x="3" y="5" width="18" height="1"/><rect class="h-roof" x="1" y="6" width="22" height="2"/>
      <rect class="h-wall" x="3" y="8" width="18" height="12"/><rect class="h-trim" x="3" y="8" width="18" height="1"/>
      <rect class="h-win" x="5" y="11" width="4" height="4"/><rect class="h-pane" x="7" y="11" width="1" height="4"/><rect class="h-pane" x="5" y="13" width="4" height="1"/>
      <rect class="h-win" x="15" y="11" width="4" height="4"/><rect class="h-pane" x="17" y="11" width="1" height="4"/><rect class="h-pane" x="15" y="13" width="4" height="1"/>
      <rect class="h-door" x="10" y="13" width="4" height="7"/><rect class="h-knob" x="13" y="16" width="1" height="1"/>
      <rect class="h-heart" x="11" y="10" width="1" height="1"/><rect class="h-heart" x="13" y="10" width="1" height="1"/><rect class="h-heart" x="11" y="11" width="3" height="1"/><rect class="h-heart" x="12" y="12" width="1" height="1"/>
    </svg>`;
  // Mini court: the same pixel players as on the court cards (yellow Team 1 vs lavender Team 2), rallying over the net
  const PLAYER = `<g class="pxp-body">
        <rect class="pxp-hair" x="3" y="0" width="4" height="1"/><rect class="pxp-hair" x="2" y="1" width="1" height="2"/>
        <rect class="pxp-skin" x="3" y="1" width="4" height="3"/><rect class="pxp-eye" x="6" y="2" width="1" height="1"/>
        <rect class="pxp-shirt" x="3" y="4" width="4" height="5"/><rect class="pxp-skin" x="2" y="5" width="1" height="3"/>
        <rect class="pxp-shorts" x="3" y="9" width="4" height="2"/>
        <rect class="pxp-skin" x="3" y="11" width="1" height="3"/><rect class="pxp-skin" x="6" y="11" width="1" height="3"/>
        <rect class="pxp-shoe" x="3" y="14" width="2" height="1"/><rect class="pxp-shoe" x="6" y="14" width="2" height="1"/>
        <g class="pxp-arm">
          <rect class="pxp-skin" x="7" y="5" width="3" height="1"/>
          <rect class="pxp-handle" x="9" y="3" width="1" height="2"/>
          <rect class="pxp-paddle" x="8" y="0" width="3" height="3"/><rect class="pxp-paddle" x="9" y="-1" width="1" height="1"/>
          <rect class="pxp-paddle-edge" x="8" y="-1" width="1" height="1"/><rect class="pxp-paddle-edge" x="10" y="-1" width="1" height="1"/>
          <rect class="pxp-paddle-hi" x="9" y="0" width="1" height="2"/>
        </g>
      </g>
      <rect class="pxp-floor" x="2" y="15" width="7" height="1"/>`;
  // Each player is the 12 x 17 sprite scaled into the court (feet on the white line); the right one is mirrored
  const courtPlayer = (team, x) => `<svg class="cp" x="${x}" y="1.71" width="8.47" height="12" viewBox="0 -1 12 17">${PLAYER}</svg>`;
  const COURT = `<svg class="pxf-svg" viewBox="0 0 40 14" shape-rendering="crispEdges">
      <rect class="c-line" x="0" y="13" width="40" height="1"/>
      <rect class="c-net" x="19" y="7" width="2" height="7"/><rect class="c-post" x="19" y="6" width="2" height="1"/>
      <g class="pxp-team1 cp-l">${courtPlayer('team1', 4)}</g>
      <g class="pxp-team2 cp-r" transform="translate(36 0) scale(-1 1)">${courtPlayer('team2', 0)}</g>
      <g class="pr-ball"><svg width="2.4" height="2.4" viewBox="0 0 6 6">${BALL_PIXELS}</svg></g>
    </svg>`;
  document.querySelectorAll('[data-px-fetch]').forEach(stage => {
    stage.innerHTML = `<span class="pxs-house">${HOUSE}</span>`
      + `<span class="pxf-yard"><span class="pxf-dog"><span class="pxf-face">${PUP}</span></span>`
      + `<span class="pxf-ball"><span class="pxf-shadow"></span><span class="pxf-bob">${BALL}</span></span></span>`
      + `<span class="pxs-court">${COURT}</span>`;
  });

  const heroStart = document.getElementById('hero-start');
  if (heroStart) heroStart.addEventListener('click', e => { e.preventDefault(); startSession(); });
  document.querySelectorAll('[data-footer-new]').forEach(b => b.addEventListener('click', startSession));
})();
