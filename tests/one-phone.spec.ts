import { test, expect } from '@playwright/test';
import { clipboard, dish, expectNoHorizontalScroll, phone, upiParams } from './helpers';
import { noProblems } from './helpers';

test.afterEach(noProblems);

test('one phone: bill to frozen split, QR, pay link on the payer phone, PDF and reload', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await host.goto('/');
    await host.getByRole('button', { name: /One phone/ }).click();

    // Bill
    await host.getByRole('button', { name: 'Try sample bill' }).click();
    await expect(host.getByText(/Read 7 items and 3 charges/)).toBeVisible();
    await expect(host.getByText('Total printed on bill')).toBeVisible();
    await host.getByRole('button', { name: 'Next: people' }).click();

    // People: Asha collects
    for (const n of ['Asha', 'Bilal', 'Chitra']) { await host.getByLabel('Name', { exact: true }).fill(n); await host.getByRole('button', { name: 'Add', exact: true }).click(); }
    await expect(host.getByRole('radio', { name: 'Asha' })).toHaveAttribute('aria-checked', 'true');
    await host.fill('#upi', 'asha@okaxis');
    await host.getByRole('button', { name: 'Next: pass the phone' }).click();

    // Pass the phone round
    // Single dishes are a tap; several of one dish are counted (6 naans: Asha 2, Bilal 1, Chitra 3)
    const picks: Record<string, [string, number][]> = { Asha: [['Paneer Tikka', 1], ['Garlic Naan', 2]], Bilal: [['Butter Chicken', 2], ['Dal Makhani', 1], ['Garlic Naan', 1]], Chitra: [['Masala Cola', 4], ['Gulab Jamun', 2], ['Garlic Naan', 3]] };
    for (const [n, ds] of Object.entries(picks)) {
        await host.getByRole('button', { name: `${n} here. Show me the food` }).click();
        for (const [d, count] of ds) {
            await dish(host, d).click();
            for (let k = 1; k < count; k++) await host.getByRole('button', { name: `More ${d} ${n} had` }).click();
        }
        if (n === 'Chitra') await expect(host.getByRole('button', { name: 'More Garlic Naan Chitra had' })).toBeDisabled(); // only 3 left
        await host.getByRole('button', { name: n === 'Chitra' ? 'Done, see split' : 'Done, pass on' }).click();
    }

    // Split: everything assigned, totals add up to the printed bill. Naan is ₹60 each.
    await expect(host.getByText('Every rupee is assigned and shares add up to the bill')).toBeVisible();
    await expect(host.locator('.sb-big')).toHaveText('₹3,268.66');
    const card = (n: string) => host.locator('.sb-person').filter({ has: host.locator('.sb-pn strong', { hasText: new RegExp(`^${n}$`) }) });
    const amount = async (n: string) => (await card(n).locator('.sb-amt').innerText());
    expect([await amount('Asha'), await amount('Bilal'), await amount('Chitra')]).toEqual(['₹736.24', '₹1,596.21', '₹936.21']) // each charge line's leftover paisa goes to the first diner;
    await card('Chitra').locator('.sb-person-top').click();
    await expect(card('Chitra').getByText('3 of 6')).toBeVisible();
    const bilal = await amount('Bilal');
    await expectNoHorizontalScroll(host);

    // Freeze
    await host.getByRole('button', { name: 'Review final details' }).click();
    await host.getByRole('button', { name: 'Confirm and freeze table' }).click();
    await expect(host.getByText('Finalized payment details')).toBeVisible();

    // QR on the collector's phone carries the frozen amount for Bilal
    const bilalCard = host.locator('.sb-person', { hasText: 'Bilal' });
    await bilalCard.getByRole('button', { name: 'Show QR for Bilal' }).click();
    const qr = upiParams((await bilalCard.locator('svg.lv-qr').getAttribute('data-url'))!);
    expect(qr).toMatchObject({ pa: 'asha@okaxis', pn: 'Asha', cu: 'INR', am: bilal.replace(/[₹,]/g, '') });

    // Pay link goes to Bilal's own phone (iPhone) and opens UPI apps there
    await bilalCard.getByRole('button', { name: 'Send Bilal a pay link' }).click();
    const shared = await clipboard(host);
    const link = shared.match(/https?:\/\/\S+#pay=\S+/)![0];
    const bphone = await phone(browser, 'iphone');
    await bphone.goto(link);
    await expect(bphone.getByRole('heading', { name: 'Pay Asha' })).toBeVisible();
    await expect(bphone.locator('.lv-total b')).toHaveText(bilal);
    const apps = bphone.locator('.ch-paybox a[data-app]');
    await expect(apps).toHaveCount(4);
    for (const [app, scheme] of [['gpay', 'gpay://upi/pay?'], ['phonepe', 'phonepe://pay?'], ['paytm', 'paytmmp://pay?'], ['any', 'upi://pay?']]) {
        const href = (await bphone.locator(`a[data-app="${app}"]`).getAttribute('href'))!;
        expect(href.startsWith(scheme)).toBe(true);
        expect(upiParams(href)).toMatchObject({ pa: 'asha@okaxis', am: qr.am });
    }
    await bphone.getByRole('button', { name: /Show UPI QR/ }).click();
    expect(upiParams((await bphone.locator('svg.lv-qr').getAttribute('data-url'))!).am).toBe(qr.am);
    await expectNoHorizontalScroll(bphone);

    // Mark received; the group message carries pay links only for people still owing
    await bilalCard.getByRole('switch').click();
    await expect(bilalCard.getByText('COLLECTED')).toBeVisible();
    const wa = await host.locator('pre.sb-wa').innerText();
    expect(wa).toContain('Bilal: *' + bilal + '* ✅ received');
    expect(wa).toMatch(/Chitra: .*\n\s+Pay: https?:\/\/\S+#pay=/);

    // PDF downloads and is a PDF
    const [dl] = await Promise.all([host.waitForEvent('download'), host.getByRole('button', { name: 'Share the detailed PDF' }).click()]);
    const buf = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c));
    expect(buf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(buf.toString('latin1')).toContain('Bilal');

    // Reload keeps the frozen table, and edits stay blocked
    await host.reload();
    await expect(host.getByText('Finalized payment details')).toBeVisible();
    await expect(host.locator('.sb-person', { hasText: 'Bilal' }).getByText('COLLECTED')).toBeVisible();
    await expect(host.getByRole('button', { name: /Bill$/ })).toBeDisabled();

    // New bill starts clean
    await host.getByRole('button', { name: 'New bill' }).click();
    await host.getByRole('button', { name: 'Old links stay valid. Start new?' }).click();
    await expect(host.getByRole('button', { name: /One phone/ })).toBeVisible();
});

test('one phone: unclaimed dishes can be split equally, external collector', async ({ browser }) => {
    const host = await phone(browser, 'iphone');
    await host.goto('/');
    await host.getByRole('button', { name: /One phone/ }).click();
    await host.fill('#paste', 'Masala Dosa 180.00\nFilter Coffee 60.00\nTotal 240.00');
    await host.getByRole('button', { name: 'Read items from text' }).click();
    await host.getByRole('button', { name: 'Next: people' }).click();
    for (const n of ['Dev', 'Esha']) { await host.getByLabel('Name', { exact: true }).fill(n); await host.getByRole('button', { name: 'Add', exact: true }).click(); }
    await host.getByRole('button', { name: 'Someone not dining' }).click();
    await host.fill('#external-collector', 'Mom');
    await host.fill('#upi', 'mom@oksbi');
    await host.getByRole('button', { name: 'Next: pass the phone' }).click();
    await host.getByRole('button', { name: 'Dev here. Show me the food' }).click();
    await dish(host, 'Masala Dosa').click();
    await host.getByRole('button', { name: 'Done, pass on' }).click();
    await host.getByRole('button', { name: 'Esha here. Show me the food' }).click();
    await host.getByRole('button', { name: 'Done, see split' }).click();
    await expect(host.getByText('₹60.00 nobody has claimed')).toBeVisible();
    await host.getByRole('button', { name: 'Split it equally' }).click();
    await expect(host.getByText('Every rupee is assigned and shares add up to the bill')).toBeVisible();
    await expect(host.locator('.sb-person', { hasText: 'Dev' }).locator('.sb-amt')).toHaveText('₹210.00');
    await expect(host.locator('.sb-person', { hasText: 'Esha' }).locator('.sb-amt')).toHaveText('₹30.00');
    await host.getByRole('button', { name: 'Review final details' }).click();
    await host.getByRole('button', { name: 'Confirm and freeze table' }).click();
    const card = host.locator('.sb-person', { hasText: 'Esha' });
    await card.getByRole('button', { name: 'Show QR for Esha' }).click();
    expect(upiParams((await card.locator('svg.lv-qr').getAttribute('data-url'))!)).toMatchObject({ pa: 'mom@oksbi', pn: 'Mom', am: '30.00' });
});

test('narrow 320px phone: every screen fits without sideways scrolling', async ({ browser }) => {
    const host = await phone(browser, 'narrow');
    await host.goto('/');
    await expectNoHorizontalScroll(host);
    await host.getByRole('button', { name: /One phone/ }).click();
    await host.getByRole('button', { name: 'Try sample bill' }).click();
    await expectNoHorizontalScroll(host);
    await host.getByRole('button', { name: 'Next: people' }).click();
    for (const n of ['Aishwarya Ramakrishnan', 'Bilal']) { await host.getByLabel('Name', { exact: true }).fill(n); await host.getByRole('button', { name: 'Add', exact: true }).click(); }
    await host.fill('#upi', 'aishwarya.ramakrishnan@okhdfcbank');
    await expectNoHorizontalScroll(host);
    await host.getByRole('button', { name: 'Next: pass the phone' }).click();
    await host.getByRole('button', { name: /here\. Show me the food/ }).click();
    await expectNoHorizontalScroll(host);
    await host.getByRole('button', { name: 'Done, pass on' }).click();
    await host.getByRole('button', { name: /here\. Show me the food/ }).click();
    await host.getByRole('button', { name: 'Done, see split' }).click();
    await host.getByRole('button', { name: 'Split it equally' }).click();
    await host.getByRole('button', { name: 'Review final details' }).click();
    await host.getByRole('button', { name: 'Confirm and freeze table' }).click();
    await host.locator('.sb-person', { hasText: 'Bilal' }).getByRole('button', { name: 'Show QR for Bilal' }).click();
    await expectNoHorizontalScroll(host);
    await host.locator('.sb-person', { hasText: 'Bilal' }).getByRole('button', { name: 'Send Bilal a pay link' }).click();
    const link = (await clipboard(host)).match(/https?:\/\/\S+#pay=\S+/)![0];
    const payer = await phone(browser, 'narrow');
    await payer.goto(link);
    await payer.getByRole('button', { name: /Show UPI QR/ }).click();
    await expectNoHorizontalScroll(payer);
});
