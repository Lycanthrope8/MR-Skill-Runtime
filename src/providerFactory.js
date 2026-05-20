'use strict';

const { ParleyProvider } = require('./providers/parley');
const { LocalProvider } = require('./providers/local');

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

  if (name === 'local') {
    return new LocalProvider({
      apiKey: env.LOCAL_LLM_API_KEY,             // optional; Ollama doesn't need one
      baseUrl: env.LOCAL_LLM_BASE_URL,           // e.g. http://localhost:11434/v1
      model: env.LOCAL_LLM_MODEL,                // e.g. qwen2.5:7b-instruct-q4_K_M
      maxOutputTokens: env.LOCAL_LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: env.LOCAL_LLM_TIMEOUT_MS,
      temperature: env.LOCAL_LLM_TEMPERATURE,
    });
  }

  throw new Error(`unknown LLM_PROVIDER: ${name} (supported: parley, local)`);
}

module.exports = { buildProvider };
