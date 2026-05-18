# MR-Skill-Runtime

Edge service for the **Safe Agentic Blockchain Governance for Multi-User Mixed Reality** journal-extension prototype.

Phase 2 of the build plan. Loads the [`MR-Skill-Assets`](https://github.com/Lycanthrope8/MR-Skill-Assets) `spatial-governance-skill` from a local checkout, builds prompts via progressive disclosure, calls a single LLM provider (Parley), parses the response, validates it against the Decision contract + transaction argument schemas, and returns a structured `Decision` enriched with audit metadata.

> **Design principle:** *The LLM prepares. The gateway validates. The chaincode enforces. The ledger records.* This service does the *prepare* step only. It holds no credentials, signs nothing, never speaks to Fabric or Unity. Phase 4 will add the gateway-side handler that consumes its output.

---

## Architecture

```
                   user text + grounding context
                                 │
                                 ▼
┌────────────────────────────────────────────────────────┐
│ Gateway (Phase 4)                                      │
│   binds orgMsp from caller TLS identity                │
│   forwards request to skill runtime                    │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ MR-Skill-Runtime  (this repo)                          │
│                                                        │
│  skillLoader  → reads MR-Skill-Assets from disk        │
│  promptBuilder → progressive disclosure                │
│  ParleyProvider → GPT-5/o-series via OpenAI-compat API │
│  outputParser → JSON extraction + schema validation    │
│  interpret    → audit-enriched envelope                │
└─────────────────────────┬──────────────────────────────┘
                          │ Decision (validated, hashed)
                          ▼
                   back to Gateway → Fabric
```

---

## Repository layout

```
MR-Skill-Runtime/
├── README.md                  this file
├── package.json
├── .env.example               copy to .env, fill in PARLEY_API_KEY etc.
├── .gitignore
├── src/
│   ├── cli.js                 one-off skill invocation
│   ├── server.js              Express on :5100
│   ├── interpret.js           the main pipeline function
│   ├── skillLoader.js         loads MR-Skill-Assets from SKILL_ASSETS_PATH
│   ├── promptBuilder.js       progressive disclosure (L1/L2/L3)
│   ├── outputParser.js        extract + validate Decision JSON
│   ├── providerFactory.js     selects the provider from env
│   ├── providers/
│   │   ├── base.js            LLMProvider interface
│   │   └── parley.js          Parley adapter (Phase 2: only provider)
│   └── utils/
│       ├── hash.js            canonical SHA-256 (mirrors asset-side)
│       └── logger.js
├── eval/
│   └── run_intent_eval.js     exit-criterion runner (50 cases, target ≥80%)
└── tests/
    └── unit.test.js           offline tests, no LLM
```

---

## Configuration

```bash
cp .env.example .env
# edit:
#   SKILL_ASSETS_PATH=../MR-Skill-Assets/spatial-governance-skill
#   PARLEY_API_KEY=...
#   PARLEY_MODEL=gpt-5
```

The runtime reads MR-Skill-Assets purely from disk. Phase 2 chose **env-var sourcing** (not Git submodule) for simplicity — clone the two repos as siblings, point `SKILL_ASSETS_PATH` at the skill subdirectory.

### Recommended workspace layout

```
~/code/journal-extension/
├── MR-Skill-Assets/                              v0.1.0 tag
└── MR-Skill-Runtime/
    └── .env  →  SKILL_ASSETS_PATH=../MR-Skill-Assets/spatial-governance-skill
```

---

## Usage

### CLI — one-off invocation

```bash
# A read query (no LLM call needed — but if --no-llm not set, will call Parley)
node src/cli.js --org Org1MSP "show all active anchors"

# A write proposal with grounding context
node src/cli.js \
  --org Org1MSP \
  --asset TAG_017 \
  --pose-hash sha256:abc... \
  --meta-hash sha256:def... \
  "register this anchor"

# Inspect the prompt without spending a Parley credit
node src/cli.js --no-llm "approve CLAIM_017_a1"
```

### Server — long-running edge service

```bash
node src/server.js
# Listening on http://127.0.0.1:5100
#   GET  /health
#   POST /skills/interpret   { userText, orgMsp, context }
```

In Phase 4, the cloud gateway will POST to `/skills/interpret`. For now this server is useful for the user study harness and ad-hoc curl testing.

```bash
curl -s http://127.0.0.1:5100/health | jq
curl -s -X POST http://127.0.0.1:5100/skills/interpret \
  -H 'content-type: application/json' \
  -d '{"userText":"show snapshot","orgMsp":"Org1MSP","context":{}}' | jq
```

### Eval — Phase 2 exit-criterion run

```bash
node eval/run_intent_eval.js
# runs all 50 cases from MR-Skill-Assets/tests/intent_cases.json
# writes eval/results/<timestamp>/summary.json + per_case.jsonl
# exits 0 if function-selection-accuracy >= 80%
```

---

## What this runtime does NOT do

- Hold Fabric credentials
- Sign or commit transactions
- Decide policy (it can *propose* a decision, but enforcement is the gateway's job)
- Persist state (decisions live in the gateway's decision store, not here)
- Author the skill content (that's `MR-Skill-Assets`)
- Talk to multiple LLM providers (Phase 2 is Parley-only by design)

---

## Audit hashing parity

The runtime ports the canonical hashing logic from `MR-Skill-Assets/scripts/hash_intent.js` so that `intentHash`, `contextHash`, `argumentHash`, and `skillManifestHash` match byte-for-byte between the two repos. This is asserted by the unit test suite (`tests/unit.test.js`), which runs the asset-side script in a subprocess and compares output. If you ever change the canonicalisation in either repo, the test will catch the divergence immediately.

---

## License

Apache 2.0.
