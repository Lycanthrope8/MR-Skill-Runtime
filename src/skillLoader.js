'use strict';

/*
 * skillLoader.js
 *
 * Reads a checkout of MR-Skill-Assets from SKILL_ASSETS_PATH, validates the
 * folder layout, indexes assets by disclosure level (1 / 2 / 3), and computes
 * skillManifestHash at startup.
 *
 * Per Phase 2 design decision: env-var sourcing only. No submodule logic.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const log = require('./utils/logger');
const { hashManifest } = require('./utils/hash');

/**
 * Load a skill from disk.
 *
 * @param {string} skillRoot - absolute path to e.g. "/.../MR-Skill-Assets/spatial-governance-skill"
 * @returns {object} skill descriptor (see properties below)
 */
function loadSkill(skillRoot) {
  if (!skillRoot) throw new Error('SKILL_ASSETS_PATH is required');
  const root = path.resolve(skillRoot);
  if (!fs.existsSync(root)) throw new Error(`skill path does not exist: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`skill path is not a directory: ${root}`);

  // -- Required top-level files
  const skillMdPath = path.join(root, 'SKILL.md');
  const manifestPath = path.join(root, 'manifest.json');
  for (const f of [skillMdPath, manifestPath]) {
    if (!fs.existsSync(f)) throw new Error(`required file missing: ${f}`);
  }

  const skillMd = fs.readFileSync(skillMdPath, 'utf8');
  const manifestRaw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const skillManifestHash = hashManifest(manifestRaw);

  // -- Assets directory
  const assetsDir = path.join(root, 'assets');
  if (!fs.existsSync(assetsDir)) throw new Error(`assets directory missing at ${assetsDir}`);

  // Read Level-2 assets — required for any write decision
  const chaincodeInterface = readJson(path.join(assetsDir, 'chaincode_interface.json'));
  const endorsementPolicy = readYaml(path.join(assetsDir, 'endorsement_policy.yaml'));

  // Level-3 assets — loaded conditionally
  const lifecycleRules = readText(path.join(assetsDir, 'lifecycle_rules.md'));
  const riskTiers = readYaml(path.join(assetsDir, 'risk_tiers.yaml'));

  // Transaction schemas — indexed by function name via the FUNCTION_SCHEMA_MAP
  // The asset's chaincode_interface.json already lists `schema: "transaction_schemas/..."`.
  const schemasDir = path.join(assetsDir, 'transaction_schemas');
  const schemas = {};
  for (const fn of chaincodeInterface.functions || []) {
    if (fn.schema) {
      const schemaPath = path.join(assetsDir, fn.schema);
      if (fs.existsSync(schemaPath)) {
        schemas[fn.name] = readJson(schemaPath);
      } else {
        log.warn('skillLoader: schema referenced in interface not found on disk', { fn: fn.name, schemaPath });
      }
    }
  }

  // Examples — opportunistic, used by promptBuilder for few-shot exemplars
  const examplesDir = path.join(assetsDir, 'examples');
  const examples = {
    valid: readJsonl(path.join(examplesDir, 'valid.jsonl')),
    ambiguous: readJsonl(path.join(examplesDir, 'ambiguous.jsonl')),
    adversarial: readJsonl(path.join(examplesDir, 'adversarial.jsonl')),
  };

  // Build a function-name set for cheap allowlist check downstream
  const knownFunctions = new Set((chaincodeInterface.functions || []).map((f) => f.name));

  const skill = {
    root,
    skillId: manifestRaw.skillId,
    skillVersion: manifestRaw.skillVersion,
    skillManifestHash,
    supportedChaincodes: (manifestRaw.supportedChaincodes || []).map((c) => c.name),
    organizations: manifestRaw.supportedOrganizations || [],

    skillMd,
    manifest: manifestRaw,

    chaincodeInterface,
    endorsementPolicy,
    lifecycleRules,
    riskTiers,
    schemas,
    examples,
    knownFunctions,
  };

  log.info('skill loaded', {
    skillId: skill.skillId,
    skillVersion: skill.skillVersion,
    skillManifestHash: skill.skillManifestHash,
    functions: Array.from(knownFunctions),
    root,
  });
  return skill;
}

// -- Tiny helpers
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function readYaml(p) {
  return yaml.load(fs.readFileSync(p, 'utf8'));
}
function readText(p) {
  return fs.readFileSync(p, 'utf8');
}
function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

module.exports = { loadSkill };
