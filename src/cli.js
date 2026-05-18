#!/usr/bin/env node
'use strict';

/*
 * cli.js — one-off skill runtime invocation.
 *
 * Examples:
 *   node src/cli.js "register this anchor"
 *   node src/cli.js --org Org2MSP "approve CLAIM_017_a1"
 *   node src/cli.js --asset TAG_017 --pose-hash sha256:... --meta-hash sha256:... "pin this"
 *   node src/cli.js --no-llm "register this anchor"     # offline: build prompt, skip LLM
 *
 * Exit codes:
 *   0  decision is valid, shouldInvoke as planned
 *   2  decision rejected by validator
 *   3  LLM call or pipeline error
 *   64 usage error
 */

require('dotenv').config();
const { loadSkill } = require('./skillLoader');
const { buildProvider } = require('./providerFactory');
const { interpret } = require('./interpret');
const { buildMessages } = require('./promptBuilder');
const log = require('./utils/logger');

function parseArgv(argv) {
  const args = { context: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--org')        args.orgMsp = argv[++i];
    else if (a === '--asset') args.context.focusedAssetId = argv[++i];
    else if (a === '--claim') args.context.focusedClaimId = argv[++i];
    else if (a === '--pose-hash') args.context.poseHash = argv[++i];
    else if (a === '--meta-hash') args.context.metadataHash = argv[++i];
    else if (a === '--visible') args.context.visibleAssetIds = argv[++i].split(',');
    else if (a === '--no-llm') args.noLlm = true;
    else if (a === '--json') args.outputJson = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else rest.push(a);
  }
  args.userText = rest.join(' ').trim();
  return args;
}

function usage() {
  console.log(`mr-skill-runtime CLI

Usage:
  node src/cli.js [options] <user text>

Options:
  --org <orgMsp>           Authoritative org identity (default: Org1MSP)
  --asset <assetId>        focusedAssetId in context
  --claim <claimId>        focusedClaimId in context
  --pose-hash <sha256:..>  Pose hash in context (for ProposeAnchor)
  --meta-hash <sha256:..>  Metadata hash in context
  --visible a,b,c          Comma-separated visibleAssetIds
  --no-llm                 Build the prompt but skip the LLM call (offline test)
  --json                   Emit the full envelope as JSON on stdout
  -h, --help               Show this help

Examples:
  node src/cli.js "register this anchor" --asset TAG_017 --pose-hash sha256:abc... --meta-hash sha256:def...
  node src/cli.js --org Org2MSP "approve CLAIM_017_a1"
  node src/cli.js --no-llm "register this anchor"
`);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.userText) {
    usage();
    process.exit(args.help ? 0 : 64);
  }
  args.orgMsp = args.orgMsp || 'Org1MSP';

  const skillPath = process.env.SKILL_ASSETS_PATH;
  if (!skillPath) {
    console.error('error: SKILL_ASSETS_PATH is not set (copy .env.example to .env)');
    process.exit(64);
  }

  const skill = loadSkill(skillPath);

  // Offline path: just print the prompt that would be sent.
  if (args.noLlm) {
    const { messages, levelsLoaded, tokenEstimate } = buildMessages(skill, {
      userText: args.userText,
      orgMsp: args.orgMsp,
      context: args.context,
    });
    if (args.outputJson) {
      console.log(JSON.stringify({ ok: true, levelsLoaded, tokenEstimate, messages }, null, 2));
    } else {
      console.log(`[offline] levels=${levelsLoaded.join(',')}  tokens≈${tokenEstimate}`);
      console.log('--- system ---');
      console.log(messages[0].content);
      console.log('--- user ---');
      console.log(messages[1].content);
    }
    return;
  }

  const provider = buildProvider(process.env);
  const envelope = await interpret(skill, provider, {
    userText: args.userText,
    orgMsp: args.orgMsp,
    context: args.context,
  });

  if (args.outputJson) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    if (envelope.ok) {
      const d = envelope.decision;
      console.log(`OK  ${d.decisionType}  function=${d.selectedFunction || '-'}  risk=${d.riskLevel || '-'}`);
      console.log(`    intent       : ${d.intent}`);
      if (d.clarificationQuestion) console.log(`    clarification: ${d.clarificationQuestion}`);
      console.log(`    reasoning    : ${d.policyReasoning}`);
      console.log(`    audit        : skillVer=${envelope.audit.skillVersion}  model=${envelope.audit.llmModel}  latency=${envelope.audit.totalLatencyMs}ms`);
    } else {
      console.error(`FAIL  ${envelope.errors.length} error${envelope.errors.length === 1 ? '' : 's'}`);
      for (const e of envelope.errors) console.error(`  - ${e}`);
      process.exit(2);
    }
  }
}

main().catch((e) => {
  log.error('cli: unexpected failure', { error: e.message, stack: e.stack });
  console.error(`error: ${e.message}`);
  process.exit(3);
});
