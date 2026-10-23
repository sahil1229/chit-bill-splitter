import { pinDinerPayment, type DinerPayment } from './settlement';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { computeSplit, fmt, type Item, type Person } from './engine';
import { onRelayBusy, store, Diner, HostEngine, Reassembler, hostSend, newSession, openHost, linkFragment, parseLink, subscribe, verify, type Link, type LiveState, type Snap, validUpi } from './live';
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
    const broadcast = () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            if (!eng.current || !keys.current) return;
            const engine = eng.current; const g = generation.current; const link = engine.link;
            try { const ok = await hostSend(link, keys.current, engine.state()); if (ok) lastSent.current = Date.now(); if (g !== generation.current || eng.current !== engine) return; setSess((s) => (s ? { ...s, ...(ok ? { sent: Date.now() } : {}), failed: !ok } : s)); } catch { if (g === generation.current && eng.current === engine) setSess((s) => (s ? { ...s, failed: true } : s)); }
        }, 2000); // one relay message for a burst of picks
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

export function HostPanel({ s, host, goClaim, removePerson, setPay }: { s: HostSnap & { collectorId: string; collectorMode?: 'diner' | 'external'; externalCollector?: string; upi?: string; hostName?: string; approved?: string[] }; setPay: (p: { collectorMode?: 'diner' | 'external'; externalCollector?: string; upi?: string; hostName?: string; collectorId?: string; received?: Record<string, number>; approved?: string[] }) => void; host: ReturnType<typeof useHost>; goClaim: (personId?: string) => void; removePerson: (id: string) => void }) {
    const { sess } = host; const busy = useRelayBusy(); useEffect(()=>{if(!sess&&!s.collectorMode)setPay({collectorMode:'diner',externalCollector:undefined});},[!!sess,s.collectorMode]);const [copied, setCopied] = useState(false); const [dn, setDn] = useState(s.hostName ?? ''); const [du, setDu] = useState(s.upi ?? ''); useEffect(() => { setDn(s.hostName ?? ''); setDu(s.upi ?? ''); }, [!!sess]); const payOk = validUpi(s.upi); const dirty = dn.trim() !== (s.hostName ?? '').trim() || du.trim() !== (s.upi ?? '').trim();
    const [approveErr,setApproveErr]=useState('');useEffect(()=>{if(!sess||s.collectorMode!=='diner'||!s.collectorId)return;const k='chit.autoclaim.'+sess.link.topic;try{if(localStorage.getItem(k))return;localStorage.setItem(k,'1');}catch{return;}goClaim(s.collectorId);},[!!sess,s.collectorId]);
    const res = useMemo(() => computeSplit({ ...s, spread: false }), [s]);
    const url = sess ? `${JOIN_BASE}#${linkFragment(sess.link)}` : '';
    const unclaimed = s.items.filter((i) => !i.everyone && (res.unclaimedUnits[i.id] ?? 0) > 0);
    if (s.settlement) { const st0 = s.settlement; const ok = s.approved ?? []; return <section className="lv-card"><h2>Approve payments, one person at a time</h2><p>Collector: {st0.collector.name}, {st0.collector.upi}</p><p className="sb-small">Nobody sees a pay button until you approve them here. An approval fixes that person's amount and the payee. It cannot be taken back, because a payment link that was already opened cannot be recalled. To correct anything, start a new table.</p><ul className="lv-list">{st0.shares.map((sh) => { const done = ok.includes(sh.personId); return <li key={sh.personId}><b>{sh.name}</b><span>{!sh.owesCollector ? 'Collector, nothing to send' : sh.amount === 0 ? 'Nothing to pay' : fmt(sh.amount)}</span>{sh.owesCollector && sh.amount > 0 && (done ? <em>Approved</em> : <button type="button" className="sb-btn" onClick={() => { if ((s.approved ?? []).includes(sh.personId)) return; try { const raw = localStorage.getItem('chit.split.v1'); const cur = raw ? JSON.parse(raw) : null; if (!cur || cur.tableId !== (s as any).tableId) throw Error('x'); const next = [...(cur.approved ?? []), sh.personId]; const text = JSON.stringify({ ...cur, approved: next }); localStorage.setItem('chit.split.v1', text); if (localStorage.getItem('chit.split.v1') !== text) throw Error('x'); setApproveErr(''); setPay({ approved: next }); } catch { setApproveErr('This approval was not saved on this phone, so this person was not approved. Free up browser storage and try again.'); } }}>Approve {sh.name} · {fmt(sh.amount)}</button>)}</li>; })}</ul>{approveErr && <p className="lv-warn" role="alert">{approveErr}</p>}<p className="sb-small">Opening a pay app never counts as paid. Tick received by hand in the Split step.</p></section>; }
    if (!sess) return <section className="lv-card"><h2>Start with your plate</h2><p>Enter your name, claim what you ate, then invite friends by link or QR.</p><details><summary>How QR sharing and recovery work</summary><p className="sb-muted sb-small">Picks travel end-to-end encrypted through a free public relay (ntfy.sh). The relay sees only scrambled data, but it is best-effort with no uptime promise. The join link holds the key.</p><p className="lv-warn"><b>Keep this page open.</b> The table runs from this phone. If the page reloads, this phone tries to resume the same table from its own saved copy. That is not guaranteed, and everyone sees "Lost the host" until it does.</p></details><div className="ch-payee"><p>You are hosting and dining.</p><details><summary>Someone else is collecting, or I am not dining</summary><div className="sb-pills" role="radiogroup" aria-label="Collector type"><button type="button" role="radio" aria-checked={s.collectorMode === 'external'} onClick={() => setPay({ collectorMode: 'external', collectorId: '', externalCollector: s.hostName ?? '' })}>Not dining</button><button type="button" role="radio" aria-checked={s.collectorMode === 'diner'} onClick={() => setPay({ collectorMode: 'diner', externalCollector: undefined, collectorId: '' })}>I am dining too</button></div></details><label className="sb-label" htmlFor="hn">Your name</label><input id="hn" className="lv-in" value={s.hostName ?? ''} maxLength={30} placeholder="Your name" onChange={(e) => setPay({ hostName: e.target.value, ...(s.collectorMode === 'external' ? { externalCollector: e.target.value, collectorId: '' } : {}) })} /><details><summary>Payment details (optional for now)</summary><label className="sb-label" htmlFor="hupi">Collector UPI ID</label><input id="hupi" className="lv-in" inputMode="email" autoCapitalize="none" autoCorrect="off" placeholder="name@bank" value={s.upi ?? ''} onChange={(e) => setPay({ upi: e.target.value })} />{(s.upi ?? '').trim() && !validUpi(s.upi) && <p className="lv-rej">That does not look like a UPI ID (name@bank). Save a valid ID for the collector record. Payment links appear only after host finalization and diner review.</p>}<p className="sb-muted sb-small">Everyone at the table sees this ID and name (encrypted in transit). Only you can change it, from this phone. Nothing is paid from here.</p></details></div><button className="sb-btn sb-block" type="button" onClick={host.start} disabled={!s.items.length || !s.collectorMode || (s.collectorMode==='diner'&&!(s.hostName??'').trim()) || host.starting}>{host.starting?'Opening table…':s.items.length ? (s.collectorMode==='external'?'Open the table':'Pick my food') : 'Add the bill first'}</button>{!s.collectorMode&&<p className="lv-warn" role="status">Choose whether the collector is dining above before opening the table.</p>}{s.collectorMode==='diner'&&!(s.hostName??'').trim()&&<p className="lv-warn">Enter your name above so you can claim your own dishes on this phone.</p>}{host.startError&&<p className="lv-warn" role="alert">{host.startError}</p>}</section>;
    return <section className="lv-card">
        <h2>{sess.closed ? 'Table closed' : 'Scan to join'}</h2>
        {!sess.closed && <><Qr text={url} /><p className="sb-small lv-status" data-s={sess.status}>{sess.status === 'live' ? '● Connected to the relay' : sess.status === 'connecting' ? '○ Connecting…' : '○ Reconnecting. New joins may be delayed.'}{sess.failed ? ' · Last update to diners failed, retrying on the next change.' : ''}</p>{busy && <BusyNote />}
            <a className="sb-btn sb-block sb-a" href={url} target="_blank" rel="noopener noreferrer">Open join link</a><button className="sb-link" type="button" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Link copied' : 'Copy join link'}</button><p className="sb-small">Send the copied link to diners. Tapping it opens this same table without scanning the QR. The link contains the table key, so keep it inside your group.</p>
            <p className="sb-muted sb-small">Anyone with this link can join and see the bill. Keep it inside your group. Keep this page open while people join. If it reloads, the table tries to resume with the same link. Diners see "Lost the host" until it does.</p></>}
        <h3>Who is here ({s.people.length})</h3>{s.collectorMode==='diner'&&s.collectorId&&s.people.some(p=>p.id===s.collectorId)&&<button className="sb-btn sb-block" type="button" onClick={()=>goClaim(s.collectorId)}>Claim my dishes on this phone</button>}
        {!s.people.length && <p className="sb-muted">Nobody yet.</p>}
        <ul className="lv-list">{res.people.map((p) => <li key={p.id}><b>{p.name}</b>{res.people.filter((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()).length > 1 && <em className="lv-rej"> same name twice. If someone reloaded, remove the old one.</em>}<span>{p.lines.filter((l) => l.itemId !== 'unclaimed' && !s.items.find((i) => i.id === l.itemId)?.everyone).length} dishes · {fmt(p.total)}</span>{!sess.closed && <button className="sb-link" type="button" onClick={() => { host.remove(p.id); removePerson(p.id); }}>Remove</button>}</li>)}</ul>
        {unclaimed.length > 0 && <div className="lv-warn" role="alert"><b>Nobody has had:</b><ul>{unclaimed.map((i) => <li key={i.id}>{i.name} × {res.unclaimedUnits[i.id]} ({fmt(Math.round((i.total / i.qty) * res.unclaimedUnits[i.id]))})</li>)}</ul><p>Talk it over, then claim it on your phone. I will keep this flag until it is claimed.</p></div>}
        {s.items.length > 0 && unclaimed.length === 0 && s.people.length > 0 && <p className="lv-ok">Every dish has an owner.</p>}
        {!sess.closed && <details className="lv-collect"><summary>Collector and payment details (optional)</summary><label className="sb-small">Name<input id="cn" value={dn} onChange={(e) => setDn(e.target.value)} /></label><label className="sb-small">UPI ID<input id="cu" value={du} autoCapitalize="none" autoCorrect="off" onChange={(e) => setDu(e.target.value)} /></label>
            <p className={payOk ? 'sb-small lv-ok' : 'sb-small lv-warn'}>{payOk ? `Collector: ${(s.hostName ?? '').trim() || 'the host'} at ${s.upi}. Payment links appear after the host freezes the table and each diner reviews it.` : 'No valid collector UPI ID saved. Finalize the table before showing payment links.'}</p>
            <button type="button" className="sb-pill" aria-pressed={s.externalCollector !== undefined} onClick={() => { setPay({ collectorMode: 'external', collectorId: '', externalCollector: s.hostName ?? '', received: {} }); }}>Collector is not dining</button>
            {s.externalCollector !== undefined && <p className="sb-small">The collector name above is separate from the diners and does not change their shares.</p>}
            {s.people.length > 0 && <><p className="sb-small">Which diner is the collector? (pick only if switching to a diner collector. This clears the previous UPI ID. Picking a different person clears the UPI ID, so enter their UPI ID above for the collector record. Finalize the table before showing payment links.)</p><div role="radiogroup" aria-label="Collector">{s.people.map((p) => <button key={p.id} type="button" role="radio" aria-checked={s.collectorId === p.id} className="sb-pill" onClick={() => { if (s.collectorId === p.id) return; setDn(p.name); setDu(''); setPay({ collectorMode: 'diner', collectorId: p.id, externalCollector: undefined, hostName: p.name, upi: '', received: {} }); }}>{p.name}</button>)}</div></>}
            <button className="sb-btn" type="button" disabled={!dirty} onClick={() => setPay({ hostName: dn.trim(), upi: du.trim(), ...(s.externalCollector !== undefined ? { externalCollector: dn.trim() } : {}) })}>Update collector</button></details>}
        {s.externalCollector && s.people.some(p => p.name.trim().toLowerCase() === s.externalCollector!.trim().toLowerCase()) && <p className="lv-warn">The outside collector has the same name as a diner. They are treated as different people: that diner still owes their share. Use a clearer collector name if they are different people, or choose the diner above.</p>}
        <details><summary>Who had what</summary><ul className="lv-list">{s.items.filter((i) => !i.everyone).map((i) => { const who = s.people.filter((p) => (s.claims[i.id]?.[p.id] ?? 0) > 0 || s.shares[i.id]?.includes(p.id)); return <li key={i.id}><b>{i.name}</b><span>{who.length ? who.map((p) => `${p.name}${s.shares[i.id]?.includes(p.id) ? ' (shared)' : (s.claims[i.id]?.[p.id] ?? 0) > 1 || i.qty > 1 ? ` ×${s.claims[i.id]?.[p.id]}` : ''}`).join(', ') : 'nobody yet'}</span></li>; })}</ul></details>
        <button className="sb-btn sb-block" type="button" onClick={()=>goClaim()}>Reassign on this phone</button>
        {!sess.closed && <button className="sb-link" type="button" onClick={() => { void host.close().catch(() => {}); }}>Close the table</button>}
        {host.log.length > 0 && <p className="sb-small sb-muted">Blocked: {host.log.length} attempt(s) to take over someone else's seat.</p>}
    </section>;
}

export function DinerApp({ link }: { link: Link }) {
    const d = useRef<Diner | null>(null); const re = useRef(new Reassembler());
    const [seatId, setSeatId] = useState('');
    const [name, setName] = useState(''); const [joined, setJoined] = useState(false); const [st, setSt] = useState<LiveState | null>(null);
    const [relay, setRelay] = useState('connecting'); const [now, setNow] = useState(Date.now()); const [lastSeen, setLastSeen] = useState(0); const [joinAt, setJoinAt] = useState(0);
    const [want, setWant] = useState<Record<string, number>>({}); const [sh, setSh] = useState<string[]>([]); const [myN, setMyN] = useState(0); const [sendFail, setSendFail] = useState(false);
    const dirty = useRef(false); const sendT = useRef<any>(null);
    const [payment, setPayment] = useState<DinerPayment | null>(null); const [paymentError, setPaymentError] = useState(''); const [paymentReviewed, setPaymentReviewed] = useState('');
    useEffect(() => { let cancelled = false; setPayment(null); setPaymentReviewed('');
        if (!st?.settlement || !seatId || !joined || !(st.approved ?? []).includes(seatId)) return;
        const personId = seatId;
        void pinDinerPayment(st.settlement, link, personId, localStorage).then(p => { if (!cancelled) { setPayment(p); setPaymentError(''); } }).catch(e => { if (!cancelled) setPaymentError(String(e.message ?? e)); });
        return () => { cancelled = true; };
    }, [st?.settlement?.id, st?.settlement?.digest, seatId, joined, (st?.approved ?? []).includes(seatId ?? '')]);

    useEffect(() => { const onStorage = (e: StorageEvent) => {
        if (e.key !== 'chit.diner-final.' + link.topic + '.' + seatId) return;
        try { const saved = e.newValue ? JSON.parse(e.newValue) : null; if (saved?.status === 'conflict' || !saved) { setPayment(null); setPaymentReviewed(''); setPaymentError('This table has a saved payment conflict. Do not pay; ask the host for a new table.'); } } catch { setPayment(null); setPaymentReviewed(''); setPaymentError('Saved payment details could not be read. Do not pay.'); }
    }; window.addEventListener('storage', onStorage); return () => window.removeEventListener('storage', onStorage); }, [link.topic, seatId]);
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 3000); return () => clearInterval(t); }, []);
    useEffect(() => subscribe(link.topic, async (b) => {
        const m = await openHost(link, b); if (!m) return;
        const x = re.current.add(m); if (!x) return;
        setSt(x); setLastSeen(Date.now());
    }, setRelay), [link.topic]);
    const pid = seatId;
    const me = st?.people.find((p) => p.i === pid);
    // adopt host truth: once the host acknowledged my latest snapshot, show what it actually granted
    useEffect(() => {
        if (!st || !me || dirty.current) return;
        if ((st.ack[pid] ?? 0) >= myN) {
            const c: Record<string, number> = {}; const s2: string[] = [];
            st.items.forEach((i) => { if (i.c[pid]) c[i.i] = i.c[pid]; if (i.s.includes(pid)) s2.push(i.i); });
            setWant(c); setSh(s2);
        }
    }, [st?.rev]);
    const push = (c: Record<string, number>, s2: string[]) => {
        setWant(c); setSh(s2); dirty.current = true; clearTimeout(sendT.current);
        sendT.current = setTimeout(async () => { const n = (d.current!.n += 1); setMyN(n); d.current!.save(name); dirty.current = false; const ok = await (await d.current!.claimsRaw(c, s2, n)); setSendFail(!ok); }, 1500);
    };
    const [joining, setJoining] = useState(false); const busy = useRelayBusy();
    // A retry after a slow or rate-limited join reuses the same seat, so the host never sees a duplicate.
    const join = async () => { if (joining) return; setJoining(true); setSendFail(false); try { const nm = name.trim() || 'Guest'; if (!d.current) { d.current = await new Diner(link).init(); setSeatId(d.current.pid); } await d.current.save(nm); const ok = await d.current.join(nm); setJoined(ok); setJoinAt(Date.now()); if (!ok) setSendFail(true); } finally { setJoining(false); } };
    useEffect(() => { (async () => { const x = new Diner(link); const nm = await x.restore(); if (nm) { d.current = x; setSeatId(x.pid); setName(nm); setMyN(x.n); await x.join(nm); setJoined(true); setJoinAt(Date.now()); } })(); }, []);
    if (st && !st.open) return <section className="lv-card"><h2>The table is closed</h2><p>The host closed this session. Your last picks are with the host.</p></section>;
    if (!joined) return <section className="lv-card"><h2>Join the table</h2><p>Add your name, then tick what you had.</p><input className="lv-in" aria-label="Your name" placeholder="Your name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} /><button className="sb-btn sb-block" type="button" disabled={!name.trim() || joining} onClick={join}>{joining ? 'Joining…' : 'Join'}</button>{joining && busy && <BusyNote />}{sendFail && <p className="lv-warn">Could not reach the relay. Check your connection and try again.</p>}</section>;
    const stale = lastSeen > 0 && now - lastSeen > HOST_LOST;
    if (!me) return <section className="lv-card"><h2>{st ? 'You are not on the list' : 'Waiting for the host…'}</h2>{st ? <p>This seat is not on the host list. The table may already be finalized, or the host may have removed the seat. Reloading will not add you. Ask the host for a new table if you need to join.</p> : now - joinAt > 25000 ? <p className="lv-warn">The host has not answered. Check the host phone is open and online, then reload this link.</p> : <p className="sb-muted">Connecting ({relay}).</p>}</section>;
    const acked = (st!.ack[pid] ?? 0) >= myN && !dirty.current;
    if (st!.settlement) {
        const currentPayment = payment?.settlementId === st!.settlement.id && payment?.digest === st!.settlement.digest;
        const reviewed = !!payment && currentPayment && paymentReviewed === payment.digest;
        const myShare = st!.settlement.shares.find((x) => x.personId === seatId);
        if (!(st!.approved ?? []).includes(seatId ?? '')) return <section className="lv-card"><h2>Table finalized for {me.n}</h2>{myShare && !myShare.owesCollector ? <p>You are the collector. Nothing to send.</p> : myShare && myShare.amount === 0 ? <p>Nothing to pay.</p> : <p>Waiting for the host to approve your payment. No pay button until then.</p>}</section>;
        return <section className="lv-card"><h2>Finalized for {me.n}</h2>{paymentError ? <p className="lv-warn" role="alert">{paymentError}</p> : (!payment || !currentPayment) ? <p>Checking and saving the signed settlement. No payment links yet.</p> : <><div className="lv-total"><span>Your frozen amount</span><b>{fmt(payment.amount)}</b></div><p>Collector: {payment.name}<br />UPI ID: {payment.upi}<br />Settlement: {payment.settlementId.slice(0, 8)}</p>{!payment.owesCollector ? <p>You are the collector. Do not transfer your own share to yourself.</p> : payment.amount === 0 ? <p>Nothing to pay.</p> : !reviewed ? <><p className="lv-warn">Check the collector name, UPI ID and amount with your host before opening your payment app.</p><button type="button" className="sb-btn" onClick={() => setPaymentReviewed(payment.digest)}>I checked these details</button></> : <div className="lv-paybox"><PayOptions req={{ pa: payment.upi, pn: payment.name, am: payment.amount, tn: 'CHIT ' + payment.settlementId.slice(0, 8) }} /></div>}</>}<p>This settlement cannot be edited. Corrections need a new table; old payment instructions cannot be revoked.</p></section>;
    }
    const unclaimed = st!.items.filter((i) => !i.e && (Object.values(i.c) as number[]).reduce((a, b) => a + b, 0) === 0 && i.s.length === 0);
    return <section className="lv-card">
        <h2>Hi {me.n}</h2>
        {stale && <p className="lv-warn" role="alert">Lost the host. Your picks are not saved until it is back. Keep this page open.</p>}
        {busy && <BusyNote />}
        {sendFail && <p className="lv-warn" role="alert">Your last pick did not reach the relay. Change anything to retry.</p>}
        {unclaimed.length > 0 && <div className="lv-warn"><b>Nobody has had yet:</b> {unclaimed.map((i) => i.n).join(', ')}</div>}
        <ul className="lv-list">{st!.items.map((i) => {
            const mine = want[i.i] ?? 0; const shared = sh.includes(i.i); const rej = st!.rej[pid]?.[i.i];
            if (i.e) return <li key={i.i}><b>{i.n}</b><span>{fmt(i.t)} split by everyone</span></li>;
            const eaters = new Set<string>([...i.s, ...Object.keys(i.c).filter((k) => (i.c[k] ?? 0) > 0)]);
            // Several of one dish (6 naans) are claimed by count; one dish is shared equally.
            if (i.q > 1 && i.s.length === 0) {
                const others = Object.entries(i.c).reduce((a, [k, v]) => a + (k === pid ? 0 : v), 0); const max = Math.max(0, i.q - others);
                const set = (v: number) => push({ ...want, [i.i]: Math.max(0, Math.min(v, max)) }, sh.filter((x) => x !== i.i));
                return <li key={i.i} className="lv-item"><b>{i.n}</b><span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{fmt(i.t)} · {i.q} × {fmt(Math.round(i.t / i.q))}<br />{others ? `${others} taken by others · ` : ''}{i.q - others - mine} left</span>
                    <span className="lv-step" role="group" aria-label={`How many ${i.n} you had`}><button type="button" aria-label={`Fewer ${i.n}`} disabled={mine <= 0} onClick={() => set(mine - 1)}>−</button><output aria-live="polite">{mine}</output><button type="button" aria-label={`More ${i.n}`} disabled={mine >= max} onClick={() => set(mine + 1)}>+</button></span>
                    {mine > 0 && <small className="sb-small">You: {mine} of {i.q} · {fmt(Math.round(i.t * mine / i.q))}</small>}
                    {rej && <em className="lv-rej">{rej}</em>}</li>;
            }
            const legacy = i.s.length === 0 && eaters.size > 0; const on = shared || (legacy && mine > 0); const count = eaters.size + (on && !eaters.has(pid) ? 1 : 0);
            return <li key={i.i} className="lv-item"><b>{i.n}</b><span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{fmt(i.t)}{i.q > 1 ? ` · ${i.q} ordered` : ''}<br />{count === 0 ? 'nobody yet' : count === 1 ? 'one eater' : `${count} eating · ${fmt(Math.round(i.t / count))} each`}</span>
                {legacy ? <em className="lv-rej">Picked by units earlier ({mine ? `you ${mine} of ${i.q}` : 'not you'}). Ask the host to switch it to equal split.</em> : <button type="button" className={`lv-share ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => push({ ...want, [i.i]: 0 }, on ? sh.filter((x) => x !== i.i) : [...sh, i.i])}>{on ? 'I had this ✓' : 'I had this'}</button>}
                {rej && <em className="lv-rej">{rej}</em>}</li>; })}</ul>
        <div className="lv-total"><span>Your amount so far</span><b>{fmt(st!.tot[pid] ?? 0)}</b><small>{acked ? 'Saved with the host' : 'Sending…'} · changes if others pick more</small></div>
        <div className="ch-pay lv-paybox" role="status"><p className="sb-small"><b>Payment comes later</b></p><p className="sb-small">When everyone has picked, the host freezes the table and approves each person one at a time. Your pay button appears here only after the host approves you. Your amount above is provisional until then.</p><p className="sb-muted sb-small">The app cannot verify payments. The collector records received payments by hand.</p></div>
    </section>;
}
