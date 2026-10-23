import { devices, expect, type Browser, type Page } from '@playwright/test';

const { defaultBrowserType: _a, ...iphone } = devices['iPhone 14'];
const { defaultBrowserType: _b, ...pixel } = devices['Pixel 7'];
export const PHONES = { iphone, pixel, narrow: { ...pixel, viewport: { width: 320, height: 640 } } };

/** Page errors and console errors from every phone in the current test. */
export const problems: string[] = [];
export function noProblems() { const p = problems.splice(0); expect(p).toEqual([]); }

/** A separate phone: its own context, so its own storage and keys. */
export async function phone(browser: Browser, kind: keyof typeof PHONES = 'pixel'): Promise<Page> {
    const ctx = await browser.newContext({ ...PHONES[kind], baseURL: 'http://localhost:4175/', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    return page;
}

export const dish = (page: Page, name: string) => page.getByRole('button', { name: new RegExp('^' + name + ',') });

/** upi:// links: assert the exact payment request a UPI app would receive. */
export function upiParams(href: string) {
    const q = href.slice(href.indexOf('?') + 1).split('#')[0];
    return Object.fromEntries(q.split('&').map((kv) => { const [k, v] = kv.split('='); return [k, decodeURIComponent(v)]; }));
}

export async function clipboard(page: Page) { return page.evaluate(() => navigator.clipboard.readText()); }

export async function expectNoHorizontalScroll(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}
