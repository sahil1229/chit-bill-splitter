import { test, expect } from '@playwright/test';
import { clipboard, dish, expectNoHorizontalScroll, phone, upiParams } from './helpers';
import { noProblems } from './helpers';

test.afterEach(noProblems);

test('one phone: bill to frozen split, payment links to the group and to one payer, PDF and reload', async ({ browser }) => {
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
    // Dishes are a tap (2 Butter Chicken shared, here only by Bilal); naans and drinks are counted (6 naans: Asha 2, Bilal 1, Chitra 3)
    const picks: Record<string, [string, number][]> = { Asha: [['Paneer Tikka', 1], ['Garlic Naan', 2]], Bilal: [['Butter Chicken', 1], ['Dal Makhani', 1], ['Garlic Naan', 1]], Chitra: [['Masala Cola', 4], ['Gulab Jamun', 2], ['Garlic Naan', 3]] };
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

    // Freeze: one obvious next step, one confirm
    await expect(host.locator('.ch-next')).toContainText('Check the amounts, then freeze');
    await host.getByRole('button', { name: 'Freeze & send payment links' }).click();
    await host.getByRole('button', { name: 'Yes, freeze' }).click();
    await expect(host.locator('.ch-next')).toContainText('Send everyone their payment link');

    // One message for the group carries every payer's link
    await host.getByRole('button', { name: 'Send payment links to the group' }).click();
    const group = await clipboard(host);
    expect(group).toMatch(/Bilal: .*\n\s+Pay: https?:\/\/\S+#pay=/);
    expect(group).toMatch(/Chitra: .*\n\s+Pay: https?:\/\/\S+#pay=/);
    expect(group).not.toMatch(/Asha: .*\n\s+Pay:/); // the collector pays nobody

    // Or one person at a time; it opens Google Pay first on Bilal's own iPhone
    const bilalCard = card('Bilal');
    await bilalCard.getByRole('button', { name: 'Send Bilal their payment link' }).click();
    const link = (await clipboard(host)).match(/https?:\/\/\S+#pay=\S+/)![0];
    const bphone = await phone(browser, 'iphone');
    await bphone.goto(link);
    await expect(bphone.getByRole('heading', { name: 'Pay Asha' })).toBeVisible();
    await expect(bphone.locator('.lv-total b')).toHaveText(bilal);
    await expect(bphone.locator('a[data-app="gpay"]')).toHaveText(`Pay ${bilal} in Google Pay`);
    await expect(bphone.locator('.ch-paybox a[data-app]')).toHaveCount(4);
    const am = bilal.replace(/[₹,]/g, '');
    for (const [app, scheme] of [['gpay', 'gpay://upi/pay?'], ['phonepe', 'phonepe://pay?'], ['paytm', 'paytmmp://pay?'], ['any', 'upi://pay?']]) {
        const href = (await bphone.locator(`a[data-app="${app}"]`).getAttribute('href'))!;
        expect(href.startsWith(scheme)).toBe(true);
        expect(upiParams(href)).toMatchObject({ pa: 'asha@okaxis', pn: 'Asha', am, cu: 'INR' });
    }
    await expect(bphone.locator('svg.lv-qr')).toHaveCount(0);
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
    // Each person's own box lists what they had and how (PDF text escapes brackets)
    const pdf = buf.toString('latin1');
    for (const line of ['Garlic Naan  \\(2 of 6\\)', 'Garlic Naan  \\(3 of 6\\)', 'Butter Chicken  \\(whole dish\\)', 'Masala Cola  \\(4 of 4\\)', 'WHO OWES WHAT']) expect(pdf).toContain(line);

    // Reload keeps the frozen table, and edits stay blocked
    await host.reload();
    await expect(host.locator('.ch-next')).toContainText('Send everyone their payment link');
    await expect(card('Bilal').getByText('COLLECTED')).toBeVisible();
    await card('Chitra').getByRole('switch').click();
    await expect(host.locator('.ch-next')).toContainText('All paid ✓');
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
    await expect(host.locator('.ch-next')).toContainText('Not ready to freeze yet');
    await host.getByRole('button', { name: 'Split the rest equally' }).click();
    await expect(host.getByText('Every rupee is assigned and shares add up to the bill')).toBeVisible();
    await expect(host.locator('.sb-person', { hasText: 'Dev' }).locator('.sb-amt')).toHaveText('₹210.00');
    await expect(host.locator('.sb-person', { hasText: 'Esha' }).locator('.sb-amt')).toHaveText('₹30.00');
    await host.getByRole('button', { name: 'Freeze & send payment links' }).click();
    await host.getByRole('button', { name: 'Yes, freeze' }).click();
    await host.locator('.sb-person', { hasText: 'Esha' }).getByRole('button', { name: 'Send Esha their payment link' }).click();
    const payer = await phone(browser, 'pixel');
    await payer.goto((await clipboard(host)).match(/https?:\/\/\S+#pay=\S+/)![0]);
    expect(upiParams((await payer.locator('a[data-app="gpay"]').getAttribute('href'))!)).toMatchObject({ pa: 'mom@oksbi', pn: 'Mom', am: '30.00' });
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
    await host.getByRole('button', { name: 'Split the rest equally' }).click();
    await host.getByRole('button', { name: 'Freeze & send payment links' }).click();
    await host.getByRole('button', { name: 'Yes, freeze' }).click();
    await expectNoHorizontalScroll(host);
    await host.locator('.sb-person', { hasText: 'Bilal' }).getByRole('button', { name: 'Send Bilal their payment link' }).click();
    const link = (await clipboard(host)).match(/https?:\/\/\S+#pay=\S+/)![0];
    const payer = await phone(browser, 'narrow');
    await payer.goto(link);
    await expect(payer.locator('a[data-app="gpay"]')).toBeVisible();
    await expectNoHorizontalScroll(payer);
});

test('one phone: 2 gravies shared by 3 split equally by tapping', async ({ browser }) => {
    const host = await phone(browser, 'pixel');
    await host.goto('/');
    await host.getByRole('button', { name: /One phone/ }).click();
    await host.fill('#paste', '2 Dal Makhani 600.00\nTotal 600.00');
    await host.getByRole('button', { name: 'Read items from text' }).click();
    await host.getByRole('button', { name: 'Next: people' }).click();
    for (const n of ['Asha', 'Bilal', 'Chitra']) { await host.getByLabel('Name', { exact: true }).fill(n); await host.getByRole('button', { name: 'Add', exact: true }).click(); }
    await host.fill('#upi', 'asha@okaxis');
    await host.getByRole('button', { name: 'Next: pass the phone' }).click();
    for (const n of ['Asha', 'Bilal', 'Chitra']) {
        await host.getByRole('button', { name: `${n} here. Show me the food` }).click();
        await dish(host, 'Dal Makhani').click();
        await host.getByRole('button', { name: n === 'Chitra' ? 'Done, see split' : 'Done, pass on' }).click();
    }
    for (const n of ['Asha', 'Bilal', 'Chitra']) await expect(host.locator('.sb-person').filter({ has: host.locator('.sb-pn strong', { hasText: new RegExp(`^${n}$`) }) }).locator('.sb-amt')).toHaveText('₹200.00');
});
