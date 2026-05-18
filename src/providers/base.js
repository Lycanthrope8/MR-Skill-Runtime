'use strict';

/*
 * LLMProvider interface.
 *
 * All providers expose the same surface:
 *   - name        : identifier for audit records (e.g., "parley")
 *   - modelId()   : the specific model id the provider is configured to call
 *   - complete()  : turn a messages[] into a single string of model output
 *
 * Phase 2 ships only ParleyProvider. Future phases will add openai, anthropic,
 * gemini, vllm — all behind this same interface. Switching providers is a
 * one-line change in .env once the others are implemented.
 */

class LLMProvider {
  constructor(name) {
    if (this.constructor === LLMProvider) {
      throw new Error('LLMProvider is abstract; subclass it.');
    }
    this.name = name;
  }

  /** Returns the model id this provider is configured to call. */
  modelId() {
    throw new Error('modelId() not implemented');
  }

  /**
   * Send a chat-style request and return the raw string response.
   *
   * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
   * @param {object} [opts]                  - per-call overrides
   * @param {number} [opts.maxOutputTokens]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{text: string, providerMeta: object}>}
   */
  // eslint-disable-next-line no-unused-vars
  async complete(messages, opts = {}) {
    throw new Error('complete() not implemented');
  }
}

module.exports = { LLMProvider };
