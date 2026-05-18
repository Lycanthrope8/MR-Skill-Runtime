'use strict';

/*
 * Canonical SHA-256 hashing utility.
 *
 * Mirrors MR-Skill-Assets/spatial-governance-skill/scripts/hash_intent.js so
 * that intent / context / argument / manifest hashes match byte-for-byte
 * between the asset-side authoring tool and the runtime.
 *
 * Canonicalization rules (same as the asset-side script):
 *   - Strings: NFC-normalized, trimmed. Optional lowercase for text hashing.
 *   - Objects: keys sorted lexicographically, recursively canonicalized.
 *   - Arrays: order preserved.
 *   - No whitespace, no indentation, UTF-8.
 */

const crypto = require('crypto');

function nfc(s) {
  return typeof s.normalize === 'function' ? s.normalize('NFC') : s;
}

function canonicalize(value, { lowercase = false } = {}) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be canonicalized');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    let s = nfc(value.trim());
    if (lowercase) s = s.toLowerCase();
    return JSON.stringify(s);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v, { lowercase })).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k], { lowercase })}`)
      .join(',');
    return `{${body}}`;
  }
  throw new Error(`unsupported type: ${typeof value}`);
}

function sha256Hex(input) {
  return `sha256:${crypto.createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

function hashText(text, { lowercase = false } = {}) {
  return sha256Hex(canonicalize(String(text), { lowercase }));
}

function hashJson(obj) {
  return sha256Hex(canonicalize(obj));
}

function hashManifest(manifestObj) {
  // Strip a previously-stored manifestHash, mirroring the asset-side script.
  const copy = { ...manifestObj };
  delete copy.manifestHash;
  return sha256Hex(canonicalize(copy));
}

module.exports = { canonicalize, sha256Hex, hashText, hashJson, hashManifest };
