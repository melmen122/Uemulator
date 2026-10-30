import { h, icon, clear, fmtBytes, fmtAgo, toMs, initials, coverVars, emptyState } from '../ui.js';
import {
  state, TABS, SYSTEMS, coreForGame, launchBlockReason, launchGame, toggleFavorite,
  addFolderFlow, rescanFlow, isPlaying, setView,
} from '../state.js';

const RECENT_LIMIT = 6;

export function createLibraryView() {
  let selectedKey = null;

  /* ---- header (built once, updated in place so the search box keeps focus) ---- */
  const searchInput = h('input', {
    type: 'search', class: 'search-input', id: 'lib-search', placeholder: 'Search games',
    'aria-label': 'Search games', autocomplete: 'off', spellcheck: 'false',
  });
  const clearBtn = h('button', { type: 'button', class: 'icon-btn search-clear', 'aria-label': 'Clear search', hidden: true,
    onClick: () => { setQuery(''); searchInput.focus(); } }, icon('x', 14));
  const slashHint = h('kbd', { class: 'kbd search-kbd', 'aria-hidden': 'true' }, '/');
  const search = h('div', { class: 'search' }, icon('search', 16), searchInput, slashHint, clearBtn);

  const addBtn = h('button', { type: 'button', class: 'btn', onClick: addFolderFlow }, icon('plus', 16), 'Add folder');
  const rescanBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Rescan ROM folders', title: 'Rescan ROM folders', onClick: rescanFlow }, icon('refresh', 16));

  const sub = h('p', { class: 'view-sub' });
  const chips = TABS.map((t) => {
    const count = h('span', { class: 'chip-count' });
    const btn = h('button', { type: 'button', class: 'chip', 'aria-pressed': t.id === state.filter, dataset: { tab: t.id },
      onClick: () => { state.filter = t.id; render(); } }, t.label, count);
    return { tab: t, btn, count };
  });
  const chipRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by system' }, ...chips.map((c) => c.btn));
  const scanBar = h('div', { class: 'scan-bar', role: 'progressbar', 'aria-label': 'Scanning ROM folders', hidden: true }, h('span', { class: 'scan-bar-fill' }));

  const head = h('header', { class: 'view-head' },
    h('div', { class: 'view-head-row' },
      h('div', { class: 'view-titles' }, h('h1', { class: 'view-title', id: 'lib-title' }, 'Library'), sub),
      h('div', { class: 'toolbar' }, search, addBtn, rescanBtn)),
    chipRow, scanBar);

  const body = h('div', { class: 'view-body', id: 'lib-body' });
  const el = h('section', { class: 'view', 'aria-labelledby': 'lib-title' }, head, body);

  /* ---- search ---- */
  function setQuery(q) {
    state.query = q;
    searchInput.value = q;
    renderBody();
    syncSearchChrome();
  }
  function syncSearchChrome() {
    const has = state.query.length > 0;
    clearBtn.hidden = !has;
    slashHint.hidden = has;
  }
  searchInput.addEventListener('input', () => { state.query = searchInput.value; syncSearchChrome(); renderBody(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.query) setQuery(''); else searchInput.blur();
    } else if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.isComposing)) {
      const first = body.querySelector('.card[tabindex="0"]') || body.querySelector('.card');
      if (first) { e.preventDefault(); select(first, true); }
    }
  });

  /* ---- data ---- */
  const tabOf = (id) => TABS.find((t) => t.id === id) || TABS[0];
  const inTab = (g, tab) => !tab.systems || tab.systems.includes(g.system);

  function visible() {
    const tab = tabOf(state.filter);
    const q = state.query.trim().toLowerCase();
    return state.games.filter((g) => inTab(g, tab) && (!q
      || g.title.toLowerCase().includes(q)
      || (SYSTEMS[g.system] ? SYSTEMS[g.system].name.toLowerCase().includes(q) : false)));
  }

  /* ---- cards ---- */
  function card(game, section) {
    const reason = launchBlockReason(game);
    const playing = isPlaying(game.id);
    const starting = state.launching.has(game.id);
    const sys = SYSTEMS[game.system] || { short: String(game.system || '?').toUpperCase(), name: 'Unknown' };
    const cv = coverVars(game.title);
    const played = fmtAgo(game.lastPlayed);
    const meta = [fmtBytes(game.size), played ? `Played ${played}` : ''].filter(Boolean).join(' · ');
    const core = coreForGame(game);

    const cover = h('div', { class: 'cover', 'aria-hidden': 'true', style: { '--h1': cv.h1, '--h2': cv.h2, '--a': cv.a } },
      h('span', { class: 'cover-mark' }, sys.short),
      h('span', { class: 'cover-initials' }, initials(game.title)));

    const fav = h('button', {
      type: 'button', class: `icon-btn fav${game.favorite ? ' is-on' : ''}`, dataset: { act: 'fav' },
      'aria-pressed': !!game.favorite, 'aria-label': `Favorite ${game.title}`, title: game.favorite ? 'Remove from favorites' : 'Add to favorites',
    }, icon(game.favorite ? 'star-fill' : 'star', 16));

    const play = h('button', {
      type: 'button', class: `btn btn-primary btn-sm play${starting ? ' is-busy' : ''}`, dataset: { act: 'play' },
      'aria-disabled': reason ? 'true' : null,
      title: reason || `Play ${game.title}`,
      'aria-label': reason ? `Play ${game.title} (unavailable: ${reason})` : `Play ${game.title}`,
    }, starting ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('play', 14), starting ? 'Starting' : 'Play');

    return h('article', {
      class: `card sys-${game.system}${playing ? ' is-playing' : ''}${reason ? ' is-blocked' : ''}`,
      tabindex: -1, dataset: { id: game.id, key: `${section}:${game.id}` }, 'aria-label': game.title,
    },
    h('div', { class: 'cover-wrap' }, cover, fav, playing ? h('span', { class: 'live-pill' }, h('span', { class: 'live-dot' }), 'Playing') : null),
    h('div', { class: 'card-body' },
      h('h3', { class: 'card-title', title: game.title }, game.title),
      reason
        ? h('p', { class: 'card-meta card-warn' }, core ? `${core.name} ${core.status === 'unsupported' ? 'unsupported here' : core.id === 'project64' ? 'not set up' : 'not installed'}` : 'No emulator')
        : h('p', { class: 'card-meta' }, meta || '\u00a0'),
      h('div', { class: 'card-foot' },
        h('span', { class: 'badge sys-badge' }, sys.short),
        play)));
  }

  function section(title, games, key, count) {
    return h('section', { class: 'lib-section', 'aria-label': title },
      h('h2', { class: 'section-title' }, title, h('span', { class: 'section-count' }, String(count ?? games.length))),
      h('div', { class: 'grid' }, ...games.map((g) => card(g, key))));
  }

  function skeletons() {
    return h('div', { class: 'grid', 'aria-hidden': 'true' }, ...Array.from({ length: 10 }, () =>
      h('div', { class: 'card skeleton' }, h('div', { class: 'cover-wrap' }), h('div', { class: 'card-body' }, h('div', { class: 'sk-line' }), h('div', { class: 'sk-line short' })))));
  }

  /* ---- render ---- */
  function renderChrome() {
    const total = state.games.length;
    const systems = new Set(state.games.map((g) => g.system)).size;
    clear(sub);
    sub.append(state.loading ? 'Loading your games…'
      : state.scanning ? 'Scanning ROM folders…'
        : total ? `${total} ${total === 1 ? 'game' : 'games'} across ${systems} ${systems === 1 ? 'system' : 'systems'}` : 'No games yet');
    for (const { tab, btn, count } of chips) {
      const n = state.games.filter((g) => inTab(g, tab)).length;
      count.textContent = String(n);
      btn.setAttribute('aria-pressed', String(tab.id === state.filter));
      btn.classList.toggle('is-empty', n === 0 && tab.id !== 'all');
    }
    scanBar.hidden = !state.scanning;
    rescanBtn.classList.toggle('is-spinning', state.scanning);
    rescanBtn.setAttribute('aria-disabled', String(state.scanning || state.bridgeMissing));
    addBtn.setAttribute('aria-disabled', String(state.bridgeMissing));
    syncSearchChrome();
  }

  function renderBody() {
    const hadFocus = body.contains(document.activeElement);
    const keep = selectedKey;
    const scrollTop = body.scrollTop;
    clear(body);

    if (state.loading) { body.append(skeletons()); return; }

    const list = visible();
    const q = state.query.trim();
    const tab = tabOf(state.filter);

    if (!state.games.length) {
      const hasFolders = state.folders.length > 0;
      body.append(emptyState({
        title: hasFolders ? 'No games found in your folders' : 'Add your ROM folder to get started',
        body: hasFolders
          ? `Uemulator looked through ${state.folders.length} ${state.folders.length === 1 ? 'folder' : 'folders'} and didn't find a supported ROM. Check the folder, or add another.`
          : 'Point Uemulator at a folder of ROMs. It detects N64, PS3, Switch, 3DS, GBA, GBC and GB games by file type and builds your library.',
        actions: [
          h('button', { type: 'button', class: 'btn btn-primary btn-lg', 'aria-disabled': state.bridgeMissing ? 'true' : null, onClick: addFolderFlow }, icon('folder', 18), 'Add ROM folder'),
          hasFolders ? h('button', { type: 'button', class: 'btn btn-lg', onClick: rescanFlow }, icon('refresh', 18), 'Rescan') : null,
        ],
      }));
      return;
    }

    if (!list.length) {
      body.append(emptyState({
        iconName: 'search',
        title: q ? `No games match “${q}”` : `No ${tab.title} games`,
        body: q ? 'Try a different title, or clear the search to see everything.' : 'Pick another system, or add a folder that contains these games.',
        actions: [q ? h('button', { type: 'button', class: 'btn', onClick: () => { setQuery(''); searchInput.focus(); } }, 'Clear search')
          : h('button', { type: 'button', class: 'btn', onClick: () => { state.filter = 'all'; render(); } }, 'Show all systems')],
      }));
      return;
    }

    const byTitle = [...list].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    if (q) {
      body.append(section(`Results`, byTitle, 'all'));
    } else {
      const favs = byTitle.filter((g) => g.favorite);
      const recent = list.filter((g) => toMs(g.lastPlayed) > 0).sort((a, b) => toMs(b.lastPlayed) - toMs(a.lastPlayed)).slice(0, RECENT_LIMIT);
      if (favs.length) body.append(section('Favorites', favs, 'fav'));
      if (recent.length) body.append(section('Recently played', recent, 'recent'));
      body.append(section(tab.title, byTitle, 'all'));
    }

    body.scrollTop = scrollTop;
    const cards = [...body.querySelectorAll('.card')];
    const target = cards.find((c) => c.dataset.key === keep) || cards.find((c) => c.dataset.key.endsWith(`:${(keep || '').split(':')[1]}`)) || cards[0];
    if (target) select(target, hadFocus, true);
  }

  function render() { renderChrome(); renderBody(); }

  /* ---- selection / keyboard ---- */
  function select(cardEl, focus, quiet) {
    for (const c of body.querySelectorAll('.card')) {
      const on = c === cardEl;
      c.tabIndex = on ? 0 : -1;
      c.classList.toggle('is-selected', on);
      for (const b of c.querySelectorAll('button')) b.tabIndex = on ? 0 : -1;
    }
    selectedKey = cardEl.dataset.key;
    if (focus) cardEl.focus({ preventScroll: !!quiet });
  }

  function neighbor(cards, from, dir) {
    const i = cards.indexOf(from);
    if (dir === 'left') return cards[i - 1];
    if (dir === 'right') return cards[i + 1];
    if (dir === 'home') return cards[0];
    if (dir === 'end') return cards[cards.length - 1];
    const r = from.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = null;
    let bestScore = Infinity;
    for (const c of cards) {
      if (c === from) continue;
      const b = c.getBoundingClientRect();
      const dy = dir === 'down' ? b.top - r.top : r.top - b.top;
      if (dy < r.height * 0.5) continue;
      const score = dy * 3 + Math.abs(b.left + b.width / 2 - cx);
      if (score < bestScore) { best = c; bestScore = score; }
    }
    return best;
  }

  body.addEventListener('keydown', (e) => {
    const cardEl = e.target.closest && e.target.closest('.card');
    if (!cardEl || e.altKey || e.ctrlKey || e.metaKey) return;
    const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' };
    if (dirs[e.key]) {
      e.preventDefault();
      const cards = [...body.querySelectorAll('.card')];
      const next = neighbor(cards, cardEl, dirs[e.key]);
      if (next) select(next, true);
      else if (e.key === 'ArrowUp') searchInput.focus();
    } else if (e.key === 'Enter' && e.target === cardEl) {
      e.preventDefault();
      launchGame(cardEl.dataset.id);
    } else if ((e.key === 'f' || e.key === 'F') && e.target === cardEl) {
      e.preventDefault();
      toggleFavorite(cardEl.dataset.id);
    }
  });

  body.addEventListener('click', (e) => {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;
    const act = e.target.closest('[data-act]');
    select(cardEl, !act);
    if (!act) return;
    if (act.dataset.act === 'fav') toggleFavorite(cardEl.dataset.id);
    else if (act.dataset.act === 'play') launchGame(cardEl.dataset.id);
  });

  body.addEventListener('dblclick', (e) => {
    const cardEl = e.target.closest('.card');
    if (cardEl && !e.target.closest('button')) launchGame(cardEl.dataset.id);
  });

  return {
    el,
    topics: ['library', 'cores', 'settings', 'sessions', 'scan'],
    render,
    focusSearch() { searchInput.focus(); searchInput.select(); },
    gotoCores() { setView('cores'); },
  };
}
