'use strict';

/*
 * Local provider — OpenAI-compatible adapter for self-hosted LLMs.
 *
 * Works with any OpenAI-compatible chat-completions endpoint, including:
 *   - Ollama        (default — http://localhost:11434/v1)
 *   - llama.cpp     (./server --host 0.0.0.0 --port 8080 -> http://localhost:8080/v1)
 *   - LM Studio     (http://localhost:1234/v1)
 *   - vLLM          (http://localhost:8000/v1)
 *
 * Differences from ParleyProvider:
 *   - Authentication header is optional (most local servers don't require one).
 *   - No reasoning-model detection: local models use `max_tokens`, not
 *     `max_completion_tokens`, and accept `temperature`.
 *   - Some local servers don't honor `response_format: {type:"json_object"}`.
 *     We send it anyway because Ollama and recent llama.cpp do honor it; the
 *     promptBuilder's instruction to "return only JSON" remains the safety net.
 */

const { LLMProvider } = require('./base');
const log = require('../utils/logger');

class LocalProvider extends LLMProvider {
  constructor({ apiKey, baseUrl, model, maxOutputTokens, timeoutMs, temperature } = {}) {
    super('local');
    if (!baseUrl) throw new Error('LocalProvider: LOCAL_LLM_BASE_URL is required');
    if (!model) throw new Error('LocalProvider: LOCAL_LLM_MODEL is required');
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.maxOutputTokens = Number(maxOutputTokens) || 2048;
    this.timeoutMs = Number(timeoutMs) || 120000;          // local can be slow; default 2 min
    this.temperature = (temperature !== undefined && temperature !== '') ? Number(temperature) : 0.2;
    log.debug('local: configured', {
      baseUrl: this.baseUrl,
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
      temperature: this.temperature,
      auth: !!this.apiKey,
    });
  }

  modelId() {
    return this.model;
  }

  async complete(messages, opts = {}) {
    const maxOutput = Number(opts.maxOutputTokens) || this.maxOutputTokens;
    const timeoutMs = Number(opts.timeoutMs) || this.timeoutMs;

    const body = {
      model: this.model,
      messages,
      max_tokens: maxOutput,
      temperature: opts.temperature ?? this.temperature,
      // Many local servers honor this; ones that don't will ignore it.
      response_format: { type: 'json_object' },
      // Ollama-specific hint that's ignored elsewhere:
      stream: false,
    };

    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      clearTimeout(t);
      if (e.name === 'AbortError') {
        throw new Error(`local: request timed out after ${timeoutMs}ms (try a smaller model or raise LOCAL_LLM_TIMEOUT_MS)`);
      }
      throw new Error(`local: network error: ${e.message} (is the local server running at ${this.baseUrl}?)`);
    }
    clearTimeout(t);
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); }
      catch (_) { detail = '<no body>'; }
      throw new Error(`local: HTTP ${res.status} ${res.statusText} — ${detail}`);
    }

    let data;
    try { data = await res.json(); }
    catch (e) { throw new Error(`local: response was not JSON: ${e.message}`); }

    const choice = data && data.choices && data.choices[0];
    if (!choice || !choice.message || typeof choice.message.content !== 'string') {
      throw new Error(`local: unexpected response shape: ${JSON.stringify(data).slice(0, 400)}`);
    }

    return {
      text: choice.message.content,
      providerMeta: {
        provider: 'local',
        model: this.model,
        latencyMs,
        finishReason: choice.finish_reason || null,
        usage: data.usage || null,
        id: data.id || null,
      },
    };
  }
}

module.exports = { LocalProvider };
