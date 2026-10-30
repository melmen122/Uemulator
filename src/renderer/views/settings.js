import { h, icon, clear, segmented, switchControl, viewHead } from '../ui.js';
import { state, coreById, addFolderFlow, removeFolderFlow, rescanFlow, updateSettings } from '../state.js';

let uid = 0;

export function createSettingsView() {
  function row({ title, desc, control, note }) {
    const id = `set-${++uid}`;
    const t = h('div', { class: 'row-title', id }, title);
    const ctl = typeof control === 'function' ? control(id) : control;
    return { el: h('div', { class: 'row' }, h('div', { class: 'row-text' }, t, desc ? h('div', { class: 'row-desc' }, desc) : null, note || null), h('div', { class: 'row-control' }, ctl)), ctl };
  }

  /* ROM folders */
  const folderList = h('ul', { class: 'folder-list', 'aria-label': 'ROM folders' });
  const foldersPanel = h('section', { class: 'panel', 'aria-labelledby': 'set-folders' },
    h('div', { class: 'panel-head' },
      h('div', null, h('h2', { class: 'panel-title', id: 'set-folders' }, 'ROM folders'),
        h('p', { class: 'panel-desc' }, 'Uemulator scans these folders (and their subfolders) for games.')),
      h('div', { class: 'toolbar' },
        h('button', { type: 'button', class: 'btn', onClick: addFolderFlow }, icon('plus', 16), 'Add folder'),
        h('button', { type: 'button', class: 'btn', onClick: rescanFlow }, icon('refresh', 16), 'Rescan'))),
    folderList);

  /* Preferences */
  const fullscreen = row({
    title: 'Fullscreen on launch', desc: 'Start games in fullscreen when the emulator supports it.',
    control: (id) => switchControl({ labelledBy: id, checked: state.settings.fullscreen, onChange: (v) => updateSettings({ fullscreen: v }) }),
  });
  const gbHint = h('div', { class: 'row-note' });
  const gbCore = row({
    title: 'Game Boy / Color core', desc: 'Which emulator plays .gb and .gbc games. GBA always uses mGBA.',
    control: segmented({ label: 'Game Boy and Game Boy Color core', options: [{ value: 'mgba', label: 'mGBA' }, { value: 'pyboy', label: 'PyBoy' }], value: state.settings.gbCore, onChange: (v) => updateSettings({ gbCore: v }) }),
    note: gbHint,
  });
  const theme = row({
    title: 'Theme', desc: 'System follows your operating system’s light or dark setting.',
    control: segmented({ label: 'Theme', options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], value: state.settings.theme, onChange: (v) => updateSettings({ theme: v }) }),
  });
  const prefs = h('section', { class: 'panel', 'aria-labelledby': 'set-prefs' },
    h('div', { class: 'panel-head' }, h('div', null, h('h2', { class: 'panel-title', id: 'set-prefs' }, 'Preferences'))),
    h('div', { class: 'rows' }, fullscreen.el, gbCore.el, theme.el));

  const el = h('section', { class: 'view', 'aria-labelledby': 'settings-title' },
    viewHead({ id: 'settings-title', title: 'Settings' }),
    h('div', { class: 'view-body' }, h('div', { class: 'stack' }, foldersPanel, prefs)));

  function render() {
    clear(folderList);
    if (!state.folders.length) {
      folderList.append(h('li', { class: 'folder-empty' }, 'No folders yet. Add one to build your library.'));
    }
    for (const f of state.folders) {
      folderList.append(h('li', { class: 'folder-item' },
        h('span', { class: 'folder-icon' }, icon('folder', 18)),
        h('span', { class: 'path', title: f }, f),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove folder ${f}`, title: 'Remove from library', onClick: () => removeFolderFlow(f) }, icon('trash', 16))));
    }
    fullscreen.ctl.set(state.settings.fullscreen);
    gbCore.ctl.set(state.settings.gbCore);
    theme.ctl.set(state.settings.theme);
    const chosen = coreById(state.settings.gbCore);
    clear(gbHint);
    if (chosen && chosen.status !== 'ready') {
      gbHint.append(`${chosen.name} ${chosen.status === 'unsupported' ? 'isn’t supported on this OS' : 'isn’t installed yet'}, so GB and GBC games can’t launch. Set its path in Cores.`);
    }
    gbHint.hidden = !gbHint.firstChild;
  }

  return { el, topics: ['library', 'settings', 'cores'], render };
}
