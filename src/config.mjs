import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SECTIONS = Object.freeze(['timing', 'transport', 'provider', 'health']);
export const DEFAULTS = Object.freeze({ preset: 'compact', capture: 'metadata', historyLimit: 50,
  traceBytes: 100 * 1024 * 1024, quietMs: 30000, slowMs: 30000,
  sections: Object.freeze(Object.fromEntries(SECTIONS.map(k => [k, true]))) });

/** Validate complete or partial settings; unknown keys are rejected, never silently saved. */
export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid settings');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError('Unknown setting');
  const c = { ...DEFAULTS, ...input, sections: { ...DEFAULTS.sections, ...input.sections } };
  if (!['off', 'compact', 'expanded', 'timeline'].includes(c.preset) ||
      !['off', 'metadata', 'events', 'bodies'].includes(c.capture)) throw new TypeError('Invalid mode');
  for (const [key, max] of Object.entries({ historyLimit: 1000, traceBytes: 1024 ** 3, quietMs: 86400000, slowMs: 86400000 })) {
    if (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > max) throw new TypeError('Invalid limit');
  }
  if (input.sections !== undefined && (!input.sections || typeof input.sections !== 'object' || Array.isArray(input.sections))) throw new TypeError('Invalid sections');
  for (const [key, value] of Object.entries(c.sections)) if (!SECTIONS.includes(key) || typeof value !== 'boolean') throw new TypeError('Invalid section');
  return Object.freeze({ ...c, sections: Object.freeze(c.sections) });
}
export async function loadConfig(path) {
  try { return validateConfig(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return validateConfig(); throw new Error('Settings unavailable'); }
}
export async function saveConfig(path, input) {
  const config = validateConfig(input);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return config;
}
