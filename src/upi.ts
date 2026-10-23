/** UPI payment requests: one source for every pay button, QR code and shared pay link. */
import { b64u, unb64u, validUpi } from './live';

export type PayRequest = { pa: string; pn: string; am: number; tn: string };
export type Platform = 'ios' | 'android' | 'other';

export function platform(ua = navigator.userAgent, touch = navigator.maxTouchPoints): Platform {
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touch > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'other';
}

const cleanNote = (s: string) => s.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40) || 'CHIT';
const rupees = (paise: number) => (paise / 100).toFixed(2);

/** NPCI query string. The VPA is left unescaped: some apps fail to parse %40. */
function query(r: PayRequest) {
    if (!validUpi(r.pa)) throw Error('Invalid UPI ID');
    if (!Number.isSafeInteger(r.am) || r.am <= 0) throw Error('Invalid amount');
    return `pa=${r.pa.trim()}&pn=${encodeURIComponent(r.pn.trim().slice(0, 50))}&am=${rupees(r.am)}&cu=INR&tn=${encodeURIComponent(cleanNote(r.tn))}`;
}
export const upiUrl = (r: PayRequest) => `upi://pay?${query(r)}`;

export type AppLink = { id: string; label: string; href: string };
const ANDROID_APPS: [string, string, string][] = [
    ['gpay', 'Google Pay', 'com.google.android.apps.nbu.paisa.user'],
    ['phonepe', 'PhonePe', 'com.phonepe.app'],
    ['paytm', 'Paytm', 'net.one97.paytm'],
];
/** iOS cannot choose between apps that all claim upi://, so each app gets its own scheme. */
const IOS_APPS: [string, string, string][] = [
    ['gpay', 'Google Pay', 'gpay://upi/pay'],
    ['phonepe', 'PhonePe', 'phonepe://pay'],
    ['paytm', 'Paytm', 'paytmmp://pay'],
];
export function appLinks(r: PayRequest, p: Platform): { primary: AppLink | null; apps: AppLink[] } {
    const q = query(r);
    if (p === 'android') return {
        // Android shows its own chooser of every installed UPI app.
        primary: { id: 'any', label: 'Pay with a UPI app', href: `upi://pay?${q}` },
        apps: ANDROID_APPS.map(([id, label, pkg]) => ({ id, label, href: `intent://pay?${q}#Intent;scheme=upi;package=${pkg};end` })),
    };
    if (p === 'ios') return {
        primary: null,
        apps: [...IOS_APPS.map(([id, label, base]) => ({ id, label, href: `${base}?${q}` })), { id: 'any', label: 'Other UPI app', href: `upi://pay?${q}` }],
    };
    return { primary: null, apps: [] };
}

/** Shareable link that opens CHIT's pay screen on the payer's own phone. */
export const payLink = (r: PayRequest, base = location.origin + location.pathname) =>
    `${base}#pay=${b64u(new TextEncoder().encode(JSON.stringify({ v: 1, pa: r.pa.trim(), pn: r.pn.trim(), am: r.am, tn: cleanNote(r.tn) })))}`;
export function parsePayLink(hash: string): PayRequest | null {
    const m = hash.match(/pay=([A-Za-z0-9_-]{10,800})/); if (!m) return null;
    try {
        const v = JSON.parse(new TextDecoder().decode(unb64u(m[1])));
        if (v?.v !== 1 || typeof v.pa !== 'string' || typeof v.pn !== 'string' || typeof v.tn !== 'string' || !validUpi(v.pa) || !Number.isSafeInteger(v.am) || v.am <= 0 || v.am > 10_000_000) return null;
        return { pa: v.pa.trim(), pn: v.pn.replace(/[\u0000-\u001f<>]/g, '').slice(0, 50), am: v.am, tn: cleanNote(v.tn) };
    } catch { return null; }
}
