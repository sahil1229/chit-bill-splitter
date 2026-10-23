import { computeSplit, type Item, type Charge, type Person, type Claims, type Shares, type ChargeMode } from './engine';

export type Collector = { kind: 'diner'; dinerId: string; upi: string } | { kind: 'external'; name: string; upi: string };
export type SettlementDraft = {
    tableId: string; liveLink?: { topic: string; key: string; hostPub: string }; items: Item[]; charges: Charge[]; people: Person[]; claims: Claims; shares: Shares;
    chargeMode: ChargeMode; spread?: boolean; printedTotal: number | null; collector: Collector;
};
export type Settlement = Readonly<{
    version: 1; id: string; tableId: string; createdAt: number; billTotal: number;
    hostBinding?: Readonly<{ topic: string; hostPub: string }>;
    collector: Readonly<{ kind: 'diner' | 'external'; dinerId: string | null; name: string; upi: string }>;
    shares: readonly Readonly<{ personId: string; name: string; amount: number; owesCollector: boolean }>[];
    digest: string;
}>;
const upiValid = (s: string) => /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,30}$/.test(s);
const safeAmount = (n: number) => Number.isSafeInteger(n) && n >= 0;
const textValid = (s: unknown, max: number) => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\u0000-\u001f<>]/.test(s);
function freeze<T>(o: T): T { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; }
function normalized(d: SettlementDraft) {
    if (!textValid(d.tableId, 200)) throw Error('Missing table ID.');
    if (!d.people.length || d.people.length > 30 || !d.items.length) throw Error('Add diners and bill items first.');
    if (new Set(d.people.map(p => p.id)).size !== d.people.length || d.people.some(p => !textValid(p.id, 100) || !textValid(p.name, 100))) throw Error('Each diner needs a unique ID and name.');
    if (d.items.some(i => !Number.isSafeInteger(i.qty) || i.qty <= 0 || !Number.isSafeInteger(i.total))) throw Error('Check item quantities and amounts.');
    if (d.charges.some(c => !Number.isSafeInteger(c.amount))) throw Error('Check charge amounts.');
    const res = computeSplit({ ...d, spread: !!d.spread });
    if (!safeAmount(res.billTotal) || res.people.some(p => !safeAmount(p.total))) throw Error('Payment amounts must be nonnegative whole paise.');
    if (res.overclaimed.length || res.unassigned !== 0 || (!d.spread && Object.keys(res.unclaimedUnits).length) || !res.reconciles) throw Error('Assign every unit before finalizing.');
    if (d.printedTotal != null && d.printedTotal !== res.billTotal) throw Error('Printed total does not match.');
    const upi = d.collector.upi.trim();
    if (!upiValid(upi)) throw Error('Add a valid collector UPI ID.');
    const collector = d.collector;
    const diner = collector.kind === 'diner' ? d.people.find(p => p.id === collector.dinerId) : undefined;
    if (d.collector.kind === 'diner' && !diner) throw Error('Collector diner no longer exists.');
    const name = (d.collector.kind === 'external' ? d.collector.name : diner!.name).trim();
    if (!textValid(name, 100)) throw Error('Add a collector name.');
    return { billTotal: res.billTotal, collector: { kind: d.collector.kind, dinerId: diner?.id ?? null, name, upi }, shares: res.people.map(p => ({ personId: p.id, name: p.name, amount: p.total, owesCollector: p.id !== diner?.id })) };
}
const digest = async (o: object) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(o))))).map(n => n.toString(16).padStart(2, '0')).join('');
/** Called only after host review. Does not publish, sign, or process a payment. */
export async function finalizeSettlement(draft: SettlementDraft): Promise<Settlement> {
    const d = structuredClone(draft); const values = normalized(d);
    const body = { ...(d.liveLink ? { hostBinding: { topic: d.liveLink.topic, hostPub: d.liveLink.hostPub } } : {}), version: 1 as const, id: crypto.randomUUID(), tableId: d.tableId, createdAt: Date.now(), ...values };
    return freeze({ ...body, digest: await digest(body) });
}
/** Detects storage corruption. A matching digest is NOT authenticity or payment proof. */
export async function restoreSettlement(raw: unknown): Promise<Settlement> {
    const s = structuredClone(raw) as Settlement;
    if (!s || s.version !== 1 || !textValid(s.id, 100) || !textValid(s.tableId, 200) || !safeAmount(s.billTotal) || !Number.isSafeInteger(s.createdAt) || s.createdAt < 0 || !s.collector || !Array.isArray(s.shares)) throw Error('Invalid saved settlement.');
    if (!['diner', 'external'].includes(s.collector.kind) || !textValid(s.collector.name, 100) || typeof s.collector.upi !== 'string' || !upiValid(s.collector.upi)) throw Error('Invalid saved collector.');
    if (s.shares.length === 0 || s.shares.length > 30 || new Set(s.shares.map(p => p.personId)).size !== s.shares.length || s.shares.some(p => !p || !textValid(p.personId, 100) || !textValid(p.name, 100) || typeof p.owesCollector !== 'boolean' || !safeAmount(p.amount))) throw Error('Invalid saved shares.');
    if (s.shares.reduce((a,p) => a + p.amount, 0) !== s.billTotal) throw Error('Saved shares do not match the bill.');
    if (s.collector.kind === 'diner' ? !s.shares.some(p => p.personId === s.collector.dinerId) : s.collector.dinerId !== null) throw Error('Invalid collector membership.');
    if (s.shares.some(p => p.owesCollector !== (p.personId !== s.collector.dinerId))) throw Error('Invalid payment responsibility.');
    if (s.hostBinding && (!textValid(s.hostBinding.topic, 100) || !textValid(s.hostBinding.hostPub, 200))) throw Error('Invalid host binding.');
    const { digest: expected, ...body } = s;
    if (expected !== await digest(body)) throw Error('Saved settlement changed.');
    return freeze(s);
}
export type Receipt = Readonly<{ settlementId: string; settlementDigest: string; personId: string; amount: number; payee: string; markedAt: number }>;
/** A host's manual record only. Never a claim that a bank payment succeeded. */
export function markReceived(s: Settlement, personId: string): Receipt {
    const p = s.shares.find(p => p.personId === personId);
    if (!p || !p.owesCollector) throw Error('This person does not owe the collector.');
    return freeze({ settlementId: s.id, settlementDigest: s.digest, personId, amount: p.amount, payee: s.collector.upi, markedAt: Date.now() });
}
export function receiptMatches(s: Settlement, r: Receipt): boolean {
    const p = s.shares.find(p => p.personId === r.personId);
    return !!p?.owesCollector && r.settlementId === s.id && r.settlementDigest === s.digest && r.amount === p.amount && r.payee === s.collector.upi;
}

/** Prototype lifecycle. Integration must route EVERY host/diner mutation through this gate. */
export class SettlementBook {
    private phase: 'draft' | 'finalizing' | 'indeterminate' | 'final' = 'draft';
    private value: Settlement | null = null;
    private pending: { id: string; tableId: string; digest: string } | null = null;
    get status() { return this.phase; }
    get settlement() { return this.value; }
    assertEditable() { if (this.phase !== 'draft') throw Error('This table is finalized or finalizing. Start a new table to make corrections.'); }
    async finalize(draft: SettlementDraft, save: (s: Settlement) => Promise<void>): Promise<Settlement> {
        this.assertEditable(); this.phase = 'finalizing';
        let s: Settlement;
        try { s = await finalizeSettlement(draft); }
        catch (e) { this.phase = 'draft'; throw e; }
        this.pending = { id: s.id, tableId: s.tableId, digest: s.digest };
        try {
            // No instructions are exposed until durable save succeeds.
            await save(s); this.value = s; this.phase = 'final'; return s;
        } catch (e) { this.phase = 'indeterminate'; throw e; }
    }
    async reconcile(readDurable: () => Promise<unknown>): Promise<void> {
        if (this.phase !== 'indeterminate') throw Error('No indeterminate write to reconcile.');
        const raw = await readDurable();
        // Absence or read failure does not prove an earlier write never committed.
        if (!raw) throw Error('No confirmed durable settlement. Keep this table blocked.');
        const s = await restoreSettlement(raw);
        if (!this.pending || s.id !== this.pending.id || s.tableId !== this.pending.tableId || s.digest !== this.pending.digest) throw Error('Durable record does not match the pending settlement.');
        this.value = s; this.phase = 'final';
    }
    async restore(raw: unknown): Promise<void> {
        this.assertEditable(); this.phase = 'finalizing';
        try { this.value = await restoreSettlement(raw); this.phase = 'final'; }
        catch (e) { // A corrupt finalized record must not silently become an editable draft.
            this.value = null; this.phase = 'indeterminate'; throw e;
        }
    }
}

export type DinerPayment = Readonly<{ settlementId: string; digest: string; personId: string; amount: number; name: string; upi: string; owesCollector: boolean }>;
/** Caller must first authenticate the complete snapshot with the table's host signing key. */
export type PinLock = <T>(name: string, work: () => Promise<T>) => Promise<T>;
const browserPinLock: PinLock = async (name, work) => {
    if (typeof navigator === 'undefined' || !navigator.locks) throw Error('Safe cross-tab payment locking is unavailable. Payment links are disabled.');
    return navigator.locks.request(name, { mode: 'exclusive' }, work);
};
export async function pinDinerPayment(raw: unknown, table: { topic: string; hostPub: string }, personId: string, storage: Pick<Storage, 'getItem' | 'setItem'>, lock: PinLock = browserPinLock): Promise<DinerPayment> {
    const s = await restoreSettlement(raw);
    if (s.hostBinding?.topic !== table.topic || s.hostBinding?.hostPub !== table.hostPub) throw Error('Settlement does not belong to this signed table.');
    const share = s.shares.find(p => p.personId === personId);
    if (!share) throw Error('You are not a diner in this finalized settlement.');
    const key = 'chit.diner-final.' + table.topic + '.' + personId;
    return lock(key, async () => {
        const identity = JSON.stringify({ id: s.id, digest: s.digest, hostPub: table.hostPub });
        const savedText = storage.getItem(key);
        let saved: { status: 'pinned' | 'conflict'; identity: string } | null = null;
        if (savedText) {
            try { saved = JSON.parse(savedText); } catch { throw Error('Invalid saved payment pin. Payment links are disabled.'); }
            if (!saved || !['pinned','conflict'].includes(saved.status) || typeof saved.identity !== 'string') throw Error('Invalid saved payment pin. Payment links are disabled.');
            if (saved.status === 'conflict') throw Error('This table has a saved payment conflict. Do not pay; ask the host for a new table.');
            if (saved.identity !== identity) {
                const conflict = JSON.stringify({ status: 'conflict', identity: saved.identity });
                storage.setItem(key, conflict);
                if (storage.getItem(key) !== conflict) throw Error('Could not save payment conflict. Do not pay.');
                throw Error('This table published conflicting finalized payment details. Do not pay; ask the host for a new table.');
            }
        }
        const text = JSON.stringify({ status: 'pinned', identity });
        storage.setItem(key, text);
        if (storage.getItem(key) !== text) throw Error('Cannot save your finalized payment details. Payment links are disabled.');
        return Object.freeze({ settlementId: s.id, digest: s.digest, personId, amount: share.amount, name: s.collector.name, upi: s.collector.upi, owesCollector: share.owesCollector });
    });
                                      }
