// Small DOM toolkit: element helper, authored SVG icons, toasts, formatters, shared controls.
// Nothing here ever uses innerHTML: all text goes through text nodes / textContent.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('div', {class:'x', onClick}, 'text', childNode, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, String(sv));
    else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith('aria-')) el.setAttribute(k, String(v));
    else if (v === false) continue;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/* ---------- icons (24px grid, 1.75 stroke, round caps; one family) ---------- */

const P = (d, extra) => ['path', { d, ...extra }];
const ICONS = {
  library: [['rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.8 }], ['rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.8 }], ['rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.8 }], ['rect', { x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.8 }]],
  running: [P('M3 12h4l2.5-6.5 4 13 2.5-6.5H21')],
  cores: [['rect', { x: 7, y: 7, width: 10, height: 10, rx: 2 }], P('M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3')],
  settings: [P('M4 7h9M17 7h3M4 17h3M11 17h9'), ['circle', { cx: 15, cy: 7, r: 2 }], ['circle', { cx: 9, cy: 17, r: 2 }]],
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], P('M16 16l4.5 4.5')],
  star: [P('M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z')],
  'star-fill': [P('M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z', { fill: 'currentColor' })],
  play: [P('M7.5 4.8v14.4a.6.6 0 0 0 .9.5l11.4-7.2a.6.6 0 0 0 0-1L8.4 4.3a.6.6 0 0 0-.9.5z', { fill: 'currentColor' })],
  stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2.2, fill: 'currentColor' }]],
  folder: [P('M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z')],
  plus: [P('M12 5v14M5 12h14')],
  refresh: [P('M20 11a8 8 0 1 0-2.3 5.7'), P('M20.5 4.5V11H14')],
  external: [P('M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4')],
  x: [P('M6 6l12 12M18 6L6 18')],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2.2 }], P('M15 9V6.5a2 2 0 0 0-2-2H6.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H9')],
  check: [P('M5 12.5l4.5 4.5L19 7.5')],
  alert: [P('M12 4.2l9 15.6H3z'), P('M12 10v4.2M12 17.3v.1')],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], P('M12 11v5.2M12 7.9v.1')],
  trash: [P('M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7')],
  gamepad: [P('M7 8h10a4 4 0 0 1 3.9 4.9l-.7 3.2a2.4 2.4 0 0 1-4.3.9l-1.4-2h-5l-1.4 2a2.4 2.4 0 0 1-4.3-.9l-.7-3.2A4 4 0 0 1 7 8z'), P('M8 10.5v3.5M6.25 12.25h3.5'), P('M15.5 11.2v.1M17.5 13.2v.1')],
  down: [P('M12 5v14M6 13l6 6 6-6')],
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  for (const [tag, attrs] of ICONS[name] || []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

/** The Uemulator mark: rounded tile with a U-shaped cartridge slot. */
export function logoMark(size = 26) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('logo-mark');
  const tile = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: 1, y: 1, width: 30, height: 30, rx: 9, fill: 'currentColor' })) tile.setAttribute(k, String(v));
  const u = document.createElementNS(SVG_NS, 'path');
  u.setAttribute('d', 'M10.5 9v8.2a5.5 5.5 0 0 0 11 0V9');
  u.setAttribute('fill', 'none');
  u.setAttribute('stroke', 'var(--on-accent)');
  u.setAttribute('stroke-width', '3.4');
  u.setAttribute('stroke-linecap', 'round');
  svg.append(tile, u);
  return svg;
}

/* ---------- formatting ---------- */

/** Accepts epoch ms, epoch seconds-ish numbers, ISO strings, Date; returns ms or 0. */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

export function fmtAgo(ts) {
  const ms = toMs(ts);
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`;
  if (d < 30 * 86400e3) return `${Math.floor(d / 86400e3)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function basename(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || String(p || '');
}

/** Electron wraps handler errors: "Error invoking remote method 'x': Error: message". Keep only the message. */
export function readableError(err) {
  let msg = (err && err.message) || String(err || '');
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Uncaught )?Error:\s*/, '').trim();
  return msg || 'Something went wrong.';
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/* ---------- generated covers ---------- */

export function coverVars(title) {
  let x = 2166136261;
  for (const ch of String(title)) {
    x ^= ch.codePointAt(0);
    x = Math.imul(x, 16777619) >>> 0;
  }
  const h1 = x % 360;
  const h2 = (h1 + 35 + ((x >>> 9) % 70)) % 360;
  const a = 120 + ((x >>> 17) % 120);
  return { h1, h2, a };
}

const SKIP_WORDS = new Set(['the', 'of', 'a', 'an', 'and', 'in', 'on', 'for', 'to']);
export function initials(title) {
  const clean = String(title).replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  const words = clean.match(/[\p{L}\p{N}]+/gu) || [];
  const sig = words.filter((w) => !SKIP_WORDS.has(w.toLowerCase()));
  const pick = (sig.length ? sig : words).slice(0, 2);
  let out = pick.map((w) => Array.from(w)[0]).join('');
  if (out.length < 2 && pick[0]) out = Array.from(pick[0]).slice(0, 2).join('');
  return (out || '?').toUpperCase();
}

/* ---------- toasts ---------- */

let toastHost = null;
export function mountToasts(el) { toastHost = el; }

export function toast({ kind = 'info', title, message, action, duration } = {}) {
  if (!toastHost) return;
  const ms = duration ?? (kind === 'error' ? 9000 : 4200);
  const ic = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info';
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 180);
  };
  const el = h('div', { class: `toast is-${kind}` },
    h('span', { class: 'toast-icon' }, icon(ic, 18)),
    h('div', { class: 'toast-text' },
      title ? h('div', { class: 'toast-title' }, title) : null,
      message ? h('div', { class: 'toast-msg' }, message) : null),
    action ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost toast-action', onClick: () => { close(); action.onClick(); } }, action.label) : null,
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss notification', onClick: close }, icon('x', 16)));
  toastHost.append(el);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  timer = setTimeout(close, ms);
  return close;
}

/* ---------- shared controls ---------- */

export function emptyState({ iconName = 'gamepad', title, body, actions = [] }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-art' }, icon(iconName, 34)),
    h('h2', { class: 'empty-title' }, title),
    body ? h('p', { class: 'empty-body' }, body) : null,
    actions.length ? h('div', { class: 'empty-actions' }, ...actions) : null);
}

/** Radiogroup rendered as a segmented control, with roving tabindex + arrow keys. */
export function segmented({ label, options, value, onChange }) {
  const root = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) => h('button', {
    type: 'button', class: 'seg', role: 'radio', dataset: { value: o.value },
    'aria-checked': o.value === value, tabindex: o.value === value ? 0 : -1,
    onClick: () => pick(o.value),
  }, o.label));
  function paint(v) {
    for (const b of btns) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  function pick(v) { paint(v); onChange(v); }
  root.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = btns[(i + step + btns.length) % btns.length];
    next.focus();
    pick(next.dataset.value);
  });
  root.append(...btns);
  root.set = paint;
  return root;
}

/** On/off switch (button role=switch). Label it via aria-labelledby. */
export function switchControl({ labelledBy, checked, onChange }) {
  const btn = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-labelledby': labelledBy, 'aria-checked': !!checked },
    h('span', { class: 'switch-thumb' }));
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  btn.set = (v) => btn.setAttribute('aria-checked', String(!!v));
  return btn;
}

/** Page header shared by every view. */
export function viewHead({ id, title, sub, actions }) {
  return h('header', { class: 'view-head' },
    h('div', { class: 'view-head-row' },
      h('div', { class: 'view-titles' },
        h('h1', { class: 'view-title', id }, title),
        sub || null),
      actions || null));
}
