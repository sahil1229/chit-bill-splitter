import { fmt, type SplitResult, type Item, type Charge, type Person } from './engine';

export type ReportInput = {
    res: SplitResult;
    items: Item[];
    charges: Charge[];
    people: Person[];
    collectorId: string;
    upi: string;
    received: Record<string, boolean>;
    chargeMode: 'equal' | 'prorata';
    spread: boolean;
    date: string;
};

/** A split is final only when every rupee is assigned and the parts match the bill. */
export function isFinal(r: ReportInput): { ok: boolean; why: string } {
    if (r.people.length === 0) return { ok: false, why: 'Add people first.' };
    if (!r.people.some((p) => p.id === r.collectorId)) return { ok: false, why: 'Choose who is collecting the money.' };
    if (r.res.overclaimed.length) return { ok: false, why: 'Some dishes are claimed more times than served. Fix those first.' };
    if (r.res.unassigned !== 0) return { ok: false, why: `${fmt(r.res.unassigned)} is not assigned yet. Claim it or split it equally first.` };
    if (!r.res.reconciles) return { ok: false, why: 'The shares do not add up to the bill yet.' };
    return { ok: true, why: '' };
}

const statusOf = (r: ReportInput, id: string) => (id === r.collectorId ? 'collecting' : r.received[id] ? 'received' : 'waiting');

export function whatsappText(r: ReportInput): string {
    const col = r.people.find((p) => p.id === r.collectorId)!;
    const L: string[] = [];
    L.push(`🧾 *Dinner split* (${r.date})`);
    L.push(`Bill ${fmt(r.res.billTotal)}. ${col.name} is collecting. Everyone else sends ${col.name} their share, and ${col.name} settles with the restaurant.`);
    L.push('');
    for (const p of r.res.people) {
        if (p.id === r.collectorId) continue;
        const st = statusOf(r, p.id) === 'received' ? ' ✅ received' : '';
        L.push(`• ${p.name}: *${fmt(p.total)}*${st}`);
    }
    const mine = r.res.people.find((p) => p.id === r.collectorId)!;
    L.push(`• ${col.name}: ${fmt(mine.total)} (own share, collecting)`);
    L.push('');
    const cl = r.res.chargeLines;
    const shared = r.items.filter((i) => i.everyone).map((i) => i.name);
    const cn = cl.map((c) => c.name);
    if (r.chargeMode === 'equal') {
        const all = [...cn, ...shared];
        if (all.length) L.push(`Split equally between everyone: ${all.join(', ')}.`);
    } else {
        if (cn.length) L.push(`${cn.join(', ')}: split by what each person had.`);
        if (shared.length) L.push(`Split equally between everyone: ${shared.join(', ')}.`);
    }
    if (r.spread) L.push('Items nobody claimed were split equally.');
    if (r.upi.trim()) L.push(`Pay ${col.name} on UPI: ${r.upi.trim()}`);
    const wait = r.people.filter((p) => statusOf(r, p.id) === 'waiting').map((p) => p.name);
    L.push(wait.length ? `Not yet marked received: ${wait.join(', ')} (ticked by ${col.name} by hand).` : `${col.name} has marked everyone as received.`);
    L.push('Detailed breakdown in the PDF.');
    return L.join('\n');
}

/* ---------- minimal PDF writer (Helvetica / Courier, WinAnsi-safe ASCII) ---------- */
const norm = (s: string) => s.replace(/₹/g, 'Rs ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\u00a0/g, ' ');
const clean = (s: string) => norm(s);
const OK = /^[\x20-\x7e\xa1-\xff]*$/;
/** Text the PDF cannot draw with its built-in fonts. Export is blocked, never printed as '?'. */
export function pdfUnsupported(r: ReportInput): string[] {
    const all = [...r.people.map((p) => p.name), ...r.items.map((i) => i.name), ...r.charges.map((c) => c.name), r.upi];
    return all.filter((s) => !OK.test(norm(s)));
}
const esc = (s: string) => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const money = (n: number) => fmt(n, 'Rs ');

export function buildPdf(r: ReportInput): Uint8Array {
    const W = 595, H = 842, M = 40;
    const pages: string[][] = [];
    let ops: string[] = [];
    let y = 0;
    const newPage = () => { ops = []; pages.push(ops); ops.push(`0.984 0.969 0.929 rg 0 0 ${W} ${H} re f`); y = H - M; };
    const rgb = (c: string) => { const n = parseInt(c.slice(1), 16); return `${((n >> 16) & 255) / 255} ${((n >> 8) & 255) / 255} ${(n & 255) / 255}`; };
    const rect = (x: number, yy: number, w: number, h: number, fill?: string, stroke = 0) => {
        if (fill) ops.push(`${rgb(fill)} rg ${x} ${yy} ${w} ${h} re f`);
        if (stroke) ops.push(`0.11 0.09 0.09 RG ${Math.min(stroke, 1.2)} w [3 3] 0 d ${x} ${yy} ${w} ${h} re S [] 0 d`);
    };
    const text = (s: string, x: number, yy: number, font: 'F1' | 'F2' | 'F3' | 'F4', size: number, color = '#1C1917') => {
        font = font === 'F1' ? 'F3' : font === 'F2' ? 'F4' : font;
        ops.push(`BT ${rgb(color)} rg /${font} ${size} Tf ${x} ${yy} Td (${esc(s)}) Tj ET`);
    };
    const mono = (s: string, xRight: number, yy: number, size: number, bold = false) => {
        const w = clean(s).length * 0.6 * size;
        text(s, xRight - w, yy, bold ? 'F4' : 'F3', size);
    };
    const need = (h: number) => { if (y - h < M + 30) newPage(); };
    const col = r.people.find((p) => p.id === r.collectorId)!;

    newPage();
    text('* * *', M + 12, y - 8, 'F4', 10);
    text('CHIT', M + 12, y - 36, 'F4', 30);
    text('THE BILL, SPLIT FAIR & SQUARE', M + 120, y - 36, 'F3', 8.5);
    ops.push(`0.11 0.09 0.09 RG 1 w [2 3] 0 d ${M} ${y - 52} m ${W - M} ${y - 52} l S [] 0 d`);
    text('DINNER SPLIT', M + 12, y - 70, 'F4', 14);
    text(`${r.date}   |   Bill ${money(r.res.billTotal)}   |   ${r.people.length} people`, M + 12, y - 86, 'F1', 9);
    y -= 108;
    {
        const words = `${col.name} is collecting. Everyone else sends ${col.name} the amount below; ${col.name} settles with the restaurant.`.split(' '); let line = '';
        for (const w of words) { if ((line + ' ' + w).length > 78) { text(line, M, y, 'F1', 9.5); y -= 13; line = w; } else line = line ? line + ' ' + w : w; }
        text(line, M, y, 'F1', 9.5); y -= 14;
    }
    if (r.upi.trim()) { text(`UPI ID to pay: ${r.upi.trim()}`, M, y, 'F2', 10.5); y -= 14; }
    y -= 8;

    // summary table
    text('WHO OWES WHAT', M, y, 'F2', 12); y -= 8;
    const rows = r.res.people;
    const sh = 20;
    rect(M, y - sh * (rows.length + 1), W - 2 * M, sh * (rows.length + 1), '#FFFDF6', 2);
    rect(M, y - sh, W - 2 * M, sh, '#1C1917');
    text('Person', M + 8, y - 14, 'F2', 9.5, '#FBF7ED');
    text('Status (ticked by hand)', M + 200, y - 14, 'F2', 9.5, '#FBF7ED');
    text('Amount', W - M - 70, y - 14, 'F2', 9.5, '#FBF7ED');
    rows.forEach((p, i) => {
        const yy = y - sh * (i + 2) + 6;
        const st = statusOf(r, p.id);
        text(p.name, M + 8, yy, 'F2', 10.5);
        text(st === 'collecting' ? 'collecting (own share)' : st === 'received' ? 'COLLECTED (ticked)' : 'owes, not yet ticked', M + 200, yy, st === 'received' ? 'F2' : 'F1', 9.5, st === 'received' ? '#C2402A' : '#1C1917');
        mono(money(p.total), W - M - 8, yy, 10, true);
    });
    y -= sh * (rows.length + 1) + 6;
    const tot = rows.reduce((a, b) => a + b.total, 0);
    text('All shares added up', M + 8, y - 8, 'F1', 9.5);
    mono(money(tot), W - M - 8, y - 8, 10, true);
    y -= 22;
    text(`Bill total ${money(r.res.billTotal)}. ${tot === r.res.billTotal ? 'Shares add up to the bill exactly.' : 'WARNING: shares do not match the bill.'}`, M, y, 'F1', 9.5);
    y -= 26;

    // how charges are split
    text('HOW IT WAS CALCULATED', M, y, 'F2', 12); y -= 15;
    const notes = [
        'Each dish is divided by the units each person took. Dishes marked "shared by N" are split equally among the people picked.',
        r.chargeMode === 'equal' ? `Split equally between everyone: ${[...r.charges.map((c) => c.name), ...r.items.filter((i) => i.everyone).map((i) => i.name)].join(', ') || 'nothing'}.` : `Charges (${r.charges.map((c) => c.name).join(', ') || 'none'}) are split in proportion to what each person had. Split equally between everyone: ${r.items.filter((i) => i.everyone).map((i) => i.name).join(', ') || 'nothing'}.`,
        'Amounts are worked out in paise and rounded so the shares add up to the bill exactly.',
    ];
    if (r.spread) notes.push('Dishes nobody claimed were split equally between everyone.');
    for (const n of notes) {
        const words = n.split(' '); let line = '';
        for (const w of words) { if ((line + ' ' + w).length > 82) { text(line, M, y, 'F1', 9.5); y -= 12; line = w; } else line = line ? line + ' ' + w : w; }
        text(line, M, y, 'F1', 9.5); y -= 14;
    }
    y -= 8;
    // bill items
    need(40 + r.items.length * 14);
    text('THE BILL', M, y, 'F2', 12); y -= 14;
    for (const it of r.items) {
        need(16);
        text(`${it.qty > 1 ? it.qty + ' x ' : ''}${it.name}`, M + 4, y, 'F1', 9.5);
        mono(money(it.total), W - M - 4, y, 9.5); y -= 13;
    }
    for (const c of r.charges) { need(16); text(c.name, M + 4, y, 'F1', 9.5); mono(money(c.amount), W - M - 4, y, 9.5); y -= 13; }
    y -= 2; ops.push(`0 0 0 RG 1.5 w ${M} ${y + 6} m ${W - M} ${y + 6} l S`);
    text('Total', M + 4, y - 6, 'F2', 10); mono(money(r.res.billTotal), W - M - 4, y - 6, 10, true);
    y -= 28;

    // per person
    const palette = ['#EFE6D0'];
    r.res.people.forEach((p, idx) => {
        const lines = p.lines.length;
        const cl = r.res.chargeLines.filter((c) => (c.perPerson[idx] ?? 0) !== 0).length;
        const h = 34 + (lines + cl + 1) * 14 + 6;
        need(h + 8);
        rect(M, y - h, W - 2 * M, h, '#FFFDF6', 2);
        rect(M, y - 26, W - 2 * M, 26, palette[idx % palette.length], 2);
        text(p.name, M + 10, y - 18, 'F2', 13);
        mono(money(p.total), W - M - 10, y - 18, 13, true);
        let yy = y - 42;
        for (const l of p.lines) { text(`${l.name}  (${l.note})`, M + 12, yy, 'F1', 9.5); mono(money(l.amount), W - M - 12, yy, 9.5); yy -= 14; }
        r.res.chargeLines.forEach((c) => { const a = c.perPerson[idx] ?? 0; if (a !== 0) { text(c.name, M + 12, yy, 'F1', 9.5, '#444444'); mono(money(a), W - M - 12, yy, 9.5); yy -= 14; } });
        text('Total', M + 12, yy, 'F2', 10); mono(money(p.total), W - M - 12, yy, 10, true);
        y -= h + 12;
    });

    if (y - 30 < 34) newPage();
    text('Printed on CHIT. Payment status above was ticked by hand by the collector.', M, y - 6, 'F1', 8.5, '#444444');
    text('It is not a bank confirmation and the app moves no money.', M, y - 18, 'F1', 8.5, '#444444');

    // page numbers
    pages.forEach((pg, i) => { const keep = ops; ops = pg; text(`${i + 1} / ${pages.length}`, W - M - 30, 22, 'F1', 8.5, '#444444'); ops = keep; });

    // assemble
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const catalog = add('');
    const pagesObj = add('');
    const fonts = ['Helvetica', 'Helvetica-Bold', 'Courier', 'Courier-Bold'].map((f) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
    const pageIds: number[] = [];
    for (const pg of pages) {
        const c = pg.join('\n');
        const cid = add(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
        pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R /F4 ${fonts[3]} 0 R >> >> /Contents ${cid} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let out = '%PDF-1.4\n';
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return bytes;
}
