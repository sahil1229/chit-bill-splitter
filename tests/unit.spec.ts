import { test, expect } from '@playwright/test';
import { allocate, computeSplit, countedByDefault, fmt, parseBill, toMinor } from '../src/engine';
import { finalizeSettlement, restoreSettlement, pinDinerPayment, type SettlementDraft } from '../src/settlement';
import { HostEngine, MAX_BODY, Reassembler, linkFragment, newKeyPair, newSession, open, openHost, parseLink, seal, sealState, verify, type Snap } from '../src/live';
import { appLinks, parsePayLink, payLink, platform, upiUrl } from '../src/upi';

const SAMPLE = `Paneer Tikka 420.00\n2 Butter Chicken 960.00\n6 Garlic Naan 360.00\nDal Makhani 380.00\n3 Mineral Water 150.00\n4 Masala Cola 320.00\n2 Gulab Jamun 240.00\nSubtotal 2830.00\nService Charge 10% 283.00\nCGST 2.5% 77.83\nSGST 2.5% 77.83\nTotal 3268.66`;

test.describe('money', () => {
    test('allocate always sums to the total', () => {
        for (const [total, w] of [[100, [1, 1, 1]], [1, [1, 1]], [-7, [2, 1]], [99999, [3, 0, 5, 7]], [0, [1]]] as [number, number[]][]) {
            const parts = allocate(total, w);
            expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
            w.forEach((x, i) => { if (x === 0) expect(parts[i]).toBe(0); });
        }
    });
    test('toMinor and fmt', () => {
        expect(toMinor('1,234.50')).toBe(123450);
        expect(toMinor('abc')).toBeNull();
        expect(fmt(12345678)).toBe('₹1,23,456.78');
        expect(fmt(-5)).toBe('-₹0.05');
    });
    test('sample bill parses to the printed total', () => {
        const r = parseBill(SAMPLE);
        expect(r.items.map((i) => [i.name, i.qty])).toEqual([['Paneer Tikka', 1], ['Butter Chicken', 2], ['Garlic Naan', 6], ['Dal Makhani', 1], ['Mineral Water', 3], ['Masala Cola', 4], ['Gulab Jamun', 2]]);
        expect(r.items.find((i) => i.name === 'Mineral Water')!.everyone).toBe(true);
        const total = r.items.reduce((a, i) => a + i.total, 0) + r.charges.reduce((a, c) => a + c.amount, 0);
        expect(total).toBe(r.printedTotal);
    });
    test('foreign currency bills are refused', () => {
        expect(parseBill('Burger $12.00\nTotal $12.00').items).toHaveLength(0);
    });
    test('split reconciles with units, shares, everyone and charges', () => {
        const { items, charges } = parseBill(SAMPLE);
        const people = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
        const claims: Record<string, Record<string, number>> = {}; const shares: Record<string, string[]> = {};
        items.forEach((it, k) => { if (it.everyone) return; if (k % 2) shares[it.id] = ['a', 'c']; else claims[it.id] = { [people[k % 3].id]: it.qty }; });
        for (const chargeMode of ['equal', 'prorata'] as const) {
            const res = computeSplit({ items, charges, people, claims, shares, chargeMode, spread: false });
            expect(res.reconciles).toBe(true);
            expect(res.unassigned).toBe(0);
            expect(res.people.reduce((a, p) => a + p.total, 0)).toBe(326866);
        }
    });
    test('naans and drinks are counted by default; gravies are shared', () => {
        for (const n of ['Garlic Naan', 'Butter Roti', 'Masala Cola', 'Fresh Lime Soda', 'Kingfisher Beer', 'Gulab Jamun', 'Masala Chai']) expect(countedByDefault(n)).toBe(true);
        for (const n of ['Dal Makhani', 'Butter Chicken', 'Paneer Butter Masala', 'Veg Biryani', 'Jeera Rice', 'Chicken 65']) expect(countedByDefault(n)).toBe(false);
    });
    test('6 naans eaten 2, 1 and 3 are charged by count', () => {
        const naan = { id: 'n', name: 'Garlic Naan', qty: 6, total: 36000, everyone: false };
        const people = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
        const res = computeSplit({ items: [naan], charges: [{ id: 'g', name: 'GST', amount: 1800 }], people, claims: { n: { a: 2, b: 1, c: 3 } }, shares: {}, chargeMode: 'prorata', spread: false });
        expect(res.people.map((p) => p.items)).toEqual([12000, 6000, 18000]);
        expect(res.people.map((p) => p.extras)).toEqual([600, 300, 900]);
        expect(res.people[0].lines[0].note).toBe('2 of 6');
        const short = computeSplit({ items: [naan], charges: [], people, claims: { n: { a: 2, b: 1 } }, shares: {}, chargeMode: 'equal', spread: false });
        expect(short.unclaimedUnits).toEqual({ n: 3 });
        const over = computeSplit({ items: [naan], charges: [], people, claims: { n: { a: 4, b: 3 } }, shares: {}, chargeMode: 'equal', spread: false });
        expect(over.overclaimed).toEqual(['n']);
    });
    test('unclaimed units block until spread', () => {
        const { items, charges } = parseBill(SAMPLE);
        const people = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
        const res = computeSplit({ items, charges, people, claims: {}, shares: {}, chargeMode: 'equal', spread: false });
        expect(res.unassigned).toBeGreaterThan(0);
        const spread = computeSplit({ items, charges, people, claims: {}, shares: {}, chargeMode: 'equal', spread: true });
        expect(spread.unassigned).toBe(0);
        expect(spread.reconciles).toBe(true);
    });
});

test.describe('settlement', () => {
    const draft = (): SettlementDraft => {
        const { items, charges, printedTotal } = parseBill(SAMPLE);
        return { tableId: 't1', items, charges, people: [{ id: 'a', name: 'Asha' }, { id: 'b', name: 'Bilal' }], claims: {}, shares: {}, chargeMode: 'equal', spread: true, printedTotal, collector: { kind: 'diner', dinerId: 'a', upi: 'asha@okaxis' } };
    };
    test('finalize, restore and detect tampering', async () => {
        const s = await finalizeSettlement(draft());
        expect(s.shares.reduce((a, p) => a + p.amount, 0)).toBe(s.billTotal);
        expect(s.shares.find((p) => p.personId === 'a')!.owesCollector).toBe(false);
        await expect(restoreSettlement(JSON.parse(JSON.stringify(s)))).resolves.toBeTruthy();
        const bad = JSON.parse(JSON.stringify(s)); bad.collector.upi = 'thief@okaxis';
        await expect(restoreSettlement(bad)).rejects.toThrow();
    });
    test('refuses bad UPI, printed total mismatch and unassigned units', async () => {
        await expect(finalizeSettlement({ ...draft(), collector: { kind: 'diner', dinerId: 'a', upi: 'nope' } })).rejects.toThrow(/UPI/);
        await expect(finalizeSettlement({ ...draft(), printedTotal: 1 })).rejects.toThrow(/Printed total/);
        await expect(finalizeSettlement({ ...draft(), spread: false })).rejects.toThrow(/Assign every unit/);
    });
    test('diner pin blocks a conflicting second settlement', async () => {
        const { link } = await newSession();
        const mem = new Map<string, string>(); const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
        const lock = <T,>(_: string, w: () => Promise<T>) => w();
        const s1 = await finalizeSettlement({ ...draft(), liveLink: link });
        const pay = await pinDinerPayment(s1, link, 'b', storage, lock);
        expect(pay.upi).toBe('asha@okaxis');
        const s2 = await finalizeSettlement({ ...draft(), liveLink: link });
        await expect(pinDinerPayment(s2, link, 'b', storage, lock)).rejects.toThrow(/conflicting/);
        await expect(pinDinerPayment(s1, link, 'b', storage, lock)).rejects.toThrow(/conflict/);
    });
});

test.describe('live relay envelope', () => {
    test('join link round trips through the #fragment', async () => {
        const { link } = await newSession();
        expect(parseLink('https://x.test/#' + linkFragment(link))).toEqual(link);
    });
    test('every message fits under the ntfy limit, even huge finalized tables', async () => {
        const { link, host } = await newSession();
        for (const [ni, np] of [[7, 2], [25, 10], [60, 30]]) {
            const items = Array.from({ length: ni }, (_, i) => ({ id: 'i' + i.toString(36) + 'xyzw', name: 'Chicken Tikka Masala Special ' + i, qty: 3, total: 45000 + i, everyone: false }));
            const people = Array.from({ length: np }, (_, i) => ({ id: 'p' + Math.random().toString(36).slice(2, 10), name: 'Diner number ' + i }));
            const claims: Record<string, Record<string, number>> = {}; items.forEach((it, k) => (claims[it.id] = { [people[k % np].id]: 1, [people[(k + 1) % np].id]: 2 }));
            const settlement = await finalizeSettlement({ tableId: crypto.randomUUID(), liveLink: link, items, charges: [], people, claims, shares: {}, chargeMode: 'equal', spread: false, printedTotal: null, collector: { kind: 'diner', dinerId: people[0].id, upi: 'host@okaxis' } });
            const snap: Snap = { items, charges: [], people, claims, shares: {}, chargeMode: 'equal', spread: false, settlement, approved: people.map((p) => p.id) };
            const st = new HostEngine(link, () => snap, () => {}).state();
            const bodies = await sealState(link, host.sign, st);
            for (const b of bodies) expect(b.length).toBeLessThanOrEqual(MAX_BODY);
            const re = new Reassembler(); let got = null;
            for (const b of [...bodies].reverse()) { const m = await openHost(link, b); expect(m).not.toBeNull(); got = re.add(m!) ?? got; }
            expect(got).toEqual(st);
        }
    });
    test('forged host state, tampering and replays are rejected', async () => {
        const { link } = await newSession(); const evil = await newKeyPair();
        expect(await openHost(link, await seal(link, { t: 'state', rev: Date.now() + 1e9, i: 0, n: 1, d: '{}' }, evil.sign))).toBeNull();
        const good = await seal(link, { t: 'claims', pid: 'pabc1234', n: 1, c: {}, sh: [] }, evil.sign);
        const o = await open(link, good); expect(o && await verify(evil.pub, o.p, o.s)).toBe(true);
        expect(await open(link, good.slice(0, 30) + (good[30] === 'A' ? 'B' : 'A') + good.slice(31))).toBeNull();
        const re = new Reassembler(); const st = { d: '{"rev":5}', rev: 5, i: 0, n: 1 };
        expect(re.add(st)).not.toBeNull(); expect(re.add(st)).toBeNull();
    });
    test('host engine: diners can only change their own claims, in order', async () => {
        const { link } = await newSession();
        const { items } = parseBill(SAMPLE);
        let snap: Snap = { items, charges: [], people: [], claims: {}, shares: {}, chargeMode: 'equal', spread: false };
        const eng = new HostEngine(link, () => snap, (p) => { snap = { ...snap, ...p }; });
        const a = await newKeyPair(), b = await newKeyPair();
        expect(await eng.handle(await seal(link, { t: 'join', pid: 'pasha001', name: 'Asha', pub: a.pub }, a.sign))).toBe(true);
        expect(await eng.handle(await seal(link, { t: 'join', pid: 'pasha001', name: 'Imposter', pub: b.pub }, b.sign))).toBe(false);
        const naan = items.find((i) => i.name === 'Garlic Naan')!;
        expect(await eng.handle(await seal(link, { t: 'claims', pid: 'pasha001', n: 1, c: { [naan.id]: 4 }, sh: [] }, b.sign))).toBe(false);
        expect(await eng.handle(await seal(link, { t: 'claims', pid: 'pasha001', n: 1, c: { [naan.id]: 99 }, sh: [] }, a.sign))).toBe(true);
        expect(snap.claims[naan.id]).toEqual({ pasha001: 6 });
        expect(await eng.handle(await seal(link, { t: 'claims', pid: 'pasha001', n: 1, c: {}, sh: [] }, a.sign))).toBe(false);
    });
    test('a reloaded host outranks the revision diners last saw', async () => {
        const { link } = await newSession();
        const snap: Snap = { items: [], charges: [], people: [], claims: {}, shares: {}, chargeMode: 'equal', spread: false };
        const e1 = new HostEngine(link, () => snap, () => {}); const saved = e1.dump(); let last = 0;
        for (let i = 0; i < 50; i++) last = e1.state().rev;
        await new Promise((r) => setTimeout(r, 60));
        const e2 = new HostEngine(link, () => snap, () => {}); e2.load(saved);
        expect(e2.state().rev).toBeGreaterThan(last);
    });
});

test.describe('upi', () => {
    const req = { pa: 'host@okaxis', pn: 'Sahil S', am: 158050, tn: 'CHIT ab12cd34' };
    test('upi url follows the NPCI format', () => {
        expect(upiUrl(req)).toBe('upi://pay?pa=host@okaxis&pn=Sahil%20S&am=1580.50&cu=INR&tn=CHIT%20ab12cd34');
        expect(() => upiUrl({ ...req, pa: 'bad' })).toThrow();
        expect(() => upiUrl({ ...req, am: 0 })).toThrow();
    });
    test('platform detection and per-platform app links', () => {
        expect(platform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe('ios');
        expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
        expect(platform('Mozilla/5.0 (Linux; Android 14; Pixel 7)', 5)).toBe('android');
        expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
        const ios = appLinks(req, 'ios');
        expect(ios.primary!.href.split('?')[0]).toBe('gpay://upi/pay');
        expect(ios.apps.map((a) => a.href.split('?')[0])).toEqual(['phonepe://pay', 'paytmmp://pay', 'upi://pay']);
        const android = appLinks(req, 'android');
        expect(android.primary!.href).toContain('#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end');
        expect(android.apps.map((a) => a.id)).toEqual(['phonepe', 'paytm', 'any']);
        expect(android.apps[2].href).toBe(upiUrl(req));
        expect(appLinks(req, 'other').apps).toHaveLength(0);
    });
    test('pay links round trip and reject junk', () => {
        const link = payLink(req, 'https://chit.test/');
        expect(parsePayLink(new URL(link).hash)).toEqual(req);
        expect(parsePayLink('#pay=bm90LWpzb24')).toBeNull();
        expect(parsePayLink('#join=abc')).toBeNull();
    });
});

test.describe('share links', () => {
    test('links made on a locked Vercel address point at the public site', async () => {
        const { shareBase, PUBLIC_URL } = await import('../src/site');
        const at = (href: string) => { const u = new URL(href); return shareBase({ hostname: u.hostname, origin: u.origin, pathname: u.pathname }); };
        expect(at('https://chit-bill-splitter-git-33028d-sahilshah3142-gmailcoms-projects.vercel.app/')).toBe(PUBLIC_URL);
        expect(at('https://chit-bill-splitter-abc123-sahilshah3142-gmailcoms-projects.vercel.app/')).toBe(PUBLIC_URL);
        expect(at('https://chit-bill-splitter.vercel.app/')).toBe('https://chit-bill-splitter.vercel.app/');
        expect(at('http://localhost:4175/')).toBe('http://localhost:4175/');
        expect(at('https://chit.example.com/app/')).toBe('https://chit.example.com/app/');
    });
});

test.describe('two people at once', () => {
    const bill = () => parseBill('6 Garlic Naan 360.00\n2 Dal Makhani 700.00\nTotal 1060.00');
    async function table(names: string[]) {
        const { link } = await newSession(); const { items } = bill();
        let snap: Snap = { items, charges: [], people: [], claims: {}, shares: {}, chargeMode: 'equal', spread: false };
        const eng = new HostEngine(link, () => snap, (p) => { snap = { ...snap, ...p }; });
        const diners: Record<string, { pid: string; key: Awaited<ReturnType<typeof newKeyPair>>; n: number }> = {};
        for (const [k, name] of names.entries()) {
            const key = await newKeyPair(); const pid = 'p' + name.toLowerCase().padEnd(7, 'x') + k;
            await eng.handle(await seal(link, { t: 'join', pid, name, pub: key.pub }, key.sign)); diners[name] = { pid, key, n: 0 };
        }
        const naan = items.find((i) => i.name === 'Garlic Naan')!.id, dal = items.find((i) => i.name === 'Dal Makhani')!.id;
        const send = async (name: string, ops: Record<string, { c?: number; s?: boolean }>, n?: number) => { const d = diners[name]; const m = n ?? ++d.n; return eng.handle(await seal(link, { t: 'claims', pid: d.pid, n: m, ops }, d.key.sign)); };
        const count = (name: string, id = naan) => snap.claims[id]?.[diners[name].pid] ?? 0;
        return { eng, send, count, naan, dal, diners, snap: () => snap, set: (p: Partial<Snap>) => { snap = { ...snap, ...p }; } };
    }

    test('race for the last naans: whoever reaches the host first gets them; the other is told', async () => {
        const t = await table(['Asha', 'Bilal']);
        await t.send('Asha', { [t.naan]: { c: 4 } });
        await t.send('Bilal', { [t.naan]: { c: 4 } });
        expect([t.count('Asha'), t.count('Bilal')]).toEqual([4, 2]);
        expect(t.eng.rej[t.diners.Bilal.pid][t.naan]).toBe('Someone got there first: only 2 left, so you have 2.');
        await t.send('Asha', { [t.naan]: { c: 2 } }); // Asha gives two back
        await t.send('Bilal', { [t.naan]: { c: 4 } });
        expect([t.count('Asha'), t.count('Bilal')]).toEqual([2, 4]);
        expect(t.eng.rej[t.diners.Bilal.pid][t.naan]).toBeUndefined();
    });

    test('a diner changing one dish does not undo what the host fixed on another', async () => {
        const t = await table(['Asha']);
        await t.send('Asha', { [t.naan]: { c: 3 } });
        t.set({ claims: { ...t.snap().claims, [t.naan]: { [t.diners.Asha.pid]: 1 } } }); // host fixes Asha to 1 on the host phone
        await t.send('Asha', { [t.dal]: { s: true } });
        expect(t.count('Asha')).toBe(1);
        expect(t.snap().shares[t.dal]).toEqual([t.diners.Asha.pid]);
    });

    test('resends are harmless, replays and old messages are ignored', async () => {
        const t = await table(['Asha']);
        await t.send('Asha', { [t.naan]: { c: 2 } });
        await t.send('Asha', { [t.naan]: { c: 2 } }); // resend of the same change
        expect(t.count('Asha')).toBe(2);
        expect(await t.send('Asha', { [t.naan]: { c: 6 } }, 1)).toBe(false); // replayed old message number
        expect(t.count('Asha')).toBe(2);
    });

    test('shared vs counted at the same moment: first one decides, the other is told', async () => {
        const t = await table(['Asha', 'Bilal']);
        await t.send('Asha', { [t.dal]: { s: true } });
        await t.send('Bilal', { [t.dal]: { c: 1 } });
        expect(t.count('Bilal', t.dal)).toBe(0);
        expect(t.eng.rej[t.diners.Bilal.pid][t.dal]).toContain('Others are sharing this dish');
        await t.send('Bilal', { [t.dal]: { s: true } });
        expect(t.snap().shares[t.dal]).toEqual([t.diners.Asha.pid, t.diners.Bilal.pid]);
    });

    test('free-for-all: 5 people, 2000 random taps in random order never break the rules', async () => {
        const names = ['A', 'B', 'C', 'D', 'E'];
        const t = await table(names);
        let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
        const qty = { [t.naan]: 6, [t.dal]: 2 };
        for (let k = 0; k < 2000; k++) {
            const who = names[rnd(5)]; const id = rnd(2) ? t.naan : t.dal;
            const op = rnd(3) === 0 ? { s: !!rnd(2) } : { c: rnd(8) - 1 };
            // A third of messages arrive out of order (an older number): the host must drop them.
            const n = rnd(3) === 0 ? Math.max(1, t.diners[who].n - rnd(3)) : undefined;
            await t.send(who, { [id]: op }, n);
            for (const item of [t.naan, t.dal]) {
                const counts = Object.values(t.snap().claims[item] ?? {}); const sharers = t.snap().shares[item] ?? [];
                expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(qty[item]);
                expect(counts.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
                expect(sharers.length > 0 && counts.some((c) => c > 0)).toBe(false); // never shared and counted at once
                expect(new Set(sharers).size).toBe(sharers.length);
            }
        }
    });
});
