'use strict';
// Running-game registry: spawn (no shell), line-buffered log streaming, ring buffer, stop/kill.
// No Electron dependency; spawn/emit/clock are injectable for tests.
const childProcess = require('child_process');
const crypto = require('crypto');

const MAX_LOG_LINES = 500;
const MAX_LINE_LEN = 4000;
const FLUSH_INTERVAL_MS = 50;
const MAX_LINES_PER_FLUSH = 100;
const MAX_QUEUE = 1000;
const KILL_GRACE_MS = 5000;
// env accepted from adapters (never from the renderer). Anything else is ignored.
const ENV_ALLOWLIST = Object.freeze(['WINEPREFIX', 'WINEDEBUG', 'WINEDLLOVERRIDES']);
const MAX_ENV_VALUE_LEN = 4096;
// After the child exits, wait this long for its stdio to close before reporting the exit anyway.
// wine leaves a `wineserver` behind that inherits the pipes for a few seconds, which delays 'close'.
const EXIT_CLOSE_GRACE_MS = 1500;

/** Validate an adapter-supplied env object against the allowlist. Returns a plain object (maybe empty). */
function sanitizeEnv(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) throw new Error('env must be an object');
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) continue;
    const v = env[key];
    if (typeof v !== 'string' || v.includes('\0') || v.length > MAX_ENV_VALUE_LEN) throw new Error(`Invalid value for env ${key}`);
    out[key] = v;
  }
  return out;
}

/** Inherited environment minus loader-injection variables (used only for env-carrying wine launches). */
function inheritedEnvForWine(base) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === 'WINELOADER' || k.startsWith('DYLD_') || k.startsWith('LD_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * @param {{spawn?:Function, emit?:(ev:object)=>void, now?:()=>number, killGraceMs?:number, flushIntervalMs?:number, exitCloseGraceMs?:number}} [opts]
 */
function createProcessManager(opts = {}) {
  const spawn = opts.spawn || childProcess.spawn;
  const emit = opts.emit || (() => {});
  const now = opts.now || Date.now;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const exitCloseGraceMs = opts.exitCloseGraceMs ?? EXIT_CLOSE_GRACE_MS;
  /** @type {Map<string, object>} */
  const sessions = new Map();

  function safeEmit(ev) {
    try { emit(ev); } catch { /* window may be gone */ }
  }

  function pushLine(s, line) {
    if (line.length > MAX_LINE_LEN) line = `${line.slice(0, MAX_LINE_LEN)}…`;
    s.log.push(line);
    if (s.log.length > MAX_LOG_LINES) s.log.shift();
    s.queue.push(line);
    if (s.queue.length > MAX_QUEUE) {
      s.dropped += s.queue.length - MAX_QUEUE;
      s.queue.splice(0, s.queue.length - MAX_QUEUE);
    }
    scheduleFlush(s);
  }

  function scheduleFlush(s) {
    if (s.timer) return;
    s.timer = setTimeout(() => { s.timer = null; flush(s); }, flushIntervalMs);
    if (s.timer.unref) s.timer.unref();
  }

  function flush(s, all = false) {
    if (s.dropped > 0) {
      safeEmit({ type: 'log', sessionId: s.sessionId, line: `[uemulator] ${s.dropped} log lines skipped (output too fast)` });
      s.dropped = 0;
    }
    const n = all ? s.queue.length : Math.min(s.queue.length, MAX_LINES_PER_FLUSH);
    for (const line of s.queue.splice(0, n)) safeEmit({ type: 'log', sessionId: s.sessionId, line });
    if (s.queue.length > 0) scheduleFlush(s);
  }

  function attach(s, stream) {
    if (!stream) return;
    let buf = '';
    stream.setEncoding && stream.setEncoding('utf8');
    const onData = (chunk) => {
      if (s.exited) return;
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) pushLine(s, line);
      if (buf.length > 8192) { pushLine(s, buf); buf = ''; } // no newline in sight; avoid unbounded growth
    };
    const end = () => { if (s.exited) return; if (buf) { pushLine(s, buf); buf = ''; } };
    stream.on('data', onData);
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', () => {});
    // Called by finish(): emit the leftover partial line, then drop the listeners so nothing arrives after 'exit'.
    s.detachers.push(() => {
      if (buf) { pushLine(s, buf); buf = ''; }
      stream.removeListener('data', onData);
      stream.removeListener('end', end);
      stream.removeListener('close', end);
    });
  }

  /**
   * Spawn a game. Resolves with {pid, sessionId} once the process actually started;
   * rejects with a readable Error if it could not be spawned.
   */
  function start({ gameId, coreId, command, args, env }) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        const spawnOpts = { shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] };
        const extra = sanitizeEnv(env);
        if (Object.keys(extra).length > 0) spawnOpts.env = { ...inheritedEnvForWine(process.env), ...extra };
        child = spawn(command, args, spawnOpts);
      } catch (err) {
        reject(new Error(`Could not start ${coreId}: ${err.message}`));
        return;
      }
      const s = {
        sessionId: crypto.randomUUID(), gameId, coreId, child, pid: child.pid,
        startedAt: now(), log: [], queue: [], dropped: 0, timer: null, killTimer: null, exitTimer: null, exited: false, started: false, detachers: [],
      };

      // `on`, not `once`: a later error (e.g. EPERM from child.kill()) must never become an uncaught exception.
      let rejected = false;
      child.on('error', (err) => {
        if (!s.started) {
          if (rejected) return; // settle the start() promise only once
          rejected = true;
          reject(new Error(`Could not start ${coreId}: ${err && err.code === 'ENOENT' ? 'executable not found' : (err && err.message)}`));
        } else {
          try { pushLine(s, `[uemulator] process error: ${err && err.message}`); } catch { /* never throw from an error handler */ }
        }
      });
      child.once('spawn', () => {
        s.started = true;
        s.pid = child.pid;
        sessions.set(s.sessionId, s);
        resolve({ pid: s.pid, sessionId: s.sessionId });
      });
      attach(s, child.stdout);
      attach(s, child.stderr);

      // 'close' fires once stdio is drained; 'exit' fires when the process ends. A lingering grandchild
      // (wineserver) can hold the pipes open, so 'exit' also arms a short fallback to finish the session.
      const finish = (code, signal) => {
        if (s.exited) return;
        s.exited = true;
        if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
        if (s.exitTimer) { clearTimeout(s.exitTimer); s.exitTimer = null; }
        if (!s.started) { if (s.timer) { clearTimeout(s.timer); s.timer = null; } return; } // spawn failure already rejected
        // Flush each stream's partial line and detach its listeners BEFORE exit, so no 'log' can follow 'exit'.
        for (const detach of s.detachers) { try { detach(); } catch { /* ignore */ } }
        s.detachers = [];
        if (s.timer) { clearTimeout(s.timer); s.timer = null; }
        for (const st of [child.stdout, child.stderr]) { try { if (st && !st.destroyed && st.destroy) st.destroy(); } catch { /* ignore */ } }
        flush(s, true);
        sessions.delete(s.sessionId);
        safeEmit({ type: 'exit', sessionId: s.sessionId, code: typeof code === 'number' ? code : null, signal: signal || null });
      };
      child.once('close', finish);
      child.once('exit', (code, signal) => {
        if (s.exited || s.exitTimer) return;
        s.exitTimer = setTimeout(() => { s.exitTimer = null; finish(code, signal); }, exitCloseGraceMs);
        if (s.exitTimer.unref) s.exitTimer.unref();
      });
    });
  }

  function terminate(s) {
    if (s.exited) return;
    try { s.child.kill('SIGTERM'); } catch { /* already gone */ }
    if (!s.killTimer) {
      s.killTimer = setTimeout(() => {
        s.killTimer = null;
        if (!s.exited) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } }
      }, killGraceMs);
      if (s.killTimer.unref) s.killTimer.unref();
    }
  }

  /** SIGTERM, then SIGKILL after the grace period. @returns {boolean} whether the session existed */
  function stop(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    terminate(s);
    return true;
  }

  function list() {
    return [...sessions.values()].map((s) => ({
      sessionId: s.sessionId, gameId: s.gameId, coreId: s.coreId, pid: s.pid, startedAt: s.startedAt,
    }));
  }

  function getLog(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.log.slice() : [];
  }

  /** Terminate every child (app quit). Resolves when all have exited or after timeoutMs (then SIGKILL). */
  function killAll(timeoutMs = 3000) {
    const live = [...sessions.values()];
    if (live.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearInterval(poll);
        clearTimeout(limit);
        resolve();
      };
      for (const s of live) terminate(s);
      const poll = setInterval(() => { if (live.every((s) => s.exited)) done(); }, 50);
      const limit = setTimeout(() => {
        for (const s of live) if (!s.exited) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } }
        done();
      }, timeoutMs);
    });
  }

  return { start, stop, list, getLog, killAll, get size() { return sessions.size; } };
}

module.exports = { createProcessManager, MAX_LOG_LINES, ENV_ALLOWLIST, sanitizeEnv };
