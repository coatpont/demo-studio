import type { Locator, Page } from 'playwright-core';
import type { Target } from '../schema/scenario.ts';

type Root = Page | Locator;
type AriaRole = Parameters<Page['getByRole']>[0];

export function describeTarget(target: Target): string {
    const own =
        target.role !== undefined
            ? `${target.role}${target.name ? ` "${target.name}"` : ''}`
            : target.label !== undefined
              ? `field "${target.label}"`
              : target.text !== undefined
                ? `text "${target.text}"`
                : target.placeholder !== undefined
                  ? `placeholder "${target.placeholder}"`
                  : target.testId !== undefined
                    ? `test-id "${target.testId}"`
                    : `css "${target.css}"`;
    const nth = undefined !== target.nth ? ` #${target.nth + 1}` : '';

    return target.within ? `${own}${nth} within ${describeTarget(target.within)}` : `${own}${nth}`;
}

export function locate(page: Page, target: Target): Locator {
    const root: Root = target.within ? locate(page, target.within) : page;
    const exact = target.exact ?? false;
    let locator: Locator;
    if (undefined !== target.role) {
        locator = root.getByRole(target.role as AriaRole, target.name ? { name: target.name, exact } : {});
    } else if (undefined !== target.label) {
        locator = root.getByLabel(target.label, { exact });
    } else if (undefined !== target.text) {
        locator = root.getByText(target.text, { exact });
    } else if (undefined !== target.placeholder) {
        locator = root.getByPlaceholder(target.placeholder, { exact });
    } else if (undefined !== target.testId) {
        locator = root.getByTestId(target.testId);
    } else {
        locator = root.locator(target.css ?? '');
    }

    return undefined !== target.nth ? locator.nth(target.nth) : locator;
}
