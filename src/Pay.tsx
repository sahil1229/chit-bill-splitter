import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmt } from './engine';
import { qrMatrix } from './qr';
import { appLinks, payLink, platform, upiUrl, type PayRequest } from './upi';

export function Qr({ text, label = 'QR code' }: { text: string; label?: string }) {
    const m = useMemo(() => { try { return qrMatrix(text); } catch { return null; } }, [text]);
    if (!m) return <p className="sb-muted">Link too long for a QR.</p>;
    const n = m.length; const q = 3;
    return <svg className="lv-qr" data-url={text} viewBox={`0 0 ${n + q * 2} ${n + q * 2}`} role="img" aria-label={label} shapeRendering="crispEdges"><rect width="100%" height="100%" fill="#fff" />{m.map((r, y) => r.map((b, x) => (b ? <rect key={`${x}-${y}`} x={x + q} y={y + q} width="1" height="1" fill="#111" /> : null)))}</svg>;
}

/** PNG of a QR so a payer can pick it with "scan from gallery" in their UPI app. */
function qrPng(text: string): Promise<Blob> {
    const m = qrMatrix(text); const scale = 10, q = 4, size = (m.length + q * 2) * scale;
    const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
    m.forEach((row, y) => row.forEach((on, x) => { if (on) g.fillRect((x + q) * scale, (y + q) * scale, scale, scale); }));
    return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(Error('QR image failed'))), 'image/png'));
}

/**
 * Everything a payer needs on their own phone: app buttons for this platform, a standard UPI QR
 * any UPI app can scan, and copy fallbacks. Nothing here can confirm a payment.
 */
export function PayOptions({ req, showQr = true, compact = false }: { req: PayRequest; showQr?: boolean; compact?: boolean }) {
    const p = useMemo(() => platform(), []);
    const links = useMemo(() => appLinks(req, p), [req.pa, req.pn, req.am, req.tn, p]);
    const url = useMemo(() => upiUrl(req), [req.pa, req.pn, req.am, req.tn]);
    const [msg, setMsg] = useState(''); const [qrOpen, setQrOpen] = useState(showQr && p === 'other');
    const opened = useRef<any>(null);
    useEffect(() => () => clearTimeout(opened.current), []);
    // If the page is still in front 2.5s after a tap, the app probably did not open.
    const tapped = (label: string) => {
        setMsg(''); clearTimeout(opened.current);
        const hidden = () => { clearTimeout(opened.current); document.removeEventListener('visibilitychange', hidden); };
        document.addEventListener('visibilitychange', hidden);
        opened.current = setTimeout(() => { document.removeEventListener('visibilitychange', hidden); if (document.visibilityState === 'visible') setMsg(`${label} did not seem to open. Try another app, scan the QR, or copy the UPI ID and amount.`); }, 2500);
    };
    const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); setMsg(`${what} copied.`); } catch { setMsg(`Could not copy. ${what}: ${text}`); } };
    const saveQr = async () => {
        try {
            const file = new File([await qrPng(url)], `pay-${req.pn.replace(/[^A-Za-z0-9]/g, '') || 'upi'}.png`, { type: 'image/png' });
            if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
            const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000); setMsg('QR image saved. In your UPI app, scan and pick it from your gallery.');
        } catch (e) { if ((e as Error).name !== 'AbortError') setMsg('Could not save the QR image. Take a screenshot instead.'); }
    };
    return <div className="ch-paybox" data-platform={p}>
        {links.primary && <a className="sb-btn sb-block sb-a" href={links.primary.href} onClick={() => tapped('The UPI app')} data-app={links.primary.id}>{links.primary.label} · {fmt(req.am)}</a>}
        {links.apps.length > 0 && <div className="ch-apps">{links.apps.map((a) => <a key={a.id} className={`sb-a ${links.primary ? 'sb-link' : 'sb-btn sb-ghost sb-small-btn'}`} href={a.href} data-app={a.id} onClick={() => tapped(a.label)}>{links.primary ? `Open ${a.label}` : a.label}</a>)}</div>}
        {showQr && <>
            {p !== 'other' && <button type="button" className="sb-link" aria-expanded={qrOpen} onClick={() => setQrOpen(!qrOpen)}>{qrOpen ? 'Hide UPI QR' : 'Show UPI QR (scan from another phone)'}</button>}
            {qrOpen && <><Qr text={url} label={`UPI QR to pay ${req.pn} ${fmt(req.am)}`} /><p className="sb-small sb-muted">Scan with any UPI app: Google Pay, PhonePe, Paytm, BHIM or your bank app.</p>{!compact && <button type="button" className="sb-link" onClick={saveQr}>Save QR image</button>}</>}
        </>}
        <div className="ch-apps"><button type="button" className="sb-link" onClick={() => copy(req.pa, 'UPI ID')}>Copy UPI ID</button><button type="button" className="sb-link" onClick={() => copy((req.am / 100).toFixed(2), 'Amount')}>Copy amount</button></div>
        {msg && <p className="sb-small lv-warn" role="status">{msg}</p>}
        <p className="sb-small sb-muted">Check the name and amount in your UPI app before you pay. Opening the app does not mean it was paid.</p>
    </div>;
}

/** Opened from a shared pay link on the payer's own phone. */
export function PayPage({ req }: { req: PayRequest }) {
    return <section className="lv-card">
        <h2>Pay {req.pn}</h2>
        <div className="lv-total"><span>Your share</span><b>{fmt(req.am)}</b></div>
        <p>UPI ID: <b>{req.pa}</b></p>
        <PayOptions req={req} />
        <p className="sb-small sb-muted">This link was made by whoever split the bill in CHIT. If the name or amount looks wrong, ask them before paying.</p>
    </section>;
}

export { payLink };
