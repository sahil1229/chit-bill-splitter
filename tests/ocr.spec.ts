import { test, expect } from '@playwright/test';
import { phone } from './helpers';
import { noProblems } from './helpers';

test.afterEach(noProblems);

const LINES = [['Masala Dosa', '180.00'], ['Idli Vada', '120.00'], ['Filter Coffee', '60.00'], ['CGST 2.5%', '9.00'], ['SGST 2.5%', '9.00'], ['Total', '378.00']];

test('photo of a bill is read on the device and imported only when it reconciles', async ({ browser }) => {
    test.setTimeout(150_000);
    // A clean synthetic receipt photo
    const cam = await browser.newPage({ viewport: { width: 700, height: 520 } });
    await cam.setContent(`<body style="margin:0;background:#fff;font:600 34px/1.5 'Courier New',monospace;padding:30px 40px">${LINES.map(([n, a]) => `<div style="display:flex;justify-content:space-between"><span>${n}</span><span>${a}</span></div>`).join('')}</body>`);
    const photo = await cam.screenshot({ type: 'jpeg', quality: 90 });
    await cam.close();

    const host = await phone(browser, 'pixel');
    await host.goto('/');
    await host.getByRole('button', { name: /One phone/ }).click();
    await host.locator('input[type=file]').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: photo });
    await expect(host.getByAltText('The bill you photographed')).toBeVisible();
    await host.getByRole('button', { name: 'Read photo on this device' }).click();
    await expect(host.getByText(/Photo read\. Check the text above/)).toBeVisible({ timeout: 120_000 });
    const text = await host.locator('#paste').inputValue();
    expect(text).toMatch(/Masala Dosa/i);
    await host.getByRole('button', { name: 'Read items from text' }).click();
    await expect(host.getByText(/Read 3 items and 2 charges/)).toBeVisible();
    await expect(host.getByText('Total printed on bill')).toBeVisible();

    // An unsupported file type is refused with guidance
    await host.locator('input[type=file]').setInputFiles({ name: 'bill.heic', mimeType: 'image/heic', buffer: Buffer.from('x') });
    await expect(host.getByText(/HEIC is not supported/).first()).toBeVisible();
});
