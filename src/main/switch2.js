'use strict';
// Switch 1 vs Switch 2 title detection. Pure functions: no fs, no Electron. Inputs (file names and
// file bytes) are untrusted, so every parser is bounds-checked and never throws.
//
// Title IDs are 16 hex digits. Switch 1 titles start with 01, Switch 2 titles with 04.

const TITLE_ID_RE = /^[0-9A-Fa-f]{16}$/;
const BRACKETED_ID_RE = /\[([0-9A-Fa-f]{16})\]/g;

/** Bytes of an .nsp that the scanner reads for PFS0 parsing (header + entries + string table of real files fit easily). */
const PFS0_HEAD_BYTES = 65536;
const PFS0_MAX_FILES = 4096;
const PFS0_ENTRY_BYTES = 0x18;
const PFS0_HEADER_BYTES = 16;
const MAX_ANCESTORS = 3;

/**
 * @param {*} hex
 * @returns {'switch'|'switch2'|null} 'switch2' for 04xxxxxxxxxxxxxx, 'switch' for 01xxxxxxxxxxxxxx, else null
 */
function classifyTitleId(hex) {
  if (typeof hex !== 'string' || !TITLE_ID_RE.test(hex)) return null;
  const prefix = hex.slice(0, 2);
  if (prefix === '04') return 'switch2';
  if (prefix === '01') return 'switch';
  return null;
}

/**
 * First bracketed, classifiable title ID in a file or folder name, e.g. "Game [0400C3F00006E000].nsp".
 * @param {*} name
 * @returns {string|null} uppercased title ID
 */
function titleIdFromName(name) {
  if (typeof name !== 'string') return null;
  for (const m of name.matchAll(BRACKETED_ID_RE)) {
    const id = m[1].toUpperCase();
    if (classifyTitleId(id)) return id;
  }
  return null;
}

/**
 * Title ID from the file name, else from up to 3 ancestor folder names (nearest first).
 * Handles both "/" and "\\" separators regardless of host OS.
 * @param {*} p
 * @returns {string|null}
 */
function titleIdFromPath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const parts = p.split(/[\\/]/);
  const base = parts.pop();
  let id = titleIdFromName(base);
  if (id) return id;
  for (let i = 0; i < MAX_ANCESTORS && parts.length > 0; i++) {
    id = titleIdFromName(parts.pop());
    if (id) return id;
  }
  return null;
}

/**
 * Title ID from the head of an .nsp (PFS0 container) via the "<rightsId>.tik" entry; the rights ID is
 * titleId(16 hex) + keygen(16 hex).
 * @param {*} buf
 * @returns {string|null}
 */
function parsePfs0TitleId(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < PFS0_HEADER_BYTES) return null;
    if (buf.toString('latin1', 0, 4) !== 'PFS0') return null;
    const count = buf.readUInt32LE(4);
    const strSize = buf.readUInt32LE(8);
    if (count === 0 || count > PFS0_MAX_FILES) return null;
    const strStart = PFS0_HEADER_BYTES + count * PFS0_ENTRY_BYTES;
    if (strStart > buf.length || strSize > buf.length - strStart) return null;
    const strEnd = strStart + strSize;
    for (let i = 0; i < count; i++) {
      const nameOff = buf.readUInt32LE(PFS0_HEADER_BYTES + i * PFS0_ENTRY_BYTES + 16);
      const start = strStart + nameOff;
      if (nameOff >= strSize || start >= strEnd) continue;
      let end = start;
      while (end < strEnd && buf[end] !== 0 && end - start <= 64) end++;
      if (end - start !== 36) continue; // 32 hex + ".tik"
      const name = buf.toString('latin1', start, end);
      if (!/^[0-9A-Fa-f]{32}\.tik$/i.test(name)) continue;
      const id = name.slice(0, 16).toUpperCase();
      if (classifyTitleId(id)) return id;
    }
  } catch { /* malformed: fall through */ }
  return null;
}

/**
 * Decide which Switch generation a file belongs to. Name-based first, then PFS0 head bytes.
 * @param {{path?:string, head?:Buffer}} [info]
 * @returns {'switch'|'switch2'}
 */
function detectSwitchGeneration(info) {
  const { path: p, head } = info || {};
  let kind = classifyTitleId(titleIdFromPath(p));
  if (kind !== 'switch2' && Buffer.isBuffer(head)) {
    const fromHead = classifyTitleId(parsePfs0TitleId(head));
    if (fromHead === 'switch2') kind = fromHead;
  }
  return kind === 'switch2' ? 'switch2' : 'switch';
}

module.exports = { TITLE_ID_RE, PFS0_HEAD_BYTES, classifyTitleId, titleIdFromName, titleIdFromPath, parsePfs0TitleId, detectSwitchGeneration };
