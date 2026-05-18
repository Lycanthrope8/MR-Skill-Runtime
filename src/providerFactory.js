'use strict';

const { ParleyProvider } = require('./providers/parley');

function buildProvider(env = process.env) {
  const name = (env.LLM_PROVIDER || 'parley').toLowerCase();
  if (name === 'parley') {
    return new ParleyProvider({
      apiKey: env.PARLEY_API_KEY,
      baseUrl: env.PARLEY_BASE_URL,
      model: env.PARLEY_MODEL,
      maxOutputTokens: env.PARLEY_MAX_OUTPUT_TOKENS,
      timeoutMs: env.PARLEY_TIMEOUT_MS,
    });
  }
  throw new Error(`unknown LLM_PROVIDER: ${name} (phase 2 supports only "parley")`);
}

module.exports = { buildProvider };
