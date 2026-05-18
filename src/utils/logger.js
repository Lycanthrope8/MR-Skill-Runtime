'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, extra) {
  if (LEVELS[level] < CURRENT) return;
  const stamp = new Date().toISOString();
  let line = `${stamp} [${level}] ${msg}`;
  if (extra !== undefined) {
    try {
      line += ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    } catch (_) {
      line += ` <unserializable>`;
    }
  }
  process.stderr.write(line + '\n');
}

module.exports = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
};
