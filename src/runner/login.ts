import type { Page } from 'playwright-core';
import type {
    AccountValue,
    DeclarativeLogin,
    DemoStudioConfig,
    Login,
    LoginContext,
    LoginStep,
    ValueSource,
} from '../config/schema.ts';
import { locate } from './targets.ts';

export interface PlayableAccount {
    id: string;
    description?: string;
    values: Record<string, AccountValue>;
    login: Login;
}

/** Each config account with the login it uses: its own, or the config's default. */
export function playableAccounts(config: DemoStudioConfig): Map<string, PlayableAccount> {
    const accounts = new Map<string, PlayableAccount>();
    for (const account of config.accounts) {
        const login = account.login ?? config.login;
        if (login) {
            accounts.set(account.id, { ...account, login });
        }
    }

    return accounts;
}

/** Scenario accounts the runner could not log in as. */
export function accountErrors(accountIds: string[], config: DemoStudioConfig): string[] {
    const playable = playableAccounts(config);
    const declared = new Set(config.accounts.map((account) => account.id));

    return [...new Set(accountIds)]
        .filter((id) => !playable.has(id))
        .map((id) =>
            declared.has(id)
                ? `Account "${id}": no login in the config (set accounts[].login, or a default login).`
                : `Account "${id}": not declared in the config's accounts.`
        );
}

export type EnvReader = (name: string) => string | null;

/** Values are resolved at the last moment and never printed: an error names the variable, not its content. */
export function resolveValue(source: ValueSource, account: PlayableAccount, env: EnvReader): string {
    if ('string' === typeof source) {
        return source;
    }
    if ('env' in source) {
        const value = env(source.env);
        if (null === value) {
            throw new Error(`Environment variable ${source.env} is not set (needed to log in as "${account.id}").`);
        }

        return value;
    }
    const value = account.values[source.account];
    if (undefined === value) {
        throw new Error(`Account "${account.id}" has no value "${source.account}" (accounts[].values).`);
    }

    return resolveValue(value, account, env);
}

export function loginContext(
    account: PlayableAccount,
    options: { baseUrl: string; language: string; timeoutMs: number; env: EnvReader }
): LoginContext {
    return {
        baseUrl: options.baseUrl,
        language: options.language,
        timeoutMs: options.timeoutMs,
        value: (key) => resolveValue({ account: key }, account, options.env),
        env: (name) => resolveValue({ env: name }, account, options.env),
    };
}

async function runLoginStep(
    page: Page,
    step: LoginStep,
    account: PlayableAccount,
    context: LoginContext,
    env: EnvReader
) {
    if ('goto' in step) {
        await page.goto(step.goto.replace('{language}', encodeURIComponent(context.language)), { waitUntil: 'load' });

        return;
    }
    const target = 'click' in step ? step.click : 'check' in step ? step.check : step.fill;
    const locator = locate(page, target).first();
    if (step.optional && !(await locator.isVisible())) {
        return;
    }
    if ('click' in step) {
        await locator.click({ timeout: context.timeoutMs });
        await page.waitForLoadState('load');
    } else if ('check' in step) {
        await locator.check({ force: true, timeout: context.timeoutMs });
    } else {
        await locator.fill(resolveValue(step.value, account, env), { timeout: context.timeoutMs });
    }
}

async function declarativeLogin(
    page: Page,
    login: DeclarativeLogin,
    account: PlayableAccount,
    context: LoginContext,
    env: EnvReader
): Promise<void> {
    await page.goto(login.url, { waitUntil: 'load' });
    for (const field of login.fields) {
        await locate(page, field.target).fill(resolveValue(field.value, account, env), { timeout: context.timeoutMs });
    }
    await locate(page, login.submit).click({ timeout: context.timeoutMs });
    await page.waitForLoadState('load');
    const path = new URL(page.url()).pathname;
    const refused = login.success.url
        ? !path.startsWith(login.success.url)
        : !login.success.visible && path.startsWith(new URL(login.url, page.url()).pathname);
    if (refused) {
        throw new Error(`Login refused for account "${account.id}" (landed on ${path}).`);
    }
    if (login.success.visible) {
        await locate(page, login.success.visible)
            .first()
            .waitFor({ state: 'visible', timeout: context.timeoutMs })
            .catch(() => {
                throw new Error(`Login refused for account "${account.id}": success element not visible.`);
            });
    }
    for (const step of login.after) {
        await runLoginStep(page, step, account, context, env);
    }
}

/** Logs in off camera: what the account needs before any scene (terms, language) is not part of the demo. */
export async function logIn(
    page: Page,
    account: PlayableAccount,
    options: { baseUrl: string; language: string; timeoutMs: number; env: EnvReader }
): Promise<void> {
    const context = loginContext(account, options);
    if ('none' === account.login) {
        return;
    }
    if ('function' === typeof account.login) {
        await account.login(page, { id: account.id, description: account.description }, context);

        return;
    }
    await declarativeLogin(page, account.login, account, context, options.env);
}
