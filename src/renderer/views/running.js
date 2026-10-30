import { h, icon, stripAnsi, fmtUptime, toMs, emptyState } from '../ui.js';
import { state, SYSTEMS, coreById, gameById, gameTitle, onLog, stopSession, dismissSession, setView } from '../state.js';

const MAX_DOM_LINES = 500;

export function createRunningView() {
  const panels = new Map(); // sessionId -> panel refs
  const list = h('div', { class: 'sessions' });
  const empty = emptyState({
    iconName: 'running',
    title: 'Nothing is running',
    body: 'Games you launch show up here with a live log and a Stop button.',
    actions: [h('button', { type: 'button', class: 'btn', onClick: () => setView('library') }, icon('library', 16), 'Back to Library')],
  });
  const sub = h('p', { class: 'view-sub' }, 'No active sessions');
  const body = h('div', { class: 'view-body' }, list, empty);
  const el = h('section', { class: 'view', 'aria-labelledby': 'run-title' },
    h('header', { class: 'view-head' }, h('div', { class: 'view-head-row' }, h('div', { class: 'view-titles' }, h('h1', { class: 'view-title', id: 'run-title' }, 'Running'), sub))),
    body);

  function buildPanel(s) {
    const title = h('h2', { class: 'session-title' });
    const meta = h('p', { class: 'session-meta' });
    const uptime = h('span', { class: 'session-uptime', 'aria-label': 'Uptime' });
    const status = h('span', { class: 'status-pill' });
    const action = h('button', { type: 'button', class: 'btn btn-sm' });
    const log = h('div', { class: 'log', role: 'log', 'aria-live': 'off', tabindex: 0 });
    const jump = h('button', { type: 'button', class: 'btn btn-sm jump', hidden: true }, icon('down', 14), 'Latest');
    const panel = { s, title, meta, uptime, status, action, log, jump, stick: true, queue: [], raf: 0, domLines: 0 };

    log.addEventListener('scroll', () => {
      panel.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
      jump.hidden = panel.stick;
    });
    jump.addEventListener('click', () => { panel.stick = true; jump.hidden = true; log.scrollTop = log.scrollHeight; log.focus(); });
    action.addEventListener('click', () => (panel.s.exited ? dismissSession(panel.s.sessionId) : stopSession(panel.s.sessionId)));

    panel.el = h('article', { class: 'session', dataset: { id: s.sessionId } },
      h('div', { class: 'session-head' },
        h('div', { class: 'session-id' }, title, meta),
        h('div', { class: 'session-side' }, uptime, status, action)),
      h('div', { class: 'log-wrap' }, log, jump));
    for (const line of s.lines) addLine(panel, line);
    flush(panel);
    return panel;
  }

  function addLine(panel, text) {
    panel.queue.push(text);
    if (!panel.raf) panel.raf = requestAnimationFrame(() => flush(panel));
  }

  function flush(panel) {
    panel.raf = 0;
    if (!panel.queue.length) return;
    const frag = document.createDocumentFragment();
    for (const raw of panel.queue) {
      const text = stripAnsi(raw);
      const cls = /\b(error|fatal|panic|exception|failed)\b/i.test(text) ? ' is-error' : /\bwarn(ing)?\b/i.test(text) ? ' is-warn' : '';
      frag.append(h('div', { class: `log-line${cls}` }, text));
    }
    panel.domLines += panel.queue.length;
    panel.queue = [];
    panel.log.append(frag);
    while (panel.domLines > MAX_DOM_LINES && panel.log.firstChild) { panel.log.removeChild(panel.log.firstChild); panel.domLines--; }
    if (panel.stick) panel.log.scrollTop = panel.log.scrollHeight;
  }

  function paint(panel) {
    const s = panel.s;
    const game = gameById(s.gameId);
    const core = coreById(s.coreId);
    const sys = game && SYSTEMS[game.system];
    panel.title.textContent = s.gameId ? gameTitle(s.gameId) : 'Starting…';
    panel.meta.textContent = [core ? core.name : s.coreId, sys ? sys.short : '', s.pid ? `PID ${s.pid}` : ''].filter(Boolean).join(' · ');
    panel.log.setAttribute('aria-label', `Log output for ${panel.title.textContent}`);
    panel.el.classList.toggle('is-exited', s.exited);
    panel.status.className = `status-pill ${s.exited ? (s.code ? 'is-danger' : 'is-muted') : s.stopping ? 'is-warn' : 'is-ok'}`;
    panel.status.textContent = s.exited ? `Exited${s.code === null ? '' : ` · code ${s.code}`}` : s.stopping ? 'Stopping…' : 'Running';
    panel.action.replaceChildren(...(s.exited ? [icon('x', 14), 'Dismiss'] : [icon('stop', 14), s.stopping ? 'Stopping' : 'Stop']));
    panel.action.classList.toggle('btn-stop', !s.exited);
    panel.action.setAttribute('aria-disabled', String(!s.exited && s.stopping));
    panel.action.setAttribute('aria-label', s.exited ? `Dismiss ${panel.title.textContent}` : `Stop ${panel.title.textContent}`);
    tickPanel(panel);
  }

  function tickPanel(panel) {
    const s = panel.s;
    const start = toMs(s.startedAt);
    panel.uptime.textContent = start ? fmtUptime((s.endedAt || Date.now()) - start) : '–:––';
  }

  function render() {
    const sessions = [...state.sessions.values()].sort((a, b) => (toMs(b.startedAt) || Infinity) - (toMs(a.startedAt) || Infinity));
    for (const [id, p] of panels) if (!state.sessions.has(id)) { cancelAnimationFrame(p.raf); p.el.remove(); panels.delete(id); }
    sessions.forEach((s, i) => {
      let p = panels.get(s.sessionId);
      if (!p) { p = buildPanel(s); panels.set(s.sessionId, p); }
      p.s = s;
      paint(p);
      if (list.children[i] !== p.el) list.insertBefore(p.el, list.children[i] || null);
      if (p.stick) p.log.scrollTop = p.log.scrollHeight;
    });
    const active = sessions.filter((s) => !s.exited).length;
    sub.textContent = sessions.length ? `${active} active ${active === 1 ? 'session' : 'sessions'}` : 'No active sessions';
    empty.hidden = sessions.length > 0;
    list.hidden = sessions.length === 0;
  }

  onLog((sessionId, line) => {
    const p = panels.get(sessionId);
    if (p) addLine(p, line);
  });

  return {
    el,
    topics: ['sessions', 'library'],
    alwaysRender: true, // keeps log DOM current while another view is showing
    render,
    tick() { if (!el.hidden) for (const p of panels.values()) if (!p.s.exited) tickPanel(p); },
  };
}
