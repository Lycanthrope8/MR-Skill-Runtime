#!/usr/bin/env node
'use strict';

/*
 * run_intent_eval.js
 *
 * Phase 2 exit-criterion runner. Loads tests/intent_cases.json from the
 * MR-Skill-Assets checkout, runs each case through the full pipeline, and
 * reports:
 *
 *   - function-selection accuracy        (the exit-criterion metric, target ≥80%)
 *   - decisionType-classification accuracy
 *   - per-category accuracy
 *   - valid-JSON rate (envelopes where ok=true)
 *   - latency p50/p95
 *   - per-case results (jsonl artifact for later analysis)
 *
 * Reads concurrency from --concurrency or env EVAL_CONCURRENCY (default 4).
 * Writes results under eval/results/<timestamp>/.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadSkill } = require('../src/skillLoader');
const { buildProvider } = require('../src/providerFactory');
const { interpret } = require('../src/interpret');
const log = require('../src/utils/logger');

function parseArgs(argv) {
  const opts = { concurrency: Number(process.env.EVAL_CONCURRENCY || 4), limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--cases') opts.casesPath = argv[++i];
    else if (a === '--out') opts.outDir = argv[++i];
  }
  return opts;
}

function pctile(sortedNums, p) {
  if (!sortedNums.length) return 0;
  const idx = Math.min(sortedNums.length - 1, Math.floor((p / 100) * sortedNums.length));
  return sortedNums[idx];
}

async function runOne(skill, provider, c) {
  const t0 = Date.now();
  const env = await interpret(skill, provider, c.input);
  return {
    id: c.id,
    category: c.category || (c.id && c.id.includes('clarify') ? 'ambiguous' : c.id && c.id.includes('adv') ? 'adversarial' : 'valid'),
    expected: c.expected,
    actual: env.decision,
    ok: env.ok,
    errors: env.errors,
    latencyMs: Date.now() - t0,
    audit: env.audit,
  };
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    while (true) {
      const j = i++;
      if (j >= tasks.length) return;
      try {
        out[j] = await tasks[j]();
      } catch (e) {
        out[j] = { error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const skillPath = process.env.SKILL_ASSETS_PATH;
  if (!skillPath) {
    console.error('error: SKILL_ASSETS_PATH is not set');
    process.exit(64);
  }
  const skill = loadSkill(skillPath);

  // Locate cases file. Default: SKILL_ASSETS_PATH/tests/intent_cases.json.
  const casesPath = opts.casesPath || path.join(skillPath, 'tests', 'intent_cases.json');
  if (!fs.existsSync(casesPath)) {
    console.error(`error: cases file not found: ${casesPath}`);
    process.exit(64);
  }
  const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases || [];
  const cases = allCases.slice(0, opts.limit);

  const provider = buildProvider(process.env);

  // Output directory
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.outDir || path.join(__dirname, 'results', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Running ${cases.length} cases  concurrency=${opts.concurrency}  provider=${provider.name}  model=${provider.modelId()}`);
  console.log(`Output: ${outDir}`);

  const tasks = cases.map((c) => () => runOne(skill, provider, c));
  const t0 = Date.now();
  const results = await pool(tasks, opts.concurrency);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  // ---- Score
  let okEnvelope = 0;
  let dtCorrect = 0;
  let fnCorrect = 0;
  const byCat = {};
  const latencies = [];
  const perCase = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const c = cases[i];
    if (!r) { perCase.push({ id: c.id, error: 'no result' }); continue; }
    if (r.error) { perCase.push({ id: c.id, error: r.error }); continue; }
    if (r.ok) okEnvelope++;
    if (r.latencyMs) latencies.push(r.latencyMs);

    const cat = r.category;
    byCat[cat] = byCat[cat] || { total: 0, dt: 0, fn: 0, ok: 0 };
    byCat[cat].total++;
    if (r.ok) byCat[cat].ok++;

    const dtMatch = r.actual && r.actual.decisionType === r.expected.decisionType;
    if (dtMatch) { dtCorrect++; byCat[cat].dt++; }

    // Function-selection accuracy:
    //   For INVOKE expected: exact match on selectedFunction
    //   For REJECT/CLARIFY expected: function field should be "" or not in known set
    let fnMatch = false;
    if (r.actual) {
      if (r.expected.decisionType === 'INVOKE') {
        fnMatch = r.actual.selectedFunction === r.expected.selectedFunction;
      } else {
        fnMatch = (!r.actual.selectedFunction || r.actual.selectedFunction === '' || r.actual.decisionType !== 'INVOKE');
      }
    }
    if (fnMatch) { fnCorrect++; byCat[cat].fn++; }

    perCase.push({
      id: c.id,
      category: cat,
      expected_decisionType: r.expected.decisionType,
      actual_decisionType: r.actual && r.actual.decisionType,
      expected_function: r.expected.selectedFunction || '',
      actual_function: (r.actual && r.actual.selectedFunction) || '',
      envelope_ok: r.ok,
      decisionType_correct: dtMatch,
      function_correct: fnMatch,
      latencyMs: r.latencyMs,
      errors: r.errors,
    });
  }

  latencies.sort((a, b) => a - b);
  const summary = {
    runId: stamp,
    casesAttempted: cases.length,
    envelopeValid: okEnvelope,
    envelopeValidPct: pct(okEnvelope, cases.length),
    decisionTypeAccuracy: pct(dtCorrect, cases.length),
    functionSelectionAccuracy: pct(fnCorrect, cases.length),
    p50LatencyMs: pctile(latencies, 50),
    p95LatencyMs: pctile(latencies, 95),
    elapsedSec: Number(elapsedSec),
    perCategory: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, {
      total: v.total,
      decisionType_acc: pct(v.dt, v.total),
      function_acc: pct(v.fn, v.total),
      envelope_ok_pct: pct(v.ok, v.total),
    }])),
    provider: provider.name,
    model: provider.modelId(),
    skillId: skill.skillId,
    skillVersion: skill.skillVersion,
    skillManifestHash: skill.skillManifestHash,
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'per_case.jsonl'),
    perCase.map((r) => JSON.stringify(r)).join('\n') + '\n'
  );

  // ---- Human report
  const lines = [];
  lines.push('');
  lines.push('==================================================================');
  lines.push(`  Phase 2 intent evaluation — ${stamp}`);
  lines.push('==================================================================');
  lines.push(`  Provider              : ${summary.provider} (${summary.model})`);
  lines.push(`  Skill                 : ${summary.skillId} v${summary.skillVersion}`);
  lines.push(`  Manifest hash         : ${summary.skillManifestHash}`);
  lines.push(`  Cases                 : ${summary.casesAttempted}`);
  lines.push(`  Envelope valid        : ${summary.envelopeValid} / ${summary.casesAttempted}  (${summary.envelopeValidPct}%)`);
  lines.push(`  decisionType accuracy : ${summary.decisionTypeAccuracy}%`);
  lines.push(`  function-selection    : ${summary.functionSelectionAccuracy}%   <-- exit-criterion metric (target >=80%)`);
  lines.push(`  latency p50 / p95     : ${summary.p50LatencyMs} ms / ${summary.p95LatencyMs} ms`);
  lines.push(`  elapsed               : ${summary.elapsedSec} s`);
  lines.push('');
  lines.push('  Per-category:');
  for (const [cat, v] of Object.entries(summary.perCategory)) {
    lines.push(`    ${cat.padEnd(14)} n=${String(v.total).padStart(3)}  fn=${String(v.function_acc).padStart(5)}%  dt=${String(v.decisionType_acc).padStart(5)}%  envOk=${String(v.envelope_ok_pct).padStart(5)}%`);
  }
  lines.push('');
  lines.push(`  Artifacts:`);
  lines.push(`    summary.json   ${path.join(outDir, 'summary.json')}`);
  lines.push(`    per_case.jsonl ${path.join(outDir, 'per_case.jsonl')}`);
  lines.push('==================================================================');
  lines.push('');

  const text = lines.join('\n');
  process.stdout.write(text);
  fs.writeFileSync(path.join(outDir, 'report.txt'), text);

  // Exit code reflects the exit-criterion target.
  process.exit(summary.functionSelectionAccuracy >= 80 ? 0 : 1);
}

function pct(num, denom) {
  if (!denom) return 0;
  return Math.round((num / denom) * 1000) / 10;
}

main().catch((e) => {
  log.error('eval crashed', { error: e.message, stack: e.stack });
  console.error(`error: ${e.message}`);
  process.exit(3);
});
