import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface GitInfo {
    commit: string | null;
    branch: string | null;
    // Uncommitted changes: the commit alone does not identify the code.
    dirty: boolean | null;
}

/** The git directory, including when `.git` is a file pointing to it (worktree, submodule). */
function gitDir(root: string): string | null {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) {
        return null;
    }
    if (statSync(dotGit).isDirectory()) {
        return dotGit;
    }
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));

    return pointer ? resolve(root, pointer[1].trim()) : null;
}

function isDirty(root: string): boolean | null {
    try {
        const status = execFileSync('git', ['status', '--porcelain'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });

        return '' !== status.trim();
    } catch {
        return null;
    }
}

/** Reads HEAD from the files themselves: the git binary is not always installed where demos run. */
export function gitInfo(root: string): GitInfo {
    let directory = resolve(root);
    let dir = gitDir(directory);
    while (null === dir) {
        const parent = resolve(directory, '..');
        if (parent === directory) {
            return { commit: null, branch: null, dirty: null };
        }
        directory = parent;
        dir = gitDir(directory);
    }
    const dirty = isDirty(directory);
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) {
        return { commit: head, branch: null, dirty };
    }
    const ref = head.slice(5);
    const branch = ref.replace(/^refs\/heads\//, '');
    // In a worktree, shared references live in the main repository (`commondir`).
    const commonFile = join(dir, 'commondir');
    const commonDir = existsSync(commonFile) ? resolve(dir, readFileSync(commonFile, 'utf8').trim()) : dir;
    for (const candidate of [dir, commonDir]) {
        const looseRef = join(candidate, ref);
        if (existsSync(looseRef)) {
            return { commit: readFileSync(looseRef, 'utf8').trim(), branch, dirty };
        }
    }
    const packedRefs = join(commonDir, 'packed-refs');
    if (existsSync(packedRefs)) {
        const line = readFileSync(packedRefs, 'utf8')
            .split('\n')
            .find((candidate) => candidate.endsWith(` ${ref}`));
        if (line) {
            return { commit: line.split(' ')[0], branch, dirty };
        }
    }

    return { commit: null, branch, dirty };
}
