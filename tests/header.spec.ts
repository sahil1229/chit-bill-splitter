import { test, expect } from '@playwright/test';
import { phone, noProblems } from './helpers';

test.afterEach(noProblems);

test('the CHIT header is centred on every screen size', async ({ browser }) => {
    for (const kind of ['pixel', 'iphone', 'narrow'] as const) {
        const p = await phone(browser, kind);
        for (const path of ['/', '/#pay=eyJ2IjoxLCJwYSI6InNhaGlsQG9rYXhpcyIsInBuIjoiU2FoaWwiLCJhbSI6MTAwLCJ0biI6IkNISVQifQ']) {
            await p.goto(path);
            const off = await p.evaluate(() => {
                const vw = document.documentElement.clientWidth;
                // Centre of the painted text, ignoring the letter-spacing gap after the last character.
                return ['.ch-stars', '.ch-mark h1', '.ch-tag'].map((s) => {
                    const el = document.querySelector(s)!; const range = document.createRange(); range.selectNodeContents(el);
                    const r = range.getBoundingClientRect(); const ls = parseFloat(getComputedStyle(el).letterSpacing) || 0;
                    return Math.abs(r.left + (r.width - ls) / 2 - vw / 2);
                });
            });
            for (const o of off) expect(o).toBeLessThan(2);
        }
        await p.context().close();
    }
});
