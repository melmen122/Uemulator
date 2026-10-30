import { h, icon, clear, toast, viewHead } from '../ui.js';
import { state, SYSTEMS, pickCorePath, resetCorePath, openExternal, refreshCores } from '../state.js';

const STATUS = {
  ready: { label: 'Ready', cls: 'is-ok' },
  missing: { label: 'Not installed', cls: 'is-warn' },
  unsupported: { label: 'Unsupported on this OS', cls: 'is-muted' },
};

const SOURCES = [
  [/override|custom|setting|user/i, 'Custom path from Settings'],
  [/built|bin|local/i, 'Built locally (bin/)'],
  [/path|which/i, 'Found on PATH'],
  [/system|install|known/i, 'System install'],
];
export const sourceLabel = (src) => (src ? (SOURCES.find(([re]) => re.test(src)) || [0, src])[1] : '');

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ kind: 'success', message: 'Command copied.', duration: 2200 });
  } catch {
    toast({ kind: 'error', message: 'Couldn’t copy automatically. Select the command and copy it manually.' });
  }
}

export function createCoresView() {
  const grid = h('div', { class: 'core-grid' });
  const el = h('section', { class: 'view', 'aria-labelledby': 'cores-title' },
    viewHead({
      id: 'cores-title', title: 'Cores',
      sub: h('p', { class: 'view-sub' }, 'The emulators Uemulator launches. Each one is detected automatically, or you can point to your own copy.'),
      actions: h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn', onClick: refreshCores }, icon('refresh', 16), 'Recheck')),
    }),
    h('div', { class: 'view-body' }, grid));

  function coreCard(core) {
    const st = STATUS[core.status] || { label: String(core.status || 'Unknown'), cls: 'is-muted' };
    const overridden = !!(state.settings.corePaths || {})[core.id] || /override/i.test(core.source || '');
    const cmd = `npm run build:cores -- ${core.id}`;
    const systems = (core.systems || []).map((s) => h('span', { class: `badge sys-badge sys-${s}` }, (SYSTEMS[s] || { short: s }).short));

    return h('article', { class: `core-card${core.status === 'ready' ? '' : ' is-off'}`, 'aria-label': core.name },
      h('div', { class: 'core-top' },
        h('div', { class: 'core-name' }, h('h2', null, core.name), h('div', { class: 'core-systems', 'aria-label': 'Systems' }, ...systems)),
        h('span', { class: `status-pill ${st.cls}` }, st.label)),
      h('dl', { class: 'core-path' },
        h('dt', null, 'Executable'),
        h('dd', { class: core.exe ? 'path' : 'path is-none' }, core.exe || (core.status === 'unsupported' ? 'Not available on this operating system' : 'Not found')),
        core.exe && core.source ? h('dd', { class: 'path-source' }, sourceLabel(core.source)) : null),
      core.id === 'project64' && core.status === 'unsupported'
        ? h('p', { class: 'core-note' }, 'Project64 is Windows-only. On macOS and Linux it can run through Wine: install Wine, then set the path to a Project64.exe.') : null,
      core.id === 'rpcs3'
        ? h('p', { class: 'core-note' }, 'RPCS3 needs PS3 firmware (PS3UPDAT.PUP) installed inside RPCS3 itself before games will boot.') : null,
      h('div', { class: 'core-actions' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: () => pickCorePath(core.id) }, icon('folder', 15), 'Set path…'),
        h('button', { type: 'button', class: 'btn btn-sm', 'aria-disabled': overridden ? null : 'true', title: overridden ? 'Go back to automatic detection' : 'Already using automatic detection',
          onClick: () => { if (overridden) resetCorePath(core.id); } }, 'Reset')),
      core.status === 'ready' ? null : h('div', { class: 'core-build' },
        h('span', { class: 'core-build-label' }, 'Build from source'),
        h('code', { class: 'cmd' }, cmd),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Copy build command for ${core.name}`, title: 'Copy command', onClick: () => copy(cmd) }, icon('copy', 15))),
      h('div', { class: 'core-foot' },
        core.homepage ? h('button', { type: 'button', class: 'link', onClick: () => openExternal(core.homepage), 'aria-label': `${core.name} homepage (opens in your browser)` }, 'Homepage', icon('external', 13)) : null,
        core.license ? h('span', { class: 'core-license' }, `License ${core.license}`) : null));
  }

  function render() {
    clear(grid);
    if (!state.cores.length) {
      grid.append(h('p', { class: 'muted' }, state.loading ? 'Checking installed emulators…' : 'No cores reported. Is the Uemulator bridge running?'));
      return;
    }
    for (const c of state.cores) grid.append(coreCard(c));
  }

  return { el, topics: ['cores', 'settings'], render };
}
