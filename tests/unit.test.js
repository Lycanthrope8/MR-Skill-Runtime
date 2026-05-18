#!/usr/bin/env node
'use strict';

/*
 * tests/unit.test.js — offline tests for the Phase 2 runtime.
 *
 * No LLM is called. Verifies:
 *   - skillLoader reads MR-Skill-Assets correctly and computes manifest hash
 *   - promptBuilder progressive disclosure: L1 always, L2 on writes, L3 conditionally
 *   - outputParser: extractJson handles unfenced, ```json fenced, and prose-wrapped
 *   - outputParser: validateDecision accepts valid Decisions, rejects malformed
 *   - hash utility: deterministic, key-order independent
 *   - hash compatibility: hash_intent.js (asset side) and utils/hash.js (runtime) agree
 *
 * Run:
 *   node tests/unit.test.js
 *
 * Exit codes:
 *   0  all pass
 *   1  one or more failed
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { loadSkill } = require('../src/skillLoader');
const { buildMessages, classifyIntent } = require('../src/promptBuilder');
const { extractJson, validateDecision, parseAndValidate } = require('../src/outputParser');
const { hashText, hashJson, hashManifest, canonicalize } = require('../src/utils/hash');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; failures.push({ name, msg: e.message, stack: e.stack }); console.log(`  [FAIL] ${name}: ${e.message}`); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function bad(v, msg) { if (v) throw new Error(msg || 'expected falsy'); }

// Resolve a path for the MR-Skill-Assets checkout.
const SKILL_PATH = process.env.SKILL_ASSETS_PATH
  || path.resolve(__dirname, '..', '..', 'MR-Skill-Assets', 'spatial-governance-skill');

if (!fs.existsSync(SKILL_PATH)) {
  console.error(`error: skill path not found: ${SKILL_PATH}`);
  console.error('Set SKILL_ASSETS_PATH or place MR-Skill-Assets next to MR-Skill-Runtime.');
  process.exit(64);
}

console.log(`Loading skill from: ${SKILL_PATH}`);
let skill;
try { skill = loadSkill(SKILL_PATH); }
catch (e) { console.error(`skill load failed: ${e.message}`); process.exit(1); }

// =================== hash utility ===================
console.log('\n== hash utility ==');
t('hashText is deterministic', () => {
  eq(hashText('hello'), hashText('hello'));
});
t('hashJson key-order independent', () => {
  eq(hashJson({a: 1, b: 2}), hashJson({b: 2, a: 1}));
});
t('hashJson nested key-order independent', () => {
  eq(hashJson({a: {x: 1, y: 2}, b: 3}), hashJson({b: 3, a: {y: 2, x: 1}}));
});
t('canonicalize rejects non-finite numbers', () => {
  let threw = false;
  try { canonicalize(NaN); } catch (_) { threw = true; }
  ok(threw, 'NaN should throw');
});

// Cross-check against the asset-side script.
t('runtime hash matches asset-side hash_intent.js (text)', () => {
  const assetHashScript = path.join(SKILL_PATH, 'scripts', 'hash_intent.js');
  const r = spawnSync('node', [assetHashScript, '--text'], { input: 'register this anchor', encoding: 'utf8' });
  ok(r.status === 0, `asset script failed: ${r.stderr}`);
  const fromAsset = r.stdout.trim();
  const fromRuntime = hashText('register this anchor');
  eq(fromAsset, fromRuntime, 'asset and runtime hashes must match');
});

t('runtime manifest hash matches asset-side', () => {
  const assetHashScript = path.join(SKILL_PATH, 'scripts', 'hash_intent.js');
  const manifestPath = path.join(SKILL_PATH, 'manifest.json');
  const r = spawnSync('node', [assetHashScript, '--manifest', manifestPath], { encoding: 'utf8' });
  ok(r.status === 0, `asset script failed: ${r.stderr}`);
  const fromAsset = r.stdout.trim();
  eq(skill.skillManifestHash, fromAsset, 'manifest hashes must match');
});

// =================== skillLoader ===================
console.log('\n== skillLoader ==');
t('skill loaded with expected metadata', () => {
  eq(skill.skillId, 'spatial-governance-skill');
  eq(skill.skillVersion, '0.1.1');
  ok(/^sha256:[0-9a-f]{64}$/.test(skill.skillManifestHash));
});
t('seven known functions present', () => {
  const expected = ['ProposeAnchor','EndorseAnchor','ProposeRevocation','EndorseRevocation','QueryAnchor','QueryAnchorHistory','GetSnapshot'];
  for (const fn of expected) ok(skill.knownFunctions.has(fn), `missing function: ${fn}`);
});
t('all transaction schemas loaded', () => {
  ok(skill.schemas.ProposeAnchor, 'schemas.ProposeAnchor missing');
  ok(skill.schemas.GetSnapshot, 'schemas.GetSnapshot missing');
});
t('examples loaded', () => {
  ok(skill.examples.valid.length > 0);
  ok(skill.examples.adversarial.length > 0);
});
t('organizations present', () => {
  ok(skill.organizations.includes('Org1MSP'));
  ok(skill.organizations.includes('Org2MSP'));
});

// =================== promptBuilder ===================
console.log('\n== promptBuilder ==');
t('classifyIntent — write keywords detected', () => {
  ok(classifyIntent('register this anchor').isWrite);
  ok(classifyIntent('approve CLAIM_1').isWrite);
  ok(classifyIntent('revoke this').isWrite);
});
t('classifyIntent — read intent not flagged as write', () => {
  bad(classifyIntent('show me the snapshot').isWrite);
  bad(classifyIntent('what is the state of TAG_017').isWrite);
});

t('buildMessages requires orgMsp', () => {
  let threw = false;
  try { buildMessages(skill, { userText: 'x' }); } catch (_) { threw = true; }
  ok(threw, 'should reject missing orgMsp');
});
t('buildMessages rejects unknown org', () => {
  let threw = false;
  try { buildMessages(skill, { userText: 'x', orgMsp: 'Org3MSP' }); } catch (_) { threw = true; }
  ok(threw, 'should reject unknown org');
});

t('L2/L3/few-shot loaded for write intent', () => {
  const { messages, levelsLoaded } = buildMessages(skill, {
    userText: 'register this anchor',
    orgMsp: 'Org1MSP',
    context: { focusedAssetId: 'TAG_001' },
  });
  ok(levelsLoaded.includes('L2'), 'L2 must load on write');
  ok(levelsLoaded.includes('L3-lifecycle'));
  ok(levelsLoaded.includes('L3-schemas'));
  ok(levelsLoaded.includes('few-shot'));
  eq(messages.length, 2);
  eq(messages[0].role, 'system');
  ok(messages[0].content.includes('Approved function names') || messages[0].content.includes('Chaincode interface'));
});

t('only L1 for read-only intent (snapshot)', () => {
  const { levelsLoaded } = buildMessages(skill, {
    userText: 'show all anchors',
    orgMsp: 'Org2MSP',
    context: {},
  });
  eq(levelsLoaded, ['L1']);
});

t('orgMsp authority surfaced in system message', () => {
  const { messages } = buildMessages(skill, {
    userText: 'approve this',
    orgMsp: 'Org2MSP',
    context: {},
  });
  ok(messages[0].content.includes('Org2MSP'), 'orgMsp should appear in system message');
});

// =================== outputParser: extractJson ===================
console.log('\n== outputParser.extractJson ==');
const goodInvoke = {
  decisionType: 'INVOKE',
  intent: 'x',
  selectedChaincode: 'anchor-registry',
  selectedFunction: 'GetSnapshot',
  riskLevel: 'READ_ONLY',
  requiresConfirmation: false,
  arguments: {},
  policyReasoning: 'x',
  shouldInvoke: true,
};
t('extractJson — plain JSON', () => {
  eq(extractJson(JSON.stringify(goodInvoke)), goodInvoke);
});
t('extractJson — ```json fenced', () => {
  eq(extractJson('here is the result:\n```json\n' + JSON.stringify(goodInvoke) + '\n```\nthanks'), goodInvoke);
});
t('extractJson — wrapped in prose', () => {
  eq(extractJson('Thinking about this... ' + JSON.stringify(goodInvoke) + '\nDone.'), goodInvoke);
});
t('extractJson — unbalanced braces throws', () => {
  let threw = false;
  try { extractJson('{ "a": 1 '); } catch (_) { threw = true; }
  ok(threw);
});

// =================== outputParser: validateDecision ===================
console.log('\n== outputParser.validateDecision ==');
t('valid INVOKE GetSnapshot', () => {
  const v = validateDecision(goodInvoke, skill);
  ok(v.valid, JSON.stringify(v.errors));
});
t('rejects unknown function', () => {
  const bad1 = { ...goodInvoke, selectedFunction: 'ForceActivate', riskLevel: 'WRITE_GOVERNED', requiresConfirmation: true };
  const v = validateDecision(bad1, skill);
  bad(v.valid);
  ok(v.errors.some((e) => e.includes('ForceActivate')));
});
t('rejects bad assetId pattern in ProposeAnchor', () => {
  const bad2 = {
    decisionType: 'INVOKE', intent: 'x', selectedChaincode: 'anchor-registry',
    selectedFunction: 'ProposeAnchor', riskLevel: 'WRITE_GOVERNED', requiresConfirmation: true,
    arguments: { assetId: "TAG_017'; DROP TABLE--", poseHash: 'sha256:' + '0'.repeat(64), metadataHash: 'sha256:' + '1'.repeat(64) },
    policyReasoning: 'x', shouldInvoke: true,
  };
  const v = validateDecision(bad2, skill);
  bad(v.valid);
});
t('CLARIFY requires clarificationQuestion', () => {
  const bad3 = {
    decisionType: 'CLARIFY', intent: 'x', selectedChaincode: 'anchor-registry',
    selectedFunction: '', riskLevel: 'READ_ONLY', requiresConfirmation: false,
    arguments: {}, policyReasoning: 'x', shouldInvoke: false,
  };
  const v = validateDecision(bad3, skill);
  bad(v.valid);
  ok(v.errors.some((e) => e.toLowerCase().includes('clarificationquestion')));
});

t('parseAndValidate — end-to-end on prose-wrapped LLM output', () => {
  const out = 'Here is my decision:\n```json\n' + JSON.stringify(goodInvoke) + '\n```';
  const r = parseAndValidate(out, skill);
  ok(r.valid);
  eq(r.decision.selectedFunction, 'GetSnapshot');
});

// =================== Sweep all 50 intent_cases.json expected Decisions ===================
console.log('\n== sweep tests/intent_cases.json ==');
t('all 50 expected Decisions pass validation', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(SKILL_PATH, 'tests', 'intent_cases.json'), 'utf8')).cases;
  ok(cases.length === 50, `expected 50 cases, got ${cases.length}`);
  let failed = 0;
  for (const c of cases) {
    const v = validateDecision(c.expected, skill);
    if (!v.valid) { failed++; console.log(`     - ${c.id}: ${v.errors.join('; ')}`); }
  }
  eq(failed, 0, `${failed} cases failed validation`);
});

// =================== Final summary ===================
console.log('');
console.log('==================================================================');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('==================================================================');
if (fail) {
  console.log('\nFailure details:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.msg}`);
  process.exit(1);
}
process.exit(0);
