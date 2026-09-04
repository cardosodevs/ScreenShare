/* =============================================================
   Rise — servidor único: arquivos estáticos + dados em JSON + sinalização.
   Node puro, sem nenhuma dependência externa.

     node server.js            → http://localhost:4173
     PORT=8080 node server.js  → porta alternativa

   Responsabilidades:
     1. Servir index.html / styles.css / app.js / rise-client.js / config.js
     2. Guardar salas e logs em data.json (gravação atômica, com debounce)
     3. WebSocket /ws — presença + relay de offer/answer/ICE do WebRTC

   O WebRTC continua ponto a ponto: mídia nunca passa por aqui, só a
   sinalização (quem está na sala e como dois navegadores se encontram).
   ============================================================= */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

/* ---------------------------------------------------------------
   Armazenamento — data.json
   --------------------------------------------------------------- */

const EMPTY = { rooms: {}, logs: [], seq: 0 };
let db = structuredClone(EMPTY);

function loadDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      rooms: parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : {},
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      seq: Number(parsed.seq) || 0
    };
    console.log(`[rise] data.json carregado — ${Object.keys(db.rooms).length} sala(s), ${db.logs.length} log(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[rise] data.json ilegível, começando vazio:', e.message);
    db = structuredClone(EMPTY);
  }
}

let saveTimer = null;
let saving = false;
let saveAgain = false;

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 150);
}

async function flush() {
  saveTimer = null;
  if (saving) { saveAgain = true; return; }
  saving = true;
  const tmp = DATA_FILE + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fsp.rename(tmp, DATA_FILE);
  } catch (e) {
    console.error('[rise] falha ao gravar data.json:', e.message);
    try { await fsp.unlink(tmp); } catch { }
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; save(); }
  }
}

/* Salas expiradas somem junto com os logs delas. */
function purge() {
  const now = Date.now();
  let dirty = false;
  for (const [code, room] of Object.entries(db.rooms)) {
    if (new Date(room.expires_at).getTime() <= now) {
      delete db.rooms[code];
      dirty = true;
    }
  }
  if (dirty) {
    const alive = new Set(Object.keys(db.rooms));
    db.logs = db.logs.filter(l => alive.has(l.room_code));
    save();
  }
}

const norm = c => String(c || '').trim().toUpperCase();

/* Sala viva = existe, não encerrada e dentro da validade. */
function liveRoom(code) {
  const room = db.rooms[norm(code)];
  if (!room) return null;
  if (room.closed) return null;
  if (new Date(room.expires_at).getTime() <= Date.now()) return null;
  return room;
}

/* Espelha exatamente o retorno do antigo rise_room_public. */
function publicRoom(room) {
  return {
    code: room.code,
    title: room.title,
    host_name: room.host_name,
    status: room.status,
    locked: room.locked,
    closed: room.closed,
    password_required: room.password_hash != null,
    expires_at: room.expires_at
  };
}

/* ---------------------------------------------------------------
   RPCs — mesma assinatura e mesmo retorno das funções do Postgres
   --------------------------------------------------------------- */

const rpcs = {
  rise_create_room(p) {
    if (!dataWritable) return false;
    const code = norm(p.p_code);
    if (!code) return false;
    purge();
    if (db.rooms[code]) return false;           // unique_violation → false
    db.rooms[code] = {
      code,
      title: String(p.p_title || '').trim() || 'Sessão Rise',
      host_name: String(p.p_host_name || '').slice(0, 80),
      host_token_hash: p.p_host_token_hash,
      password_hash: p.p_password_hash ?? null,
      status: 'waiting',
      locked: false,
      closed: false,
      expires_at: p.p_expires_at,
      created_at: new Date().toISOString()
    };
    save();
    return true;
  },

  rise_room_public(p) {
    const room = liveRoom(p.p_code);
    return room ? [publicRoom(room)] : [];      // returns table → array
  },

  rise_check_password(p) {
    const room = liveRoom(p.p_code);
    return !!(room && room.password_hash && room.password_hash === p.p_password_hash);
  },

  rise_host_action(p) {
    const room = liveRoom(p.p_code);
    if (!room || room.host_token_hash !== p.p_host_token_hash) return false;
    const value = p.p_value == null ? null : String(p.p_value);
    switch (p.p_action) {
      case 'title': {
        const t = (value || '').trim();
        if (t) room.title = t.slice(0, 80);
        break;
      }
      case 'lock':
        room.locked = String(value || 'false').toLowerCase() === 'true';
        break;
      case 'close':
        room.closed = true;
        room.status = 'closed';
        break;
      case 'status': {
        const s = (value || '').trim();
        if (s) room.status = s;
        break;
      }
      default:
        return false;
    }
    save();
    return true;
  }
};

/* ---------------------------------------------------------------
   HTTP
   --------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store'
  });
  res.end(buf);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('payload muito grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));

  // nunca servir nada fora da pasta, nem o próprio banco
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (path.basename(file) === 'data.json' || path.basename(file).startsWith('data.json')) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw Object.assign(new Error('not file'), { code: 'ENOENT' });
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'bad url' }); }
  const p = url.pathname;

  try {
    // ---- RPC ----
    if (p.startsWith('/api/rpc/') && req.method === 'POST') {
      const name = p.slice('/api/rpc/'.length);
      const fn = rpcs[name];
      if (!fn) return sendJson(res, 404, { data: null, error: { code: 'PGRST202', message: `função ${name} não existe` } });
      const params = await readBody(req);
      return sendJson(res, 200, { data: fn(params), error: null });
    }

    // ---- logs ----
    if (p === '/api/logs' && req.method === 'POST') {
      const row = await readBody(req);
      const code = norm(row.room_code);
      if (!db.rooms[code]) return sendJson(res, 200, { data: null, error: null });
      db.logs.push({
        id: ++db.seq,
        room_code: code,
        actor_name: String(row.actor_name || 'Sistema').slice(0, 80),
        event_type: String(row.event_type || '').slice(0, 60),
        details: row.details == null ? null : String(row.details).slice(0, 500),
        created_at: new Date().toISOString()
      });
      if (db.logs.length > 5000) db.logs.splice(0, db.logs.length - 5000);
      save();
      return sendJson(res, 200, { data: null, error: null });
    }

    if (p === '/api/logs' && req.method === 'GET') {
      const code = norm(url.searchParams.get('room_code'));
      const limit = Math.min(Number(url.searchParams.get('limit')) || 80, 200);
      const data = db.logs
        .filter(l => l.room_code === code)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))
        .slice(0, limit);
      return sendJson(res, 200, { data, error: null });
    }

    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        writable: dataWritable,
        rooms: Object.keys(db.rooms).length,
        sockets: sockets.size
      });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    return await serveStatic(req, res, p);
  } catch (e) {
    console.error('[rise] erro HTTP:', e.message);
    return sendJson(res, 500, { data: null, error: { message: e.message } });
  }
});

/* ---------------------------------------------------------------
   WebSocket (RFC 6455) — implementação mínima, sem dependências
   --------------------------------------------------------------- */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** topic -> Map<socket, {key, payload}> */
const topics = new Map();
const sockets = new Set();

function wsSend(sock, obj) {
  if (sock.destroyed || !sock.writable) return;
  try { sock.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1)); } catch { }
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([head, payload]);
}

function presenceState(topic) {
  const state = {};
  const members = topics.get(topic);
  if (!members) return state;
  for (const { key, payload } of members.values()) {
    if (!payload) continue;
    (state[key] ||= []).push(payload);
  }
  return state;
}

function broadcastTo(topic, exclude, obj) {
  const members = topics.get(topic);
  if (!members) return;
  for (const sock of members.keys()) {
    if (sock === exclude) continue;
    wsSend(sock, obj);
  }
}

function syncTopic(topic) {
  const state = presenceState(topic);
  const members = topics.get(topic);
  if (!members) return;
  for (const sock of members.keys()) wsSend(sock, { op: 'sync', state });
}

function leaveTopic(sock) {
  const topic = sock._topic;
  if (!topic) return;
  const members = topics.get(topic);
  if (!members) return;
  const entry = members.get(sock);
  members.delete(sock);
  if (entry?.payload) broadcastTo(topic, null, { op: 'leave', lefts: [entry.payload] });
  if (members.size === 0) topics.delete(topic);
  else syncTopic(topic);
  sock._topic = null;
}

function handleMessage(sock, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.op === 'hello') {
    const topic = String(msg.topic || '').slice(0, 120);
    if (!topic) return;
    if (sock._topic && sock._topic !== topic) leaveTopic(sock);
    sock._topic = topic;
    sock._key = String(msg.key || '').slice(0, 120);
    const members = topics.get(topic) || (topics.set(topic, new Map()), topics.get(topic));
    members.set(sock, { key: sock._key, payload: null });
    wsSend(sock, { op: 'ready', topic });
    wsSend(sock, { op: 'sync', state: presenceState(topic) });
    return;
  }

  const topic = sock._topic;
  if (!topic) return;
  const members = topics.get(topic);
  if (!members) return;

  if (msg.op === 'track') {
    const entry = members.get(sock);
    if (!entry) return;
    const first = entry.payload == null;
    entry.payload = msg.payload || {};
    if (first) broadcastTo(topic, sock, { op: 'join', news: [entry.payload] });
    syncTopic(topic);
    wsSend(sock, { op: 'tracked', ref: msg.ref });
    return;
  }

  if (msg.op === 'bc') {
    // broadcast self:false — o remetente nunca recebe de volta
    broadcastTo(topic, sock, { op: 'bc', event: msg.event, payload: msg.payload });
    return;
  }
}

server.on('upgrade', (req, sock) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sock.destroy(); }
  if (url.pathname !== '/ws') return sock.destroy();

  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return sock.destroy();

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  sock.setNoDelay(true);
  sock.setTimeout(0);
  sockets.add(sock);
  sock._topic = null;

  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let fragParts = [];

  sock.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off); off += 8;
        if (big > 8n * 1024n * 1024n) return sock.destroy(); // 8MB de teto
        len = Number(big);
      }

      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;

      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);

      if (opcode === 0x8) { sock.end(); return; }                       // close
      if (opcode === 0x9) { sock.write(encodeFrame(payload, 0xA)); continue; } // ping
      if (opcode === 0xA) continue;                                      // pong

      if (opcode === 0x0) {                                              // continuação
        fragParts.push(payload);
        if (fin) {
          const full = Buffer.concat(fragParts);
          fragParts = [];
          if (fragOp === 0x1) handleMessage(sock, full.toString('utf8'));
          fragOp = 0;
        }
        continue;
      }

      if (!fin) { fragOp = opcode; fragParts = [payload]; continue; }
      if (opcode === 0x1) handleMessage(sock, payload.toString('utf8'));
    }
  });

  const bye = () => { leaveTopic(sock); sockets.delete(sock); };
  sock.on('close', bye);
  sock.on('end', bye);
  sock.on('error', () => { bye(); sock.destroy(); });
});

/* keepalive — derruba socket morto e mantém proxies acordados */
setInterval(() => {
  for (const sock of sockets) {
    if (sock.destroyed || !sock.writable) { leaveTopic(sock); sockets.delete(sock); continue; }
    try { sock.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch { }
  }
}, 25000).unref();

setInterval(purge, 5 * 60 * 1000).unref();

/* ---------------------------------------------------------------
   start
   --------------------------------------------------------------- */

loadDb();
purge();

let dataWritable = true;
try {
  fs.accessSync(ROOT, fs.constants.W_OK);
  const probe = DATA_FILE + '.write-test';
  fs.writeFileSync(probe, 'ok', 'utf8');
  fs.unlinkSync(probe);
} catch (e) {
  dataWritable = false;
  console.error('[rise] AVISO: sem permissão de escrita em', ROOT, '—', e.message);
  console.error('[rise] salas não serão salvas. Corrija com: chown/chmod na pasta do projeto.');
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[rise] porta ${PORT} já está em uso — o Rise provavelmente já está rodando.`);
    console.error(`[rise] abra http://localhost:${PORT} no navegador (não abra o index.html direto).`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`[rise] http://localhost:${PORT}`);
  console.log(`[rise] dados em ${DATA_FILE}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n[rise] encerrando, gravando data.json...');
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    await flush();
    process.exit(0);
  });
}
