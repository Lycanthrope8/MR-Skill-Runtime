'use strict';

/*
 * Parley provider — OpenAI-compatible BYOK gateway.
 *
 * Base URL: https://keys.theparley.org/v1
 * Auth:     Authorization: Bearer <PARLEY_API_KEY>
 *
 * Reasoning-model handling:
 *   GPT-5 and o-series models use `max_completion_tokens` instead of
 *   `max_tokens`, and reject non-default `temperature`. This adapter
 *   auto-detects by model id prefix and adjusts the request body.
 *   If the dashboard exposes other reasoning families later, add them
 *   to REASONING_PREFIXES.
 */

const { LLMProvider } = require('./base');
const log = require('../utils/logger');

const REASONING_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];

function isReasoningModel(modelId) {
  if (!modelId) return false;
  const low = modelId.toLowerCase();
  return REASONING_PREFIXES.some((p) => low.startsWith(p));
}

class ParleyProvider extends LLMProvider {
  constructor({ apiKey, baseUrl, model, maxOutputTokens, timeoutMs } = {}) {
    super('parley');
    if (!apiKey) throw new Error('ParleyProvider: PARLEY_API_KEY is required');
    if (!baseUrl) throw new Error('ParleyProvider: PARLEY_BASE_URL is required');
    if (!model) throw new Error('ParleyProvider: PARLEY_MODEL is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.maxOutputTokens = Number(maxOutputTokens) || 2048;
    this.timeoutMs = Number(timeoutMs) || 60000;
    this.reasoning = isReasoningModel(model);
    log.debug('parley: configured', {
      baseUrl: this.baseUrl,
      model: this.model,
      reasoning: this.reasoning,
      maxOutputTokens: this.maxOutputTokens,
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
    };

    // Output budget — different field for reasoning vs chat models.
    if (this.reasoning) {
      body.max_completion_tokens = maxOutput;
      // Do not send temperature for reasoning models — they reject non-default.
    } else {
      body.max_tokens = maxOutput;
      body.temperature = opts.temperature ?? 0;
    }

    // Force structured output. OpenAI-compatible response_format:
    //   { type: "json_object" } — model must return a JSON object.
    // Some providers ignore unknown fields; if Parley does, we fall back to
    // strict prompt-side instructions in promptBuilder.
    body.response_format = { type: 'json_object' };

    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      clearTimeout(t);
      if (e.name === 'AbortError') {
        throw new Error(`parley: request timed out after ${timeoutMs}ms`);
      }
      throw new Error(`parley: network error: ${e.message}`);
    }
    clearTimeout(t);
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch (_) {
        detail = '<no body>';
      }
      throw new Error(`parley: HTTP ${res.status} ${res.statusText} — ${detail}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`parley: response was not JSON: ${e.message}`);
    }

    const choice = data && data.choices && data.choices[0];
    if (!choice || !choice.message || typeof choice.message.content !== 'string') {
      throw new Error(`parley: unexpected response shape: ${JSON.stringify(data).slice(0, 400)}`);
    }

    return {
      text: choice.message.content,
      providerMeta: {
        provider: 'parley',
        model: this.model,
        reasoning: this.reasoning,
        latencyMs,
        finishReason: choice.finish_reason || null,
        usage: data.usage || null,
        id: data.id || null,
      },
    };
  }
}

module.exports = { ParleyProvider, isReasoningModel };
