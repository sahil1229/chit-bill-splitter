import { pinDinerPayment, type DinerPayment } from './settlement';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { computeSplit, countedByDefault, fmt, type Item, type Person } from './engine';
import { allowance, onRelayBusy, store, Diner, HostEngine, Reassembler, hostSend, newSession, openHost, linkFragment, parseLink, subscribe, verify, type Link, type LiveState, type Snap, validUpi } from './live';
import { PayOptions, Qr } from './Pay';
import { shareBase } from './site';

export const JOIN_BASE = shareBase();
/** ntfy.sh allows 250 messages per IP per 12h, so a quiet table only re-announces itself this often. */
const HEARTBEAT = 75000;
const HOST_LOST = HEARTBEAT * 2 + 30000;

export const envDebug = () => `href=${location.href.slice(0, 140)} | hash=${location.hash.slice(0, 40)} | search=${location.search.slice(0, 60)} | ref=${document.referrer.slice(0, 80)} | name=${window.name.slice(0, 30)}`;
export function envLink(): Link | null {
    for (const s of [location.hash, location.search, window.name]) { const l = parseLink(decodeURIComponent(s || '')); if (l) return l; }
    return null;
}
export async function recoverHostIdentity(tableId: string, previous: any) {
    if (!previous?.link?.topic) throw Error('Missing saved host table link.');
    const text = localStorage.getItem('chit.identity.' + previous.link.topic);
    if (!text) throw Error('Missing durable host signing identity.');
    const v = JSON.parse(text);
    if (v.tableId !== tableId || !v.link || JSON.stringify(v.link) !== JSON.stringify(previous.link) || !parseLink(linkFragment(v.link))) throw Error('Saved signing identity does not match this table.');
    const key = await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const challenge = 'chit-host-restore:' + tableId + ':' + crypto.randomUUID();
    const bytes = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(challenge)));
    let binary = ''; bytes.forEach(b => binary += String.fromCharCode(b));
    const signature = btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    if (!await verify(v.link.hostPub, challenge, signature)) throw Error('Saved host private key does not match the table public key.');
    return { ...previous, link: v.link, priv: v.priv, eng: v.eng };
}

function useRelayBusy() { const [busy, setBusy] = useState(false); useEffect(() => onRelayBusy(setBusy), []); return busy; }
const BusyNote = () => <p className="lv-warn" role="status">The free relay is busy. Retrying automatically. Keep this page open.</p>;

export type HostSession = { link: Link; status: 'connecting' | 'live' | 'reconnecting'; sent: number; failed: boolean; log: string[]; closed: boolean };
type HostSnap = Snap & { items: Item[]; people: Person[] };

/** Runs the host side while a session exists. Keeps its keys in memory only. */
export function useHost(read: () => HostSnap, write: (p: Partial<Snap>) => void, version: string, ready: boolean, hs: { get: () => any; set: (v: any) => void }) {
    const [sess, setSess] = useState<HostSession | null>(null);
    const [starting,setStarting]=useState(false);const [startError,setStartError]=useState('');const startingRef=useRef(false);
    const eng = useRef<HostEngine | null>(null); const keys = useRef<CryptoKey | null>(null);
    const generation = useRef(0);
    const unsub = useRef<(() => void) | null>(null); const chain = useRef(Promise.resolve()); const timer = useRef<any>(null); const lastSent = useRef(0);
    // A change after a quiet spell goes out almost at once; a burst of picks shares one message every 2s.
    const lastFire = useRef(0);
    const broadcast = () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            if (!eng.current || !keys.current) return;
            await allowance(); // build the update after any wait, so it is never stale
            if (!eng.current || !keys.current) return;
            lastFire.current = Date.now();
            const engine = eng.current; const g = generation.current; const link = engine.link;
            try { const ok = await hostSend(link, keys.current, engine.state()); if (ok) lastSent.current = Date.now(); if (g !== generation.current || eng.current !== engine) return; setSess((s) => (s ? { ...s, ...(ok ? { sent: Date.now() } : {}), failed: !ok } : s)); } catch { if (g === generation.current && eng.current === engine) setSess((s) => (s ? { ...s, failed: true } : s)); }
        }, Math.max(150, 2000 - (Date.now() - lastFire.current)));
    };
    const persist = async () => { const g = generation.current; const engine = eng.current, key = keys.current; if (engine && key) { const priv = await crypto.subtle.exportKey('jwk', key); if (g !== generation.current || eng.current !== engine) return; hs.set({ link: engine.link, priv, eng: eng.current.dump(), snap: (() => { const x = read(); return { items: x.items, charges: x.charges, people: x.people, claims: x.claims, shares: x.shares, chargeMode: x.chargeMode, spread: x.spread, printedTotal: x.printedTotal, tableId: x.tableId, settlement: x.settlement, externalCollector: x.externalCollector }; })() }); } };
    const run = (link: Link, signKey: CryptoKey, saved?: any) => {
        generation.current += 1;
        const engineGeneration = generation.current; const tableAtStart = read().tableId;
        eng.current = new HostEngine(link, read, (patch) => { if (generation.current !== engineGeneration || read().tableId !== tableAtStart) return; write(patch); }); keys.current = signKey; eng.current.load(saved);
        setSess({ link, status: 'connecting', sent: 0, failed: false, log: [], closed: !eng.current.open });
        if (!eng.current.open) return;
        const g = generation.current;
        unsub.current = subscribe(link.topic, (b) => { chain.current = chain.current.then(async () => { if (g !== generation.current) return; if (await eng.current?.handle(b)) { broadcast(); persist(); } }); }, (st) => setSess((s) => (s ? { ...s, status: st } : s)));
        broadcast();
    };
    const start = async () => {if(startingRef.current)return;startingRef.current=true;setStarting(true);setStartError('');try{if(!window.isSecureContext||!crypto.subtle)throw new DOMException('Secure connection required','SecurityError');if(!navigator.locks)throw new DOMException('Cross-tab locks unavailable','NotSupportedError');const g=generation.current;const table=read().tableId;const {link,host}=await newSession();const priv=await crypto.subtle.exportKey('jwk',host.sign);if(g!==generation.current||read().tableId!==table)throw Error('Table changed');const cur=read() as HostSnap & {collectorMode?:string;collectorId?:string};let hostPatch:Partial<Snap>&{collectorId?:string}={};if(cur.collectorMode==='diner'){if(!(cur.hostName??'').trim())throw Error('Host name required');const existing=cur.people.find(p=>p.id===cur.collectorId);const id=existing?.id??('h'+crypto.randomUUID().replace(/-/g,'').slice(0,8));hostPatch={people:existing?cur.people:[...cur.people,{id,name:cur.hostName!.trim()}],collectorId:id,externalCollector:undefined};}const initial={...cur,...hostPatch};const prepared=new HostEngine(link,()=>initial,()=>{});const identity={link,priv,eng:prepared.dump()};const text=JSON.stringify({...initial,hostSess:identity});localStorage.setItem('chit.split.v1',text);if(localStorage.getItem('chit.split.v1')!==text)throw Error('Storage read-back failed');if(Object.keys(hostPatch).length)write(hostPatch);hs.set(identity);run(link,host.sign);}catch(e){const code=e instanceof DOMException?e.name:'setup-error';const action=code==='NotSupportedError'?'This browser is missing a feature needed for secure table setup. Update your browser, or use one-phone mode.':code==='SecurityError'?'Open the HTTPS site in your browser directly and allow browser storage.':code==='QuotaExceededError'?'Browser storage is full. Free storage, then reload before opening a table.':'Reload and try again. If it still fails, use one-phone mode and share this error code.';setStartError(`Could not open the table (${code}). ${action} No payment has been started.`);}finally{startingRef.current=false;setStarting(false);}};
    const remove = (id: string) => { if (read().settlement || read().frozen) return; eng.current?.banned.add(id); persist(); };
    const [resumed, setResumed] = useState(false);
    useEffect(() => { // host reload: pick the table back up, same link, same seats
        if (!ready || resumed || sess) return; setResumed(true);
        const v = hs.get(); if (!v?.priv || !v.link) return; const g = generation.current;
        crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']).then((k) => { if (g !== generation.current) return; if (v.snap && !read().items.length) write(v.snap); run(v.link, k, v.eng); }).catch(() => {});
    }, [ready]);
    const close = async (newBill = false) => {
        if (read().settlement && !newBill) throw Error('Finalized payment instructions cannot be closed or revoked. Start a new bill for corrections.');
        if (!eng.current || !keys.current) return;
        eng.current.open = false; clearTimeout(timer.current);
        try { await hostSend(eng.current.link, keys.current, eng.current.state()); } catch { /* best effort */ }
        await persist(); unsub.current?.(); setSess((s) => (s ? { ...s, closed: true } : s));
    };
    useEffect(() => { if (sess && !sess.closed) { broadcast(); persist(); } }, [version]); // roster, items or claims changed on the host phone
    useEffect(() => { if (!sess || sess.closed) return; const t = setInterval(() => { if (Date.now() - lastSent.current >= HEARTBEAT) broadcast(); }, 15000); return () => clearInterval(t); }, [sess?.link.topic, sess?.closed]);
    useEffect(() => () => { unsub.current?.(); clearTimeout(timer.current); }, []);
    const reset = () => { generation.current += 1; clearTimeout(timer.current); unsub.current?.(); unsub.current = null; eng.current = null; keys.current = null; chain.current = Promise.resolve(); hs.set({}); setSess(null); setResumed(true); };
    const saveIdentity = async (tableId: string) => {
        if (!eng.current || !keys.current) throw Error('Open the live table first.');
        const value = { tableId, link: eng.current.link, priv: await crypto.subtle.exportKey('jwk', keys.current), eng: eng.current.dump() };
        const key = 'chit.identity.' + eng.current.link.topic; const text = JSON.stringify(value);
        localStorage.setItem(key, text); if (localStorage.getItem(key) !== text) throw Error('Could not save host signing identity.');
        await persist();
    };
    return { sess, starting, startError, start, close, reset, saveIdentity, remove, log: eng.current?.log ?? [] };
}

export function HostPanel({ s, host, goClaim, goPay, removePerson, setPay }: { s: HostSnap & { collectorId: string; collectorMode?: 'diner' | 'external'; externalCollector?: string; upi?: string; hostName?: string; spread?: boolean }; setPay: (p: { collectorMode?: 'diner' | 'external'; externalCollector?: string; upi?: string; hostName?: string; collectorId?: string; received?: Record<string, number>; spread?: boolean }) => void; host: ReturnType<typeof useHost>; goClaim: (personId?: string) => void; goPay: () => void; removePerson: (id: string) => void }) {
    const { sess } = host; const busy = useRelayBusy();
    useEffect(() => { if (!sess && !s.collectorMode) setPay({ collectorMode: 'diner', externalCollector: undefined }); }, [!!sess, s.collectorMode]);
    const [copied, setCopied] = useState(false); const [editPay, setEditPay] = useState(false);
    const [dn, setDn] = useState(s.hostName ?? ''); const [du, setDu] = useState(s.upi ?? '');
    useEffect(() => { setDn(s.hostName ?? ''); setDu(s.upi ?? ''); }, [!!sess, editPay]);
    const res = useMemo(() => computeSplit({ ...s, spread: !!s.spread }), [s]);
    const raw = useMemo(() => computeSplit({ ...s, spread: false }), [s]);
    const url = sess ? `${JOIN_BASE}#${linkFragment(sess.link)}` : '';
    const unclaimed = s.items.filter((i) => !i.everyone && (raw.unclaimedUnits[i.id] ?? 0) > 0);
    const left = unclaimed.reduce((a, i) => a + Math.round((i.total / i.qty) * raw.unclaimedUnits[i.id]), 0);
    const external = s.collectorMode === 'external';
    const hostIn = !external && s.people.some((p) => p.id === s.collectorId);
    const guests = s.people.filter((p) => p.id !== s.collectorId).length;

    // 1. Frozen: nothing left to do here.
    if (s.settlement) return <section className="lv-card ch-next" data-next="collect">
        <h2>Table frozen</h2>
        <p>Everyone now sees their payment link on their own phone. Tick people off as the money arrives.</p>
        <button type="button" className="sb-btn sb-block" onClick={goPay}>Track payments →</button>
    </section>;

    // 2. Setup: who collects, then open the table.
    if (!sess) {
        const nameOk = !!(s.hostName ?? '').trim(); const upiOk = validUpi(s.upi);
        return <section className="lv-card">
            <h2>Set up the table</h2>
            <p className="sb-small">Everyone pays one person: you. Add your details once.</p>
            <label className="sb-label" htmlFor="hn">Your name</label>
            <input id="hn" className="lv-in" value={s.hostName ?? ''} maxLength={30} placeholder="Your name" onChange={(e) => setPay({ hostName: e.target.value, ...(external ? { externalCollector: e.target.value, collectorId: '' } : {}) })} />
            <label className="sb-label" htmlFor="hupi">Your UPI ID (everyone pays you here)</label>
            <input id="hupi" className="lv-in" inputMode="email" autoCapitalize="none" autoCorrect="off" placeholder="name@okaxis" value={s.upi ?? ''} onChange={(e) => setPay({ upi: e.target.value })} />
            {(s.upi ?? '').trim() && !upiOk && <p className="lv-rej">That does not look like a UPI ID. It looks like name@bank, for example sahil@okaxis.</p>}
            <label className="sb-check"><input type="checkbox" checked={external} onChange={(e) => setPay(e.target.checked ? { collectorMode: 'external', collectorId: '', externalCollector: s.hostName ?? '' } : { collectorMode: 'diner', externalCollector: undefined, collectorId: '' })} /> I am not eating, just collecting the money</label>
            <button className="sb-btn sb-block" type="button" onClick={host.start} disabled={!s.items.length || !nameOk || !upiOk || host.starting}>{host.starting ? 'Opening table…' : !s.items.length ? 'Add the bill first' : 'Open the table'}</button>
            {s.items.length > 0 && (!nameOk || !upiOk) && <p className="sb-small sb-muted">Add your name and UPI ID to open the table.</p>}
            {host.startError && <p className="lv-warn" role="alert">{host.startError}</p>}
            <details><summary>How it works</summary><p className="sb-muted sb-small">Friends scan a QR, tick what they ate on their own phones, and you see it here. When everything is picked, you check the amounts and freeze the table; each person then gets a payment link for their share. Picks travel end-to-end encrypted through a free public relay (ntfy.sh). Keep this page open while people pick.</p></details>
        </section>;
    }

    // 3. Open table: one clear next step at the top.
    const next = sess.closed ? null
        : guests === 0 ? { key: 'invite', title: 'Next: get everyone to scan the QR', body: 'Ask each person to scan this with their phone camera. They will tick what they ate.' }
        : unclaimed.length > 0 && !s.spread ? { key: 'wait', title: `Waiting for picks: ${unclaimed.length} ${unclaimed.length === 1 ? 'dish' : 'dishes'} not picked yet`, body: `${fmt(left)} is not picked by anyone yet.` }
        : { key: 'freeze', title: 'Everything is picked. Check and freeze', body: 'Look over everyone’s amount. Fix anything on your phone, then freeze the table to send payment links.' };
    return <>
        {next && <section className="lv-card ch-next" data-next={next.key}>
            <h2>{next.title}</h2>
            <p>{next.body}</p>
            {next.key === 'wait' && <><ul className="ch-left">{unclaimed.map((i) => <li key={i.id}>{i.name}{i.qty > 1 ? ` × ${raw.unclaimedUnits[i.id]}` : ''} <span>{fmt(Math.round((i.total / i.qty) * raw.unclaimedUnits[i.id]))}</span></li>)}</ul>
                <div className="ch-apps"><button type="button" className="sb-btn sb-small-btn" onClick={() => goClaim()}>Assign them on my phone</button><button type="button" className="sb-btn sb-ghost sb-small-btn" onClick={() => setPay({ spread: true })}>Split the rest equally</button></div></>}
            {next.key === 'freeze' && <button type="button" className="sb-btn sb-block" onClick={goPay}>Review and freeze →</button>}
            {s.spread && unclaimed.length > 0 && <p className="sb-small">Unpicked dishes are split equally. <button type="button" className="sb-link" onClick={() => setPay({ spread: false })}>Undo</button></p>}
            {busy && <BusyNote />}
        </section>}
        <section className="lv-card">
            {!sess.closed ? <>
                <h2>Scan to join</h2>
                <Qr text={url} label="QR code to join the table" />
                <p className="sb-small lv-status" data-s={sess.status}>{sess.status === 'live' ? '● Connected' : sess.status === 'connecting' ? '○ Connecting…' : '○ Reconnecting. New joins may be delayed.'}{sess.failed ? ' · Last update did not go out; retrying.' : ''}</p>
                <div className="ch-apps"><button className="sb-btn sb-ghost sb-small-btn" type="button" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Link copied' : 'Copy join link'}</button><a className="sb-link sb-a" href={url} target="_blank" rel="noopener noreferrer">Open join link</a></div>
                <p className="sb-small sb-muted">The link holds the table key: share it only with your group. Keep this page open.</p>
            </> : <h2>Table closed</h2>}
            <h3>Who is here ({s.people.length})</h3>
            {!s.people.length && <p className="sb-muted">Nobody yet.</p>}
            <ul className="lv-list">{res.people.map((p) => <li key={p.id}><b>{p.name}{p.id === s.collectorId ? ' (you)' : ''}</b>{res.people.filter((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()).length > 1 && <em className="lv-rej"> same name twice. If someone reloaded, remove the old one.</em>}<span>{fmt(p.total)}</span>{!sess.closed && p.id !== s.collectorId && <button className="sb-link" type="button" onClick={() => { host.remove(p.id); removePerson(p.id); }}>Remove</button>}</li>)}</ul>
            {hostIn && <button className="sb-btn sb-block" type="button" onClick={() => goClaim(s.collectorId)}>Pick my own dishes</button>}
            <details><summary>Who had what</summary><ul className="lv-list">{s.items.filter((i) => !i.everyone).map((i) => { const who = s.people.filter((p) => (s.claims[i.id]?.[p.id] ?? 0) > 0 || s.shares[i.id]?.includes(p.id)); return <li key={i.id}><b>{i.name}</b><span>{who.length ? who.map((p) => `${p.name}${s.shares[i.id]?.includes(p.id) ? '' : i.qty > 1 ? ` ×${s.claims[i.id]?.[p.id]}` : ''}`).join(', ') : 'nobody yet'}</span></li>; })}</ul>
                <button className="sb-btn sb-ghost sb-block" type="button" onClick={() => goClaim()}>Fix picks on my phone</button></details>
            <div className="ch-payee"><p className="sb-small">Payments go to <b>{(s.hostName ?? '').trim() || 'you'}</b> · {s.upi} {!sess.closed && <button type="button" className="sb-link" onClick={() => setEditPay(!editPay)}>{editPay ? 'Cancel' : 'Change'}</button>}</p>
                {editPay && <div className="lv-collect"><label className="sb-small">Name<input id="cn" value={dn} onChange={(e) => setDn(e.target.value)} /></label><label className="sb-small">UPI ID<input id="cu" value={du} autoCapitalize="none" autoCorrect="off" onChange={(e) => setDu(e.target.value)} /></label>
                    <button className="sb-btn sb-small-btn" type="button" disabled={!dn.trim() || !validUpi(du)} onClick={() => { setPay({ hostName: dn.trim(), upi: du.trim(), ...(external ? { externalCollector: dn.trim() } : {}) }); setEditPay(false); }}>Save</button></div>}</div>
            {!sess.closed && <button className="sb-link" type="button" onClick={() => { void host.close().catch(() => {}); }}>Close the table without splitting</button>}
            {host.log.length > 0 && <p className="sb-small sb-muted">Blocked: {host.log.length} attempt(s) to take over someone else's seat.</p>}
        </section>
    </>;
}

export function DinerApp({ link }: { link: Link }) {
    const d = useRef<Diner | null>(null); const re = useRef(new Reassembler());
    const [seatId, setSeatId] = useState('');
    const [name, setName] = useState(''); const [joined, setJoined] = useState(false);
    // A saved seat means this phone already joined: show loading, not the join form, while it is restored.
    const [restoring, setRestoring] = useState(() => !!store.get('sb.seat.' + link.topic)?.pid); const [st, setSt] = useState<LiveState | null>(null);
    const [relay, setRelay] = useState('connecting'); const [now, setNow] = useState(Date.now()); const [lastSeen, setLastSeen] = useState(0); const [joinAt, setJoinAt] = useState(0);
    const [sendFail, setSendFail] = useState(false); const sendT = useRef<any>(null);
    // My changes the host has not confirmed yet, per dish. n = the message they last went out in (0 = not sent).
    type Op = { c?: number; s?: boolean; n: number; at: number; tries?: number };
    const pendingRef = useRef<Record<string, Op>>({}); const [pending, setPendingState] = useState<Record<string, Op>>({});
    const setPending = (p: Record<string, Op>) => { pendingRef.current = p; setPendingState(p); };
    const [lateChange, setLateChange] = useState(false);
    const [payment, setPayment] = useState<DinerPayment | null>(null); const [paymentError, setPaymentError] = useState(''); const [paymentReviewed, setPaymentReviewed] = useState('');
    useEffect(() => { let cancelled = false; setPayment(null); setPaymentReviewed('');
        if (!st?.settlement || !seatId || !joined) return;
        const personId = seatId;
        void pinDinerPayment(st.settlement, link, personId, localStorage).then(p => { if (!cancelled) { setPayment(p); setPaymentError(''); } }).catch(e => { if (!cancelled) setPaymentError(String(e.message ?? e)); });
        return () => { cancelled = true; };
    }, [st?.settlement?.id, st?.settlement?.digest, seatId, joined]);

    useEffect(() => { const onStorage = (e: StorageEvent) => {
        if (e.key !== 'chit.diner-final.' + link.topic + '.' + seatId) return;
        try { const saved = e.newValue ? JSON.parse(e.newValue) : null; if (saved?.status === 'conflict' || !saved) { setPayment(null); setPaymentReviewed(''); setPaymentError('This table has a saved payment conflict. Do not pay; ask the host for a new table.'); } } catch { setPayment(null); setPaymentReviewed(''); setPaymentError('Saved payment details could not be read. Do not pay.'); }
    }; window.addEventListener('storage', onStorage); return () => window.removeEventListener('storage', onStorage); }, [link.topic, seatId]);
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 3000); return () => clearInterval(t); }, []);
    // On (re)load the relay replays every earlier update; hold them back and show only the newest.
    const [loaded, setLoaded] = useState(false); const caughtUp = useRef(false); const newest = useRef<LiveState | null>(null);
    useEffect(() => { caughtUp.current = false; return subscribe(link.topic, async (b) => {
        const m = await openHost(link, b); if (!m) return;
        const x = re.current.add(m); if (!x) return;
        if (caughtUp.current) { setSt(x); setLastSeen(Date.now()); } else newest.current = x;
    }, setRelay, () => { caughtUp.current = true; if (newest.current) { setSt(newest.current); setLastSeen(Date.now()); } setLoaded(true); }); }, [link.topic]);
    const pid = seatId;
    const me = st?.people.find((p) => p.i === pid);
    const listed = useRef(false); if (me) listed.current = true; // seen on the host's list at least once
    const send = async () => {
        clearTimeout(sendT.current); const dn = d.current; const ops = pendingRef.current;
        if (!dn || !Object.keys(ops).length) return;
        const n = (dn.n += 1); const at = Date.now(); lastSend.current = at;
        setPending(Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, { ...v, n, at, tries: (v.n > 0 ? (v.tries ?? 0) + 1 : 0) }])));
        void dn.save(name);
        const ok = await dn.sendOps(Object.fromEntries(Object.entries(ops).map(([k, { c, s: share }]) => [k, { ...(c !== undefined ? { c } : {}), ...(share !== undefined ? { s: share } : {}) }])), n);
        setSendFail(!ok);
    };
    // One tap = one per-dish change; bursts of taps go out together after 1.5s.
    const lastSend = useRef(0);
    const change = (id: string, op: { c?: number; s?: boolean }) => { setPending({ ...pendingRef.current, [id]: { ...op, n: 0, at: Date.now() } }); clearTimeout(sendT.current); sendT.current = setTimeout(() => void send(), Math.max(250, 1500 - (Date.now() - lastSend.current))); };
    // The host confirmed message n: those changes are now part of its state (granted, or rejected with a reason).
    useEffect(() => {
        if (!st || !pid) return;
        const ack = st.ack[pid] ?? 0; const left = Object.fromEntries(Object.entries(pendingRef.current).filter(([, v]) => v.n === 0 || v.n > ack));
        if (Object.keys(left).length !== Object.keys(pendingRef.current).length) setPending(left);
        if (st.settlement && Object.keys(left).length) setLateChange(true);
    }, [st?.rev, pid]);
    // Unconfirmed changes are resent until the host confirms them; leaving the page sends them right away.
    const stRef = useRef(st); stRef.current = st;
    // Backs off (8s, 16s, 32s, then every minute) and stops once the table is frozen or closed, to spare the relay's limit.
    useEffect(() => { const t = setInterval(() => { const cur = stRef.current; if (!cur || cur.settlement || !cur.open) return; if (Object.values(pendingRef.current).some((v) => v.n > 0 && Date.now() - v.at > Math.min(8000 * 2 ** (v.tries ?? 0), 60000))) void send(); }, 4000); return () => clearInterval(t); }, [seatId]);
    useEffect(() => { const flush = () => { if (document.visibilityState === 'hidden' || !document.visibilityState) void send(); }; document.addEventListener('visibilitychange', flush); window.addEventListener('pagehide', flush); return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('pagehide', flush); }; }, [seatId]);
    const [joining, setJoining] = useState(false); const busy = useRelayBusy(); const [pref, setPref] = useState<Record<string, 'share' | 'count'>>({});
    // A retry after a slow or rate-limited join reuses the same seat, so the host never sees a duplicate.
    const join = async () => { if (joining) return; setJoining(true); setSendFail(false); try { const nm = name.trim() || 'Guest'; if (!d.current) { d.current = await new Diner(link).init(); setSeatId(d.current.pid); } await d.current.save(nm); const ok = await d.current.join(nm); setJoined(ok); setJoinAt(Date.now()); if (!ok) setSendFail(true); } finally { setJoining(false); } };
    useEffect(() => { (async () => { const x = new Diner(link); const nm = await x.restore(); if (nm) { d.current = x; setSeatId(x.pid); setName(nm); setJoined(true); setJoinAt(Date.now()); setRestoring(false); await x.join(nm); } else setRestoring(false); })(); }, []);
    if (st && !st.open) return <section className="lv-card"><h2>The table is closed</h2><p>The host closed this session. Your last picks are with the host.</p></section>;
    if (restoring) return <section className="lv-card"><h2>Loading the table…</h2></section>;
    if (!joined) return <section className="lv-card"><h2>Join the table</h2><p>Add your name, then tick what you had.</p><input className="lv-in" aria-label="Your name" placeholder="Your name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} /><button className="sb-btn sb-block" type="button" disabled={!name.trim() || joining} onClick={join}>{joining ? 'Joining…' : 'Join'}</button>{joining && busy && <BusyNote />}{sendFail && <p className="lv-warn">Could not reach the relay. Check your connection and try again.</p>}</section>;
    const stale = lastSeen > 0 && now - lastSeen > HOST_LOST;
    // Just joined: earlier updates do not list me yet, so that is "adding you", not "not on the list".
    const joining2 = !!st && !listed.current && now - joinAt < 30000;
    if (!me) return <section className="lv-card"><h2>{joining2 ? 'Adding you to the table…' : st ? 'You are not on the list' : loaded ? 'Waiting for the host…' : 'Loading the table…'}</h2>{joining2 ? <p className="sb-muted">The host’s phone adds you in a moment.</p> : st ? <p>This seat is not on the host list. The table may already be finalized, or the host may have removed the seat. Reloading will not add you. Ask the host for a new table if you need to join.</p> : now - joinAt > 25000 ? <p className="lv-warn">The host has not answered. Check the host phone is open and online, then reload this link.</p> : <p className="sb-muted">Connecting ({relay}).</p>}</section>;
    const acked = Object.keys(pending).length === 0;
    if (st!.settlement) {
        const currentPayment = payment?.settlementId === st!.settlement.id && payment?.digest === st!.settlement.digest;
        return <section className="lv-card ch-next" data-next="pay">
            {paymentError ? <><h2>Do not pay yet</h2><p className="lv-warn" role="alert">{paymentError}</p></>
            : (!payment || !currentPayment) ? <><h2>The bill is frozen</h2><p>Getting your payment ready…</p></>
            : !payment.owesCollector ? <><h2>You are collecting</h2><p>Everyone else pays you. Your own share is {fmt(st!.settlement.shares.find((x) => x.personId === seatId)?.amount ?? 0)}.</p></>
            : payment.amount === 0 ? <><h2>Nothing to pay</h2><p>Your share came to ₹0.</p></>
            : <><h2>Pay {payment.name}</h2>
                <div className="lv-total"><span>Your share</span><b>{fmt(payment.amount)}</b></div>
                <p className="sb-small">To UPI ID <b>{payment.upi}</b></p>
                <PayOptions req={{ pa: payment.upi, pn: payment.name, am: payment.amount, tn: 'CHIT ' + payment.settlementId.slice(0, 8) }} autoOpen={`${payment.settlementId}-${seatId}`} /></>}
            {lateChange && <p className="lv-warn" role="alert">The host froze the bill before your last change reached them, so it is not included. If your amount looks wrong, tell the host before paying.</p>}
            <p className="sb-small sb-muted">The host froze this bill, so amounts cannot change. Settlement {st!.settlement.id.slice(0, 8)}.</p>
        </section>;
    }
    const unclaimed = st!.items.filter((i) => !i.e && (Object.values(i.c) as number[]).reduce((a, b) => a + b, 0) === 0 && i.s.length === 0);
    return <section className="lv-card">
        <h2>Hi {me.n}</h2>
        {stale && <p className="lv-warn" role="alert">Lost the host. Your picks are not saved until it is back. Keep this page open.</p>}
        {busy && <BusyNote />}
        {sendFail && <p className="lv-warn" role="alert">Your last pick has not reached the host yet. Retrying automatically.</p>}
        {unclaimed.length > 0 && <div className="lv-warn"><b>Nobody has had yet:</b> {unclaimed.map((i) => i.n).join(', ')}</div>}
        <ul className="lv-list">{st!.items.map((i) => {
            // What the host has, with my unconfirmed change on top.
            const op = pending[i.i]; let mine = i.c[pid] ?? 0; let shared = i.s.includes(pid);
            if (op?.s !== undefined) { shared = op.s; if (op.s) mine = 0; }
            if (op?.c !== undefined) { mine = op.c; if (op.c > 0) shared = false; }
            const rej = op ? undefined : st!.rej[pid]?.[i.i];
            if (i.e) return <li key={i.i}><b>{i.n}</b><span>{fmt(i.t)} split by everyone</span></li>;
            const eaters = new Set<string>([...i.s, ...Object.keys(i.c).filter((k) => (i.c[k] ?? 0) > 0)]);
            const others = Object.entries(i.c).reduce((a, [k, v]) => a + (k === pid ? 0 : v), 0);
            const othersShared = i.s.filter((x) => x !== pid).length;
            // One plate is shared. Several plates: gravies are shared by everyone who had some; naans and drinks are counted.
            const mode: 'share' | 'count' = i.q <= 1 || i.s.length > 0 ? 'share' : others > 0 || mine > 0 ? 'count' : (pref[i.i] ?? (countedByDefault(i.n) ? 'count' : 'share'));
            const canSwitch = i.q > 1 && others === 0 && othersShared === 0;
            const switchTo = (m: 'share' | 'count') => { setPref({ ...pref, [i.i]: m }); if (mine > 0 || shared) change(i.i, { c: 0, s: false }); };
            if (mode === 'count') {
                const max = Math.max(0, i.q - others);
                const set = (v: number) => change(i.i, { c: Math.max(0, Math.min(v, max)) });
                return <li key={i.i} className="lv-item"><b>{i.n}</b><span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{fmt(i.t)} · {i.q} × {fmt(Math.round(i.t / i.q))}<br />{others ? `${others} taken by others · ` : ''}{i.q - others - mine} left</span>
                    <span className="lv-step" role="group" aria-label={`How many ${i.n} you had`}><button type="button" aria-label={`Fewer ${i.n}`} disabled={mine <= 0} onClick={() => set(mine - 1)}>−</button><output aria-live="polite">{mine}</output><button type="button" aria-label={`More ${i.n}`} disabled={mine >= max} onClick={() => set(mine + 1)}>+</button></span>
                    {mine > 0 && <small className="sb-small">You: {mine} of {i.q} · {fmt(Math.round(i.t * mine / i.q))}</small>}
                    {canSwitch && <button type="button" className="sb-link ch-switch" onClick={() => switchTo('share')}>We shared these instead</button>}
                    {rej && <em className="lv-rej">{rej}</em>}</li>;
            }
            const on = shared; const count = eaters.size + (on && !eaters.has(pid) ? 1 : 0) - (!on && eaters.has(pid) ? 1 : 0);
            return <li key={i.i} className="lv-item"><b>{i.n}</b><span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{fmt(i.t)}{i.q > 1 ? ` · ${i.q} plates, shared` : ''}<br />{count === 0 ? 'nobody yet' : count === 1 ? 'one person' : `${count} sharing · ${fmt(Math.round(i.t / count))} each`}</span>
                <button type="button" className={`lv-share ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => change(i.i, { s: !on })}>{on ? 'I had this ✓' : 'I had this'}</button>
                {canSwitch && <button type="button" className="sb-link ch-switch" onClick={() => switchTo('count')}>Count how many I had instead</button>}
                {rej && <em className="lv-rej">{rej}</em>}</li>; })}</ul>
        <div className={`lv-total${acked ? '' : ' is-updating'}`} aria-busy={!acked}><span>Your amount so far</span><b>{fmt(st!.tot[pid] ?? 0)}</b><small>{acked ? 'Saved with the host' : 'Sending…'} · changes if others pick more</small></div>
        <div className="lv-paybox" role="status"><p className="sb-small"><b>That’s it for now.</b> When everyone has picked, the host freezes the bill and your payment opens right here, ready for Google Pay. Keep this page open.</p></div>
    </section>;
}
