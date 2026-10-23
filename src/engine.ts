export type Item = { id: string; name: string; qty: number; total: number; everyone: boolean };
export type Charge = { id: string; name: string; amount: number };
export type Person = { id: string; name: string };
export type Claims = Record<string, Record<string, number>>;
export type Shares = Record<string, string[]>;
export type ChargeMode = 'equal' | 'prorata';

let counter = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Parse "1,234.5" to minor units (paise). Returns null if not a number. */
export function toMinor(s: string): number | null {
    const t = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
    if (!t || !/\d/.test(t)) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}

export function fmt(minor: number, symbol = '₹'): string {
    const neg = minor < 0;
    const abs = Math.abs(minor);
    const whole = Math.floor(abs / 100).toString();
    // Indian digit grouping: last 3, then pairs
    let g = whole;
    if (whole.length > 3) {
        const last3 = whole.slice(-3);
        const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
        g = `${rest},${last3}`;
    }
    return `${neg ? '-' : ''}${symbol}${g}.${(abs % 100).toString().padStart(2, '0')}`;
}

/** Split `total` (integer) across weights so parts sum exactly to total (largest remainder). */
export function allocate(total: number, weights: number[]): number[] {
    const out = weights.map(() => 0);
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0 || total === 0) return out;
    const sign = total < 0 ? -1 : 1;
    const abs = Math.abs(total);
    const exact = weights.map((w) => (abs * w) / sum);
    const floors = exact.map(Math.floor);
    let left = abs - floors.reduce((a, b) => a + b, 0);
    const order = exact
        .map((e, i) => ({ i, r: e - Math.floor(e) }))
        .filter((x) => weights[x.i] > 0)
        .sort((a, b) => b.r - a.r || a.i - b.i);
    for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) floors[order[k].i] += 1;
    return floors.map((f) => f * sign);
}

const CHARGE_RE = /\b(tax|gst|cgst|sgst|igst|vat|service|svc|s\.?\s?charge|charge|cess|tip|cover|packing|packaging|round\s*off|rounding|discount|delivery|surcharge)\b/i;
const TOTAL_RE = /\b(sub\s*-?\s*total|total|grand|net\s*amount|amount\s*due|balance|bill\s*amount|payable)\b/i;
const WATER_RE = /\bwater\b/i;
const SKIP_RE = /\b(invoice|bill\s*no|table|date|time|gstin|phone|ph\b|tel|thank|cashier|server|pax|guests?|order\s*no|kot|fssai|address)\b/i;

export type Parsed = { items: Item[]; charges: Charge[]; printedTotal: number | null; skipped: string[] };

export function parseBill(text: string): Parsed {
    const items: Item[] = [];
    const charges: Charge[] = [];
    let printedTotal: number | null = null;
    const skipped: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        let line = raw.replace(/[|₹]/g, ' ').replace(/\b(rs|inr)\.?/gi, ' ').replace(/\d+(\.\d+)?\s*%/g, ' ').replace(/\s+/g, ' ').trim();
        if (!line || !/[a-z]/i.test(line)) continue;
        const m = line.match(/((?:-?\d[\d,]*(?:\.\d{1,2})?\s*)+)$/);
        if (!m) { if (line.length > 2) skipped.push(raw.trim()); continue; }
        const nums = m[1].trim().split(/\s+/);
        const amount = toMinor(nums[nums.length - 1]);
        let name = line.slice(0, line.length - m[1].length).trim().replace(/[:\-.]+$/, '').trim();
        if (amount === null || !/[a-z]/i.test(name)) { skipped.push(raw.trim()); continue; }
        if (TOTAL_RE.test(name) && !CHARGE_RE.test(name)) {
            if (!/sub/i.test(name)) printedTotal = amount;
            continue;
        }
        if (CHARGE_RE.test(name) && !/^\d+\s*[x×]?\s/.test(name)) {
            const disc = /\b(discount|coupon|promo|offer|saving|savings)\b/i.test(name) && amount > 0;
            charges.push({ id: uid('c'), name: name.replace(/\s+/g, ' ').replace(/[@:]+$/, '').trim(), amount: disc ? -amount : amount });
            if (disc) skipped.push(`CHECK: "${raw.trim()}" has no minus sign. Read as a discount of ${(amount / 100).toFixed(2)}. Fix it if that is wrong.`);
            continue;
        }
        if (SKIP_RE.test(name)) { skipped.push(raw.trim()); continue; }
        let warn = '';
        if (/\b(discount|coupon|promo|offer|saving|savings)\b/i.test(name) && amount > 0) { charges.push({ id: uid('c'), name: name.replace(/\s+/g, ' ').replace(/[@:\-]+$/, '').trim(), amount: -amount }); skipped.push(`CHECK: "${raw.trim()}" has no minus sign. Read as a discount of ${(amount / 100).toFixed(2)}. Fix it if that is wrong.`); continue; }
        let qty = nums.length >= 2 && /^\d{1,2}$/.test(nums[0]) && parseInt(nums[0], 10) > 0 ? parseInt(nums[0], 10) : 1; // qty column, e.g. "Naan 6 360.00"
        if (nums.length >= 3) { // rate qty total, e.g. "Naan 60.00 6 360.00"
            const rate = toMinor(nums[nums.length - 3]); const qn = /^\d{1,3}$/.test(nums[nums.length - 2]) ? parseInt(nums[nums.length - 2], 10) : 0;
            if (rate !== null && qn > 0 && rate * qn === amount) qty = qn;
            else warn = `${nums.join(' ')}`;
        }
        // trailing "2 x", "3 @", or "x" left in the name by the number split
        const tq = name.match(/^(.*?)\s+(\d{1,3})\s*[xX×@]$/);
        if (tq) { name = tq[1]; qty = Math.max(1, parseInt(tq[2], 10)); warn = warn || `${qty} x ${(amount / 100).toFixed(2)}`; }
        else if (/\s[xX×@]$/.test(name)) name = name.replace(/\s*[xX×@]$/, '');
        const q = name.match(/^(\d{1,3})\s*(?:[xX×]\s*|\s+)(.+)$/);
        if (q) { qty = Math.max(1, parseInt(q[1], 10)); name = q[2]; }
        else {
            const q2 = name.match(/^(.+?)\s*[xX×]\s*(\d{1,3})$/);
            if (q2) { name = q2[1]; qty = Math.max(1, parseInt(q2[2], 10)); }
        }
        items.push({ id: uid('i'), name: name.trim(), qty, total: amount, everyone: WATER_RE.test(name) });
        if (warn) skipped.push(`CHECK: "${raw.trim()}" was read as ${qty} unit${qty > 1 ? 's' : ''}, ${(amount / 100).toFixed(2)} in total. If ${(amount / 100).toFixed(2)} is the price each, fix the total.`);
    }
    return { items, charges, printedTotal, skipped };
}

export type PersonResult = { id: string; name: string; lines: { itemId: string; name: string; amount: number; note: string }[]; items: number; extras: number; total: number };
export type SplitResult = {
    people: PersonResult[];
    unassigned: number; // items nobody has claimed yet (0 when spread)
    unclaimedUnits: Record<string, number>;
    overclaimed: string[];
    chargesTotal: number;
    itemsTotal: number;
    billTotal: number; // items + charges
    sumOfParts: number; // people + unassigned
    reconciles: boolean;
    chargeLines: { id: string; name: string; amount: number; perPerson: number[] }[];
};

export function computeSplit(p: { items: Item[]; charges: Charge[]; people: Person[]; claims: Claims; shares?: Shares; chargeMode: ChargeMode; spread: boolean }): SplitResult {
    const n = p.people.length;
    const people: PersonResult[] = p.people.map((x) => ({ id: x.id, name: x.name, lines: [], items: 0, extras: 0, total: 0 }));
    let unassigned = 0;
    const unclaimedUnits: Record<string, number> = {};
    const overclaimed: string[] = [];
    for (const it of p.items) {
        const claims = p.people.map((x) => Math.max(0, Math.floor(p.claims[it.id]?.[x.id] ?? 0)));
        let weights: number[]; let un = 0;
        const sh = p.shares?.[it.id]?.filter((id) => p.people.some((x) => x.id === id)) ?? [];
        if (it.everyone) weights = p.people.map(() => 1);
        else if (sh.length) weights = p.people.map((x) => (sh.includes(x.id) ? 1 : 0));
        else {
            const S = claims.reduce((a, b) => a + b, 0);
            weights = claims;
            un = Math.max(it.qty - S, 0);
            if (S > it.qty) overclaimed.push(it.id);
            if (un > 0) unclaimedUnits[it.id] = un;
        }
        if (n === 0) { unassigned += it.total; continue; }
        const parts = allocate(it.total, [...weights, un]);
        parts.slice(0, n).forEach((amt, i) => {
            if (!weights[i]) return;
            people[i].items += amt;
            const note = it.everyone ? 'split by everyone' : sh.length ? `shared by ${sh.length}` : weights[i] === 1 && it.qty === 1 && weights.filter((w) => w).length > 1 ? 'shared' : `${weights[i]} of ${it.qty}`;
            people[i].lines.push({ itemId: it.id, name: it.name, amount: amt, note });
        });
        unassigned += parts[n];
    }
    if (p.spread && unassigned !== 0 && n > 0) {
        const parts = allocate(unassigned, p.people.map(() => 1));
        parts.forEach((amt, i) => { people[i].items += amt; if (amt) people[i].lines.push({ itemId: 'unclaimed', name: 'Unclaimed items, split equally', amount: amt, note: 'equal' }); });
        unassigned = 0;
    }
    const chargeLines = p.charges.map((c) => {
        let w = p.people.map(() => 1);
        if (p.chargeMode === 'prorata') {
            const basis = people.map((x) => Math.max(x.items, 0));
            if (basis.some((b) => b > 0)) w = basis;
        }
        const per = n ? allocate(c.amount, w) : [];
        per.forEach((amt, i) => (people[i].extras += amt));
        return { id: c.id, name: c.name, amount: c.amount, perPerson: per };
    });
    people.forEach((x) => (x.total = x.items + x.extras));
    const itemsTotal = p.items.reduce((a, b) => a + b.total, 0);
    const chargesTotal = p.charges.reduce((a, b) => a + b.amount, 0);
    const billTotal = itemsTotal + chargesTotal;
    const sumOfParts = people.reduce((a, b) => a + b.total, 0) + unassigned;
    return { people, unassigned, unclaimedUnits, chargesTotal, itemsTotal, billTotal, sumOfParts, reconciles: n > 0 && sumOfParts === billTotal && overclaimed.length === 0, overclaimed, chargeLines };
}
