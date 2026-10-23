import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileCard, useLocalState } from '@instinct/files';
import { buildPdf, isFinal, pdfUnsupported, whatsappText, type ReportInput } from './report';
import './style.css';
import { parseLink, validUpi } from './live';
import { DinerApp, HostPanel, envLink, useHost } from './LiveUI';
import { Charge, ChargeMode, Claims, Shares, Item, Person, computeSplit, fmt, parseBill, toMinor, uid } from './engine';

type State = {
    step: 0 | 1 | 2 | 3;
    items: Item[];
    charges: Charge[];
    printedTotal: number | null;
    people: Person[];
    claims: Claims;
    shares: Shares;
    chargeMode: ChargeMode;
    spread: boolean;
    collectorId: string;
    upi: string;
    received: Record<string, string | number | boolean>;
    current: string;
    touched: Record<string, boolean>;
    gate: boolean;
    mode?: 'pick' | 'one' | 'live';
    hostSess?: unknown;
    hostName?: string;
};
const EMPTY: State = { step: 0, items: [], charges: [], printedTotal: null, people: [], claims: {}, shares: {}, chargeMode: 'equal', spread: false, collectorId: '', upi: '', received: {}, current: '', touched: {}, gate: true };

const SAMPLE = `Paneer Tikka 420.00
2 Butter Chicken 960.00
6 Garlic Naan 360.00
Dal Makhani 380.00
3 Mineral Water 150.00
4 Masala Cola 320.00
2 Gulab Jamun 240.00
Subtotal 2830.00
Service Charge 10% 283.00
CGST 2.5% 77.83
SGST 2.5% 77.83
Total 3268.66`;


const PALETTE = ['#ff6b6b', '#ffb703', '#4cc9a4', '#5b8def', '#b983ff', '#ff8fb8', '#2ec4d6', '#9acd32'];
const hue = (id: string, people: Person[]) => PALETTE[Math.max(0, people.findIndex((p) => p.id === id)) % PALETTE.length];
function Avatar({ p, people }: { p: Person; people: Person[] }) {
    return <span className="sb-avatar" aria-hidden style={{ background: hue(p.id, people) }}>{p.name.slice(0, 1).toUpperCase()}</span>;
}
const EMOJI: [RegExp, string][] = [[/water/i, '💧'], [/cola|coke|soda|pepsi|sprite|7up|juice|lemonade|lassi|shake/i, '🥤'], [/beer|lager|ipa/i, '🍺'], [/wine|cocktail|mojito|whisk|vodka|rum|gin/i, '🍷'], [/coffee|tea|chai|latte/i, '☕'], [/naan|roti|paratha|kulcha|bread|toast/i, '🫓'], [/paneer|dal\b|curry|gravy/i, '🍛'], [/chicken|tikka|kebab|kabab|wings/i, '🍗'], [/biryani|rice|pulao/i, '🍚'], [/pizza/i, '🍕'], [/burger/i, '🍔'], [/pasta|noodle|spaghetti|ramen/i, '🍝'], [/fries|chips/i, '🍟'], [/salad/i, '🥗'], [/soup/i, '🍲'], [/jamun|cake|ice\s?cream|brownie|dessert|kulfi|sundae|halwa|pastry/i, '🍨'], [/fish|prawn|shrimp|sushi/i, '🍤']];
const emojiFor = (name: string) => EMOJI.find(([r]) => r.test(name))?.[1] ?? '🍽️';

const STEPS = ['Bill', 'People', 'Claim', 'Split'];

function Stepper({ value, min = 0, max = 99, onChange, label }: { value: number; min?: number; max?: number; onChange: (n: number) => void; label: string }) {
    return <div className="sb-stepper" role="group" aria-label={label}>
        <button type="button" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
        <output aria-live="polite">{value}</output>
        <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>;
}

function MoneyInput({ value, onCommit, label }: { value: number; onCommit: (n: number) => void; label: string }) {
    const [text, setText] = useState((value / 100).toFixed(2));
    useEffect(() => setText((value / 100).toFixed(2)), [value]);
    return <input className="sb-input sb-money" inputMode="decimal" aria-label={label} value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { const m = toMinor(text); if (m === null) setText((value / 100).toFixed(2)); else onCommit(m); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

/* ---------- Step 1: bill ---------- */
function BillStep({ s, set }: { s: State; set: (p: Partial<State>) => void }) {
    const [paste, setPaste] = useState('');
    const [photo, setPhoto] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    useEffect(() => () => { if (photo) URL.revokeObjectURL(photo); }, [photo]);

    const read = (text: string) => {
        const r = parseBill(text);
        if (!r.items.length) { setNote('Could not find any dishes with prices in that text. Add them by hand below.'); return; }
        set({ items: r.items, charges: r.charges, printedTotal: r.printedTotal, claims: {}, shares: {}, touched: {} });
        setNote(`Read ${r.items.length} items and ${r.charges.length} charges${r.skipped.filter((x) => !x.startsWith('CHECK:')).length ? `. Ignored ${r.skipped.filter((x) => !x.startsWith('CHECK:')).length} lines` : ''}. Check them against the bill.${r.skipped.filter((x) => x.startsWith('CHECK:')).length ? ' ' + r.skipped.filter((x) => x.startsWith('CHECK:')).join(' ') : ''}`);
    };
    const itemsTotal = s.items.reduce((a, b) => a + b.total, 0);
    const chargesTotal = s.charges.reduce((a, b) => a + b.amount, 0);
    const total = itemsTotal + chargesTotal;
    const mismatch = s.printedTotal !== null && s.printedTotal !== total;
    const updItem = (id: string, patch: Partial<Item>) => set({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });

    return <>
        <section className="sb-card">
            <h2>Get the bill in</h2>
            <ol className="sb-how">
                <li><span>Tap the <b>Bill text</b> box below, touch and hold, then tap <b>Scan Text</b>.</span></li>
                <li><span>Point the camera at the bill and tap <b>Insert</b>.</span></li>
                <li><span>Tap <b>Read items</b>, then fix anything that looks off.</span></li>
            </ol>
            <p className="sb-muted sb-small">Scan Text is iPhone’s own on-device reader, so nothing leaves your phone. Already have a photo? Add it below and copy its text the same way.</p>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPhoto(URL.createObjectURL(f)); setNote(''); } }} />
            <div className="sb-row-btns">
                <button className="sb-btn" type="button" onClick={() => fileRef.current?.click()}>{photo ? 'Change photo' : 'Photo of bill'}</button>
                <button className="sb-btn sb-ghost" type="button" onClick={() => { setPaste(SAMPLE); read(SAMPLE); }}>Try sample bill</button>
            </div>
            {photo && <div className="sb-photo"><img src={photo} alt="The bill you photographed" />
                <p className="sb-muted sb-small">On iPhone, touch and hold the text in the photo, choose Select All, then Copy. Paste it below. This prototype does not read photos by itself.</p></div>}
            <label className="sb-label" htmlFor="paste">Bill text</label>
            <textarea id="paste" className="sb-input sb-area" rows={5} placeholder={'2 Butter Chicken 960.00\nService Charge 283.00'} value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button className="sb-btn sb-block" type="button" disabled={!paste.trim()} onClick={() => read(paste)}>Read items from text</button>
            {note && <p className="sb-note" role="status">{note}</p>}
        </section>

        <section className="sb-card">
            <div className="sb-head"><h2>Items</h2><span className="sb-muted">{s.items.length}</span></div>
            {!s.items.length && <p className="sb-muted">Nothing yet. Read a bill above or add dishes by hand.</p>}
            <ul className="sb-list">
                {s.items.map((it) => <li key={it.id} className="sb-item">
                    <input className="sb-input" aria-label="Item name" placeholder="🍽️ Dish name" value={it.name} onChange={(e) => updItem(it.id, { name: e.target.value })} />
                    <div className="sb-item-row">
                        <Stepper label="quantity" value={it.qty} min={1} onChange={(n) => updItem(it.id, { qty: n })} />
                        <MoneyInput label={`Line total for ${it.name}`} value={it.total} onCommit={(n) => updItem(it.id, { total: n })} />
                        <button className="sb-x" type="button" aria-label={`Remove ${it.name}`} onClick={() => set({ items: s.items.filter((i) => i.id !== it.id) })}>×</button>
                    </div>
                    <label className="sb-check"><input type="checkbox" checked={it.everyone} onChange={(e) => updItem(it.id, { everyone: e.target.checked })} /> Split equally between everyone</label>
                </li>)}
            </ul>
            <button className="sb-btn sb-ghost sb-block" type="button" onClick={() => set({ items: [...s.items, { id: uid('i'), name: '', qty: 1, total: 0, everyone: false }] })}>Add item</button>
        </section>

        <section className="sb-card">
            <div className="sb-head"><h2>Tax & service</h2><span className="sb-muted">split equally</span></div>
            <ul className="sb-list">
                {s.charges.map((c) => <li key={c.id} className="sb-charge">
                    <input className="sb-input" aria-label="Charge name" value={c.name} onChange={(e) => set({ charges: s.charges.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)) })} />
                    <MoneyInput label={`Amount for ${c.name}`} value={c.amount} onCommit={(n) => set({ charges: s.charges.map((x) => (x.id === c.id ? { ...x, amount: n } : x)) })} />
                    <button className="sb-x" type="button" aria-label={`Remove ${c.name}`} onClick={() => set({ charges: s.charges.filter((x) => x.id !== c.id) })}>×</button>
                </li>)}
            </ul>
            <button className="sb-btn sb-ghost sb-block" type="button" onClick={() => set({ charges: [...s.charges, { id: uid('c'), name: '', amount: 0 }] })}>Add charge or discount</button>
            <div className="sb-seg" role="radiogroup" aria-label="How to split charges">
                <button type="button" role="radio" aria-checked={s.chargeMode === 'equal'} onClick={() => set({ chargeMode: 'equal' })}>Equally</button>
                <button type="button" role="radio" aria-checked={s.chargeMode === 'prorata'} onClick={() => set({ chargeMode: 'prorata' })}>By what each ate</button>
            </div>
        </section>

        <section className="sb-total">
            <div><span className="sb-muted">Items + charges</span><strong>{fmt(total)}</strong></div>
            {s.printedTotal !== null && <div><span className="sb-muted">Total printed on bill</span><strong>{fmt(s.printedTotal)}</strong></div>}
            {mismatch && <p className="sb-warn">This is {fmt(Math.abs(total - (s.printedTotal ?? 0)))} {total > (s.printedTotal ?? 0) ? 'more' : 'less'} than the printed total. Check for a missed line, a discount or a round off.</p>}
        </section>
    </>;
}

/* ---------- Step 2: people ---------- */
function PeopleStep({ s, set }: { s: State; set: (p: Partial<State>) => void }) {
    const [name, setName] = useState('');
    const [count, setCount] = useState(Math.max(s.people.length, 2));
    useEffect(() => { if (s.people.length > count) setCount(s.people.length); }, [s.people.length]);
    const add = () => {
        const n = name.trim();
        if (!n) return;
        const p = { id: uid('p'), name: n };
        set({ people: [...s.people, p], collectorId: s.collectorId || p.id, current: s.current || p.id });
        setName('');
    };
    const remove = (id: string) => {
        const people = s.people.filter((p) => p.id !== id);
        const claims: Claims = {};
        for (const k of Object.keys(s.claims)) { const { [id]: _drop, ...rest } = s.claims[k]; claims[k] = rest; }
        const shares: Shares = {}; for (const k of Object.keys(s.shares)) shares[k] = s.shares[k].filter((x) => x !== id);
        set({ people, claims, shares, collectorId: s.collectorId === id ? people[0]?.id ?? '' : s.collectorId, current: s.current === id ? people[0]?.id ?? '' : s.current });
    };
    return <>
        <section className="sb-card">
            <h2>Who is at the table?</h2><p className="ch-note">Names, please. A receipt can’t read “the tall one”.</p>
            <p className="sb-muted">How many people, then their names. You will pass the phone round in the next step.</p>
            <div className="sb-count"><span>People</span><Stepper label="people" value={count} min={1} max={30} onChange={setCount} /></div>
            <div className="sb-add">
                <input className="sb-input" aria-label="Name" placeholder={`Name ${s.people.length + 1}`} value={name} onChange={(e) => setName(e.target.value)} enterKeyHint="done" autoCapitalize="words" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
                <button className="sb-btn" type="button" disabled={!name.trim()} onClick={add}>Add</button>
            </div>
            <ul className="sb-chips">
                {s.people.map((p) => <li key={p.id} className="sb-chip"><Avatar p={p} people={s.people} />{p.name}<button type="button" aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)}>×</button></li>)}
            </ul>
            {s.people.length < count && s.people.length > 0 && <p className="sb-note">{s.people.length} of {count} names added.</p>}
        </section>
        {s.people.length > 0 && <section className="sb-card">
            <h2>Who is collecting the money?</h2><p className="ch-note">Everyone pays this one person. They settle with the restaurant. Nobody has to be a hero twice.</p>
            <p className="sb-muted">Everyone else pays this person. They settle with the restaurant.</p>
            <div className="sb-pills" role="radiogroup" aria-label="Collector">
                {s.people.map((p) => <button key={p.id} type="button" role="radio" aria-checked={s.collectorId === p.id} className="sb-pill" onClick={() => set(s.collectorId === p.id ? {} : { collectorId: p.id, upi: '', received: {} })}>{p.name}{s.people.filter((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()).length > 1 ? ` (#${s.people.filter((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()).findIndex((q) => q.id === p.id) + 1})` : ''}</button>)}
            </div>
            <label className="sb-label" htmlFor="upi">UPI ID of the collector (optional)</label>
            <input id="upi" className="sb-input" inputMode="email" autoCapitalize="none" autoCorrect="off" placeholder="name@bank" value={s.upi} onChange={(e) => set({ upi: e.target.value })} />
            {s.upi.trim() && !validUpi(s.upi) && <p className="sb-warn">That does not look like a UPI ID (name@bank). No pay buttons will show until it does.</p>}
            <p className="sb-small sb-muted">Only used to make Pay buttons. Stays on this device. Nothing is paid from here. The buttons try to open your UPI app with the amount filled in. That may not work on every phone or app, so check the ID and amount there, or use Copy. Opening an app does not mean it was paid.</p>
        </section>}
    </>;
}

/* ---------- Step 3: claim ---------- */
function ClaimStep({ s, set }: { s: State; set: (p: Partial<State>) => void }) {
    const person = s.people.find((p) => p.id === s.current) ?? s.people[0];
    const res = useMemo(() => computeSplit(s), [s]);
    const [shareOpen, setShareOpen] = useState<string | null>(null);
    if (!person) return <section className="sb-card"><p>Add people first.</p></section>;
    const idx = s.people.findIndex((p) => p.id === person.id);
    const next = s.people[idx + 1];
    const mine = res.people.find((p) => p.id === person.id)!;
    const color = hue(person.id, s.people);
    if (s.gate) {
        return <section className="sb-gate" style={{ ['--who' as string]: color }}>
            <span className="sb-gate-k">{idx === 0 ? 'First up' : 'Next up'}</span>
            <span className="sb-gate-lead">Who is holding the phone?</span>
            <h2 className="sb-gate-name">{person.name}</h2>
            <button className="sb-btn sb-block sb-huge" type="button" onClick={() => set({ gate: false })}>{person.name} here. Show me the food</button>
            <div className="sb-dots" aria-label="Progress">{s.people.map((p) => <span key={p.id} className={p.id === person.id ? 'is-now' : s.touched[p.id] ? 'is-done' : ''} style={{ background: hue(p.id, s.people) }}>{p.name.slice(0, 1).toUpperCase()}</span>)}</div>
        </section>;
    }
    const setClaim = (itemId: string, n: number) => set({ claims: { ...s.claims, [itemId]: { ...(s.claims[itemId] ?? {}), [person.id]: n } }, touched: { ...s.touched, [person.id]: true } });
    const finish = () => next ? set({ current: next.id, gate: true, touched: { ...s.touched, [person.id]: true } }) : set({ step: 3, touched: { ...s.touched, [person.id]: true } });
    return <div style={{ ['--who' as string]: color }} className="sb-claimscreen">
        <div className="sb-whobar"><Avatar p={person} people={s.people} /><strong>{person.name}</strong><span className="ch-note">{person.name}’s turn. Claim your paneer, not your friend’s fries.</span></div>
        <ul className="sb-tiles">
            {s.items.map((it) => {
                const n = s.claims[it.id]?.[person.id] ?? 0;
                const sharedBy = s.people.filter((p) => s.shares[it.id]?.includes(p.id));
                const isShared = sharedBy.length > 0;
                const claimers = s.people.filter((p) => (s.claims[it.id]?.[p.id] ?? 0) > 0);
                const taken = claimers.reduce((a, p) => a + (s.claims[it.id][p.id] ?? 0), 0);
                const left = Math.max(it.qty - taken, 0);
                const room = it.qty - (taken - n); // most units this person could hold
                const each = Math.round(it.total / it.qty);
                const mineShared = sharedBy.some((p) => p.id === person.id);
                const mineOn = isShared ? mineShared : n > 0;
                const tap = () => {
                    if (it.everyone || isShared) return;
                    if (room <= 0) return;
                    if (it.qty === 1) setClaim(it.id, n ? 0 : 1); else if (n < room) setClaim(it.id, n + 1);
                };
                const blocked = !it.everyone && !isShared && room <= 0 && n === 0;
                const toggleShare = (pid: string) => {
                    const cur = s.shares[it.id] ?? [];
                    const nextList = cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid];
                    const claims = { ...s.claims }; delete claims[it.id];
                    set({ shares: { ...s.shares, [it.id]: nextList }, claims: cur.length ? s.claims : claims, touched: { ...s.touched, [person.id]: true } });
                };
                return <React.Fragment key={it.id}>
                <li className={`sb-tile${mineOn ? ' is-mine' : ''}${it.everyone ? ' is-all' : ''}${blocked ? ' is-full' : ''}`}>
                    <button type="button" className="sb-tile-main" onClick={tap} disabled={it.everyone || isShared || blocked} aria-label={`${it.name}, ${fmt(it.total)}. ${it.everyone ? 'Split by everyone.' : isShared ? `Shared by ${sharedBy.map((p) => p.name).join(', ')}.` : blocked ? 'All units taken.' : `${person.name} has ${n} of ${it.qty}. Tap to add.`}`}>
                        <span className="ch-box" aria-hidden>{it.everyone ? "◆" : mineOn ? "☑" : "☐"}</span>
                        <span className="sb-tile-name">{it.name || 'Item'}{it.qty > 1 ? ` ×${it.qty}` : ''}</span><span className="ch-lead" aria-hidden />
                        <span className="sb-tile-price">{fmt(it.total)}</span>
                        {it.everyone ? <span className="sb-tag">Everyone</span> : <span className="sb-tile-claim">
                            {isShared ? <><span className="sb-tag sb-tag-s">Shared</span>{sharedBy.map((p) => <i key={p.id} style={{ background: hue(p.id, s.people) }} title={p.name}>{p.name.slice(0, 1).toUpperCase()}</i>)}</>
                                : <>{claimers.map((p) => <i key={p.id} style={{ background: hue(p.id, s.people) }} title={p.name}>{p.name.slice(0, 1).toUpperCase()}{it.qty > 1 ? <b>{s.claims[it.id][p.id]}</b> : null}</i>)}
                                {left > 0 && (taken > 0 || it.qty > 1) && <em>{left} left</em>}
                                {blocked && <em>all taken</em>}</>}
                        </span>}
                    </button>
                    {mineOn && !isShared && it.qty > 1 && <span className="ch-mine">yours ×{n}</span>}
                    {!isShared && n > 0 && it.qty > 1 && <button type="button" className="sb-minus" aria-label={`One less ${it.name}`} onClick={() => setClaim(it.id, n - 1)}>−</button>}
                    {!it.everyone && <button type="button" className="sb-sharebtn" aria-expanded={shareOpen === it.id} onClick={() => setShareOpen(shareOpen === it.id ? null : it.id)}>{isShared ? 'Edit share' : 'Share'}</button>}
                </li>
                {shareOpen === it.id && <li className="sb-sharepanel">
                    <strong>Who shared {it.name}?</strong>
                    <span className="sb-small">It is split equally between the people you pick. {claimers.length > 0 && !isShared ? 'This replaces the unit counts for this dish.' : ''}</span>
                    <div className="sb-pills" role="group" aria-label="People sharing">
                        {s.people.map((p) => <button key={p.id} type="button" aria-pressed={sharedBy.some((x) => x.id === p.id)} className="sb-pill" style={{ ['--c' as string]: hue(p.id, s.people) }} onClick={() => toggleShare(p.id)}>{p.name}</button>)}
                    </div>
                    <div className="sb-row-btns">
                        {isShared && <button type="button" className="sb-btn sb-ghost" onClick={() => { set({ shares: { ...s.shares, [it.id]: [] } }); }}>Not shared</button>}
                        <button type="button" className="sb-btn" onClick={() => setShareOpen(null)}>Done</button>
                    </div>
                </li>}
                </React.Fragment>;
            })}
        </ul>
        <div className="sb-bar sb-ticker">
            <div><span className="sb-small">{person.name}, so far</span><strong>{fmt(mine.items)}</strong></div>
            <button className="sb-btn" type="button" onClick={finish}>{next ? `Done, pass on` : 'Done, see split'}</button>
        </div>
    </div>;
}

/* ---------- Step 4: split ---------- */
function SplitStep({ s, set }: { s: State; set: (p: Partial<State>) => void }) {
    const res = useMemo(() => computeSplit(s), [s]);
    const [open, setOpen] = useState<string | null>(null);
    const [msg, setMsg] = useState('');
    const collector = s.people.find((p) => p.id === s.collectorId);
    const unclaimedList = s.items.filter((i) => !i.everyone && (res.unclaimedUnits[i.id] ?? 0) > 0);
    const payers = res.people.filter((p) => p.id !== s.collectorId);
    const owed = payers.reduce((a, b) => a + b.total, 0);
    const rk = (n: number) => `${n}|${s.collectorId}|${s.upi.trim().toLowerCase()}`;
    useEffect(() => { const bad = Object.keys(s.received).filter((id) => s.received[id] && (id === s.collectorId || s.received[id] !== rk(res.people.find((p) => p.id === id)?.total ?? -1))); if (bad.length) set({ received: Object.fromEntries(Object.entries(s.received).filter(([id]) => !bad.includes(id))) }); }, [s.received, s.collectorId, s.upi, res]);
    const back = payers.filter((p) => s.received[p.id] === rk(p.total)).reduce((a, b) => a + b.total, 0);
    const pct = owed ? Math.round((back / owed) * 100) : 0;
    const upiLink = (amt: number) => `upi://pay?pa=${encodeURIComponent(s.upi.trim())}&pn=${encodeURIComponent(collector?.name ?? '')}&am=${(amt / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Dinner split')}`;
    const share = async (text: string, okMsg: string) => {
        try {
            if (navigator.share) { await navigator.share({ text }); setMsg(okMsg); }
            else { await navigator.clipboard.writeText(text); setMsg('Copied. Paste it into your group chat.'); }
        } catch { setMsg('Sharing was cancelled. Nothing was sent.'); }
    };
    const request = (p: { name: string; total: number }) => share(`Hi ${p.name}, your share of dinner is ${fmt(p.total)}.${s.upi.trim() ? ` Pay ${collector?.name} on UPI: ${s.upi.trim()}` : ` Please pay ${collector?.name ?? 'me'}.`}`, `Request for ${p.name} opened in the share sheet. That is a request, not a payment.`);
    const rep: ReportInput = { printedTotal: s.printedTotal, res, items: s.items, charges: s.charges, people: s.people, collectorId: s.collectorId, upi: s.upi, received: Object.fromEntries(payers.filter((p) => s.received[p.id] === rk(p.total)).map((p) => [p.id, true])), chargeMode: s.chargeMode, spread: s.spread, date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) };
    const fin = isFinal(rep);
    const waText = fin.ok ? whatsappText(rep) : '';
    const bad = pdfUnsupported(rep);
    const copyWa = async () => { try { await navigator.clipboard.writeText(waText); setMsg('Message copied. Paste it into your group chat.'); } catch { setMsg('Could not copy here. Use Share message instead.'); } };
    const sharePdf = async () => {
        if (!isFinal(rep).ok) { setMsg('Not final yet, so no PDF was made.'); return; }
        if (bad.length) { setMsg(`PDF not made: these names use characters the PDF cannot print: ${bad.join(', ')}. Rename them with plain letters, or share the message instead.`); return; }
        const file = new File([buildPdf(rep) as BlobPart], 'dinner-split.pdf', { type: 'application/pdf' });
        try {
            if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Dinner split' }); setMsg('PDF opened in the share sheet. Pick your group. Nothing was sent yet.'); return; }
        } catch (e) { if ((e as Error).name === 'AbortError') { setMsg('Sharing was cancelled. Nothing was sent.'); return; } }
        const url = URL.createObjectURL(file);
        const a = document.createElement('a'); a.href = url; a.download = 'dinner-split.pdf'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setMsg('Download requested, not confirmed. This page cannot tell if your browser saved the file. If nothing appeared, use Share message instead.');
    };
    const summary = () => `🧾 Dinner split, total ${fmt(res.billTotal)}\n${payers.map((p) => `${p.name}: ${fmt(p.total)}`).join('\n')}\nPay ${collector?.name ?? 'the collector'}${s.upi.trim() ? ` on UPI: ${s.upi.trim()}` : ''}.`;
    return <>
        <section className="sb-receipt">
            <div className="sb-receipt-top"><span>BILL TOTAL</span><span>{res.people.length} PEOPLE</span></div>
            <strong className="sb-big">{fmt(res.billTotal)}</strong>
            {res.unassigned !== 0 ? <p className="sb-warn">Not fully assigned yet: {fmt(res.unassigned)} of {fmt(res.billTotal)} is unclaimed. Shares below cover only {fmt(res.billTotal - res.unassigned)}.</p> : res.reconciles ? <p className="sb-ok">✓ Every rupee is assigned and shares add up to the bill</p> : <p className="sb-warn">Shares add up to {fmt(res.sumOfParts)}; the bill is {fmt(res.billTotal)}. Check the bill step.</p>}
            {s.printedTotal !== null && s.printedTotal !== res.billTotal && <p className="sb-warn">Printed total was {fmt(s.printedTotal)}; items and charges here come to {fmt(res.billTotal)}.</p>}
        </section>
        {res.unassigned !== 0 && <section className="sb-card sb-alert">
            <h2>{fmt(res.unassigned)} nobody has claimed</h2>
            <p className="sb-muted">{unclaimedList.map((i) => `${i.name} (${res.unclaimedUnits[i.id]})`).join(', ')}</p>
            <div className="sb-row-btns">
                <button className="sb-btn" type="button" onClick={() => set({ spread: true })}>Split it equally</button>
                <button className="sb-btn sb-ghost" type="button" onClick={() => set({ step: 2, current: s.people[0]?.id ?? '', gate: true })}>Go back and claim</button>
            </div>
        </section>}
        {s.spread && <button className="sb-link" type="button" onClick={() => set({ spread: false })}>Unclaimed items are being split equally. Undo</button>}

        <section className="sb-settle" aria-label="Collected progress">
            <div className="sb-settle-row"><span>COLLECTED BY {(collector?.name ?? '').toUpperCase()}</span><strong>{fmt(back)} / {fmt(owed)}</strong></div>
            <div className="sb-meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
            <p className="sb-small sb-muted">Ticked by hand by the collector. The app cannot see payments.</p>
        </section>

        <ul className="sb-list">
            {res.people.map((p) => {
                const isCollector = p.id === s.collectorId;
                const person = s.people.find((x) => x.id === p.id)!;
                const done = s.received[p.id] === rk(p.total); const stale = !done && !!s.received[p.id];
                return <li key={p.id} className={`sb-person${done ? ' is-paid' : ''}`} style={{ ['--who' as string]: hue(p.id, s.people) }}>
                    <button type="button" className="sb-person-top" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
                        <Avatar p={person} people={s.people} />
                        <span className="sb-pn"><strong>{p.name}</strong><span className="sb-muted sb-small">{isCollector ? 'Collecting the money' : done ? 'Marked as received' : stale ? `Amount or payee changed after you ticked it. Owes ${collector?.name ?? ''}` : `Owes ${collector?.name ?? ''}`}</span></span>
                        <strong className="sb-amt">{fmt(p.total)}</strong>
                    </button>
                    {done && !isCollector && <span className="ch-stamp" aria-label="Marked collected by hand">COLLECTED</span>}
                    {!done && !isCollector && <span className="ch-note ch-owes">owes, no stamp yet</span>}
                    {open === p.id && <div className="sb-break">
                        {p.lines.map((l, i) => <div key={i} className="sb-bl"><span>{l.name} <em>{l.note}</em></span><span>{fmt(l.amount)}</span></div>)}
                        {res.chargeLines.map((c) => <div key={c.id} className="sb-bl sb-muted"><span>{c.name}</span><span>{fmt(c.perPerson[res.people.indexOf(p)] ?? 0)}</span></div>)}
                        <div className="sb-bl sb-sum"><span>Total</span><span>{fmt(p.total)}</span></div>
                    </div>}
                    {!isCollector && <div className="sb-pay">
                        {!fin.ok ? <p className="sb-small sb-muted">Amount not final yet.</p> : done ? <p className="sb-small sb-muted">Received. Nothing more to pay.</p> : validUpi(s.upi) ? <span className="ch-pay"><a className="sb-btn sb-small-btn sb-a" href={upiLink(p.total).replace('upi://', 'gpay://upi/')}>Open Google Pay · {fmt(p.total)}</a><a className="sb-link" href={upiLink(p.total)}>Other UPI app</a><button type="button" className="sb-link" onClick={async () => { try { await navigator.clipboard.writeText(`${s.upi.trim()} ${(p.total / 100).toFixed(2)}`); setMsg('Copied UPI ID and amount. Paste them into any UPI app.'); } catch { setMsg(`UPI ID ${s.upi.trim()}, amount ${(p.total / 100).toFixed(2)}`); } }}>Copy ID + amount</button></span> : <button type="button" className="sb-btn sb-small-btn" onClick={() => request(p)}>Request {fmt(p.total)}</button>}
                        <button type="button" role="switch" aria-checked={done} className={`sb-got${done ? ' on' : ''}`} onClick={() => set({ received: { ...s.received, [p.id]: done ? 0 : rk(p.total) } })}>{done ? '✓ Received' : 'Mark received'}</button>
                    </div>}
                </li>;
            })}
        </ul>
        {msg && <p className="sb-note" role="status">{msg}</p>}
        <section className="sb-card sb-export" aria-label="Share with the group">
            <h2>Send it to the group</h2>
            {!fin.ok && <p className="sb-warn">Not ready to share as a final split. {fin.why}</p>}
            {fin.ok && <>
                <pre className="sb-wa" aria-label="WhatsApp message preview">{waText}</pre>
                <div className="sb-row-btns">
                    <button className="sb-btn" type="button" onClick={() => share(waText, 'Message opened in the share sheet. Pick your group. Nothing was sent yet.')}>Share message</button>
                    <button className="sb-btn sb-ghost" type="button" onClick={copyWa}>Copy message</button>
                </div>
                {bad.length > 0 && <p className="sb-warn">The PDF cannot print: {bad.join(', ')}. Rename with plain letters to get the PDF. The message still works.</p>}
                <button className="sb-btn sb-block" type="button" disabled={bad.length > 0} onClick={sharePdf}>Share the detailed PDF</button>
                <p className="sb-small sb-muted">Both are prepared for you to send. Nothing is posted by this page. Payment status in them is what you ticked by hand.</p>
            </>}
        </section>
        {s.upi.trim() && <p className="sb-small sb-muted">“Pay” opens a UPI app on whoever taps it. They confirm and pay there. This page never moves money.</p>}
        {!s.upi.trim() && <p className="sb-small sb-muted">Add {collector?.name ?? 'the collector'}’s UPI ID on the People step to get one-tap Pay buttons.</p>}
    </>;
}

export function App() {
    const diner = useMemo(() => envLink(), []);
    const [pasted, setPasted] = useState<ReturnType<typeof envLink>>(null);
    if (diner || pasted) return <FileCard><div className="sb-app"><header className="sb-top"><div className="sb-title"><div className="ch-mark"><span className="ch-stars">* * *</span><h1>CHIT</h1><span className="ch-tag">THE BILL, SPLIT FAIR &amp; SQUARE</span></div></div></header><DinerApp link={(diner || pasted)!} /></div></FileCard>;
    return <Host onJoin={setPasted} />;
}
function Host({ onJoin }: { onJoin: (l: NonNullable<ReturnType<typeof envLink>>) => void }) {
    const [saved, setSaved, meta] = useLocalState<State>('split.v1', EMPTY);
    const s: State = { ...EMPTY, ...saved };
    const sRef = useRef(s); sRef.current = s;
    const SETTLE = ['items', 'charges', 'people', 'claims', 'shares', 'chargeMode', 'spread', 'collectorId', 'upi', 'printedTotal', 'hostName'] as const;
    const setNow = (p: Partial<State>) => { const cur: any = sRef.current; const changed = SETTLE.some((k) => k in p && JSON.stringify((p as any)[k]) !== JSON.stringify(cur[k])); const next = { ...sRef.current, ...(changed && !('received' in p) ? { received: {} } : {}), ...p }; sRef.current = next; setSaved(next); };
    const set = (p: Partial<State>) => { if (meta.ready) setNow({ ...(p.step === 2 && p.gate === undefined ? { gate: true, current: s.people[0]?.id ?? s.current } : {}), ...p }); };
    const mode = s.mode ?? (s.items.length ? 'one' : 'pick');
    const version = JSON.stringify([s.items.map((i) => i.id + '|' + i.name + '|' + i.qty + '|' + i.total + '|' + (i.everyone ? 1 : 0)), s.people, s.claims, s.shares, s.charges, s.chargeMode, s.upi ?? '', s.hostName ?? '', s.printedTotal]);
    const host = useHost(() => sRef.current, (p) => { if (meta.ready) setNow(p as Partial<State>); }, version, meta.ready, { get: () => sRef.current.hostSess, set: (v) => { if (meta.ready) setNow({ hostSess: v }); } });
    const [code, setCode] = useState('');
    const top = useRef<HTMLDivElement>(null);
    const [sure, setSure] = useState(false);
    useEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [s.step]);
    const canNext = s.step === 0 ? s.items.length > 0 : s.step === 1 ? s.people.length > 0 : true;
    const label = s.step === 0 ? 'Next: people' : 'Next: pass the phone';
    return <FileCard>
        <div className="sb-app" ref={top}>
            <header className="sb-top">
                <div className="sb-title"><div className="ch-mark"><span className="ch-stars">* * *</span><h1>CHIT</h1><span className="ch-tag">THE BILL, SPLIT FAIR &amp; SQUARE</span></div>{s.items.length > 0 && <button className="sb-link" type="button" onClick={() => { if (sure) { setSure(false); void (async () => { if (host.sess && !host.sess.closed) await host.close(); host.reset(); sRef.current = EMPTY; setSaved(EMPTY); })(); } else { setSure(true); setTimeout(() => setSure(false), 4000); } }}>{sure ? 'Tap again to clear' : 'New bill'}</button>}</div>
                <ol className="sb-steps" aria-label="Steps">
                    {STEPS.map((t0, i) => { const t = mode === 'live' && i === 1 ? 'Table' : t0; return <li key={t}><button type="button" aria-current={s.step === i ? 'step' : undefined} disabled={(i > 0 && !s.items.length) || (i > 1 && !s.people.length)} onClick={() => set({ step: i as State['step'] })}><span>{i + 1}</span>{t}</button></li>; })}
                </ol>
            </header>
            <div className="ch-perf" aria-hidden>- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>
            {!meta.ready ? <p className="sb-muted">Loading…</p> : mode === 'pick' ? <section className="lv-card"><h2>New bill. Table for how many phones?</h2><button className="ch-door" type="button" onClick={() => setNow({ mode: 'one' })}><b>One phone</b><span>pass it around the table, everyone taps their dishes</span></button><p className="ch-or">or</p><button className="ch-door" type="button" onClick={() => setNow({ mode: 'live' })}><b>Everyone’s phones</b><span>scan to join, pick your own, host sees who owns what</span></button><p className="sb-muted sb-small">Have a join link someone sent you? Paste it:</p><input className="lv-in" aria-label="Join link" placeholder="Paste join link" value={code} onChange={(e) => { setCode(e.target.value); const l = parseLink(e.target.value); if (l) onJoin(l); }} /></section> : <>
                {s.step === 0 && <BillStep s={s} set={set} />}
                {s.step === 1 && mode !== 'live' && <PeopleStep s={s} set={set} />}
                {s.step === 1 && mode === 'live' && <HostPanel s={s} host={host} setPay={(p) => set(p)} goClaim={() => set({ step: 2, gate: false, current: s.people[0]?.id ?? '' })} removePerson={(id) => set({ people: s.people.filter((p) => p.id !== id), claims: Object.fromEntries(Object.entries(s.claims).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([q]) => q !== id))])), shares: Object.fromEntries(Object.entries(s.shares).map(([k, v]) => [k, v.filter((q) => q !== id)])) })} />}
                {s.step === 2 && <ClaimStep s={s} set={set} />}
                {s.step === 3 && <SplitStep s={s} set={set} />}
                {s.step < 2 && !(mode === 'live' && s.step === 1) && <div className="sb-bar sb-bar-solo"><button className="sb-btn sb-block" type="button" disabled={!canNext} onClick={() => set({ step: (s.step + 1) as State['step'] })}>{label}</button></div>}
            </>}
            {meta.message && <p className="sb-muted sb-small">{meta.message}</p>}
        </div>
    </FileCard>;
                            }
