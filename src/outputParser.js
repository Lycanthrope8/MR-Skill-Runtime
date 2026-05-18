'use strict';

/*
 * outputParser.js
 *
 * Turn raw LLM output text into a validated Decision object. Performs:
 *   1. JSON extraction (handles unfenced JSON, ```json fenced, and stray prose).
 *   2. Decision-contract validation (mirrors SKILL.md output contract).
 *   3. Semantic checks (selectedFunction must be in chaincode_interface).
 *   4. Argument-schema validation against the function's transaction schema.
 *
 * Mirrors MR-Skill-Assets/spatial-governance-skill/scripts/validate_decision.js
 * so behaviour stays consistent between authoring-time validation and
 * runtime validation. If Phase 1's validator changes, mirror the change here.
 */

const log = require('./utils/logger');

const ALLOWED_DECISION_TYPES = ['INVOKE', 'REJECT', 'CLARIFY'];
const ALLOWED_RISK_LEVELS = ['READ_ONLY', 'WRITE_LOW', 'WRITE_GOVERNED', 'FORBIDDEN'];

// Required top-level fields per SKILL.md
const REQUIRED_FIELDS = ['decisionType', 'intent', 'selectedFunction', 'arguments', 'policyReasoning', 'shouldInvoke'];

// Mirror of FUNCTION_SCHEMA_MAP from the asset-side validator.
const FUNCTION_SCHEMA_MAP = {
  ProposeAnchor: true,
  EndorseAnchor: true,
  ProposeRevocation: true,
  EndorseRevocation: true,
  QueryAnchor: true,
  QueryAnchorHistory: true,
  GetSnapshot: true,
};

/**
 * Extract a JSON object from raw LLM text.
 *
 * Strategy:
 *   1. If the entire stripped text is valid JSON, use it.
 *   2. Else, look for ```json ... ``` fenced block.
 *   3. Else, find the first balanced { ... } region and try that.
 *
 * @param {string} raw
 * @returns {object} parsed JSON
 * @throws if no parseable JSON object is found
 */
function extractJson(raw) {
  if (typeof raw !== 'string') throw new Error('LLM output was not a string');
  const trimmed = raw.trim();

  // 1) Try whole thing
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) { /* fall through */ }

  // 2) Try ```json ... ``` fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) { /* fall through */ }
  }

  // 3) First balanced { ... } region
  const first = trimmed.indexOf('{');
  if (first !== -1) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = first; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(first, i + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
          } catch (_) { /* keep looking */ }
        }
      }
    }
  }

  throw new Error(`could not extract JSON object from LLM output (first 200 chars): ${trimmed.slice(0, 200)}`);
}

/**
 * Tiny inline schema checker for the argument schemas. Covers the subset
 * actually used by transaction_schemas/*.schema.json:
 *   type: object | string | number | integer | boolean
 *   required, additionalProperties (false), properties, pattern,
 *   minLength, maxLength, minimum, maximum, anyOf.
 */
function validateAgainstSchema(value, schema, pathPrefix, errors) {
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const any = schema.anyOf.some((sub) => {
      const local = [];
      validateAgainstSchema(value, sub, pathPrefix, local);
      return local.length === 0;
    });
    if (!any) errors.push(`${pathPrefix}: did not match any anyOf branch`);
    return;
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${pathPrefix}: expected object`); return;
    }
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in value)) errors.push(`${pathPrefix}: missing required field "${r}"`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) errors.push(`${pathPrefix}.${k}: additionalProperties not allowed`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) validateAgainstSchema(value[k], sub, `${pathPrefix}.${k}`, errors);
      }
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') { errors.push(`${pathPrefix}: expected string`); return; }
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${pathPrefix}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${pathPrefix}: longer than maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${pathPrefix}: does not match pattern ${schema.pattern}`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) { errors.push(`${pathPrefix}: expected integer`); return; }
    if (schema.minimum != null && value < schema.minimum) errors.push(`${pathPrefix}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${pathPrefix}: above maximum ${schema.maximum}`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) { errors.push(`${pathPrefix}: expected number`); return; }
    if (schema.minimum != null && value < schema.minimum) errors.push(`${pathPrefix}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${pathPrefix}: above maximum ${schema.maximum}`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${pathPrefix}: expected boolean`);
  }
}

/**
 * Validate a Decision object.
 *
 * @param {object} decision   - parsed JSON
 * @param {object} skill      - from skillLoader.loadSkill()
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateDecision(decision, skill) {
  const errors = [];

  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { valid: false, errors: ['decision must be an object'] };
  }

  // Top-level required fields
  for (const f of REQUIRED_FIELDS) {
    if (!(f in decision)) errors.push(`top-level: missing required field "${f}"`);
  }
  if (decision.decisionType && !ALLOWED_DECISION_TYPES.includes(decision.decisionType)) {
    errors.push(`decisionType must be one of ${ALLOWED_DECISION_TYPES.join(', ')}`);
  }
  if (decision.riskLevel && !ALLOWED_RISK_LEVELS.includes(decision.riskLevel)) {
    errors.push(`riskLevel must be one of ${ALLOWED_RISK_LEVELS.join(', ')}`);
  }

  // Per-decisionType rules
  if (decision.decisionType === 'INVOKE') {
    if (!decision.selectedFunction) errors.push('INVOKE requires selectedFunction');
    if (decision.shouldInvoke !== true) errors.push('INVOKE requires shouldInvoke=true');
    if (decision.selectedFunction && !skill.knownFunctions.has(decision.selectedFunction)) {
      errors.push(`selectedFunction "${decision.selectedFunction}" is not in chaincode_interface.json`);
    }
    if (decision.selectedFunction && skill.knownFunctions.has(decision.selectedFunction)) {
      const fn = skill.chaincodeInterface.functions.find((f) => f.name === decision.selectedFunction);
      if (decision.riskLevel && decision.riskLevel !== fn.riskLevel) {
        errors.push(`riskLevel "${decision.riskLevel}" does not match function tier "${fn.riskLevel}"`);
      }
      if (typeof decision.requiresConfirmation === 'boolean' && decision.requiresConfirmation !== fn.requiresUserConfirmation) {
        errors.push(`requiresConfirmation ${decision.requiresConfirmation} does not match function spec ${fn.requiresUserConfirmation}`);
      }
      // Arguments schema check
      const argSchema = skill.schemas[decision.selectedFunction];
      if (argSchema) {
        validateAgainstSchema(decision.arguments || {}, argSchema, 'arguments', errors);
      }
    }
  } else if (decision.decisionType === 'REJECT') {
    if (decision.shouldInvoke !== false) errors.push('REJECT requires shouldInvoke=false');
  } else if (decision.decisionType === 'CLARIFY') {
    if (decision.shouldInvoke !== false) errors.push('CLARIFY requires shouldInvoke=false');
    if (!decision.clarificationQuestion || decision.clarificationQuestion.length === 0) {
      errors.push('CLARIFY requires non-empty clarificationQuestion');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * High-level: take raw LLM text, return parsed-and-validated Decision plus
 * either the validation errors or null on success.
 */
function parseAndValidate(rawText, skill) {
  let decision;
  try {
    decision = extractJson(rawText);
  } catch (e) {
    return { decision: null, valid: false, errors: [`json-extraction: ${e.message}`] };
  }
  const v = validateDecision(decision, skill);
  if (!v.valid) {
    log.debug('outputParser: decision failed validation', { errors: v.errors });
  }
  return { decision, valid: v.valid, errors: v.errors };
}

module.exports = {
  extractJson,
  validateDecision,
  parseAndValidate,
  ALLOWED_DECISION_TYPES,
  ALLOWED_RISK_LEVELS,
  FUNCTION_SCHEMA_MAP,
};
