#!/usr/bin/env node
'use strict';

/*
 * server.js — Express server exposing the runtime over HTTP.
 *
 * Endpoints (Phase 2 scope):
 *   GET  /health              — liveness + skillManifestHash banner
 *   POST /skills/interpret    — full pipeline (will be called by the gateway in Phase 4)
 *
 * The server runs on the edge box next to YOLOv11Server. It holds NO Fabric
 * credentials. Phase 4 will add the gateway-side handler that calls this
 * service and then writes the audit record + invokes anchor-registry chaincode.
 */

require('dotenv').config();
const express = require('express');
const { loadSkill } = require('./skillLoader');
const { buildProvider } = require('./providerFactory');
const { interpret } = require('./interpret');
const log = require('./utils/logger');

const skillPath = process.env.SKILL_ASSETS_PATH;
if (!skillPath) {
  console.error('error: SKILL_ASSETS_PATH is not set');
  process.exit(1);
}
const skill = loadSkill(skillPath);
const provider = buildProvider(process.env);

const app = express();
app.use(express.json({ limit: '128kb' }));

// Minimal request-id middleware so logs cross-reference.
app.use((req, res, next) => {
  req.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader('X-Request-Id', req.id);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'mr-skill-runtime',
    skillId: skill.skillId,
    skillVersion: skill.skillVersion,
    skillManifestHash: skill.skillManifestHash,
    llmProvider: provider.name,
    llmModel: provider.modelId(),
    organizations: skill.organizations,
    functions: Array.from(skill.knownFunctions),
  });
});

app.post('/skills/interpret', async (req, res) => {
  const body = req.body || {};
  const { userText, orgMsp, context } = body;

  if (typeof userText !== 'string' || !userText.trim()) {
    return res.status(400).json({ ok: false, errors: ['userText is required'] });
  }
  if (!orgMsp || typeof orgMsp !== 'string') {
    return res.status(400).json({ ok: false, errors: ['orgMsp is required (gateway-bound)'] });
  }
  if (!skill.organizations.includes(orgMsp)) {
    return res.status(400).json({ ok: false, errors: [`orgMsp "${orgMsp}" not in supported organizations`] });
  }

  log.info('interpret request', { id: req.id, orgMsp, userText: userText.slice(0, 80) });
  let envelope;
  try {
    envelope = await interpret(skill, provider, {
      userText,
      orgMsp,
      context: context || {},
    });
  } catch (e) {
    log.error('interpret crashed', { id: req.id, error: e.message });
    return res.status(500).json({ ok: false, errors: [`pipeline: ${e.message}`] });
  }
  log.info('interpret response', {
    id: req.id,
    ok: envelope.ok,
    decisionType: envelope.decision && envelope.decision.decisionType,
    function: envelope.decision && envelope.decision.selectedFunction,
    latencyMs: envelope.audit.totalLatencyMs,
  });
  res.status(envelope.ok ? 200 : 422).json(envelope);
});

const port = Number(process.env.PORT) || 5100;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  log.info('mr-skill-runtime listening', {
    host,
    port,
    skillId: skill.skillId,
    skillVersion: skill.skillVersion,
    skillManifestHash: skill.skillManifestHash,
    llmProvider: provider.name,
    llmModel: provider.modelId(),
  });
  // Also print the banner to stdout for human eyes.
  console.log(`mr-skill-runtime  http://${host}:${port}`);
  console.log(`  skill           : ${skill.skillId} v${skill.skillVersion}`);
  console.log(`  manifest hash   : ${skill.skillManifestHash}`);
  console.log(`  llm provider    : ${provider.name}`);
  console.log(`  llm model       : ${provider.modelId()}`);
});
