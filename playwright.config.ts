import { defineConfig, devices } from '@playwright/test';

// The app is built against a local ntfy-compatible relay (tests/relay.mjs) so runs are repeatable
// and never spend the public ntfy.sh quota (250 messages per IP per 12h).
// CHIT_RELAY=https://ntfy.sh runs the same tests against the real public relay (spends its quota).
const relay = process.env.CHIT_RELAY || 'http://localhost:4174';

export default defineConfig({
    testDir: 'tests',
    timeout: 90_000,
    expect: { timeout: 20_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: { baseURL: 'http://localhost:4175/', trace: 'retain-on-failure' },
    webServer: [
        { command: 'RELAY_PORT=4174 node tests/relay.mjs', url: 'http://localhost:4174/health', reuseExistingServer: false },
        { command: `node scripts/ocr-assets.mjs && VITE_RELAY=${relay} npx vite build --outDir dist-test --emptyOutDir --logLevel error && npx vite preview --outDir dist-test --port 4175 --strictPort`, url: 'http://localhost:4175/', reuseExistingServer: false, timeout: 120_000 },
    ],
    projects: [
        { name: 'unit', testMatch: /unit\.spec\.ts/ },
        { name: 'phone', testIgnore: /unit\.spec\.ts/, use: { ...devices['Pixel 7'] } },
    ],
});
