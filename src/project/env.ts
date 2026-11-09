import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads a variable from the environment, then from `.env.local` and `.env` at the project root,
 * so that an API key never has to appear on a command line.
 */
export function readEnv(root: string, name: string): string | null {
    const own = process.env[name];
    if (own) {
        return own;
    }
    for (const file of ['.env.local', '.env']) {
        const path = join(root, file);
        if (!existsSync(path)) {
            continue;
        }
        const line = readFileSync(path, 'utf8')
            .split('\n')
            .find((candidate) => candidate.startsWith(`${name}=`));
        const value = line
            ?.slice(name.length + 1)
            .trim()
            .replace(/^(['"])(.*)\1$/, '$2');
        if (value) {
            return value;
        }
    }

    return null;
}
