import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findConfigFile, loadProject, parseConfig } from '../src/config/load.ts';
import { readEnv } from '../src/project/env.ts';
import { normalizeResolved, runResolver } from '../src/resolve/resolve.ts';
import { accountErrors, loginContext, playableAccounts, resolveValue } from '../src/runner/login.ts';

const declarativeLogin = {
    url: '/login',
    fields: [
        { target: { label: 'Email' }, value: { account: 'email' } },
        { target: { label: 'Password' }, value: { env: 'DEMO_PASSWORD' } },
    ],
    submit: { role: 'button', name: 'Sign in' },
};

function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'demo-config-'));
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(root, name, '..'), { recursive: true });
        writeFileSync(join(root, name), content);
    }

    return root;
}

describe('config', () => {
    afterEach(() => {
        delete process.env.DEMO_STUDIO_BASE_URL;
        delete process.env.DEMO_PASSWORD;
    });

    it('fills every default from a minimal config', () => {
        const config = parseConfig({ baseUrl: 'http://tracker.test' }, 'demo-studio.config.json');
        expect(config).toMatchObject({
            demosDir: 'demos',
            workDir: '.demo-studio',
            catalog: 'catalog.yaml',
            defaultLanguage: 'en',
            allowedHosts: ['localhost', '127.0.0.1', '*.localhost', '*.test'],
            browser: { viewport: { width: 1920, height: 1080 }, timezone: 'UTC', testIdAttribute: 'data-testid' },
            branding: { primaryColor: '#2563eb', logo: null },
            narration: { provider: 'elevenlabs', modelId: 'eleven_v4', apiKeyEnv: 'ELEVENLABS_API_KEY' },
            accounts: [],
        });
    });

    it('explains what is wrong, unknown keys included', () => {
        const invalid = (): unknown =>
            parseConfig({ baseUrl: 'not a url', narration: { provider: 'robot' }, colour: 'blue' }, 'x.json');
        expect(invalid).toThrow(/^Invalid config x\.json/);
        expect(invalid).toThrow(/at baseUrl/);
        expect(invalid).toThrow(/at narration\.provider/);
        expect(invalid).toThrow(/Unrecognized key: "colour"/);
        expect(() =>
            parseConfig({ baseUrl: 'http://a.test', login: { url: '/login', fields: [], submit: { text: 'Go' } } }, 'x')
        ).toThrow(/login/);
    });

    it('finds the config upwards, resolves paths from its directory and lets the environment set the base URL', async () => {
        const root = project({
            'demo-studio.config.json': JSON.stringify({ baseUrl: 'http://tracker.test', demosDir: 'docs/demos' }),
            'app/src/.keep': '',
        });
        expect(findConfigFile(join(root, 'app/src'))).toBe(join(root, 'demo-studio.config.json'));
        process.env.DEMO_STUDIO_BASE_URL = 'http://localhost:3000';
        const { config, paths } = await loadProject(undefined, join(root, 'app/src'));
        expect(config.baseUrl).toBe('http://localhost:3000');
        expect(paths).toMatchObject({
            root,
            demos: join(root, 'docs/demos'),
            work: join(root, '.demo-studio'),
            catalog: join(root, 'catalog.yaml'),
            cache: join(root, '.demo-studio/cache'),
        });
        expect(() => findConfigFile(tmpdir())).toThrow(/--config/);
    });

    it('loads a module config with a login function', async () => {
        const root = project({
            'custom.config.mjs':
                "export default { baseUrl: 'http://tracker.test', accounts: [{ id: 'sso', login: async () => {} }] };",
        });
        const { config } = await loadProject('custom.config.mjs', root);
        expect(typeof config.accounts[0].login).toBe('function');
        expect(playableAccounts(config).get('sso')).toBeDefined();
    });
});

describe('accounts and login values', () => {
    const config = parseConfig(
        {
            baseUrl: 'http://tracker.test',
            login: declarativeLogin,
            accounts: [
                { id: 'manager', values: { email: 'manager@tracker.test' } },
                { id: 'visitor', login: 'none' },
                { id: 'lead', values: { email: { env: 'LEAD_EMAIL' } } },
            ],
        },
        'x'
    );
    const env = (values: Record<string, string>) => (name: string) => values[name] ?? null;

    it('gives each account its own login or the default one', () => {
        const accounts = playableAccounts(config);
        expect(accounts.get('visitor')?.login).toBe('none');
        expect(accounts.get('manager')?.login).toMatchObject({ url: '/login' });
        expect(accountErrors(['manager', 'visitor', 'ceo'], config)).toEqual([
            'Account "ceo": not declared in the config\'s accounts.',
        ]);
        const withoutDefault = parseConfig({ baseUrl: 'http://a.test', accounts: [{ id: 'manager' }] }, 'x');
        expect(accountErrors(['manager'], withoutDefault)[0]).toContain('no login in the config');
    });

    it('resolves literals, account values and environment variables, without ever printing a value', () => {
        const manager = playableAccounts(config).get('manager')!;
        const lead = playableAccounts(config).get('lead')!;
        expect(resolveValue({ account: 'email' }, manager, env({}))).toBe('manager@tracker.test');
        expect(resolveValue({ env: 'DEMO_PASSWORD' }, manager, env({ DEMO_PASSWORD: 's3cret' }))).toBe('s3cret');
        expect(resolveValue({ account: 'email' }, lead, env({ LEAD_EMAIL: 'lead@tracker.test' }))).toBe(
            'lead@tracker.test'
        );
        expect(() => resolveValue({ env: 'DEMO_PASSWORD' }, manager, env({}))).toThrow(
            'Environment variable DEMO_PASSWORD is not set (needed to log in as "manager").'
        );
        expect(() => resolveValue({ account: 'phone' }, manager, env({}))).toThrow(/no value "phone"/);
        const context = loginContext(manager, {
            baseUrl: 'http://tracker.test',
            language: 'en',
            timeoutMs: 1000,
            env: env({ DEMO_PASSWORD: 's3cret' }),
        });
        expect(context.value('email')).toBe('manager@tracker.test');
        expect(context.env('DEMO_PASSWORD')).toBe('s3cret');
    });

    it('reads a variable from the environment first, then .env.local, then .env', () => {
        const root = project({ '.env': 'DEMO_PASSWORD=from-env\nOTHER=x', '.env.local': "DEMO_PASSWORD='from-local'" });
        expect(readEnv(root, 'DEMO_PASSWORD')).toBe('from-local');
        expect(readEnv(root, 'OTHER')).toBe('x');
        process.env.DEMO_PASSWORD = 'from-process';
        expect(readEnv(root, 'DEMO_PASSWORD')).toBe('from-process');
        expect(readEnv(root, 'MISSING')).toBeNull();
    });
});

describe('resolver', () => {
    const requests = {
        landing: { entity: 'Task', where: { title: 'Design the landing page' } },
        ada: { entity: 'User', where: { name: 'Ada' } },
        nobody: { entity: 'User', where: { name: 'Nobody' } },
    };

    it('accepts an id, several ids or nothing per lookup', () => {
        expect(normalizeResolved({ landing: 7, ada: ['u1', 'u2'], nobody: null }, Object.keys(requests))).toEqual({
            landing: [7],
            ada: ['u1', 'u2'],
            nobody: [],
        });
        expect(normalizeResolved({}, ['landing'])).toEqual({ landing: [] });
        expect(() => normalizeResolved([1], ['landing'])).toThrow(/JSON object/);
        expect(() => normalizeResolved({ landing: { id: 1 } }, ['landing'])).toThrow(/strings or numbers/);
    });

    it('takes the ids from the config when there is no backend', () => {
        expect(runResolver({ values: { landing: 'task-42', ada: 3 } }, requests, tmpdir())).toEqual({
            landing: ['task-42'],
            ada: [3],
            nobody: [],
        });
    });

    it('runs a command that reads the lookups on stdin and prints the ids', () => {
        const root = project({
            'resolve.mjs': `let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
    const lookups = JSON.parse(input);
    const ids = { 'Design the landing page': 42, Ada: 'u1' };
    console.log(JSON.stringify(Object.fromEntries(Object.entries(lookups).map(([key, lookup]) => [key, ids[Object.values(lookup.where)[0]] ?? null]))));
});`,
        });
        expect(runResolver({ command: 'node resolve.mjs', timeoutMs: 10000 }, requests, root)).toEqual({
            landing: [42],
            ada: ['u1'],
            nobody: [],
        });
        expect(() => runResolver({ command: 'exit 3', timeoutMs: 10000 }, requests, root)).toThrow(/status 3/);
        expect(() => runResolver({ command: 'echo not-json', timeoutMs: 10000 }, requests, root)).toThrow(
            /did not print JSON/
        );
    });
});
