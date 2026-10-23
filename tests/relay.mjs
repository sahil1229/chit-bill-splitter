// Minimal ntfy-compatible relay for tests: publish, cached replay (since=all|id), streaming and poll.
// Like ntfy.sh, bodies over 4096 bytes become attachments, so their text never reaches subscribers.
import http from 'node:http';
const port = Number(process.env.RELAY_PORT || 4174);
const topics = new Map(); let seq = 0;
const list = (t) => topics.get(t) ?? (topics.set(t, { msgs: [], subs: new Set() }), topics.get(t));
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (url.pathname === '/health') { res.writeHead(200, cors); return res.end('ok'); }
  const topic = parts[0]; if (!topic) { res.writeHead(404, cors); return res.end(); }
  const t = list(topic);
  if (req.method === 'POST' || req.method === 'PUT') {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const id = 'm' + (++seq).toString().padStart(8, '0');
      const ev = Buffer.byteLength(body) > 4096
        ? { id, time: Math.floor(Date.now() / 1000), event: 'message', topic, message: 'You received a file: attachment.txt', attachment: { name: 'attachment.txt', size: body.length } }
        : { id, time: Math.floor(Date.now() / 1000), event: 'message', topic, message: body };
      t.msgs.push(ev); for (const s of t.subs) s.write(JSON.stringify(ev) + '\n');
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(ev));
    });
    return;
  }
  if (req.method === 'GET' && parts[1] === 'json') {
    const since = url.searchParams.get('since'); let from = 0;
    if (since && since !== 'all') { const i = t.msgs.findIndex((m) => m.id === since); from = i >= 0 ? i + 1 : 0; }
    const backlog = since ? t.msgs.slice(from) : [];
    res.writeHead(200, { ...cors, 'Content-Type': 'application/x-ndjson' });
    for (const m of backlog) res.write(JSON.stringify(m) + '\n');
    if (url.searchParams.get('poll') === '1') return res.end();
    res.write(JSON.stringify({ id: 'open' + seq, event: 'open', topic }) + '\n');
    t.subs.add(res); const ka = setInterval(() => res.write(JSON.stringify({ event: 'keepalive' }) + '\n'), 15000);
    req.on('close', () => { clearInterval(ka); t.subs.delete(res); });
    return;
  }
  res.writeHead(404, cors); res.end();
}).listen(port, () => console.log('relay on ' + port));
