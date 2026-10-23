import { test, expect, type Page } from '@playwright/test';
import { dish, expectNoHorizontalScroll, phone, upiParams } from './helpers';
import { noProblems, problems } from './helpers';

// No UPI app exists in the test browser, so the automatic Google Pay open logs this; anything else fails.
const NO_APP = /Failed to launch '(intent|gpay|upi|phonepe|paytmmp):\/\/|scheme does not have a registered handler/;
test.afterEach(() => { problems.splice(0, problems.length, ...problems.filter((p) => !NO_APP.test(p))); noProblems(); });

const DISHES = ['Paneer Tikka', 'Butter Chicken', 'Garlic Naan', 'Dal Makhani', 'Veg Biryani', 'Chicken Biryani', 'Malai Kofta', 'Jeera Rice', 'Masala Papad', 'Tandoori Roti', 'Fish Curry', 'Prawn Fry', 'Gulab Jamun', 'Rasmalai', 'Masala Chai'];
const BILL = DISHES.map((d, i) => `${d} ${200 + i * 10}.00`).join('\n') + '\nCGST 2.5% 90.00\nSGST 2.5% 90.00';

async function hostBill(host: Page, bill = BILL) {
    await host.goto('/');
    await host.getByRole('button', { name: /Everyone/ }).click();
    await host.fill('#paste', bill);
    await host.getByRole('button', { name: 'Read items from text' }).click();
    await host.getByRole('button', { name: 'Next: people' }).click();
}
async function openTable(host: Page, name: string, upi: string, eating = true) {
    await host.fill('#hn', name);
    await host.fill('#hupi', upi);
    if (!eating) await host.getByLabel('I am not eating, just collecting the money').check();
    await host.getByRole('button', { name: 'Open the table' }).click();
    const url = (await host.getByRole('link', { name: 'Open join link' }).getAttribute('href'))!;
    expect(url).toContain('/#join=');
    expect(url).not.toContain('?join');
    await expect(host.getByText('● Connected')).toBeVisible();
    return url;
}
async function join(p: Page, url: string, name: string) {
    await p.goto(url);
    await p.getByLabel('Your name').fill(name);
    await p.getByRole('button', { name: 'Join' }).click();
    await expect(p.getByRole('heading', { name: 'Hi ' + name })).toBeVisible();
}
const item = (p: Page, d: string) => p.locator('li.lv-item', { hasText: d });
const pick = (p: Page, d: string) => item(p, d).getByRole('button', { name: /^I had this/ }).click();
const roster = (host: Page, name: string) => host.locator('.lv-list').first().locator(':scope > li', { hasText: name });
const saved = (p: Page) => expect(p.getByText('Saved with the host')).toBeVisible();
const next = (host: Page) => host.locator('.ch-next');
const amt = (host: Page, n: string) => host.locator('.sb-person').filter({ has: host.locator('.sb-pn strong', { hasText: new RegExp(`^${n}$`) }) }).locator('.sb-amt');
async function freeze(host: Page) {
    await next(host).getByRole('button', { name: 'Review and freeze →' }).click();
    await host.getByRole('button', { name: 'Freeze & send payment links' }).click();
    await host.getByRole('button', { name: 'Yes, freeze' }).click();
    await expect(next(host)).toContainText('Payment links sent');
}

test('live: host guided from invite to freeze; Android + iPhone diners get Google Pay straight away', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host);
    const url = await openTable(host, 'Sahil', 'sahil@okaxis');
    await expect(next(host)).toContainText('Next: get everyone to scan the QR');

    // Host picks their own dishes from the table screen
    await host.getByRole('button', { name: 'Pick my own dishes' }).click();
    for (const d of DISHES.slice(0, 5)) await dish(host, d).click();
    await host.getByRole('button', { name: 'Done, invite friends' }).click();

    const asha = await phone(browser, 'pixel'); const bilal = await phone(browser, 'iphone'); const spare = await phone(browser, 'pixel');
    await join(asha, url, 'Asha'); await join(bilal, url, 'Bilal'); await join(spare, url, 'Spare');
    await expect(next(host)).toContainText('Waiting for picks');
    for (const d of DISHES.slice(5, 10)) await pick(asha, d);
    for (const d of DISHES.slice(10)) await pick(bilal, d);
    await saved(asha); await saved(bilal);
    await expect(asha.getByText('your payment opens right here')).toBeVisible();

    // Host removes the accidental joiner; that phone is told
    await roster(host, 'Spare').getByRole('button', { name: 'Remove' }).click();
    await expect(roster(host, 'Spare')).toHaveCount(0);
    await expect(spare.getByRole('heading', { name: 'You are not on the list' })).toBeVisible();

    // Reloads on both sides keep seats and picks
    await asha.reload();
    await expect(asha.getByRole('heading', { name: 'Hi Asha' })).toBeVisible();
    await expect(item(asha, 'Malai Kofta').getByRole('button', { name: /^I had this/ })).toHaveAttribute('aria-pressed', 'true');
    await host.reload();
    await expect(host.getByText('● Connected')).toBeVisible();
    await pick(asha, 'Masala Chai');
    await saved(asha);
    await expect(item(bilal, 'Masala Chai')).toContainText('2 sharing');
    await expectNoHorizontalScroll(asha); await expectNoHorizontalScroll(bilal); await expectNoHorizontalScroll(host);

    // Everything picked: the host is told what to do next
    await expect(next(host)).toContainText('Everything is picked. Check and freeze');
    await freeze(host);
    await expect(amt(host, 'Asha')).toHaveText('₹1,580.00'); await expect(amt(host, 'Bilal')).toHaveText('₹1,490.00');

    // Android: Google Pay first, opened automatically; other apps and the system chooser underneath
    await expect(asha.getByRole('heading', { name: 'Pay Sahil' })).toBeVisible();
    const gpay = asha.locator('a[data-app="gpay"]');
    await expect(gpay).toHaveText('Pay ₹1,580.00 in Google Pay');
    expect(await gpay.getAttribute('href')).toMatch(/^intent:\/\/pay\?pa=sahil@okaxis&pn=Sahil&am=1580\.00&cu=INR&tn=CHIT%20\w+#Intent;scheme=upi;package=com\.google\.android\.apps\.nbu\.paisa\.user;end$/);
    expect(upiParams((await asha.locator('a[data-app="any"]').getAttribute('href'))!)).toMatchObject({ pa: 'sahil@okaxis', am: '1580.00' });
    await gpay.click();
    await expect(asha.getByText('Google Pay did not open')).toBeVisible({ timeout: 6000 });

    // iPhone: Google Pay's own scheme first
    await expect(bilal.getByRole('heading', { name: 'Pay Sahil' })).toBeVisible();
    const igpay = (await bilal.locator('a[data-app="gpay"]').getAttribute('href'))!;
    expect(igpay.startsWith('gpay://upi/pay?')).toBe(true);
    expect(upiParams(igpay)).toMatchObject({ pa: 'sahil@okaxis', pn: 'Sahil', am: '1490.00', cu: 'INR' });
    for (const [app, scheme] of [['phonepe', 'phonepe://pay?'], ['paytm', 'paytmmp://pay?'], ['any', 'upi://pay?']]) expect((await bilal.locator(`a[data-app="${app}"]`).getAttribute('href'))!.startsWith(scheme)).toBe(true);
    await expect(bilal.locator('svg.lv-qr')).toHaveCount(0); // no payment QR codes

    // Reload after freezing: same payment comes back
    await bilal.reload();
    await expect(bilal.locator('a[data-app="gpay"]')).toHaveText('Pay ₹1,490.00 in Google Pay');

    // Host ticks people off; the next step says when it is done
    await host.getByRole('button', { name: /Table$/ }).click();
    await expect(host.getByRole('heading', { name: 'Table frozen' })).toBeVisible();
    await host.getByRole('button', { name: 'Track payments →' }).click();
    for (const n of ['Asha', 'Bilal']) await host.locator('.sb-person').filter({ has: host.locator('.sb-pn strong', { hasText: new RegExp(`^${n}$`) }) }).getByRole('switch').click();
    await expect(next(host)).toContainText('All paid ✓');
});

test('live: 2 gravies shared by 7 are split 7 ways; 6 naans are counted 2, 1 and 3', async ({ browser }) => {
    test.setTimeout(180_000);
    const host = await phone(browser, 'pixel');
    await hostBill(host, '2 Dal Makhani 700.00\n6 Garlic Naan 360.00\nTotal 1060.00');
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const naans: Record<string, number> = { A: 2, B: 1, C: 3 };
    const diners: Page[] = [];
    for (const n of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
        const p = await phone(browser, n === 'B' ? 'iphone' : 'pixel'); diners.push(p);
        await join(p, url, n);
        await expect(item(p, 'Dal Makhani')).toContainText('2 plates, shared');
        await pick(p, 'Dal Makhani');
        for (let k = 0; k < (naans[n] ?? 0); k++) await p.getByRole('button', { name: 'More Garlic Naan' }).click();
        await saved(p);
    }
    await expect(diners[6].getByRole('button', { name: 'More Garlic Naan' })).toBeDisabled(); // all 6 taken
    await expect(item(diners[6], 'Dal Makhani')).toContainText('7 sharing · ₹100.00 each');
    await freeze(host);
    await expect(amt(host, 'A')).toHaveText('₹220.00'); await expect(amt(host, 'B')).toHaveText('₹160.00'); await expect(amt(host, 'C')).toHaveText('₹280.00'); await expect(amt(host, 'G')).toHaveText('₹100.00');
    await expect(diners[1].locator('a[data-app="gpay"]')).toHaveText('Pay ₹160.00 in Google Pay');
});

test('live: a dish can switch between shared and counted while nobody else has picked it', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host, '3 Masala Cola 240.00\n2 Paneer Butter Masala 600.00\nTotal 840.00');
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const a = await phone(browser, 'pixel'); await join(a, url, 'A');
    await expect(item(a, 'Masala Cola').getByRole('button', { name: 'More Masala Cola' })).toBeVisible();
    await item(a, 'Masala Cola').getByRole('button', { name: 'We shared these instead' }).click();
    await expect(item(a, 'Masala Cola').getByRole('button', { name: /^I had this/ })).toBeVisible();
    await item(a, 'Paneer Butter Masala').getByRole('button', { name: 'Count how many I had instead' }).click();
    await a.getByRole('button', { name: 'More Paneer Butter Masala' }).click();
    await saved(a);
    await expect(item(a, 'Paneer Butter Masala')).toContainText('You: 1 of 2 · ₹300.00');
});

test('live: collector not dining, join by pasted link', async ({ browser }) => {
    const host = await phone(browser, 'iphone');
    await hostBill(host);
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const asha = await phone(browser, 'pixel');
    await asha.goto('/');
    await asha.getByLabel('Join link').fill(url);
    await asha.getByLabel('Your name').fill('Asha');
    await asha.getByRole('button', { name: 'Join' }).click();
    await expect(asha.getByRole('heading', { name: 'Hi Asha' })).toBeVisible();
    const dev = await phone(browser, 'pixel'); await join(dev, url, 'Dev');
    for (const d of DISHES.slice(0, 8)) await pick(asha, d);
    for (const d of DISHES.slice(8)) await pick(dev, d);
    await saved(asha); await saved(dev);
    await expect(roster(host, 'Mom')).toHaveCount(0);
    await freeze(host);
    expect(upiParams((await dev.locator('a[data-app="gpay"]').getAttribute('href'))!)).toMatchObject({ pa: 'mom@oksbi', pn: 'Mom', am: '2260.00' });
});

test('live: unpicked dishes can be split equally from the next-step card', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host, 'Masala Dosa 180.00\nFilter Coffee 60.00\nTotal 240.00');
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const a = await phone(browser, 'pixel'); await join(a, url, 'A');
    const b = await phone(browser, 'pixel'); await join(b, url, 'B');
    await pick(a, 'Masala Dosa'); await saved(a);
    await expect(next(host)).toContainText('1 dish not picked yet');
    await next(host).getByRole('button', { name: 'Split the rest equally' }).click();
    await expect(next(host)).toContainText('Everything is picked');
    await freeze(host);
    await expect(a.locator('a[data-app="gpay"]')).toHaveText('Pay ₹210.00 in Google Pay');
    await expect(b.locator('a[data-app="gpay"]')).toHaveText('Pay ₹30.00 in Google Pay');
});

test('live: closing the table before freezing tells diners', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host);
    const url = await openTable(host, 'Sahil', 'sahil@okaxis');
    const asha = await phone(browser, 'pixel'); await join(asha, url, 'Asha');
    await host.getByRole('button', { name: 'Close the table without splitting' }).click();
    await expect(host.getByRole('heading', { name: 'Table closed' })).toBeVisible();
    await expect(asha.getByRole('heading', { name: 'The table is closed' })).toBeVisible();
});

test('live: a rate-limited join waits, shows the relay is busy, and keeps one seat', async ({ browser, request }) => {
    test.skip(!!process.env.CHIT_URL, 'needs the local relay to simulate rate limits');
    const host = await phone(browser, 'pixel');
    await hostBill(host);
    const url = await openTable(host, 'Sahil', 'sahil@okaxis');
    const asha = await phone(browser, 'pixel');
    await asha.goto(url);
    await asha.getByLabel('Your name').fill('Asha');
    await request.post('http://localhost:4174/__limit?n=2');
    await asha.getByRole('button', { name: 'Join' }).click();
    await expect(asha.getByText('The free relay is busy. Retrying automatically.')).toBeVisible();
    await expect(asha.getByRole('heading', { name: 'Hi Asha' })).toBeVisible({ timeout: 40_000 });
    await expect(host.getByRole('heading', { name: 'Who is here (2)' })).toBeVisible();
    await pick(asha, 'Paneer Tikka');
    await saved(asha);
    await asha.reload();
    await expect(asha.getByRole('heading', { name: 'Hi Asha' })).toBeVisible();
    await expect(host.getByRole('heading', { name: 'Who is here (2)' })).toBeVisible();
    // The simulated 429s are logged by the browser; anything else still fails the test.
    problems.splice(0, problems.length, ...problems.filter((p) => !p.includes('status of 429')));
});

test('live race: two people mash + on the same naans; the total never passes 6 and the loser is told', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host, '6 Garlic Naan 360.00\nTotal 360.00');
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const a = await phone(browser, 'pixel'); await join(a, url, 'Asha');
    const b = await phone(browser, 'iphone'); await join(b, url, 'Bilal');
    // Both see 6 left and both grab 4, at the same time.
    await Promise.all([a, b].map(async (p) => { for (let k = 0; k < 4; k++) await p.getByRole('button', { name: 'More Garlic Naan' }).click(); }));
    await saved(a); await saved(b);
    const got = async (p: Page) => Number(await item(p, 'Garlic Naan').locator('output').innerText());
    await expect.poll(async () => (await got(a)) + (await got(b))).toBe(6);
    const [ga, gb] = [await got(a), await got(b)];
    expect([ga, gb].sort()).toEqual([2, 4]);
    const loser = ga === 2 ? a : b;
    await expect(item(loser, 'Garlic Naan')).toContainText('Someone got there first: only 2 left, so you have 2.');
    await expect(loser.getByRole('button', { name: 'More Garlic Naan' })).toBeDisabled();
    // Then they fight over it: the winner gives one back, the loser takes it.
    const winner = loser === a ? b : a;
    await winner.getByRole('button', { name: 'Fewer Garlic Naan' }).click(); await saved(winner);
    await expect(loser.getByRole('button', { name: 'More Garlic Naan' })).toBeEnabled();
    await loser.getByRole('button', { name: 'More Garlic Naan' }).click(); await saved(loser);
    await expect.poll(async () => [await got(winner), await got(loser)]).toEqual([3, 3]);
    await expect(next(host)).toContainText('Everything is picked');
});

test('live race: the host fixes Asha on the host phone while Asha taps another dish; both stick', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host, '6 Garlic Naan 360.00\nDal Makhani 400.00\nTotal 760.00');
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const a = await phone(browser, 'pixel'); await join(a, url, 'Asha');
    const b = await phone(browser, 'pixel'); await join(b, url, 'Bilal');
    for (let k = 0; k < 3; k++) await a.getByRole('button', { name: 'More Garlic Naan' }).click();
    await saved(a);
    // Host corrects Asha to 1 naan, while Asha taps Dal on her own phone at the same moment.
    await host.getByText('Who had what').click();
    await host.getByRole('button', { name: 'Fix picks on my phone' }).click();
    await host.getByRole('group', { name: 'Whose picks to fix' }).getByRole('button', { name: /Asha/ }).click();
    await Promise.all([
        (async () => { await host.getByRole('button', { name: 'Fewer Garlic Naan Asha had' }).click(); await host.getByRole('button', { name: 'Fewer Garlic Naan Asha had' }).click(); })(),
        pick(a, 'Dal Makhani'),
    ]);
    await saved(a);
    await expect(item(a, 'Garlic Naan').locator('output')).toHaveText('1');
    await expect(item(a, 'Dal Makhani').getByRole('button', { name: /^I had this/ })).toHaveAttribute('aria-pressed', 'true');
    await host.getByRole('button', { name: 'Done, invite friends' }).click();
    await host.getByText('Who had what').click();
    await expect(host.locator('details .lv-list li', { hasText: 'Garlic Naan' })).toContainText('Asha ×1');
    await expect(host.locator('details .lv-list li', { hasText: 'Dal Makhani' })).toContainText('Asha');
});

test('live race: a tap that lands after the host froze is not silently lost', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host, 'Masala Dosa 180.00\nFilter Coffee 60.00\nTotal 240.00');
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const a = await phone(browser, 'pixel'); await join(a, url, 'Asha');
    await pick(a, 'Masala Dosa'); await pick(a, 'Filter Coffee'); await saved(a);
    await next(host).getByRole('button', { name: 'Review and freeze →' }).click();
    await host.getByRole('button', { name: 'Freeze & send payment links' }).click();
    await item(a, 'Filter Coffee').getByRole('button', { name: /^I had this/ }).click(); // Asha un-ticks coffee...
    await host.getByRole('button', { name: 'Yes, freeze' }).click();                    // ...as the host freezes
    await expect(a.getByText('The host froze the bill before your last change reached them')).toBeVisible();
    await expect(a.locator('a[data-app="gpay"]')).toHaveText('Pay ₹240.00 in Google Pay');
});

test('smooth: refreshing a diner shows only the current amount, never older ones', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host);
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const a = await phone(browser, 'pixel'); await join(a, url, 'Asha');
    // Build up a history of different amounts on the relay
    for (const d of DISHES.slice(0, 6)) { await pick(a, d); await saved(a); }
    const final = await a.locator('.lv-total b').innerText();
    // Record every amount and heading the page paints while it reloads
    await a.addInitScript(() => {
        (window as any).__seen = [];
        new MutationObserver(() => { const t = document.querySelector('.lv-total b')?.textContent; const h = document.querySelector('.lv-card h2')?.textContent; const seen = (window as any).__seen; const v = `${h}|${t ?? ''}`; if (seen[seen.length - 1] !== v) seen.push(v); }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await a.reload();
    await expect(a.locator('.lv-total b')).toHaveText(final);
    await a.waitForTimeout(1500);
    const seen: string[] = await a.evaluate(() => (window as any).__seen);
    const amounts = seen.map((v) => v.split('|')[1]).filter(Boolean);
    expect(new Set(amounts)).toEqual(new Set([final]));
    expect(seen.map((v) => v.split('|')[0])).not.toContain('Join the table');
    expect(seen.map((v) => v.split('|')[0])).not.toContain('You are not on the list');
});

test('smooth: a single tap is confirmed by the host within about a second', async ({ browser }) => {
    test.skip(!!process.env.CHIT_URL, 'timing depends on the public relay');
    const host = await phone(browser, 'pixel');
    await hostBill(host);
    const url = await openTable(host, 'Mom', 'mom@oksbi', false);
    const a = await phone(browser, 'pixel'); await join(a, url, 'Asha');
    await a.waitForTimeout(2500); // quiet spell
    const t0 = Date.now();
    await pick(a, 'Paneer Tikka');
    await expect(a.locator('.lv-total.is-updating')).toHaveCount(1);
    await saved(a);
    expect(Date.now() - t0).toBeLessThan(1500);
    await expect(a.locator('.lv-total.is-updating')).toHaveCount(0);
});
