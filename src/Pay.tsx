import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmt } from './engine';
import { qrMatrix } from './qr';
import { appLinks, payLink, platform, type PayRequest } from './upi';

export function Qr({ text, label = 'QR code' }: { text: string; label?: string }) {
    const m = useMemo(() => { try { return qrMatrix(text); } catch { return null; } }, [text]);
    if (!m) return <p className="sb-muted">Link too long for a QR.</p>;
    const n = m.length; const q = 3;
    return <svg className="lv-qr" data-url={text} viewBox={`0 0 ${n + q * 2} ${n + q * 2}`} role="img" aria-label={label} shapeRendering="crispEdges"><rect width="100%" height="100%" fill="#fff" />{m.map((r, y) => r.map((b, x) => (b ? <rect key={`${x}-${y}`} x={x + q} y={y + q} width="1" height="1" fill="#111" /> : null)))}</svg>;
}

/**
 * The payer's own phone: Google Pay first, other UPI apps underneath, copy fallbacks.
 * With autoOpen, Google Pay is opened once on arrival; browsers may block that without a tap,
 * so the button stays. Nothing here can confirm a payment.
 */
export function PayOptions({ req, autoOpen }: { req: PayRequest; autoOpen?: string }) {
    const p = useMemo(() => platform(), []);
    const links = useMemo(() => appLinks(req, p), [req.pa, req.pn, req.am, req.tn, p]);
    const [msg, setMsg] = useState('');
    const opened = useRef<any>(null);
    useEffect(() => () => clearTimeout(opened.current), []);
    // If the page is still in front 2.5s after a tap, the app probably did not open.
    const tapped = (label: string) => {
        setMsg(''); clearTimeout(opened.current);
        const hidden = () => { clearTimeout(opened.current); document.removeEventListener('visibilitychange', hidden); };
        document.addEventListener('visibilitychange', hidden);
        opened.current = setTimeout(() => { document.removeEventListener('visibilitychange', hidden); if (document.visibilityState === 'visible') setMsg(`${label} did not open. Try another app below, or copy the UPI ID and amount.`); }, 2500);
    };
    useEffect(() => {
        if (!autoOpen || !links.primary) return;
        const key = 'chit.autopay.' + autoOpen;
        try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { return; }
        const t = setTimeout(() => { location.href = links.primary!.href; }, 600);
        return () => clearTimeout(t);
    }, [autoOpen, links.primary?.href]);
    const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); setMsg(`${what} copied.`); } catch { setMsg(`Could not copy. ${what}: ${text}`); } };
    return <div className="ch-paybox" data-platform={p}>
        {links.primary && <a className="sb-btn sb-block sb-a ch-gpay" href={links.primary.href} onClick={() => tapped(links.primary!.label)} data-app={links.primary.id}>Pay {fmt(req.am)} in {links.primary.label}</a>}
        {links.apps.length > 0 && <div className="ch-apps"><span className="sb-small sb-muted">Other apps:</span>{links.apps.map((a) => <a key={a.id} className="sb-a sb-link" href={a.href} data-app={a.id} onClick={() => tapped(a.label)}>{a.label}</a>)}</div>}
        {p === 'other' && <p className="sb-small">Open this page on your phone to pay with a UPI app, or pay {req.pa} by hand.</p>}
        <div className="ch-apps"><button type="button" className="sb-link" onClick={() => copy(req.pa, 'UPI ID')}>Copy UPI ID</button><button type="button" className="sb-link" onClick={() => copy((req.am / 100).toFixed(2), 'Amount')}>Copy amount</button></div>
        {msg && <p className="sb-small lv-warn" role="status">{msg}</p>}
        <p className="sb-small sb-muted">Check the name and amount in the app before you pay. Opening the app does not mean it was paid.</p>
    </div>;
}

/** Opened from a shared pay link on the payer's own phone. */
export function PayPage({ req }: { req: PayRequest }) {
    return <section className="lv-card">
        <h2>Pay {req.pn}</h2>
        <div className="lv-total"><span>Your share</span><b>{fmt(req.am)}</b></div>
        <p>UPI ID: <b>{req.pa}</b></p>
        <PayOptions req={req} autoOpen={`link-${req.pa}-${req.am}-${req.tn}`} />
        <p className="sb-small sb-muted">This link was made by whoever split the bill in CHIT. If the name or amount looks wrong, ask them before paying.</p>
    </section>;
}

export { payLink };
