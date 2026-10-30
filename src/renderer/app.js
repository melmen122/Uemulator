// Uemulator renderer entry. Shell (nav, banner, toasts) + view wiring. No framework, no innerHTML.
import { h, icon, logoMark, clear, mountToasts, getPlatform } from './ui.js';
import { state, subscribe, setView, boot, activeSessionCount, applyTheme } from './state.js';
import { createLibraryView } from './views/library.js';
import { createRunningView } from './views/running.js';
import { createCoresView } from './views/cores.js';
import { createSettingsView } from './views/settings.js';

async function main() {
  const root = document.documentElement;
  root.classList.add('is-booting'); // suppress transitions while the saved theme is applied

  if (location.search.includes('mock')) {
    await import('./mock.js');
  }
  // After the mock loads, so ?mock&platform=win32 previews the Windows chrome.
  root.classList.add({ darwin: 'is-mac', win32: 'is-win', linux: 'is-linux' }[getPlatform()]);

  mountToasts(document.getElementById('toasts'));
  for (const slot of document.querySelectorAll('[data-icon]')) slot.append(icon(slot.dataset.icon, 18));
  document.getElementById('brand').prepend(logoMark(26));

  const views = {
    library: createLibraryView(),
    running: createRunningView(),
    cores: createCoresView(),
    settings: createSettingsView(),
  };
  const host = document.getElementById('views');
  for (const v of Object.values(views)) { v.el.hidden = true; host.append(v.el); }

  const navButtons = [...document.querySelectorAll('.nav-item')];
  for (const b of navButtons) b.addEventListener('click', () => setView(b.dataset.view));

  const badge = document.getElementById('running-badge');
  const coresDot = document.getElementById('cores-dot');
  const foot = document.getElementById('sidebar-foot');
  const banner = document.getElementById('banner');

  function showView() {
    for (const [name, v] of Object.entries(views)) v.el.hidden = name !== state.view;
    for (const b of navButtons) {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    views[state.view].render();
    document.title = `${state.view[0].toUpperCase()}${state.view.slice(1)} · Uemulator`;
  }

  function chrome() {
    const n = activeSessionCount();
    badge.hidden = n === 0;
    badge.textContent = String(n);
    const notReady = state.cores.some((c) => c.status === 'missing');
    coresDot.hidden = !notReady;
    clear(foot);
    if (state.scanning) foot.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Scanning…');
    else if (state.games.length) foot.append(`${state.games.length} ${state.games.length === 1 ? 'game' : 'games'}`);
    banner.hidden = !state.bridgeMissing;
    if (state.bridgeMissing && !banner.firstChild) {
      banner.append(icon('alert', 18), h('div', null,
        h('strong', null, 'Uemulator’s bridge isn’t available. '),
        'This page is running outside the Electron app, so games can’t be scanned or launched. Open it through Electron, or add ',
        h('code', null, '?mock'), ' to the URL to preview with sample data.'));
    }
  }

  subscribe((topic) => {
    if (topic === 'nav') { showView(); chrome(); return; }
    chrome();
    for (const [name, v] of Object.entries(views)) {
      if (v.topics.includes(topic) && (name === state.view || v.alwaysRender)) v.render();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    if (state.view !== 'library') setView('library');
    views.library.focusSearch();
  });

  setInterval(() => views.running.tick(), 1000);

  const wanted = new URLSearchParams(location.search).get('view');
  if (wanted && wanted in views) state.view = wanted;
  showView();
  chrome();
  applyTheme();
  await boot();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-booting')));
}

main().catch((err) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = `Uemulator failed to start: ${err && err.message ? err.message : err}`;
  document.body.prepend(pre);
});
