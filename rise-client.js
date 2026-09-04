/* =============================================================
   Rise — cliente de dados e sinalização.

   Substitui o supabase-js expondo exatamente a mesma superfície que o
   app.js já usava (channel/on/subscribe/track/send, from().insert(),
   from().select().eq().order().limit(), rpc()). Por isso a lógica da
   aplicação continua idêntica: só a implementação por baixo mudou de
   Supabase para o server.js local, que guarda tudo em data.json.

   Dados     → HTTP  /api/rpc/*  e  /api/logs
   Presença  → WebSocket /ws     (quem está na sala)
   Sinalização WebRTC → WebSocket /ws (offer / answer / ICE)

   A mídia nunca passa pelo servidor: continua ponto a ponto.
   ============================================================= */

(function (global) {
  'use strict';

  function baseUrl() {
    const cfg = global.RISE_CONFIG || {};
    if (cfg.SERVER_URL) return String(cfg.SERVER_URL).replace(/\/+$/, '');
    if (location.protocol === 'file:') {
      const port = cfg.SERVER_PORT || 4173;
      return 'http://localhost:' + port;
    }
    return location.origin;
  }

  function wsUrl() {
    const base = baseUrl();
    return base.replace(/^http/, 'ws') + '/ws';
  }

  async function parseJson(res) {
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch {
      const snippet = text.slice(0, 80).replace(/\s+/g, ' ');
      throw new Error(res.ok
        ? 'Resposta inválida do servidor'
        : `HTTP ${res.status}${snippet ? ': ' + snippet : ''}`);
    }
    if (!res.ok) {
      const msg = body?.error?.message || body?.error || `HTTP ${res.status}`;
      return { data: null, error: { message: String(msg), code: 'HTTP_' + res.status } };
    }
    return body;
  }

  async function postJson(path, body) {
    const res = await fetch(baseUrl() + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {})
    });
    return parseJson(res);
  }

  async function getJson(path) {
    const res = await fetch(baseUrl() + path, { headers: { accept: 'application/json' } });
    return parseJson(res);
  }

  /* -----------------------------------------------------------
     Canal — presença + broadcast sobre um WebSocket
     ----------------------------------------------------------- */
  class RiseChannel {
    constructor(topic) {
      this.topic = topic;
      this.ws = null;
      this.state = {};
      this.closed = false;
      this.subscribed = false;
      this._statusCb = null;
      this._presence = { sync: [], join: [], leave: [] };
      this._broadcast = new Map();
      this._lastTrack = null;
      this._queue = [];
    }

    /* ch.on('presence', {event}, cb) | ch.on('broadcast', {event}, cb) */
    on(kind, opts, cb) {
      const event = (opts && opts.event) || '';
      if (kind === 'presence') {
        if (this._presence[event]) this._presence[event].push(cb);
      } else if (kind === 'broadcast') {
        if (!this._broadcast.has(event)) this._broadcast.set(event, []);
        this._broadcast.get(event).push(cb);
      }
      return this;
    }

    presenceState() {
      return this.state;
    }

    subscribe(statusCb) {
      this._statusCb = statusCb;
      this._connect();
      return this;
    }

    _status(st, err) {
      if (typeof this._statusCb === 'function') {
        try { this._statusCb(st, err); } catch (e) { console.warn('[rise] status cb', e); }
      }
    }

    _connect() {
      if (this.closed) return;
      let ws;
      try {
        ws = new WebSocket(wsUrl());
      } catch (e) {
        this._status('CHANNEL_ERROR', e);
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) { try { ws.close(); } catch { } return; }
        ws.send(JSON.stringify({ op: 'hello', topic: this.topic, key: this.key || this.topic }));
      };

      ws.onmessage = ev => {
        if (this.ws !== ws) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.op === 'ready') {
          this.subscribed = true;
          // reenvia o último track ao reconectar, e escoa o que ficou na fila
          if (this._lastTrack) ws.send(JSON.stringify({ op: 'track', payload: this._lastTrack }));
          for (const m of this._queue.splice(0)) { try { ws.send(m); } catch { } }
          this._status('SUBSCRIBED', null);
          return;
        }

        if (msg.op === 'sync') {
          this.state = msg.state || {};
          for (const cb of this._presence.sync) { try { cb({}); } catch (e) { console.warn(e); } }
          return;
        }

        if (msg.op === 'join') {
          for (const cb of this._presence.join) {
            try { cb({ newPresences: msg.news || [] }); } catch (e) { console.warn(e); }
          }
          return;
        }

        if (msg.op === 'leave') {
          for (const cb of this._presence.leave) {
            try { cb({ leftPresences: msg.lefts || [] }); } catch (e) { console.warn(e); }
          }
          return;
        }

        if (msg.op === 'bc') {
          const list = this._broadcast.get(msg.event);
          if (!list) return;
          for (const cb of list) {
            try { cb({ payload: msg.payload }); } catch (e) { console.warn(e); }
          }
        }
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.subscribed = false;
        if (this.closed) return;
        // o app.js já tem backoff próprio em scheduleRejoin()
        this._status('CHANNEL_ERROR', new Error('conexão perdida'));
      };

      ws.onerror = () => {
        if (this.ws !== ws || this.closed) return;
        this.subscribed = false;
        this._status('CHANNEL_ERROR', new Error('falha de socket'));
      };
    }

    _raw(obj) {
      const msg = JSON.stringify(obj);
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.subscribed) {
        this.ws.send(msg);
      } else if (!this.closed) {
        if (this._queue.length < 64) this._queue.push(msg);
      }
    }

    /* mesma assinatura do supabase: resolve com 'ok' */
    track(payload) {
      this._lastTrack = payload;
      this._raw({ op: 'track', payload });
      return Promise.resolve('ok');
    }

    /* ch.send({ type:'broadcast', event, payload }) */
    send(msg) {
      if (!msg || msg.type !== 'broadcast') return Promise.resolve('ok');
      this._raw({ op: 'bc', event: msg.event, payload: msg.payload });
      return Promise.resolve('ok');
    }

    unsubscribe() {
      this.closed = true;
      this.subscribed = false;
      this._queue.length = 0;
      const ws = this.ws;
      this.ws = null;
      if (ws) { try { ws.close(); } catch { } }
      return Promise.resolve('ok');
    }
  }

  /* -----------------------------------------------------------
     Consulta encadeada — o subconjunto que o app.js usa
     ----------------------------------------------------------- */
  class LogQuery {
    constructor() { this._code = ''; this._limit = 80; }
    eq(col, val) { if (col === 'room_code') this._code = val; return this; }
    order() { return this; }                       // sempre mais recente primeiro
    limit(n) { this._limit = n; return this._run(); }
    then(res, rej) { return this._run().then(res, rej); }
    _run() {
      const qs = `?room_code=${encodeURIComponent(this._code)}&limit=${this._limit}`;
      return getJson('/api/logs' + qs).catch(e => ({ data: [], error: { message: e.message } }));
    }
  }

  class Table {
    constructor(name) { this.name = name; }

    insert(row) {
      if (this.name === 'rise_logs') {
        return postJson('/api/logs', row).catch(e => ({ data: null, error: { message: e.message } }));
      }
      if (this.name === 'rise_rooms') {
        // caminho de fallback do app.js quando a RPC não existe
        return postJson('/api/rpc/rise_create_room', {
          p_code: row.code,
          p_title: row.title,
          p_host_name: row.host_name,
          p_host_token_hash: row.host_token_hash,
          p_password_hash: row.password_hash,
          p_expires_at: row.expires_at
        }).then(r => (r.data ? { data: null, error: null } : { data: null, error: { message: 'código em uso' } }))
          .catch(e => ({ data: null, error: { message: e.message } }));
      }
      return Promise.resolve({ data: null, error: { message: 'tabela desconhecida: ' + this.name } });
    }

    select() {
      if (this.name === 'rise_logs') return new LogQuery();
      return Promise.resolve({ data: [], error: null });
    }
  }

  /* -----------------------------------------------------------
     Cliente
     ----------------------------------------------------------- */
  class RiseClient {
    constructor() { this._channels = new Set(); }

    channel(topic, opts) {
      const ch = new RiseChannel(topic);
      ch.key = (opts && opts.config && opts.config.presence && opts.config.presence.key) || topic;
      this._channels.add(ch);
      return ch;
    }

    removeChannel(ch) {
      if (!ch) return Promise.resolve('ok');
      this._channels.delete(ch);
      return ch.unsubscribe();
    }

    from(name) { return new Table(name); }

    rpc(name, params) {
      return postJson('/api/rpc/' + name, params)
        .catch(e => ({ data: null, error: { message: e.message, code: 'NETWORK' } }));
    }
  }

  global.RiseClient = {
    create: () => new RiseClient(),
    serverUrl: baseUrl
  };
})(window);
