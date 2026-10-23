import React, { useEffect, useMemo, useRef, useState } from 'react';
import { computeSplit, fmt, type Item, type Person } from './engine';
import { store, Diner, HostEngine, Reassembler, hostSend, newSession, openHost, linkFragment, parseLink, subscribe, type Link, type LiveState, type Snap, validUpi } from './live';
import { qrMatrix } from './qr';

export const JOIN_BASE = location.origin + location.pathname;

export const envDebug = () => `href=${location.href.slice(0, 140)} | hash=${location.hash.slice(0, 40)} | search=${location.search.slice(0, 60)} | ref=${document.referrer.slice(0, 80)} | name=${window.name.slice(0, 30)}`;
export function envLink(): Link | null {
    for (const s of [location.hash, location.search, window.name]) { const l = parseLink(decodeURIComponent(s || '')); if (l) return l; }
    return null;
}
function Qr({ text }: { text: string }) {
    const m = useMemo(() => { try { return qrMatrix(text); } catch { return null; } }, [text]);
    if (!m) return <p className="sb-muted">Link too long for a QR.</p>;
    const n = m.length; const q = 3;
    return <svg className="lv-qr" data-url={text} viewBox={`0 0 ${n + q * 2} ${n + q * 2}`} role="img" aria-label="QR code to join the table" shapeRendering="crispEdges"><rect width="100%" height="100%" fill="#fff" />{m.map((r, y) => r.map((b, x) => (b ? <rect key={`${x}-${y}`} x={x + q} y={y + q} width="1" height="1" fill="#111" /> : null)))}</svg>;
}

export type HostSession = { link: Link; status: 'connecting' | 'live' | 'reconnecting'; sent: number; failed: boolean; log: string[]; closed: boolean };
type HostSnap = Snap & { items: Item[]; people: Person[] };

/** Runs the host side while a session exists. Keeps its keys in memory only. */
export function useHost(read: () => HostSnap, write: (p: Partial<Snap>) => void, version: string, ready: boolean, hs: { get: () => any; set: (v: any) => void }) {
    const [sess, setSess] = useState<HostSession | null>(null);
    const eng = useRef<HostEngine | null>(null); const keys = useRef<CryptoKey | null>(null);
    const unsub = useRef<(() => void) | null>(null); const chain = useRef(Promise.resolve()); const timer = useRef<any>(null);
    const broadcast = () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            if (!eng.current || !keys.current) return;
            const link = eng.current.link;
            try { await hostSend(link, keys.current, eng.current.state()); setSess((s) => (s ? { ...s, sent: Date.now(), failed: false } : s)); } catch { setSess((s) => (s ? { ...s, failed: true } : s)); }
        }, 700);
    };
    const persist = async () => { if (eng.current && keys.current) hs.set({ link: eng.current.link, priv: await crypto.subtle.exportKey('jwk', keys.current), eng: eng.current.dump(), snap: (() => { const x = read(); return { items: x.items, charges: x.charges, people: x.people, claims: x.claims, shares: x.shares, chargeMode: x.chargeMode, spread: x.spread }; })() }); };
    const run = (link: Link, signKey: CryptoKey, saved?: any) => {
        eng.current = new HostEngine(link, read, write); keys.current = signKey; eng.current.load(saved);
        setSess({ link, status: 'connecting', sent: 0, failed: false, log: [], closed: !eng.current.open });
        if (!eng.current.open) return;
        unsub.current = subscribe(link.topic, (b) => { chain.current = chain.current.then(async () => { if (await eng.current?.handle(b)) { broadcast(); persist(); } }); }, (st) => setSess((s) => (s ? { ...s, status: st } : s)));
        broadcast();
    };
    const start = async () => { const { link, host } = await newSession(); run(link, host.sign); await persist(); };
    const remove = (id: string) => { eng.current?.banned.add(id); persist(); };
    const [resumed, setResumed] = useState(false);
    useEffect(() => { // host reload: pick the table back up, same link, same seats
        if (!ready || resumed || sess) return; setResumed(true);
        const v = hs.get(); if (!v?.priv || !v.link) return;
        crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']).then((k) => { if (v.snap && !read().items.length) write(v.snap); run(v.link, k, v.eng); }).catch(() => {});
    }, [ready]);
    const close = async () => {
        if (!eng.current || !keys.current) return;
        eng.current.open = false; clearTimeout(timer.current);
        try { await hostSend(eng.current.link, keys.current, eng.current.state()); } catch { /* best effort */ }
        await persist(); unsub.current?.(); setSess((s) => (s ? { ...s, closed: true } : s));
    };
    useEffect(() => { if (sess && !sess.closed) { broadcast(); persist(); } }, [version]); // roster, items or claims changed on the host phone
    useEffect(() => { if (!sess || sess.closed) return; const t = setInterval(broadcast, 20000); return () => clearInterval(t); }, [sess?.link.topic, sess?.closed]);
    useEffect(() => () => { unsub.current?.(); clearTimeout(timer.current); }, []);
    return { sess, start, close, remove, log: eng.current?.log ?? [] };
}

export function HostPanel({ s, host, goClaim, removePerson, setPay }: { s: HostSnap & { collectorId: string; upi?: string; hostName?: string }; setPay: (p: { upi?: string; hostName?: string }) => void; host: ReturnType<typeof useHost>; goClaim: () => void; removePerson: (id: string) => void }) {
    const { sess } = host; const [copied, setCopied] = useState(false); const [dn, setDn] = useState(s.hostName ?? ''); const [du, setDu] = useState(s.upi ?? ''); useEffect(() => { setDn(s.hostName ?? ''); setDu(s.upi ?? ''); }, [!!sess]); const payOk = validUpi(s.upi); const dirty = dn.trim() !== (s.hostName ?? '').trim() || du.trim() !== (s.upi ?? '').trim();
    const res = useMemo(() => computeSplit({ ...s, spread: false }), [s]);
    const url = sess ? `${JOIN_BASE}?${linkFragment(sess.link)}` : '';
    const unclaimed = s.items.filter((i) => !i.everyone && (res.unclaimedUnits[i.id] ?? 0) > 0);
    if (!sess) return <section className="lv-card"><h2>Everyone on their own phone</h2><p>Scan a QR, pick a name, tick what you had. You see who has what and any dish nobody owns.</p><p className="sb-muted sb-small">Picks travel end-to-end encrypted through a free public relay (ntfy.sh). The relay sees only scrambled data, but it is best-effort with no uptime promise. The join link holds the key.</p><p className="lv-warn"><b>Keep this page open.</b> The table runs from this phone. If the page reloads it may not come back (it can only resume when you are signed in to the File), and everyone will see "Lost the host" until it does.</p><div className="ch-payee"><label className="sb-label" htmlFor="hn">Who collects the money? (your name)</label><input id="hn" className="lv-in" value={s.hostName ?? ''} maxLength={30} placeholder="Your name" onChange={(e) => setPay({ hostName: e.target.value })} /><label className="sb-label" htmlFor="hupi">Your UPI ID</label><input id="hupi" className="lv-in" inputMode="email" autoCapitalize="none" autoCorrect="off" placeholder="name@bank" value={s.upi ?? ''} onChange={(e) => setPay({ upi: e.target.value })} />{(s.upi ?? '').trim() && !validUpi(s.upi) && <p className="lv-rej">That does not look like a UPI ID (name@bank). Diners will not get a pay button until it does.</p>}<p className="sb-muted sb-small">Everyone at the table sees this ID and name (encrypted in transit). Only you can change it, from this phone. Nothing is paid from here.</p></div><button className="sb-btn sb-block" type="button" onClick={host.start} disabled={!s.items.length}>{s.items.length ? 'Open the table' : 'Add the bill first'}</button></section>;
    return <section className="lv-card">
        <h2>{sess.closed ? 'Table closed' : 'Scan to join'}</h2>
        {!sess.closed && <><Qr text={url} /><p className="sb-small lv-status" data-s={sess.status}>{sess.status === 'live' ? '● Connected to the relay' : sess.status === 'connecting' ? '○ Connecting…' : '○ Reconnecting. New joins may be delayed.'}{sess.failed ? ' · Last update to diners failed, retrying on the next change.' : ''}</p>
            <button className="sb-link" type="button" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Link copied' : 'Copy join link'}</button>
            <p className="sb-muted sb-small">Anyone with this link can join and see the bill. Keep it inside your group. Keep this page open while people join. If it reloads and you are signed in, the table tries to resume with the same link. Diners see "Lost the host" until it does.</p></>}
        <h3>Who is here ({s.people.length})</h3>
        {!s.people.length && <p className="sb-muted">Nobody yet.</p>}
        <ul className="lv-list">{res.people.map((p) => <li key={p.id}><b>{p.name}</b>{res.people.filter((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()).length > 1 && <em className="lv-rej"> same name twice. If someone reloaded, remove the old one.</em>}<span>{p.lines.filter((l) => l.itemId !== 'unclaimed' && !s.items.find((i) => i.id === l.itemId)?.everyone).length} dishes · {fmt(p.total)}</span>{!sess.closed && <button className="sb-link" type="button" onClick={() => { host.remove(p.id); removePerson(p.id); }}>Remove</button>}</li>)}</ul>
        {unclaimed.length > 0 && <div className="lv-warn" role="alert"><b>Nobody has had:</b><ul>{unclaimed.map((i) => <li key={i.id}>{i.name} × {res.unclaimedUnits[i.id]} ({fmt(Math.round((i.total / i.qty) * res.unclaimedUnits[i.id]))})</li>)}</ul><p>Talk it over, then claim it on your phone. I will keep this flag until it is claimed.</p></div>}
        {s.items.length > 0 && unclaimed.length === 0 && s.people.length > 0 && <p className="lv-ok">Every dish has an owner.</p>}
        {!sess.closed && <div className="lv-collect"><h3>Collector</h3><label className="sb-small">Name<input id="cn" value={dn} onChange={(e) => setDn(e.target.value)} /></label><label className="sb-small">UPI ID<input id="cu" value={du} autoCapitalize="none" autoCorrect="off" onChange={(e) => setDu(e.target.value)} /></label>
            <p className={payOk ? 'sb-small lv-ok' : 'sb-small lv-warn'}>{payOk ? `Diners pay ${(s.hostName ?? '').trim() || 'the host'} at ${s.upi}.` : 'No valid UPI ID yet, so diners see no pay buttons.'}</p>
            <button className="sb-btn" type="button" disabled={!dirty} onClick={() => setPay({ hostName: dn.trim(), upi: du.trim() })}>Update collector</button></div>}
        <h3>Who had what</h3>
        <ul className="lv-list">{s.items.filter((i) => !i.everyone).map((i) => { const who = s.people.filter((p) => (s.claims[i.id]?.[p.id] ?? 0) > 0 || s.shares[i.id]?.includes(p.id)); return <li key={i.id}><b>{i.name}</b><span>{who.length ? who.map((p) => `${p.name}${s.shares[i.id]?.includes(p.id) ? ' (shared)' : (s.claims[i.id]?.[p.id] ?? 0) > 1 || i.qty > 1 ? ` ×${s.claims[i.id]?.[p.id]}` : ''}`).join(', ') : 'nobody yet'}</span></li>; })}</ul>
        <button className="sb-btn sb-block" type="button" onClick={goClaim}>Reassign on this phone</button>
        {!sess.closed && <button className="sb-link" type="button" onClick={host.close}>Close the table</button>}
        {host.log.length > 0 && <p className="sb-small sb-muted">Blocked: {host.log.length} attempt(s) to take over someone else's seat.</p>}
    </section>;
}

export function DinerApp({ link }: { link: Link }) {
    const d = useRef<Diner | null>(null); const re = useRef(new Reassembler());
    const [name, setName] = useState(''); const [joined, setJoined] = useState(false); const [st, setSt] = useState<LiveState | null>(null);
    const [relay, setRelay] = useState('connecting'); const [now, setNow] = useState(Date.now()); const [lastSeen, setLastSeen] = useState(0); const [joinAt, setJoinAt] = useState(0);
    const [want, setWant] = useState<Record<string, number>>({}); const [sh, setSh] = useState<string[]>([]); const [myN, setMyN] = useState(0); const [sendFail, setSendFail] = useState(false);
    const dirty = useRef(false); const sendT = useRef<any>(null);
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 3000); return () => clearInterval(t); }, []);
    useEffect(() => subscribe(link.topic, async (b) => {
        const m = await openHost(link, b); if (!m) return;
        const x = re.current.add(m); if (!x) return;
        setSt(x); setLastSeen(Date.now());
    }, setRelay), [link.topic]);
    const pid = d.current?.pid ?? '';
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
        sendT.current = setTimeout(async () => { const n = (d.current!.n += 1); setMyN(n); d.current!.save(name); dirty.current = false; const ok = await (await d.current!.claimsRaw(c, s2, n)); setSendFail(!ok); }, 500);
    };
    const join = async () => { d.current = await new Diner(link).init(); const ok = await d.current.join(name.trim() || 'Guest'); setJoined(ok); setJoinAt(Date.now()); if (!ok) setSendFail(true); else await d.current.save(name.trim() || 'Guest'); };
    useEffect(() => { (async () => { const x = new Diner(link); const nm = await x.restore(); if (nm) { d.current = x; setName(nm); setMyN(x.n); await x.join(nm); setJoined(true); setJoinAt(Date.now()); } })(); }, []);
    if (st && !st.open) return <section className="lv-card"><h2>The table is closed</h2><p>The host closed this session. Your last picks are with the host.</p></section>;
    if (!joined) return <section className="lv-card"><h2>Join the table</h2><p>Add your name, then tick what you had.</p><input className="lv-in" aria-label="Your name" placeholder="Your name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} /><button className="sb-btn sb-block" type="button" disabled={!name.trim()} onClick={join}>Join</button>{sendFail && <p className="lv-warn">Could not reach the relay. Check your connection and try again.</p>}</section>;
    const stale = lastSeen > 0 && now - lastSeen > 70000;
    if (!me) return <section className="lv-card"><h2>{st ? 'You are not on the list' : 'Waiting for the host…'}</h2>{st ? <p>The host removed you or the table was reset. Reload the join link to join again.</p> : now - joinAt > 25000 ? <p className="lv-warn">The host has not answered. Check the host phone is open and online, then reload this link.</p> : <p className="sb-muted">Connecting ({relay}).</p>}</section>;
    const acked = (st!.ack[pid] ?? 0) >= myN && !dirty.current;
    const unclaimed = st!.items.filter((i) => !i.e && Object.values(i.c).reduce((a, b) => a + b, 0) === 0 && i.s.length === 0);
    return <section className="lv-card">
        <h2>Hi {me.n}</h2>
        {stale && <p className="lv-warn" role="alert">Lost the host. Your picks are not saved until it is back. Keep this page open.</p>}
        {sendFail && <p className="lv-warn" role="alert">Your last pick did not reach the relay. Change anything to retry.</p>}
        {unclaimed.length > 0 && <div className="lv-warn"><b>Nobody has had yet:</b> {unclaimed.map((i) => i.n).join(', ')}</div>}
        <ul className="lv-list">{st!.items.map((i) => {
            const others = Object.entries(i.c).filter(([k]) => k !== pid).reduce((a, [, v]) => a + v, 0); const mine = want[i.i] ?? 0; const shared = sh.includes(i.i); const rej = st!.rej[pid]?.[i.i];
            if (i.e) return <li key={i.i}><b>{i.n}</b><span>{fmt(i.t)} split by everyone</span></li>;
            const max = Math.max(0, i.q - others);
            return <li key={i.i} className="lv-item"><b>{i.n}</b><span>{fmt(i.t)}{i.q > 1 ? ` for ${i.q}` : ''}{others ? ` · ${others} taken by others` : ''}</span>
                {i.q > 1 || !shared ? <span className="lv-step"><button type="button" aria-label={`Fewer ${i.n}`} disabled={mine <= 0} onClick={() => push({ ...want, [i.i]: mine - 1 }, sh)}>−</button><output>{mine}</output><button type="button" aria-label={`More ${i.n}`} disabled={mine >= max || shared} onClick={() => push({ ...want, [i.i]: mine + 1 }, sh)}>+</button></span> : null}
                <button type="button" className={`lv-share ${shared ? 'on' : ''}`} aria-pressed={shared} onClick={() => push({ ...want, [i.i]: 0 }, shared ? sh.filter((x) => x !== i.i) : [...sh, i.i])}>{shared ? 'Sharing ✓' : 'Share'}</button>
                {rej && <em className="lv-rej">{rej}</em>}</li>; })}</ul>
        <div className="lv-total"><span>{st!.final ? 'Your final amount' : 'Your amount so far'}</span><b>{fmt(st!.tot[pid] ?? 0)}</b><small>{acked ? 'Saved with the host' : 'Sending…'}{!st!.final ? ' · changes if others pick more' : ''}</small></div>
        {st!.final && st!.pay ? <div className="ch-pay lv-paybox"><p className="sb-small">Pay {st!.pay.n}: {st!.pay.u}</p>{(st!.tot[pid] ?? 0) > 0 && <><a className="sb-btn" href={`gpay://upi/pay?pa=${encodeURIComponent(st!.pay.u)}&pn=${encodeURIComponent(st!.pay.n)}&am=${((st!.tot[pid] ?? 0) / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Dinner split')}`}>Open Google Pay · {fmt(st!.tot[pid] ?? 0)}</a><a className="sb-link" href={`upi://pay?pa=${encodeURIComponent(st!.pay.u)}&pn=${encodeURIComponent(st!.pay.n)}&am=${((st!.tot[pid] ?? 0) / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Dinner split')}`}>Other UPI app</a><button type="button" className="sb-link" onClick={() => { navigator.clipboard?.writeText(`${st!.pay!.u} ${((st!.tot[pid] ?? 0) / 100).toFixed(2)}`).catch(() => {}); }}>Copy ID + amount</button></>}<p className="sb-muted sb-small">These only try to open your UPI app with the amount filled in. Check the name and amount there. Opening the app does not mean it was paid; {st!.pay.n} ticks it off by hand.</p></div> : <p className="sb-muted sb-small">{!st!.final ? 'Pay buttons show up once the whole bill is claimed.' : 'The host has not added a valid UPI ID. Ask them how to pay.'}</p>}
    </section>;
}
