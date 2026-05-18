'use strict';

/*
 * interpret.js
 *
 * The core pipeline that turns a request into a validated Decision.
 * Used by both the CLI (one-off) and the server (Phase 4 will wire to gateway).
 *
 *   request → promptBuilder → LLMProvider → outputParser → Decision
 *
 * Adds runtime metadata that audit chaincode will eventually consume:
 *   - skillVersion, skillManifestHash
 *   - intentHash, contextHash, argumentHash
 *   - LLM provider, model, latency, finish_reason
 */

const { buildMessages } = require('./promptBuilder');
const { parseAndValidate } = require('./outputParser');
const { hashText, hashJson } = require('./utils/hash');
const log = require('./utils/logger');

/**
 * @param {object} skill    - from skillLoader
 * @param {object} provider - LLMProvider instance
 * @param {object} request  - { userText, orgMsp, context }
 * @returns {Promise<object>} envelope with decision + audit metadata
 */
async function interpret(skill, provider, request) {
  const t0 = Date.now();
  const intentHash = hashText(request.userText || '');
  const contextHash = hashJson(request.context || {});

  let messages, levelsLoaded, tokenEstimate;
  try {
    ({ messages, levelsLoaded, tokenEstimate } = buildMessages(skill, request));
  } catch (e) {
    return errorEnvelope(skill, provider, request, intentHash, contextHash, t0, [`promptBuilder: ${e.message}`]);
  }

  let llmResult;
  try {
    llmResult = await provider.complete(messages);
  } catch (e) {
    log.warn('interpret: LLM call failed', { error: e.message });
    return errorEnvelope(skill, provider, request, intentHash, contextHash, t0, [`llm: ${e.message}`]);
  }

  const parsed = parseAndValidate(llmResult.text, skill);
  const decision = parsed.decision;
  const argumentHash = decision && decision.arguments ? hashJson(decision.arguments) : hashJson({});

  const envelope = {
    ok: parsed.valid,
    errors: parsed.valid ? [] : parsed.errors,
    decision,
    audit: {
      skillId: skill.skillId,
      skillVersion: skill.skillVersion,
      skillManifestHash: skill.skillManifestHash,
      llmProvider: provider.name,
      llmModel: provider.modelId(),
      llmCallId: llmResult.providerMeta && llmResult.providerMeta.id,
      llmFinishReason: llmResult.providerMeta && llmResult.providerMeta.finishReason,
      llmUsage: llmResult.providerMeta && llmResult.providerMeta.usage,
      intentHash,
      contextHash,
      argumentHash,
      orgMsp: request.orgMsp,
      tokenEstimate,
      levelsLoaded,
      llmLatencyMs: llmResult.providerMeta && llmResult.providerMeta.latencyMs,
      totalLatencyMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    },
  };
  return envelope;
}

function errorEnvelope(skill, provider, request, intentHash, contextHash, t0, errors) {
  return {
    ok: false,
    errors,
    decision: null,
    audit: {
      skillId: skill.skillId,
      skillVersion: skill.skillVersion,
      skillManifestHash: skill.skillManifestHash,
      llmProvider: provider.name,
      llmModel: provider.modelId(),
      intentHash,
      contextHash,
      argumentHash: hashJson({}),
      orgMsp: request.orgMsp,
      totalLatencyMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    },
  };
}

module.exports = { interpret };
