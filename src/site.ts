/** Public address diners and payers can open without any login. */
export const PUBLIC_URL = 'https://chit-bill-splitter.vercel.app/';

/**
 * Base for join links, QR codes and pay links. Vercel's per-deployment and preview addresses
 * (*.vercel.app other than PUBLIC_URL) sit behind Vercel login, so links made there point at
 * PUBLIC_URL instead. Other hosts, such as localhost or a custom domain, keep their own address.
 */
export function shareBase(loc: Pick<Location, 'hostname' | 'origin' | 'pathname'> = location): string {
    const pub = new URL(PUBLIC_URL);
    if (loc.hostname.endsWith('.vercel.app') && loc.hostname !== pub.hostname) return PUBLIC_URL;
    return loc.origin + loc.pathname;
}
