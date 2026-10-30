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

/**
 * @param {{spawn?:Function, emit?:(ev:object)=>void, now?:()=>number, killGraceMs?:number, flushIntervalMs?:number}} [opts]
 */
function createProcessManager(opts = {}) {
  const spawn = opts.spawn || childProcess.spawn;
  const emit = opts.emit || (() => {});
  const now = opts.now || Date.now;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
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
    stream.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) pushLine(s, line);
      if (buf.length > 8192) { pushLine(s, buf); buf = ''; } // no newline in sight; avoid unbounded growth
    });
    const end = () => { if (buf) { pushLine(s, buf); buf = ''; } };
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', () => {});
  }

  /**
   * Spawn a game. Resolves with {pid, sessionId} once the process actually started;
   * rejects with a readable Error if it could not be spawned.
   */
  function start({ gameId, coreId, command, args }) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, { shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(new Error(`Could not start ${coreId}: ${err.message}`));
        return;
      }
      const s = {
        sessionId: crypto.randomUUID(), gameId, coreId, child, pid: child.pid,
        startedAt: now(), log: [], queue: [], dropped: 0, timer: null, killTimer: null, exited: false, started: false,
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

      child.once('close', (code, signal) => {
        s.exited = true;
        if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
        if (s.timer) { clearTimeout(s.timer); s.timer = null; }
        if (!s.started) return; // spawn failure already rejected
        flush(s, true);
        sessions.delete(s.sessionId);
        safeEmit({ type: 'exit', sessionId: s.sessionId, code: typeof code === 'number' ? code : null, signal: signal || null });
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

module.exports = { createProcessManager, MAX_LOG_LINES };
