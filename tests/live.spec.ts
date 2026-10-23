import { test, expect, type Page } from '@playwright/test';
import { dish, expectNoHorizontalScroll, phone, upiParams } from './helpers';
import { noProblems } from './helpers';

test.afterEach(noProblems);

const DISHES = ['Paneer Tikka', 'Butter Chicken', 'Garlic Naan', 'Dal Makhani', 'Veg Biryani', 'Chicken Biryani', 'Malai Kofta', 'Jeera Rice', 'Masala Papad', 'Tandoori Roti', 'Fish Curry', 'Prawn Fry', 'Gulab Jamun', 'Rasmalai', 'Masala Chai'];
const BILL = DISHES.map((d, i) => `${d} ${200 + i * 10}.00`).join('\n') + '\nCGST 2.5% 90.00\nSGST 2.5% 90.00';

async function hostBill(host: Page) {
    await host.goto('/');
    await host.getByRole('button', { name: /Everyone/ }).click();
    await host.fill('#paste', BILL);
    await host.getByRole('button', { name: 'Read items from text' }).click();
    await expect(host.getByText('Read 15 items')).toBeVisible();
    await host.getByRole('button', { name: 'Next: people' }).click();
}
async function joinUrl(host: Page) {
    const url = (await host.getByRole('link', { name: 'Open join link' }).getAttribute('href'))!;
    expect(url).toContain('/#join=');
    expect(url).not.toContain('?join');
    await expect(host.getByText('Connected to the relay')).toBeVisible();
    return url;
}
async function join(p: Page, url: string, name: string) {
    await p.goto(url);
    await p.getByLabel('Your name').fill(name);
    await p.getByRole('button', { name: 'Join' }).click();
    await expect(p.getByRole('heading', { name: 'Hi ' + name })).toBeVisible();
}
const pick = (p: Page, d: string) => p.locator('li.lv-item', { hasText: d }).getByRole('button').click();
const roster = (host: Page, name: string) => host.locator('.lv-list').first().locator(':scope > li', { hasText: name });
const saved = (p: Page) => expect(p.getByText('Saved with the host')).toBeVisible();

test('live: host dining, Android + iPhone diners, reloads, removal, freeze, approve, UPI apps', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host);
    await host.fill('#hn', 'Sahil');
    await host.getByText('Payment details (optional for now)').click();
    await host.fill('#hupi', 'sahil@okaxis');
    await host.getByRole('button', { name: 'Pick my food' }).click();
    for (const d of DISHES.slice(0, 5)) await dish(host, d).click();
    await host.getByRole('button', { name: 'Done, invite friends' }).click();
    const url = await joinUrl(host);

    const asha = await phone(browser, 'pixel'); const bilal = await phone(browser, 'iphone'); const spare = await phone(browser, 'pixel');
    await join(asha, url, 'Asha'); await join(bilal, url, 'Bilal'); await join(spare, url, 'Spare');
    for (const d of DISHES.slice(5, 10)) await pick(asha, d);
    for (const d of DISHES.slice(10)) await pick(bilal, d);
    await saved(asha); await saved(bilal);

    // Host removes the accidental joiner; that phone is told
    const spareRow = roster(host, 'Spare');
    await spareRow.getByRole('button', { name: 'Remove' }).click();
    await expect(spareRow).toHaveCount(0);
    await expect(spare.getByRole('heading', { name: 'You are not on the list' })).toBeVisible();
    await expect(host.getByText('Every dish has an owner.')).toBeVisible();

    // Diner reload keeps the same seat and picks
    await asha.reload();
    await expect(asha.getByRole('heading', { name: 'Hi Asha' })).toBeVisible();
    await expect(asha.locator('li.lv-item', { hasText: 'Malai Kofta' }).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await expect(roster(host, 'Asha')).toHaveCount(1);
    await expect(host.getByRole('heading', { name: 'Who is here (3)' })).toBeVisible();

    // Host reload: diners keep getting updates afterwards
    await host.reload();
    await expect(host.getByText('Connected to the relay')).toBeVisible();
    await pick(asha, 'Masala Chai');
    await saved(asha);
    await expect(bilal.locator('li.lv-item', { hasText: 'Masala Chai' })).toContainText('2 eating');
    await expectNoHorizontalScroll(asha); await expectNoHorizontalScroll(bilal); await expectNoHorizontalScroll(host);

    // Freeze and approve
    await host.getByRole('button', { name: /Split$/ }).click();
    const frozen = { Asha: await host.locator('.sb-person', { hasText: 'Asha' }).locator('.sb-amt').innerText(), Bilal: await host.locator('.sb-person', { hasText: 'Bilal' }).locator('.sb-amt').innerText() };
    expect(frozen).toEqual({ Asha: '₹1,580.00', Bilal: '₹1,490.00' });
    await host.getByRole('button', { name: 'Review final details' }).click();
    await host.getByRole('button', { name: 'Confirm and freeze table' }).click();
    await expect(host.getByText('Finalized payment details')).toBeVisible();
    await expect(asha.getByText('Waiting for the host to approve your payment')).toBeVisible();
    await host.getByRole('button', { name: /Table$/ }).click();
    await host.getByRole('button', { name: /^Approve Asha/ }).click();
    await host.getByRole('button', { name: /^Approve Bilal/ }).click();

    // Android: system chooser link plus per-app intents
    await asha.getByRole('button', { name: 'I checked these details' }).click();
    const primary = asha.locator('a[data-app="any"]');
    await expect(primary).toHaveText('Pay with a UPI app · ₹1,580.00');
    expect(upiParams((await primary.getAttribute('href'))!)).toMatchObject({ pa: 'sahil@okaxis', pn: 'Sahil', am: '1580.00', cu: 'INR' });
    expect(await asha.locator('a[data-app="phonepe"]').getAttribute('href')).toMatch(/^intent:\/\/pay\?pa=sahil@okaxis&.*am=1580\.00.*package=com\.phonepe\.app;end$/);
    // Tapping with no UPI app installed falls back to a clear message
    await primary.click();
    await expect(asha.getByText(/did not seem to open/)).toBeVisible({ timeout: 6000 });

    // iPhone: one button per app scheme
    await bilal.getByRole('button', { name: 'I checked these details' }).click();
    for (const [app, scheme] of [['gpay', 'gpay://upi/pay?'], ['phonepe', 'phonepe://pay?'], ['paytm', 'paytmmp://pay?'], ['any', 'upi://pay?']]) {
        const href = (await bilal.locator(`a[data-app="${app}"]`).getAttribute('href'))!;
        expect(href.startsWith(scheme)).toBe(true);
        expect(upiParams(href)).toMatchObject({ pa: 'sahil@okaxis', am: '1490.00' });
    }
    await bilal.getByRole('button', { name: /Show UPI QR/ }).click();
    expect(upiParams((await bilal.locator('svg.lv-qr').getAttribute('data-url'))!).am).toBe('1490.00');

    // Diner reload after payment approval: same frozen details come back
    await bilal.reload();
    await bilal.getByRole('button', { name: 'I checked these details' }).click();
    await expect(bilal.locator('a[data-app="gpay"]')).toBeVisible();
});

test('live: collector not dining, join by pasted link, close table', async ({ browser }) => {
    const host = await phone(browser, 'iphone');
    await hostBill(host);
    await host.getByText('Someone else is collecting, or I am not dining').click();
    await host.getByRole('radio', { name: 'Not dining' }).click();
    await host.fill('#hn', 'Mom');
    await host.getByText('Payment details (optional for now)').click();
    await host.fill('#hupi', 'mom@oksbi');
    await host.getByRole('button', { name: 'Open the table' }).click();
    const url = await joinUrl(host);

    // Join by pasting the link on the start screen
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
    await expect(host.getByText('Every dish has an owner.')).toBeVisible();
    await expect(roster(host, 'Mom')).toHaveCount(0);

    await host.getByRole('button', { name: /Split$/ }).click();
    await host.getByRole('button', { name: 'Review final details' }).click();
    await host.getByRole('button', { name: 'Confirm and freeze table' }).click();
    await host.getByRole('button', { name: /Table$/ }).click();
    await host.getByRole('button', { name: /^Approve Dev/ }).click();
    await dev.getByRole('button', { name: 'I checked these details' }).click();
    expect(upiParams((await dev.locator('a[data-app="any"]').getAttribute('href'))!)).toMatchObject({ pa: 'mom@oksbi', pn: 'Mom', am: '2260.00' });
    await expect(asha.getByText('Waiting for the host to approve your payment')).toBeVisible();
});

test('live: closing the table before freezing tells diners', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await hostBill(host);
    await host.fill('#hn', 'Sahil');
    await host.getByRole('button', { name: 'Pick my food' }).click();
    await host.getByRole('button', { name: 'Done, invite friends' }).click();
    const url = await joinUrl(host);
    const asha = await phone(browser, 'pixel'); await join(asha, url, 'Asha');
    await host.getByRole('button', { name: 'Close the table' }).click();
    await expect(host.getByRole('heading', { name: 'Table closed' })).toBeVisible();
    await expect(asha.getByRole('heading', { name: 'The table is closed' })).toBeVisible();
});

test('live: 6 naans eaten 2, 1 and 3 on separate phones are charged by count', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await host.goto('/');
    await host.getByRole('button', { name: /Everyone/ }).click();
    await host.fill('#paste', '6 Garlic Naan 360.00\nTotal 360.00');
    await host.getByRole('button', { name: 'Read items from text' }).click();
    await host.getByRole('button', { name: 'Next: people' }).click();
    await host.getByText('Someone else is collecting, or I am not dining').click();
    await host.getByRole('radio', { name: 'Not dining' }).click();
    await host.fill('#hn', 'Mom');
    await host.getByText('Payment details (optional for now)').click();
    await host.fill('#hupi', 'mom@oksbi');
    await host.getByRole('button', { name: 'Open the table' }).click();
    const url = await joinUrl(host);

    const counts: [string, 'pixel' | 'iphone', number][] = [['Asha', 'pixel', 2], ['Bilal', 'iphone', 1], ['Chitra', 'pixel', 3]];
    const phones: Record<string, Page> = {};
    for (const [name, kind, n] of counts) {
        const p = await phone(browser, kind); phones[name] = p; await join(p, url, name);
        for (let k = 0; k < n; k++) await p.getByRole('button', { name: 'More Garlic Naan' }).click();
        await saved(p);
    }
    // All 6 are taken: nobody can add a 7th
    await expect(phones.Bilal.getByRole('button', { name: 'More Garlic Naan' })).toBeDisabled();
    await expect(phones.Chitra.getByText('You: 3 of 6 · ₹180.00')).toBeVisible();
    await expect(host.getByText('Every dish has an owner.')).toBeVisible();

    await host.getByRole('button', { name: /Split$/ }).click();
    const amt = (n: string) => host.locator('.sb-person', { hasText: n }).locator('.sb-amt');
    await expect(amt('Asha')).toHaveText('₹120.00'); await expect(amt('Bilal')).toHaveText('₹60.00'); await expect(amt('Chitra')).toHaveText('₹180.00');
    await host.getByRole('button', { name: 'Review final details' }).click();
    await host.getByRole('button', { name: 'Confirm and freeze table' }).click();
    await host.getByRole('button', { name: /Table$/ }).click();
    await host.getByRole('button', { name: /^Approve Bilal/ }).click();
    await phones.Bilal.getByRole('button', { name: 'I checked these details' }).click();
    expect(upiParams((await phones.Bilal.locator('a[data-app="gpay"]').getAttribute('href'))!)).toMatchObject({ pa: 'mom@oksbi', am: '60.00' });
});
