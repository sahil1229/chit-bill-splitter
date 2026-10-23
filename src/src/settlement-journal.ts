import { finalizeSettlement, restoreSettlement, type Settlement, type SettlementDraft } from './settlement';
export type JournalRecord = { version: 1; tableId: string; status: 'intent' | 'final'; settlement: Settlement; draft: SettlementDraft };
export type DurableStore = Pick<Storage, 'getItem' | 'setItem'>;
export type TableLock = <T>(name: string, work: () => Promise<T>) => Promise<T>;
const browserLock: TableLock = async (name, work) => {
    if (typeof navigator === 'undefined' || !navigator.locks) throw Error('Cross-tab locking unavailable. Finalization is disabled.');
    return navigator.locks.request(name, { mode: 'exclusive' }, work);
};
const keyFor = (table: string) => 'chit.final.' + table;
/** All initialization and final writes run under the same cross-context Web Lock. */
export class SettlementJournal {
    private blocked = true;
    private initialized = false;
    private final: Settlement | null = null;
    private frozenDraft: SettlementDraft | null = null;
    constructor(private tableId: string, private store: DurableStore, private lock: TableLock = browserLock) {}
    get locked() { return this.blocked; }
    get settlement() { return this.final; }
    get draft() { return this.frozenDraft ? structuredClone(this.frozenDraft) : null; }
    assertEditable() { if (!this.initialized || this.blocked) throw Error('Table not initialized, finalized or unresolved. Reload before editing.'); }
    private write(record: JournalRecord) {
        const text = JSON.stringify(record), key = keyFor(this.tableId);
        this.store.setItem(key, text);
        if (this.store.getItem(key) !== text) throw Error('Settlement storage read-back failed.');
    }
    private async recoverLocked(): Promise<Settlement | null> {
        this.blocked = true;
        const text = this.store.getItem(keyFor(this.tableId));
        if (!text) { this.initialized = true; this.blocked = false; return null; }
        const record = JSON.parse(text) as JournalRecord;
        if (record.version !== 1 || record.tableId !== this.tableId || !['intent','final'].includes(record.status)) throw Error('Invalid settlement journal.');
        const s = await restoreSettlement(record.settlement);
        if (s.tableId !== this.tableId) throw Error('Journal table mismatch.');
        const check = await finalizeSettlement(record.draft);
        if (record.draft.tableId !== this.tableId || JSON.stringify({ hostBinding: check.hostBinding, billTotal: check.billTotal, collector: check.collector, shares: check.shares }) !== JSON.stringify({ hostBinding: s.hostBinding, billTotal: s.billTotal, collector: s.collector, shares: s.shares })) throw Error('Saved draft does not match settlement.');
        this.frozenDraft = structuredClone(record.draft);
        if (record.status === 'intent') this.write({ ...record, status: 'final', settlement: s });
        this.final = s; this.initialized = true; return s;
    }
    async recover(): Promise<Settlement | null> {
        this.blocked = true;
        return this.lock(keyFor(this.tableId), () => this.recoverLocked());
    }
    async finalize(draft: SettlementDraft): Promise<Settlement> {
        this.assertEditable(); this.blocked = true;
        return this.lock(keyFor(this.tableId), async () => {
            // An initialized but stale tab must not overwrite a final created by another tab.
            const text = this.store.getItem(keyFor(this.tableId));
            if (text) { await this.recoverLocked(); throw Error('This table already has immutable payment instructions.'); }
            if (draft.tableId !== this.tableId) { this.blocked = false; throw Error('Wrong table.'); }
            const frozenDraft = structuredClone(draft);
            let s: Settlement;
            try { s = await finalizeSettlement(frozenDraft); } catch (e) { this.blocked = false; throw e; }
            this.write({ version: 1, tableId: this.tableId, status: 'intent', settlement: s, draft: frozenDraft });
            this.write({ version: 1, tableId: this.tableId, status: 'final', settlement: s, draft: frozenDraft });
            this.frozenDraft = frozenDraft; this.final = s; return s;
        });
    }
}
