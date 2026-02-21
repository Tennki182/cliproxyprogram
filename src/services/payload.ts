import { getConfig } from '../config.js';
import { matchWildcard, resolveModelAlias } from './models.js';

interface PayloadRule {
  models: Array<{ name: string; protocol?: string }>;
  params: Record<string, any>;
}

interface FilterRule {
  models: Array<{ name: string; protocol?: string }>;
  params: string[];
}

function getNestedValue(obj: any, path: string): any {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current)) {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

function deleteNestedValue(obj: any, path: string): boolean {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current)) return false;
    current = current[key];
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey in current) {
    delete current[lastKey];
    return true;
  }
  return false;
}

function modelMatches(model: string, rule: { name: string; protocol?: string }, protocol?: string): boolean {
  const resolvedModel = resolveModelAlias(model);
  const matches = matchWildcard(rule.name, resolvedModel);
  if (!matches) return false;
  if (rule.protocol && protocol && rule.protocol !== protocol) {
    return false;
  }
  return true;
}

function applyRules(
  model: string,
  protocol: string | undefined,
  rules: PayloadRule[],
  target: any,
  isRaw: boolean = false,
  isOverride: boolean = false
): any {
  const resolved = resolveModelAlias(model);
  
  for (const rule of rules) {
    const matches = rule.models.some(m => modelMatches(resolved, m, protocol));
    if (!matches) continue;
    
    for (const [path, value] of Object.entries(rule.params)) {
      if (isRaw) {
        // For raw rules, value is a JSON string that needs to be parsed
        try {
          const parsedValue = JSON.parse(value as string);
          if (isOverride) {
            setNestedValue(target, path, parsedValue);
          } else {
            // For default, only set if not already present
            if (getNestedValue(target, path) === undefined) {
              setNestedValue(target, path, parsedValue);
            }
          }
        } catch {
          // Skip invalid JSON
        }
      } else {
        if (isOverride) {
          setNestedValue(target, path, value);
        } else {
          // For default, only set if not already present
          if (getNestedValue(target, path) === undefined) {
            setNestedValue(target, path, value);
          }
        }
      }
    }
  }
  
  return target;
}

function applyFilterRules(model: string, protocol: string | undefined, rules: FilterRule[], target: any): any {
  const resolvedModel = resolveModelAlias(model);
  
  for (const rule of rules) {
    const matches = rule.models.some(m => modelMatches(resolvedModel, m, protocol));
    if (!matches) continue;
    
    for (const path of rule.params) {
      deleteNestedValue(target, path);
    }
  }
  
  return target;
}

/**
 * Apply payload configuration rules to a request body.
 * @param model - The model name
 * @param protocol - The protocol (openai, gemini, claude, codex, antigravity)
 * @param body - The request body to modify
 * @returns Modified body
 */
export function applyPayloadConfig(model: string, protocol: string | undefined, body: any): any {
  const config = getConfig();
  const payload = config.payload || {};
  
  if (!body || typeof body !== 'object') {
    return body;
  }
  
  // Deep clone the body to avoid mutation
  let result = JSON.parse(JSON.stringify(body));
  
  // Apply default rules (only set if missing)
  if (payload.default) {
    result = applyRules(model, protocol, payload.default, result, false, false);
  }
  
  // Apply defaultRaw rules (raw JSON strings)
  if (payload.defaultRaw) {
    result = applyRules(model, protocol, payload.defaultRaw, result, true, false);
  }
  
  // Apply override rules (always overwrite)
  if (payload.override) {
    result = applyRules(model, protocol, payload.override, result, false, true);
  }
  
  // Apply overrideRaw rules (raw JSON strings, always overwrite)
  if (payload.overrideRaw) {
    result = applyRules(model, protocol, payload.overrideRaw, result, true, true);
  }
  
  // Apply filter rules (remove params)
  if (payload.filter) {
    result = applyFilterRules(model, protocol, payload.filter, result);
  }
  
  return result;
}
