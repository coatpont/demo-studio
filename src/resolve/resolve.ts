import { spawnSync } from 'node:child_process';
import type { ResolveConfig } from '../config/schema.ts';
import type { Resolved } from '../schema/scenario.ts';

type Requests = Record<string, { entity: string; where: Record<string, unknown> }>;

/** `id`, `[ids]` or `null` per key, as a resolver prints them; a missing key means nothing was found. */
export function normalizeResolved(raw: unknown, keys: string[]): Resolved {
    if (null === raw || 'object' !== typeof raw || Array.isArray(raw)) {
        throw new Error('The resolver must print a JSON object: { "<lookup>": <id> | [<ids>] | null }.');
    }
    const record = raw as Record<string, unknown>;
    const resolved: Resolved = {};
    for (const key of keys) {
        const value = record[key];
        const values = undefined === value || null === value ? [] : Array.isArray(value) ? value : [value];
        for (const id of values) {
            if ('string' !== typeof id && 'number' !== typeof id) {
                throw new Error(`Lookup "${key}": ids must be strings or numbers, got ${JSON.stringify(id)}.`);
            }
        }
        resolved[key] = values as (string | number)[];
    }

    return resolved;
}

/** Runs the project's resolver (any backend, any language): lookups as JSON on stdin, ids as JSON on stdout. */
export function runResolver(config: ResolveConfig, requests: Requests, cwd: string): Resolved {
    const keys = Object.keys(requests);
    if ('values' in config) {
        return normalizeResolved(config.values, keys);
    }
    if (0 === keys.length) {
        return {};
    }
    const result = spawnSync(config.command, {
        cwd,
        shell: true,
        input: JSON.stringify(requests),
        encoding: 'utf8',
        timeout: config.timeoutMs,
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (result.error) {
        throw new Error(`Resolver "${config.command}" could not run: ${result.error.message}`);
    }
    if (0 !== result.status) {
        throw new Error(`Resolver "${config.command}" exited with status ${result.status}.`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        throw new Error(`Resolver "${config.command}" did not print JSON: ${result.stdout.slice(0, 200)}`);
    }

    return normalizeResolved(parsed, keys);
}
