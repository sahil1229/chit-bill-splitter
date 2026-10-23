// Minimal QR encoder: byte mode, error correction L, versions 1-20, fixed mask 0.
const ECC = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28];
const BLK = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8];
const rawModules = (v: number) => {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const a = Math.floor(v / 7) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36; }
    return r;
};
const dataCodewords = (v: number) => Math.floor(rawModules(v) / 8) - ECC[v - 1] * BLK[v - 1];
function gfMul(x: number, y: number) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 255; }
function rsDiv(data: number[], deg: number) {
    const gen = new Array(deg).fill(0); gen[deg - 1] = 1; let root = 1;
    for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { gen[j] = gfMul(gen[j], root); if (j + 1 < deg) gen[j] ^= gen[j + 1]; } root = gfMul(root, 2); }
    const res = new Array(deg).fill(0);
    for (const b of data) { const f = b ^ res.shift()!; res.push(0); gen.forEach((c, i) => (res[i] ^= gfMul(c, f))); }
    return res;
}
export function qrMatrix(text: string): boolean[][] {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    for (; ver <= 20; ver++) { const cc = ver < 10 ? 8 : 16; if (4 + cc + bytes.length * 8 <= dataCodewords(ver) * 8) break; }
    if (ver > 20) throw new Error('QR too long');
    const bits: number[] = [];
    const put = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
    const cap = dataCodewords(ver) * 8;
    put(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
    for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) put(p, 8);
    const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    const nb = BLK[ver - 1], ecl = ECC[ver - 1], raw = Math.floor(rawModules(ver) / 8);
    const shortLen = Math.floor(raw / nb) - ecl, numShort = nb - (raw % nb);
    const blocks: number[][] = []; const eccs: number[][] = [];
    for (let i = 0, k = 0; i < nb; i++) { const len = shortLen + (i < numShort ? 0 : 1); const d = data.slice(k, k + len); k += len; blocks.push(d); eccs.push(rsDiv(d, ecl)); }
    const all: number[] = [];
    for (let i = 0; i <= shortLen; i++) blocks.forEach((b, j) => { if (i < b.length && !(i === shortLen && j < numShort)) all.push(b[i]); });
    for (let i = 0; i < ecl; i++) eccs.forEach((e) => all.push(e[i]));
    const size = ver * 4 + 17;
    const m: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
    const setF = (x: number, y: number, d: boolean) => { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = d; fn[y][x] = true; } };
    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); setF(cx + dx, cy + dy, d !== 2 && d !== 4); }
    const na = ver === 1 ? 0 : Math.floor(ver / 7) + 2;
    const step = ver === 1 ? 0 : ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
    const pos = na ? [6] : []; for (let p = size - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
    pos.forEach((x, i) => pos.forEach((y, j) => { if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
    const drawFormat = () => {
        const d = (1 << 3) | 0; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
        const f = ((d << 10) | r) ^ 0x5412; const g = (i: number) => ((f >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setF(8, i, g(i)); setF(8, 7, g(6)); setF(8, 8, g(7)); setF(7, 8, g(8));
        for (let i = 9; i < 15; i++) setF(14 - i, 8, g(i));
        for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, g(i));
        for (let i = 8; i < 15; i++) setF(8, size - 15 + i, g(i));
        setF(8, size - 8, true);
    };
    drawFormat();
    if (ver >= 7) { let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const v = (ver << 12) | r; for (let i = 0; i < 18; i++) { const b = ((v >>> i) & 1) !== 0; const a = size - 11 + (i % 3), c = Math.floor(i / 3); setF(a, c, b); setF(c, a, b); } }
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
            const x = right - j; const up = ((right + 1) & 2) === 0; const y = up ? size - 1 - vert : vert;
            if (!fn[y][x] && i < all.length * 8) { m[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
        }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
    return m;
}
