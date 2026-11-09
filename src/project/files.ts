import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeJson(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeText(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
}

export function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'));
}
