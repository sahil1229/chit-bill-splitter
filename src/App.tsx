import { scanPhoto } from './ocr';
import { SettlementJournal } from './settlement-journal';
import type { Settlement, SettlementDraft } from './settlement';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileCard, useLocalState } from './shim-files';
import { buildPdf, isFinal, pdfUnsupported, whatsappText, type ReportInput } from './report';
import './style.css';
import { parseLink, validUpi } from './live';
import { PayPage } from './Pay';
import { parsePayLink, payLink, type PayRequest } from './upi';
import { recoverHostIdentity, DinerApp, HostPanel, envLink, useHost } from './LiveUI';
import { Charge, ChargeMode, Claims, Shares, Item, Person, computeSplit, countedByDefault, fmt, parseBill, toMinor, uid } from './engine';

/** Accepts a function of the latest state: picks from diners can land between a render and a tap. */
type SetState = (p: Partial<State> | ((cur: State) => Partial<State>)) => void;

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
    externalCollector?: string;
    collectorMode?: 'diner' | 'external';
    tableId?: string;
    settlement?: Settlement;
    upi: string;
    received: Record<string, string | number | boolean>;
    current: string;
    touched: Record<string, boolean>;
    gate: boolean;
    mode?: 'pick' | 'one' | 'live';
    hostSess?: unknown;
    hostName?: string;
    approved?: string[];
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
function BillStep({ s, set }: { s: State; set: SetState }) {
    const [paste, setPaste] = useState('');
    const [photo, setPhoto] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const [photoDerived,setPhotoDerived]=useState(false);
    const [photoFile,setPhotoFile]=useState<File|null>(null);
    const [scanning,setScanning]=useState(false);
    const scanRef=useRef<AbortController|null>(null);
    const scanId=useRef(0);
    useEffect(()=>()=>{scanId.current++;scanRef.current?.abort();},[]);
    const scan=async()=>{if(!photoFile||scanning)return;if(paste.trim()&&!window.confirm('Replace the bill text with this photo scan? Your current text will be lost. Existing items stay unchanged until you explicitly read the new text.'))return;const id=++scanId.current;const controller=new AbortController();scanRef.current=controller;setScanning(true);try{const text=await scanPhoto(photoFile,controller.signal,m=>{if(id===scanId.current)setNote(m);});if(id===scanId.current){setPaste(text);setPhotoDerived(true);setNote('Photo read. Check the text above against your bill, then tap Read items. Nothing has been assigned yet.');}}catch(e){if(id===scanId.current)setNote(e instanceof Error?e.message:'Could not read the photo. Paste text instead.');}finally{if(id===scanId.current){setScanning(false);scanRef.current=null;}}};
    const fileRef = useRef<HTMLInputElement>(null);
    useEffect(() => () => { if (photo) URL.revokeObjectURL(photo); }, [photo]);

    const read = (text: string, fromPhoto=photoDerived) => {
        if(s.items.length && !window.confirm('Replace the current bill items and charges? All dish claims and shares will be cleared. People stay. Cancel to keep your current bill.'))return false;
        const r = parseBill(text);
        if (!r.items.length) { setNote(r.skipped.find(x=>x.startsWith('CHECK:'))??'Could not find any dishes with prices in that text. Add them by hand below.'); return false; }
        if(fromPhoto&&(r.skipped.some(x=>x.startsWith('CHECK:'))||r.printedTotal===null||r.items.some(i=>i.total<0)||r.items.reduce((a,i)=>a+i.total,0)+r.charges.reduce((a,c)=>a+c.amount,0)!==r.printedTotal)){setNote('Photo text is not reliable enough to import: there is a quantity warning, missing total, or the amounts do not reconcile. Your current bill was kept. Retake a clear photo or add the bill manually.');return false;}
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
            <p className="sb-muted sb-small">Or add a photo below and tap Read photo. English text only. Scanning runs in your browser; the photo is not uploaded. Reader downloads may take time. Always check the result.</p>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { scanId.current++;scanRef.current?.abort();setScanning(false);if(!/^image\/(jpeg|png|webp)$/i.test(f.type)||f.size>15*1024*1024){setPhotoFile(null);setPhoto(null);setNote('Choose JPEG, PNG or WebP under 15 MB. HEIC is not supported: use iPhone Live Text or export JPEG.');}else{setPhotoFile(f);setPhoto(URL.createObjectURL(f));setNote('');} }e.target.value=''; }} />
            <div className="sb-row-btns">
                <button className="sb-btn" type="button" onClick={() => fileRef.current?.click()}>{photo ? 'Change photo' : 'Photo of bill'}</button>
                <button className="sb-btn sb-ghost" type="button" disabled={scanning} onClick={() => { if(read(SAMPLE,false)!==false){setPaste(SAMPLE);setPhotoDerived(false);} }}>Try sample bill</button>
            </div>
            {photo && <div className="sb-photo"><img src={photo} alt="The bill you photographed" />
                <button className="sb-btn sb-block" type="button" disabled={scanning} onClick={scan}>{scanning?'Reading photo…':'Read photo on this device'}</button>{scanning&&<button type="button" className="sb-btn sb-ghost" onClick={()=>scanRef.current?.abort()}>Cancel scan</button>}<p className="sb-muted sb-small">Clear, upright JPEG/PNG/WebP under 15 MB. HEIC is not supported here: use iPhone Scan Text or export a JPEG. OCR can misread prices.</p></div>}
            {photoDerived && <div className="sb-warn"><p>This text came from a photo. Editing it keeps the photo checks on. To type a fresh bill by hand, switch explicitly below.</p><button type="button" className="sb-btn sb-ghost" disabled={scanning} onClick={()=>{if(window.confirm('Switch to manual bill text? This clears the scanned text, not the current items. You will check every typed amount yourself.')){setPaste('');setPhotoDerived(false);setNote('Manual entry: type the bill text or add items below. Check quantities, prices and printed total yourself.');}}}>Start fresh manual bill text</button></div>}
            <label className="sb-label" htmlFor="paste">Bill text</label>
            <textarea id="paste" disabled={scanning} className="sb-input sb-area" rows={5} placeholder={'2 Butter Chicken 960.00\nService Charge 283.00'} value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button className="sb-btn sb-block" type="button" disabled={scanning||!paste.trim()} onClick={() => read(paste)}>Read items from text</button>
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
function PeopleStep({ s, set }: { s: State; set: SetState }) {
    const [name, setName] = useState('');
    const [count, setCount] = useState(Math.max(s.people.length, 2));
    useEffect(() => { if (s.people.length > count) setCount(s.people.length); }, [s.people.length]);
    const add = () => {
        const n = name.trim();
        if (!n) return;
        const p = { id: uid('p'), name: n };
        set({ people: [...s.people, p], collectorId: s.externalCollector !== undefined ? '' : s.collectorId || p.id, current: s.current || p.id });
        setName('');
    };
    const remove = (id: string) => {
        const people = s.people.filter((p) => p.id !== id);
        const claims: Claims = {};
        for (const k of Object.keys(s.claims)) { const { [id]: _drop, ...rest } = s.claims[k]; claims[k] = rest; }
        const shares: Shares = {}; for (const k of Object.keys(s.shares)) shares[k] = s.shares[k].filter((x) => x !== id);
        set({ people, claims, shares, collectorId: s.externalCollector !== undefined ? '' : s.collectorId === id ? people[0]?.id ?? '' : s.collectorId, current: s.current === id ? people[0]?.id ?? '' : s.current });
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
                {s.people.map((p) => <button key={p.id} type="button" role="radio" aria-checked={s.collectorId === p.id} className="sb-pill" onClick={() => set(s.collectorId === p.id ? {} : { collectorId: p.id, externalCollector: undefined, upi: '', received: {} })}>{p.name}{s.people.filter((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()).length > 1 ? ` (#${s.people.filter((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()).findIndex((q) => q.id === p.id) + 1})` : ''}</button>)}
            </div>
            <button type="button" className="sb-pill" aria-pressed={s.externalCollector !== undefined} onClick={() => set({ collectorId: '', externalCollector: '', upi: '', received: {} })}>Someone not dining</button>
            {s.externalCollector !== undefined && <><label className="sb-label" htmlFor="external-collector">Collector name (not counted as a diner)</label><input id="external-collector" className="sb-input" value={s.externalCollector} onChange={(e) => set({ externalCollector: e.target.value })} /></>}
            {s.externalCollector && s.people.some(p => p.name.trim().toLowerCase() === s.externalCollector!.trim().toLowerCase()) && <p className="sb-warn">The outside collector and a diner have the same name. They are separate people in this split, so that diner still owes their share. Use a clearer collector name, or select the diner instead.</p>}
            <label className="sb-label" htmlFor="upi">UPI ID of the collector (optional)</label>
            <input id="upi" className="sb-input" inputMode="email" autoCapitalize="none" autoCorrect="off" placeholder="name@bank" value={s.upi} onChange={(e) => set({ upi: e.target.value })} />
            {s.upi.trim() && !validUpi(s.upi) && <p className="sb-warn">That does not look like a UPI ID (name@bank). No pay buttons will show until it does.</p>}
            <p className="sb-small sb-muted">Only used to make Pay buttons. Stays on this device. Nothing is paid from here. The buttons try to open your UPI app with the amount filled in. That may not work on every phone or app, so check the ID and amount there, or use Copy. Opening an app does not mean it was paid.</p>
        </section>}
    </>;
}

/* ---------- Step 3: claim ---------- */
function ClaimStep({ s, set }: { s: State; set: SetState }) {
    const person = s.people.find((p) => p.id === s.current) ?? s.people[0];
    const res = useMemo(() => computeSplit(s), [s]);
    const [shareOpen, setShareOpen] = useState<string | null>(null); const [convert, setConvert] = useState<string | null>(null);
    const [pref, setPref] = useState<Record<string, 'share' | 'count'>>({});
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
    const setClaim = (itemId: string, n: number) => set((cur) => {
        // Clamp against the latest claims: a diner may have taken units since this screen rendered.
        const it = cur.items.find((i) => i.id === itemId); const others = Object.entries(cur.claims[itemId] ?? {}).reduce((a, [k, v]) => a + (k === person.id ? 0 : v), 0);
        const v = Math.max(0, Math.min(n, (it?.qty ?? 0) - others));
        return { claims: { ...cur.claims, [itemId]: { ...(cur.claims[itemId] ?? {}), [person.id]: v } }, touched: { ...cur.touched, [person.id]: true } };
    });
    const finish = () => s.mode==='live' ? set({step:1,touched:{...s.touched,[person.id]:true}}) : next ? set({ current: next.id, gate: true, touched: { ...s.touched, [person.id]: true } }) : set({ step: 3, touched: { ...s.touched, [person.id]: true } });
    return <div style={{ ['--who' as string]: color }} className="sb-claimscreen">
        {s.mode === 'live' && s.people.length > 1 && <div className="sb-people" role="group" aria-label="Whose picks to fix">{s.people.map((p) => <button key={p.id} type="button" aria-current={p.id === person.id} onClick={() => set({ current: p.id })}><Avatar p={p} people={s.people} />{p.name}</button>)}</div>}
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
                // Several plates: naans and drinks are counted (2, 1 and 3 of 6); gravies are shared by whoever had some.
                const units = it.qty > 1 && !isShared && !it.everyone && (claimers.length > 0 || (pref[it.id] ?? (countedByDefault(it.name) ? 'count' : 'share')) === 'count');
                const canSwitch = it.qty > 1 && !it.everyone && claimers.every((p) => p.id === person.id) && sharedBy.every((p) => p.id === person.id);
                const switchTo = (m: 'share' | 'count') => { setPref({ ...pref, [it.id]: m }); set((cur) => { const claims = { ...cur.claims }; delete claims[it.id]; return { claims, shares: { ...cur.shares, [it.id]: [] } }; }); };
                const mineOn = isShared ? mineShared : n > 0;
                const toggleShare = (pid: string) => set((cur) => {
                    const base = cur.shares[it.id] ?? [];
                    const nextList = base.includes(pid) ? base.filter((x) => x !== pid) : [...base, pid];
                    const claims = { ...cur.claims }; delete claims[it.id];
                    return { shares: { ...cur.shares, [it.id]: nextList }, claims, touched: { ...cur.touched, [person.id]: true } };
                });
                const legacy = !isShared && claimers.length > 0;
                const tap = () => { if (it.everyone) return; if (units) { setClaim(it.id, n > 0 ? 0 : Math.min(1, room)); return; } if (legacy) { setConvert(it.id); return; } toggleShare(person.id); };
                const blocked = false;
                const eaters = isShared ? sharedBy.length : claimers.length;
                return <React.Fragment key={it.id}>
                <li className={`sb-tile${mineOn ? ' is-mine' : ''}${it.everyone ? ' is-all' : ''}${blocked ? ' is-full' : ''}`}>
                    <button type="button" className="sb-tile-main" onClick={tap} disabled={it.everyone} aria-label={`${it.name}, ${fmt(it.total)}. ${it.everyone ? 'Split by everyone.' : mineOn ? 'You had this. Tap to undo.' : 'Tap if you had this.'}`}>
                        <span className="ch-box" aria-hidden>{it.everyone ? "◆" : mineOn ? "☑" : "☐"}</span>
                        <span className="sb-tile-name">{it.name || 'Item'}{it.qty > 1 ? ` · ${it.qty} ordered` : ''}</span><span className="ch-lead" aria-hidden />
                        <span className="sb-tile-price">{fmt(it.total)}</span>
                        {it.everyone ? <span className="sb-tag">Everyone</span> : <span className="sb-tile-claim">
                            {(isShared ? sharedBy : claimers).map((p) => <i key={p.id} style={{ background: hue(p.id, s.people) }} title={p.name}>{p.name.slice(0, 1).toUpperCase()}</i>)}
                            <em>{units ? (taken ? `${claimers.map((p) => `${p.name} ${s.claims[it.id][p.id]}`).join(', ')} · ${left} of ${it.qty} left` : `${it.qty} × ${fmt(each)}, nobody yet`) : legacy ? `by units: ${claimers.map((p) => `${p.name} ${s.claims[it.id][p.id]}`).join(', ')}` : eaters === 0 ? 'nobody yet' : eaters === 1 ? 'one eater' : `${eaters} eating · ${fmt(Math.round(it.total / eaters))} each`}</em>
                        </span>}
                    </button>
                    {units && <div className="sb-units"><span className="sb-small">{person.name} had</span><Stepper label={`${it.name} ${person.name} had`} value={n} min={0} max={room} onChange={(v) => setClaim(it.id, v)} /><span className="sb-small">of {it.qty}{n > 0 ? ` · ${fmt(Math.round(it.total * n / it.qty))}` : ''}</span>{canSwitch && <button type="button" className="sb-link" onClick={() => switchTo('share')}>We shared these instead</button>}</div>}
                    {!units && canSwitch && !it.everyone && <div className="sb-units"><button type="button" className="sb-link" onClick={() => switchTo('count')}>Count how many {person.name} had instead</button></div>}
                    {!it.everyone && <button type="button" className="sb-sharebtn" aria-expanded={shareOpen === it.id} onClick={() => legacy ? setConvert(it.id) : setShareOpen(shareOpen === it.id ? null : it.id)}>Who ate this</button>}
                </li>
                {convert === it.id && legacy && <li className="sb-sharepanel">
                    <strong>{it.name} was picked by units</strong>
                    <span className="sb-small">{claimers.map((p) => `${p.name} ${s.claims[it.id][p.id]} of ${it.qty} (about ${fmt(Math.round(it.total * s.claims[it.id][p.id] / it.qty))})`).join(', ')}. Switching splits the whole ₹{(it.total / 100).toFixed(2)} equally between {claimers.map((p) => p.name).join(', ')}, which changes what each person owes. Nothing changes unless you confirm.</span>
                    <div className="sb-row-btns">
                        <button type="button" className="sb-btn sb-ghost" onClick={() => setConvert(null)}>Keep units</button>
                        <button type="button" className="sb-btn" onClick={() => { set((cur) => { const ids = Object.entries(cur.claims[it.id] ?? {}).filter(([, v]) => v > 0).map(([k]) => k); const claims = { ...cur.claims }; delete claims[it.id]; return { shares: { ...cur.shares, [it.id]: ids }, claims, touched: { ...cur.touched, [person.id]: true } }; }); setConvert(null); }}>Switch to equal split</button>
                    </div>
                </li>}
                {shareOpen === it.id && <li className="sb-sharepanel">
                    <strong>Who ate {it.name}?</strong>
                    <span className="sb-small">The whole price is split equally between the people you pick, however many were ordered.</span>
                    <div className="sb-pills" role="group" aria-label="People sharing">
                        {s.people.map((p) => <button key={p.id} type="button" aria-pressed={sharedBy.some((x) => x.id === p.id)} className="sb-pill" style={{ ['--c' as string]: hue(p.id, s.people) }} onClick={() => toggleShare(p.id)}>{p.name}</button>)}
                    </div>
                    <div className="sb-row-btns">
                        {isShared && <button type="button" className="sb-btn sb-ghost" onClick={() => { set((cur) => ({ shares: { ...cur.shares, [it.id]: [] } })); }}>Not shared</button>}
                        <button type="button" className="sb-btn" onClick={() => setShareOpen(null)}>Done</button>
                    </div>
                </li>}
                </React.Fragment>;
            })}
        </ul>
        <div className="sb-bar sb-ticker">
            <div><span className="sb-small">{person.name}, so far</span><strong>{fmt(mine.items)}</strong></div>
            <button className="sb-btn" type="button" onClick={finish}>{s.mode==='live' ? 'Done, invite friends' : next ? `Done, pass on` : 'Done, see split'}</button>
        </div>
    </div>;
}

/* ---------- Step 4: split ---------- */
function SplitStep({ s, set, finalize, goPick }: { s: State; set: SetState; finalize: () => Promise<void>; goPick: () => void }) {
    const res = useMemo(() => computeSplit(s), [s]);
    const [open, setOpen] = useState<string | null>(null);
    const [msg, setMsg] = useState('');
    const collector = s.externalCollector !== undefined ? { id: '', name: s.externalCollector } : s.people.find((p) => p.id === s.collectorId);
    const unclaimedList = s.items.filter((i) => !i.everyone && (res.unclaimedUnits[i.id] ?? 0) > 0);
    const payers = res.people.filter((p) => p.id !== s.collectorId && p.total > 0);
    const owed = payers.reduce((a, b) => a + b.total, 0);
    const rk = (n: number) => `${s.settlement?.id ?? 'draft'}|${n}|${s.collectorId}|${s.externalCollector ?? ''}|${s.upi.trim().toLowerCase()}`;
    useEffect(() => { const bad = Object.keys(s.received).filter((id) => s.received[id] && (id === s.collectorId || s.received[id] !== rk(res.people.find((p) => p.id === id)?.total ?? -1))); if (bad.length) set({ received: Object.fromEntries(Object.entries(s.received).filter(([id]) => !bad.includes(id))) }); }, [s.received, s.collectorId, s.upi, res]);
    const back = payers.filter((p) => s.received[p.id] === rk(p.total)).reduce((a, b) => a + b.total, 0);
    const pct = owed ? Math.round((back / owed) * 100) : 0;
    const live = s.mode === 'live';
    const frozenReq = (id: string): PayRequest | null => { const st = s.settlement; const sh = st?.shares.find((x) => x.personId === id); return st && sh && sh.owesCollector && sh.amount > 0 ? { pa: st.collector.upi, pn: st.collector.name, am: sh.amount, tn: 'CHIT ' + st.id.slice(0, 8) } : null; };
    const share = async (text: string, okMsg: string) => {
        try {
            if (navigator.share) { await navigator.share({ text }); setMsg(okMsg); }
            else { await navigator.clipboard.writeText(text); setMsg('Copied. Paste it into your group chat.'); }
        } catch { setMsg('Sharing was cancelled. Nothing was sent.'); }
    };
        const rep: ReportInput = { externalCollector: s.externalCollector, printedTotal: s.printedTotal, res, items: s.items, charges: s.charges, people: s.people, collectorId: s.collectorId, upi: s.upi, received: Object.fromEntries(payers.filter((p) => s.received[p.id] === rk(p.total)).map((p) => [p.id, true])), payLinks: Object.fromEntries(payers.flatMap((p) => { const r = frozenReq(p.id); return r ? [[p.id, payLink(r)]] : []; })), chargeMode: s.chargeMode, spread: s.spread, date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) };
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
    const [review, setReview] = useState(false); const [freezing, setFreezing] = useState(false);
    const sendOne = (p: { id: string; name: string }) => { const r = frozenReq(p.id); if (r) void share(`Hi ${p.name}, your share of dinner is ${fmt(r.am)}. Tap to pay ${r.pn}: ${payLink(r)}`, `${p.name}'s payment link is ready to send. Pick them in the share sheet.`); };
    const allIn = payers.length > 0 && back === owed;
    return <>
        {/* One next step, always at the top. */}
        {!s.settlement ? (!fin.ok ? <section className="sb-card ch-next" data-next="notready">
                <h2>Not ready to freeze yet</h2>
                <p>{fin.why}</p>
                <div className="ch-apps">{res.unassigned !== 0 && <button type="button" className="sb-btn sb-small-btn" onClick={() => set({ spread: true })}>Split the rest equally</button>}<button type="button" className="sb-btn sb-ghost sb-small-btn" onClick={goPick}>{live ? 'Back to the table' : 'Go back and pick'}</button></div>
            </section> : !validUpi(s.upi) ? <section className="sb-card ch-next" data-next="upi">
                <h2>Add the UPI ID to collect on</h2>
                <p>Everyone pays {collector?.name || 'the collector'}. Add their UPI ID first.</p>
                <button type="button" className="sb-btn sb-block" onClick={() => set({ step: 1 })}>Add UPI ID</button>
            </section> : <section className="sb-card ch-next" data-next="freeze">
                <h2>Check the amounts, then freeze</h2>
                <p>Freezing locks every amount below and {live ? 'puts a Pay button on each person’s phone' : 'gives you a payment link for each person'}. Payments go to <b>{collector?.name}</b> · {s.upi.trim()}.</p>
                {!review ? <button type="button" className="sb-btn sb-block" onClick={() => setReview(true)}>Freeze &amp; send payment links</button> : <>
                    <p className="sb-warn">Amounts cannot be changed after this. To fix a mistake later you would start a new bill.</p>
                    <div className="ch-apps"><button type="button" className="sb-btn sb-small-btn" disabled={freezing} onClick={() => { setFreezing(true); void finalize().catch((e) => setMsg(String(e.message ?? e))).finally(() => setFreezing(false)); }}>{freezing ? 'Freezing…' : 'Yes, freeze'}</button><button type="button" className="sb-btn sb-ghost sb-small-btn" onClick={() => setReview(false)}>Not yet</button></div>
                </>}
            </section>)
        : allIn ? <section className="sb-card ch-next" data-next="done"><h2>All paid ✓</h2><p>{collector?.name} has ticked off everyone. Tap New bill at the top for the next one.</p></section>
        : live ? <section className="sb-card ch-next" data-next="collect"><h2>Payment links sent</h2><p>Everyone now sees their amount and a Pay button on their own phone. Tick each person below when the money reaches {collector?.name}.</p></section>
        : <section className="sb-card ch-next" data-next="send"><h2>Send everyone their payment link</h2><p>One message for your group with each person’s amount and a link that opens their UPI app. Then tick people off below as the money arrives.</p>
            <button type="button" className="sb-btn sb-block" onClick={() => share(waText, 'Message ready. Pick your group chat to send it.')}>Send payment links to the group</button>
            <button type="button" className="sb-link" onClick={copyWa}>Copy the message instead</button></section>}
        <section className="sb-receipt">
            <div className="sb-receipt-top"><span>BILL TOTAL</span><span>{res.people.length} PEOPLE</span></div>
            <strong className="sb-big">{fmt(res.billTotal)}</strong>
            {res.unassigned !== 0 ? <p className="sb-warn">Not fully assigned yet: {fmt(res.unassigned)} of {fmt(res.billTotal)} is unclaimed. Shares below cover only {fmt(res.billTotal - res.unassigned)}.</p> : res.reconciles ? <p className="sb-ok">✓ Every rupee is assigned and shares add up to the bill</p> : <p className="sb-warn">Shares add up to {fmt(res.sumOfParts)}; the bill is {fmt(res.billTotal)}. Check the bill step.</p>}
            {s.printedTotal !== null && s.printedTotal !== res.billTotal && <p className="sb-warn">Printed total was {fmt(s.printedTotal)}; items and charges here come to {fmt(res.billTotal)}.</p>}
        </section>
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
                        <span className="sb-pn"><strong>{p.name}</strong><span className="sb-muted sb-small">{isCollector ? 'Collecting the money' : p.total <= 0 ? 'Nothing to pay' : done ? 'Marked as received' : stale ? `Amount or payee changed after you ticked it. Owes ${collector?.name ?? ''}` : `Owes ${collector?.name ?? ''}`}</span></span>
                        <strong className="sb-amt">{fmt(p.total)}</strong>
                    </button>
                    {done && !isCollector && p.total > 0 && <span className="ch-stamp" aria-label="Marked collected by hand">COLLECTED</span>}
                    {!done && !isCollector && p.total > 0 && <span className="ch-note ch-owes">owes, no stamp yet</span>}
                    {open === p.id && <div className="sb-break">
                        {p.lines.map((l, i) => <div key={i} className="sb-bl"><span>{l.name} <em>{l.note}</em></span><span>{fmt(l.amount)}</span></div>)}
                        {res.chargeLines.map((c) => <div key={c.id} className="sb-bl sb-muted"><span>{c.name}</span><span>{fmt(c.perPerson[res.people.indexOf(p)] ?? 0)}</span></div>)}
                        <div className="sb-bl sb-sum"><span>Total</span><span>{fmt(p.total)}</span></div>
                    </div>}
                    {!isCollector && <div className="sb-pay">
                        {s.settlement && !done && frozenReq(p.id) && <button type="button" className="sb-link" onClick={() => sendOne(p)}>{live ? `Resend ${p.name}'s payment link` : `Send ${p.name} their payment link`}</button>}
                        {p.total > 0 && <button type="button" role="switch" disabled={!s.settlement} aria-checked={done} className={`sb-got${done ? ' on' : ''}`} onClick={() => set({ received: { ...s.received, [p.id]: done ? 0 : rk(p.total) } })}>{done ? '✓ Received' : 'Mark received'}</button>}
                    </div>}
                </li>;
            })}
        </ul>
        {msg && <p className="sb-note" role="status">{msg}</p>}
        <section className="sb-card sb-export" aria-label="Share with the group">
            <h2>Summary for the group</h2>
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
        <p className="sb-small sb-muted">Payment links open the payer’s own UPI app with the amount filled in. This page never moves money and cannot see payments.</p>
    </>;
}

export function App() {
    const diner = useMemo(() => envLink(), []);
    const [pasted, setPasted] = useState<ReturnType<typeof envLink>>(null);
    const pay = useMemo(() => parsePayLink(location.hash), []);
    if (pay) return <FileCard><div className="sb-app"><header className="sb-top"><div className="sb-title"><div className="ch-mark"><span className="ch-stars">* * *</span><h1>CHIT</h1><span className="ch-tag">THE BILL, SPLIT FAIR &amp; SQUARE</span></div></div></header><PayPage req={pay} /></div></FileCard>;
    if (diner || pasted) return <FileCard><div className="sb-app"><header className="sb-top"><div className="sb-title"><div className="ch-mark"><span className="ch-stars">* * *</span><h1>CHIT</h1><span className="ch-tag">THE BILL, SPLIT FAIR &amp; SQUARE</span></div></div></header><DinerApp link={(diner || pasted)!} /></div></FileCard>;
    return <Host onJoin={setPasted} />;
}
function Host({ onJoin }: { onJoin: (l: NonNullable<ReturnType<typeof envLink>>) => void }) {
    const [saved, setSaved, meta] = useLocalState<State>('split.v1', EMPTY);
    const s: State = { ...EMPTY, ...saved };
    const sRef = useRef(s); sRef.current = s;
    const journal = useRef<SettlementJournal | null>(null);
    const finalizing = useRef(false);
    const [journalReady, setJournalReady] = useState(false);
    const [journalError, setJournalError] = useState('');
    const [editNotice, setEditNotice] = useState('');
    useEffect(() => { if (!meta.ready) return;if(meta.loadError){setJournalError(meta.loadError);return;} let stop = false;
        const init = async () => { const tableId = sRef.current.tableId || crypto.randomUUID();
            try { journal.current = new SettlementJournal(tableId, localStorage);
                const settled = await journal.current.recover(); if (stop) return;
                if (settled) { const d = journal.current.draft!; if (d.liveLink) { if (settled.hostBinding?.hostPub !== d.liveLink.hostPub || settled.hostBinding?.topic !== d.liveLink.topic) throw Error('Finalized table host binding mismatch.'); sRef.current = { ...sRef.current, mode: 'live', hostSess: await recoverHostIdentity(tableId, { ...(sRef.current.hostSess as any), link: d.liveLink }) }; } const next = { ...sRef.current, ...d, tableId, settlement: settled, collectorId: settled.collector.dinerId ?? '', externalCollector: settled.collector.kind === 'external' ? settled.collector.name : undefined, upi: settled.collector.upi, hostName: settled.collector.name }; sRef.current = next; setSaved(next); }
                else if (sRef.current.settlement) { throw Error('A finalized table is missing its durable record. Editing and payment are blocked.'); }
                else { const next = { ...sRef.current, tableId }; sRef.current = next; setSaved(next); }
                setJournalReady(true);
            } catch(e) { if (!stop) setJournalError('Saved table storage could not be read. Enable browser storage and reload. No finalization or payment is available. ' + String((e as Error).message)); }
        }; void init(); return () => { stop = true; }; }, [meta.ready]);
    useEffect(() => { const onStorage = (e: StorageEvent) => { if (sRef.current.tableId && e.key === 'chit.final.' + sRef.current.tableId) { finalizing.current = true; setJournalError('This table was finalized in another tab. Reload to load its immutable details.'); } }; window.addEventListener('storage', onStorage); return () => window.removeEventListener('storage', onStorage); }, []);
    const SETTLE = ['items', 'charges', 'people', 'claims', 'shares', 'chargeMode', 'spread', 'collectorId', 'upi', 'printedTotal', 'hostName', 'externalCollector', 'collectorMode'] as const;
    const hasDurableFinal=(tableId?:string)=>{try{return !!tableId&&!!localStorage.getItem('chit.final.'+tableId);}catch{setJournalError('Saved table storage is unavailable. Reload after enabling browser storage; do not pay from this screen.');return true;}};
    const setNow = (p: Partial<State>) => { const cur: any = sRef.current; const changed = SETTLE.some((k) => k in p && JSON.stringify((p as any)[k]) !== JSON.stringify(cur[k])); if (changed && (finalizing.current || cur.settlement || journal.current?.locked || hasDurableFinal(cur.tableId))) { setEditNotice('This table is frozen. Start a new bill for corrections.'); return; } const collectorPatch = p.externalCollector !== undefined ? { collectorId: '' } : {}; const next = { ...sRef.current, ...(changed && !('received' in p) ? { received: {} } : {}), ...p, ...collectorPatch }; sRef.current = next; setSaved(next); };
    const set: SetState = (arg) => { const p = typeof arg === 'function' ? arg(sRef.current) : arg; if (meta.ready) setNow({ ...(p.step === 2 && p.gate === undefined ? { gate: true, current: s.people[0]?.id ?? s.current } : {}), ...p }); };
    const mode = s.mode ?? (s.items.length ? 'one' : 'pick');
    const version = JSON.stringify([s.items.map((i) => i.id + '|' + i.name + '|' + i.qty + '|' + i.total + '|' + (i.everyone ? 1 : 0)), s.people, s.claims, s.shares, s.charges, s.chargeMode, s.upi ?? '', s.hostName ?? '', s.printedTotal, s.externalCollector, s.settlement?.id, s.approved ?? []]);
    const host = useHost(() => ({ ...sRef.current, frozen: finalizing.current }), (p) => { if (meta.ready) setNow(p as Partial<State>); }, version, meta.ready && journalReady, { get: () => sRef.current.hostSess, set: (v) => { if (meta.ready) setNow({ hostSess: v }); } });
    const [code, setCode] = useState('');
    const top = useRef<HTMLDivElement>(null);
    const [sure, setSure] = useState(false);
    useEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [s.step]);
    const finalize = async () => {
        if(meta.message)throw Error('Your changes are not saved. Finalization and payment are blocked until storage works.');
        if (!journalReady || !journal.current) throw Error('Settlement storage is not ready.');
        if (finalizing.current) throw Error('Finalization is already running.');
        finalizing.current = true;
        const cur = sRef.current; const journalForOperation = journal.current; const tableForOperation = cur.tableId;
        try { if (cur.mode === 'live') await host.saveIdentity(cur.tableId!); } catch(e) { finalizing.current = false; throw e; }
        const draft: SettlementDraft = { tableId: cur.tableId!, ...(cur.mode === 'live' ? { liveLink: (sRef.current.hostSess as any)?.link } : {}), items: cur.items, charges: cur.charges, people: cur.people, claims: cur.claims, shares: cur.shares, chargeMode: cur.chargeMode, spread: cur.spread, printedTotal: cur.printedTotal, collector: cur.externalCollector !== undefined ? { kind: 'external', name: cur.externalCollector, upi: cur.upi } : { kind: 'diner', dinerId: cur.collectorId, upi: cur.upi } };
        try { const settlement = await journalForOperation.finalize(draft); if (journal.current !== journalForOperation || sRef.current.tableId !== tableForOperation) throw Error('Table changed during finalization. Saved instructions were not applied to another table.'); const next = { ...sRef.current, settlement }; sRef.current = next; setSaved(next); }
        catch(e) { if (!journal.current.locked) finalizing.current = false; if (journal.current.locked) setJournalError('Finalization could not be confirmed. This table is blocked. Reload to reconcile saved details; do not pay from this screen.'); throw e; }
    };
    const startNew = () => {
        if (finalizing.current && !s.settlement) { setJournalError('Finalization is unresolved. Reload to reconcile before starting another table.'); setSure(false); return; }
        setSure(false);
        // A frozen table stays live on diners' phones so they can still pay. An open one is told it closed,
        // in the background: the new bill never waits on the relay.
        if (host.sess && !host.sess.closed && !s.settlement) void host.close(true).catch(() => {});
        host.reset();
        const next = { ...EMPTY, tableId: crypto.randomUUID() };
        journal.current = new SettlementJournal(next.tableId, localStorage);
        sRef.current = next; setSaved(next); setJournalError(''); finalizing.current = false;
        void journal.current.recover().then(() => setJournalReady(true), (e) => setJournalError('Saved table storage could not be read. ' + String((e as Error).message)));
    };
    const canNext = s.step === 0 ? s.items.length > 0 : s.step === 1 ? s.people.length > 0 : true;
    const label = s.step === 0 ? 'Next: people' : 'Next: pass the phone';
    return <FileCard>
        <div className="sb-app" ref={top}>
            <header className="sb-top">
                <div className="sb-title"><div className="ch-mark"><span className="ch-stars">* * *</span><h1>CHIT</h1><span className="ch-tag">THE BILL, SPLIT FAIR &amp; SQUARE</span></div>{s.items.length > 0 && !sure && <button className="sb-link" type="button" onClick={() => setSure(true)}>New bill</button>}</div>
                <ol className="sb-steps" aria-label="Steps">
                    {STEPS.map((t0, i) => { const t = mode === 'live' && i === 1 ? 'Table' : t0; return <li key={t}><button type="button" aria-current={s.step === i ? 'step' : undefined} disabled={(!!s.settlement && i !== 3 && !(mode === 'live' && i === 1)) || (i > 0 && !s.items.length) || (i > 1 && !s.people.length)} onClick={() => set({ step: i as State['step'] })}><span>{i + 1}</span>{t}</button></li>; })}
                </ol>
            </header>
            {sure && <section className="sb-card ch-next" data-next="newbill" role="dialog" aria-label="Start a new bill">
                <h2>Start a new bill?</h2>
                <p>{s.settlement ? 'Everyone keeps their payment link for this bill, so they can still pay you.' : mode === 'live' && host.sess && !host.sess.closed ? 'This clears the current bill and closes the table for everyone who joined.' : 'This clears the current bill.'}</p>
                <div className="ch-apps"><button type="button" className="sb-btn sb-small-btn" onClick={startNew}>Start new</button><button type="button" className="sb-btn sb-ghost sb-small-btn" onClick={() => setSure(false)}>Cancel</button></div>
            </section>}
            <div className="ch-perf" aria-hidden>- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>
            {editNotice && <p className="sb-warn" role="status">{editNotice}</p>}
            {journalError && <p className="sb-warn" role="alert">{journalError}</p>}
            {(!meta.ready || (!journalReady && !journalError)) ? <p className="sb-muted">Loading…</p> : journalError ? (meta.loadError ? null : <p className="sb-warn">This table is blocked. Reload to reconcile, or start a new bill. Old payment instructions cannot be revoked.</p>) : mode === 'pick' ? <section className="lv-card"><h2>New bill. Table for how many phones?</h2><button className="ch-door" type="button" onClick={() => setNow({ mode: 'one' })}><b>One phone</b><span>pass it around the table, everyone taps their dishes</span></button><p className="ch-or">or</p><button className="ch-door" type="button" onClick={() => setNow({ mode: 'live' })}><b>Everyone’s phones</b><span>scan to join, pick your own, host sees who owns what</span></button><p className="sb-muted sb-small">Have a join link someone sent you? Paste it:</p><input className="lv-in" aria-label="Join link" placeholder="Paste join link" value={code} onChange={(e) => { setCode(e.target.value); const l = parseLink(e.target.value); if (l) onJoin(l); }} /></section> : <>
                {s.step === 0 && <BillStep s={s} set={set} />}
                {s.step === 1 && mode !== 'live' && <PeopleStep s={s} set={set} />}
                {s.step === 1 && mode === 'live' && <HostPanel s={s} host={host} setPay={(p) => set(p)} goPay={() => set({ step: 3 })} goClaim={(personId) => set({ step: 2, gate: false, current: personId??s.people[0]?.id??'' })} removePerson={(id) => set((cur) => ({ people: cur.people.filter((p) => p.id !== id), claims: Object.fromEntries(Object.entries(cur.claims).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([q]) => q !== id))])), shares: Object.fromEntries(Object.entries(cur.shares).map(([k, v]) => [k, v.filter((q) => q !== id)])) }))} />}
                {s.step === 2 && <ClaimStep s={s} set={set} />}
                {s.step === 3 && !meta.message && <SplitStep s={s} set={set} finalize={finalize} goPick={() => set(mode === 'live' ? { step: 1 } : { step: 2, current: s.people[0]?.id ?? '', gate: true })} />}
                {s.step < 2 && !(mode === 'live' && s.step === 1) && <div className="sb-bar sb-bar-solo"><button className="sb-btn sb-block" type="button" disabled={!canNext} onClick={() => set({ step: (s.step + 1) as State['step'] })}>{label}</button></div>}
            </>}
            {meta.message && <p className="sb-warn" role="alert">{meta.message}</p>}
        </div>
    </FileCard>;
                    }
