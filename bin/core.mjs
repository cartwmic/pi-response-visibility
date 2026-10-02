#!/usr/bin/env node
import { corePatch } from '../src/core-patch.mjs';
const [action, ...args] = process.argv.slice(2);
try {
  if (args.length && (args.length !== 2 || args[0] !== '--pi-root')) throw new Error('Usage: core.mjs check|apply|rollback [--pi-root ABS]');
  console.log(JSON.stringify(await corePatch(action, args[1])));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
