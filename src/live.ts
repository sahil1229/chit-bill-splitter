import type { Settlement } from './settlement';
// Own-phone mode: end-to-end encrypted relay over ntfy.sh. Host is authoritative; diners can only change their own claims.
import { allocate, computeSplit, type Charge, type ChargeMode, type Claims, type Item, type Person, type Shares } from './engine';

const RELAY = 'https://ntfy.sh';
const enc = new TextEncoder(); const dec = new TextDecoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); let s = ''; u.forEach((x) => (s += String.fromCharCode(x))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const unb64u = (s: string) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
const rnd = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const rndId = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => ALPHA[x % 32]).join('');

export type Keys = { aes: CryptoKey; sign: CryptoKey; verify: CryptoKey; pub: string };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;
export async function newKeyPair() {
    const kp = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    return { sign: kp.privateKey, verify: kp.publicKey, pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}
export const importPub = (pub: string) => crypto.subtle.importKey('raw', unb64u(pub), ECDSA, false, ['verify']);
const importAes = (k: string) => crypto.subtle.importKey('raw', unb64u(k), 'AES-GCM', false, ['encrypt', 'decrypt']);

export type Link = { topic: string; key: string; hostPub: string };
export const linkFragment = (l: Link) => `join=${l.topic}.${l.key}.${l.hostPub}`;
export function parseLink(text: string): Link | null {
    const m = text.match(/join=([a-z0-9]{12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{86,88})/);
    return m ? { topic: m[1], key: m[2], hostPub: m[3] } : null;
}
export async function newSession(): Promise<{ link: Link; host: Awaited<ReturnType<typeof newKeyPair>> }> {
    const host = await newKeyPair();
    return { link: { topic: 'sb' + rndId(10), key: rnd(16), hostPub: host.pub }, host };
}

/** Envelope: iv + AES-GCM({p: payload JSON string, s: signature}) */
export async function seal(link: Link, payload: object, signKey: CryptoKey): Promise<string> {
    const p = JSON.stringify(payload);
    const s = b64u(await crypto.subtle.sign(SIG, signKey, enc.encode(p)));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importAes(link.key), enc.encode(JSON.stringify({ p, s }))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64u(out);
}
/** Returns payload string and signature without trusting either yet. */
export async function open(link: Link, body: string): Promise<{ p: string; s: string; data: any } | null> {
    try {
        const raw = unb64u(body.trim());
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await importAes(link.key), raw.slice(12));
        const { p, s } = JSON.parse(dec.decode(pt));
        return { p, s, data: JSON.parse(p) };
    } catch { return null; }
}
export async function verify(pub: string, p: string, s: string) {
    try { return await crypto.subtle.verify(SIG, await importPub(pub), unb64u(s), enc.encode(p)); } catch { return false; }
}

// ---- transport ----
export async function publish(topic: string, body: string, tries = 4): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(`${RELAY}/${topic}`, { method: 'POST', body });
            if (r.ok) return true;
            if (r.status === 429) await sleep(10000); else if (r.status >= 400 && r.status < 500) return false;
        } catch { /* network */ }
        await sleep(800 * (i + 1));
    }
    return false;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streaming subscribe with reconnect, replay of the 12h cache, delayed re-poll (the cache is eventually consistent) and dedupe by relay id. */
export function subscribe(topic: string, onMsg: (body: string) => void, onStatus: (s: 'connecting' | 'live' | 'reconnecting') => void) {
    let stop = false; const seen = new Set<string>(); let ctl: AbortController | null = null;
    const deliver = (line: string) => {
        if (!line.trim()) return;
        try { const e = JSON.parse(line); if (e.event === 'message' && e.id && !seen.has(e.id)) { seen.add(e.id); onMsg(e.message); } } catch { /* ignore */ }
    };
    const poll = async () => { try { const r = await fetch(`${RELAY}/${topic}/json?poll=1&since=all`); (await r.text()).split('\n').forEach(deliver); } catch { /* ignore */ } };
    (async () => {
        let delay = 1500; onStatus('connecting');
        while (!stop) {
            ctl = new AbortController();
            try {
                const r = await fetch(`${RELAY}/${topic}/json?since=all`, { signal: ctl.signal });
                if (!r.ok || !r.body) throw new Error(String(r.status));
                onStatus('live'); delay = 1500;
                setTimeout(poll, 3500);
                const rd = r.body.getReader(); let buf = '';
                for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() ?? ''; lines.forEach(deliver); }
            } catch { /* fallthrough */ }
            if (stop) break;
            onStatus('reconnecting'); await sleep(delay); delay = Math.min(delay * 2, 10000);
        }
    })();
    return () => { stop = true; ctl?.abort(); };
}

// ---- state published by the host ----
export type LiveItem = { i: string; n: string; q: number; t: number; e?: 1; c: Record<string, number>; s: string[] };
export const validUpi = (u?: string) => /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,30}$/.test((u ?? '').trim());
export type LiveState = { rev: number; open: boolean; final: boolean; items: LiveItem[]; pay?: { n: string; u: string }; people: { i: string; n: string }[]; tot: Record<string, number>; ack: Record<string, number>; rej: Record<string, Record<string, string>>; at: number; settlement?: Settlement; approved?: string[] };
const CHUNK = 2200;
export function chunkState(st: LiveState): object[] {
    const s = JSON.stringify(st); const parts: string[] = [];
    for (let i = 0; i < s.length; i += CHUNK) parts.push(s.slice(i, i + CHUNK));
    return parts.map((d, i) => ({ t: 'state', rev: st.rev, i, n: parts.length, d }));
}
export class Reassembler {
    private got = new Map<number, string[]>(); latest = -1;
    add(m: { rev: number; i: number; n: number; d: string }): LiveState | null {
        if (m.rev < this.latest) return null;
        const a = this.got.get(m.rev) ?? new Array(m.n).fill(null); a[m.i] = m.d; this.got.set(m.rev, a);
        if (a.every((x) => x !== null)) {
            try { const st = JSON.parse(a.join('')) as LiveState; this.latest = m.rev; for (const k of [...this.got.keys()]) if (k <= m.rev) this.got.delete(k); return st; } catch { return null; }
        }
        return null;
    }
}

// ---- host authority ----
export type Snap = { items: Item[]; charges: Charge[]; people: Person[]; claims: Claims; shares: Shares; chargeMode: ChargeMode; spread: boolean; upi?: string; hostName?: string; printedTotal?: number | null; settlement?: Settlement; externalCollector?: string; tableId?: string; frozen?: boolean; approved?: string[] };
const cleanName = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);

export class HostEngine {
    reg = new Map<string, { pub: string; lastN: number }>();
    ack: Record<string, number> = {}; rej: Record<string, Record<string, string>> = {};
    rev = 0; open = true; log: string[] = []; banned = new Set<string>();
    dump() { return { reg: [...this.reg], ack: this.ack, rej: this.rej, rev: this.rev, banned: [...this.banned], open: this.open }; }
    load(v: any) { if (!v) return; this.reg = new Map(v.reg ?? []); this.ack = v.ack ?? {}; this.rej = v.rej ?? {}; this.rev = v.rev ?? 0; this.banned = new Set(v.banned ?? []); this.open = v.open !== false; }
    constructor(public link: Link, public read: () => Snap, public write: (p: Partial<Snap>) => void) {}
    /** Process one relay body. Returns true when state changed. */
    async handle(body: string): Promise<boolean> {
        const o = await open(this.link, body);
        if (!o || !o.data || typeof o.data.pid !== 'string' || !/^[a-z0-9]{6,12}$/.test(o.data.pid)) return false;
        const d = o.data; const pid: string = d.pid;
        if (!this.open || this.banned.has(pid)) return false;
        const snap = this.read();
        if (snap.frozen || snap.settlement || (snap.tableId && typeof localStorage !== 'undefined' && localStorage.getItem('chit.final.' + snap.tableId))) return false; // immutable finalized table refuses joins and claims
        if (d.t === 'join') {
            if (typeof d.pub !== 'string' || !(await verify(d.pub, o.p, o.s))) return false;
            const known = this.reg.get(pid);
            if (known) { if (known.pub !== d.pub) { this.log.push(`refused re-registration of ${pid}`); return false; } if (snap.people.some((p) => p.id === pid)) return false; }
            else this.reg.set(pid, { pub: d.pub, lastN: 0 });
            if (snap.people.some((p) => p.id === pid)) return false;
            let name = cleanName(d.name) || 'Guest'; const base = name; let k = 2;
            while (snap.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${base} (${k++})`;
            if (snap.people.length >= 20) return false;
            this.write({ people: [...snap.people, { id: pid, name }] });
            return true;
        }
        if (d.t === 'claims') {
            const r = this.reg.get(pid);
            if (!r || !(await verify(r.pub, o.p, o.s))) return false;       // only the holder of this diner's key can change this diner's claims
            if (!Number.isInteger(d.n) || d.n <= r.lastN) return false;       // replay / out-of-order
            if (!snap.people.some((p) => p.id === pid)) return false;        // removed by host
            r.lastN = d.n;
            const want: Record<string, number> = d.c && typeof d.c === 'object' ? d.c : {};
            const wantShare: string[] = Array.isArray(d.sh) ? d.sh : [];
            const claims: Claims = {}; const shares: Shares = {}; const rej: Record<string, string> = {};
            for (const it of snap.items) {
                const cur = { ...(snap.claims[it.id] ?? {}) }; delete cur[pid];
                let sh = (snap.shares[it.id] ?? []).filter((x) => x !== pid);
                if (!it.everyone) {
                    const others = Object.values(cur).reduce((a, b) => a + b, 0);
                    const q = Math.max(0, Math.min(Number.isInteger(want[it.id]) ? want[it.id] : 0, it.qty));
                    if (wantShare.includes(it.id)) {
                        if (others > 0) rej[it.id] = 'This dish was picked by units earlier. Ask the host to switch it to equal split.';
                        else sh = [...sh, pid];
                    } else if (q > 0) {
                        if (sh.length > 0) rej[it.id] = 'This one is being shared. Tap Share to join.';
                        else { const g = Math.min(q, it.qty - others); if (g > 0) cur[pid] = g; if (g < q) rej[it.id] = g > 0 ? `Only ${g} left, you got ${g}.` : 'Already taken by others.'; }
                    }
                }
                if (Object.keys(cur).length) claims[it.id] = cur;
                if (sh.length) shares[it.id] = sh;
            }
            this.ack[pid] = d.n; this.rej[pid] = rej;
            this.write({ claims, shares });
            return true;
        }
        return false;
    }
    state(): LiveState {
        const s = this.read();
        const res = computeSplit({ ...s, spread: false });
        const tot: Record<string, number> = {}; res.people.forEach((p) => (tot[p.id] = p.total));
        const ids = new Set(s.people.map((p) => p.id));
        return {
            rev: ++this.rev, open: this.open, final: (s.printedTotal == null || s.printedTotal === res.billTotal) && res.reconciles && res.unassigned === 0 && Object.keys(res.unclaimedUnits).length === 0 && s.people.length > 0, at: Date.now(),
            items: s.items.map((it) => ({ i: it.id, n: it.name.slice(0, 40), q: it.qty, t: it.total, ...(it.everyone ? { e: 1 as const } : {}), c: s.claims[it.id] ?? {}, s: s.shares[it.id] ?? [] })),
            ...(s.settlement ? { settlement: s.settlement, approved: (s.approved ?? []).filter((id) => ids.has(id)) } : {}),
            // Live payment links disabled until immutable settlement confirmation is supported.
            people: s.people.map((p) => ({ i: p.id, n: p.name })), tot,
            ack: Object.fromEntries(Object.entries(this.ack).filter(([k]) => ids.has(k))), rej: Object.fromEntries(Object.entries(this.rej).filter(([k]) => ids.has(k))),
        };
    }
}
export { allocate };

// ---- diner side ----
export const store = {
    get(k: string): any { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
    set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
export class Diner {
    pid = 'p' + rndId(8); n = 0; kp!: Awaited<ReturnType<typeof newKeyPair>>;
    constructor(public link: Link) {}
    async init() { this.kp = await newKeyPair(); return this; }
    /** Reuse the same seat after a reload, so the host does not see a second person. Returns the saved name or null. */
    async restore(): Promise<string | null> {
        const v = store.get('sb.seat.' + this.link.topic); if (!v?.pid || !v.priv || !v.pub) return null;
        try {
            const sign = await crypto.subtle.importKey('jwk', v.priv, ECDSA, true, ['sign']);
            this.kp = { sign, verify: await importPub(v.pub), pub: v.pub }; this.pid = v.pid; this.n = v.n ?? 0; return v.name ?? 'Guest';
        } catch { return null; }
    }
    async save(name: string) { store.set('sb.seat.' + this.link.topic, { pid: this.pid, n: this.n, name, pub: this.kp.pub, priv: await crypto.subtle.exportKey('jwk', (this.kp as any).priv ?? this.kp.sign).catch(() => null) }); }
    async join(name: string) { return publish(this.link.topic, await seal(this.link, { t: 'join', pid: this.pid, name, pub: this.kp.pub }, this.kp.sign)); }
    async claimsRaw(c: Record<string, number>, sh: string[], n: number) { return publish(this.link.topic, await seal(this.link, { t: 'claims', pid: this.pid, n, c, sh }, this.kp.sign)); }
    async claims(c: Record<string, number>, sh: string[]) { this.n += 1; return { n: this.n, ok: publish(this.link.topic, await seal(this.link, { t: 'claims', pid: this.pid, n: this.n, c, sh }, this.kp.sign)) }; }
}
export async function hostSend(link: Link, hostKey: CryptoKey, st: LiveState): Promise<boolean> {
    let ok = true;
    for (const m of chunkState(st)) { if (!(await publish(link.topic, await seal(link, m, hostKey)))) ok = false; }
    return ok;
}
/** Diner-side check that a state chunk really came from the host. */
export async function openHost(link: Link, body: string) {
    const o = await open(link, body);
    if (!o || o.data?.t !== 'state' || !(await verify(link.hostPub, o.p, o.s))) return null;
    return o.data as { rev: number; i: number; n: number; d: string };
}
