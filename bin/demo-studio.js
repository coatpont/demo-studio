#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// From a git checkout without a build, Node runs the TypeScript sources directly; it refuses to inside node_modules.
const built = new URL('../dist/cli/main.js', import.meta.url);
await import(existsSync(fileURLToPath(built)) ? built.href : new URL('../src/cli/main.ts', import.meta.url).href);
