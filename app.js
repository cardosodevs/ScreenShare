const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const cfg = window.RISE_CONFIG || {};
const okCfg = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('COLE_');
const sb = okCfg ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  realtime: {
    params: { eventsPerSecond: 10 },
    presence: { enabled: true }
  }
}) : null;
const S = {
  uid: localStorage.rise_uid || crypto.randomUUID(),
  name: localStorage.rise_name || '',
  code: null,
  room: null,
  host: false,
  hostToken: null,
  channel: null,
  presence: {},
  stream: null,
  peers: new Map(),
  remoteStreams: new Map(),
  zoom: 1,
  shareAllowed: false,
  grants: new Set(),
  quality: 'auto',
  fps: 60,
  role: 'spectator',
  pingMap: new Map(),
  pendingIce: new Map(),
  joined: false,
  joinedAt: null,
  _leaving: false,
  _replacing: false,
  _joinAttempts: 0,
  _lastTrack: null,
  _grantSent: new Map(),
  _leaveTimers: new Map(),
  _lastAnnounce: 0,
  _reqThrottle: new Map()
};
localStorage.rise_uid = S.uid;

function toast(t) {
  const e = $('#toast');
  if (!e) return;
  e.textContent = t;
  e.classList.remove('show');
  void e.offsetWidth;
  e.classList.add('show');
  clearTimeout(window._t);
  window._t = setTimeout(() => e.classList.remove('show'), 3200);
}
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fixUtf8(s) {
  if (!s || typeof s !== 'string') return s || '';
  if (!/[ÃÂâ€]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from([...s].map(c => c.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    if (decoded && decoded !== s && !/[ÃÂ]/.test(decoded)) return decoded;
  } catch { }
  return s
    .replace(/SessÃ£o/gi, 'Sessão')
    .replace(/Ã£/g, 'ã').replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú').replace(/Ã§/g, 'ç').replace(/Ãª/g, 'ê')
    .replace(/Ã´/g, 'ô').replace(/Ã /g, 'à').replace(/Ãµ/g, 'õ').replace(/VocÃª/g, 'Você')
    .replace(/nÃ£o/gi, 'não').replace(/PermissÃ£o/gi, 'Permissão')
    .replace(/â€¢/g, '•').replace(/â€"/g, '—').replace(/Â·/g, '·');
}
function normalizeRoom(r) {
  if (!r) return r;
  if (r.title) r.title = fixUtf8(r.title);
  return r;
}
function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?'; }
function avatarColor(name) {
  // Rampa de grafite (dois tons quentes no fim) — mantém pessoas distinguiveis
  // sem competir com o ambar, que na UI significa estado ativo/permitido.
  const colors = ['#3A3F46', '#4C535B', '#5E666F', '#33383E', '#4A453C', '#6B7079', '#5C554A'];
  let h = 0;
  for (const c of String(name || '')) h = (h + c.charCodeAt(0)) % colors.length;
  return colors[h];
}
async function sha(v) {
  if (!crypto.subtle) {
    throw Object.assign(new Error('HTTPS_REQUIRED'), {
      userMessage: 'Abra o site em HTTPS (não use http://IP). Sem HTTPS o navegador bloqueia a criptografia necessária para criar salas.'
    });
  }
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function ensureApiReady() {
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    throw Object.assign(new Error('HTTPS_REQUIRED'), {
      userMessage: 'Use HTTPS para criar salas (GitHub Pages, Cloudflare ou localhost).'
    });
  }
}
function code() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return 'RISE-' + Array.from({ length: 4 }, () => a[Math.floor(Math.random() * a.length)]).join(''); }
function invite() { const u = new URL(location.href); u.search = ''; u.searchParams.set('room', S.code); return u.toString(); }
async function copy(t, m = 'Copiado!') { try { await navigator.clipboard.writeText(t); } catch { const x = document.createElement('textarea'); x.value = t; document.body.appendChild(x); x.select(); document.execCommand('copy'); x.remove(); } toast(m); }
function conn(on, text) {
  const c = $('#conn');
  if (c) { c.classList.toggle('off', !on); const sp = c.querySelector('span'); if (sp) sp.textContent = text; }
}
function grantsKey() { return 'rise_grants_' + S.code; }
function loadGrants() {
  S.grants = new Set();
  if (!S.code || !S.host) return;
  try {
    const raw = localStorage.getItem(grantsKey());
    if (raw) JSON.parse(raw).forEach(id => S.grants.add(id));
  } catch { S.grants = new Set(); }
}
function saveGrants() {
  if (!S.code || !S.host) return;
  localStorage.setItem(grantsKey(), JSON.stringify([...S.grants]));
}
function setRoomUI() {
  const rc = $('#roomCode'); if (rc) rc.textContent = S.code || '—';
  const tr = $('#topRoom'); if (tr) tr.textContent = S.code || '—';
  const mn = $('#meName'); if (mn) mn.textContent = S.name;
  const ma = $('#meAvatar'); if (ma) ma.textContent = initials(S.name);
  const selfAv = $('#stageSelfAvatar');
  if (selfAv) {
    selfAv.textContent = initials(S.name);
    selfAv.style.background = avatarColor(S.name);
  }
  const selfName = $('#stageSelfName'); if (selfName) selfName.textContent = S.name || 'Você';
  const mr = $('#myRole'); if (mr) mr.textContent = S.host ? 'Host' : (S.role === 'participant' ? 'Participante' : 'Espectador');
  document.body.classList.toggle('hostView', S.host);
  const appEl = $('#app'); if (appEl) appEl.classList.toggle('isHost', S.host);
  const ht = $('#hostTools'); if (ht) ht.style.display = S.host ? 'flex' : 'none';
  const lb = $('#lockBtn');
  if (lb) {
    lb.classList.toggle('hidden', !S.host);
    lb.style.display = '';
    lb.disabled = !S.host;
    lb.title = S.room?.locked ? 'Sala trancada — clique para abrir' : 'Trancar sala';
    lb.classList.toggle('ctrlActive', !!S.room?.locked);
  }
  const ot = $('#openTools');
  if (ot) { ot.classList.toggle('hidden', !S.host); ot.style.display = ''; }
  const ln = $('#liveName'); if (ln) { const sharer = flat().find(p => p.sharing); ln.textContent = sharer ? sharer.name : 'transmitindo'; }
}
function startMeetClock() {
  if (S._clockTimer) clearInterval(S._clockTimer);
  S._clockStart = Date.now();
  const tick = () => {
    const el = $('#clockTime');
    if (!el) return;
    const s = Math.floor((Date.now() - S._clockStart) / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    el.textContent = h > 0
      ? `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  S._clockTimer = setInterval(tick, 1000);
}
function syncScrim() {
  const open = $('#app')?.classList.contains('peopleOpen') || $('#tools')?.classList.contains('show');
  const scrim = $('#peopleScrim');
  if (scrim) scrim.hidden = !open;
}
function togglePeople(force) {
  const app = $('#app');
  if (!app) return;
  const open = typeof force === 'boolean' ? force : !app.classList.contains('peopleOpen');
  app.classList.toggle('peopleOpen', open);
  $('#togglePeople')?.classList.toggle('ctrlActive', open);
  if (open) {
    $('#tools')?.classList.remove('show');
    $('#openTools')?.classList.remove('ctrlActive');
  }
  syncScrim();
}
function toggleTools(force) {
  const tools = $('#tools');
  if (!tools) return;
  const open = typeof force === 'boolean' ? force : !tools.classList.contains('show');
  tools.classList.toggle('show', open);
  $('#openTools')?.classList.toggle('ctrlActive', open);
  if (open) {
    $('#app')?.classList.remove('peopleOpen');
    $('#togglePeople')?.classList.remove('ctrlActive');
  }
  syncScrim();
}
function showApp() { $('#landing').classList.remove('show'); $('#app').classList.add('show'); setRoomUI(); startMeetClock(); }
function showLanding() {
  $('#app').classList.remove('show');
  $('#landing').classList.add('show');
  setInviteMode(new URL(location.href).searchParams.get('room'));
}
function setInviteMode(code) {
  const landing = $('#landing');
  if (!landing) return;
  const c = String(code || '').trim().toUpperCase();
  const on = !!c;
  landing.classList.toggle('inviteMode', on);
  const title = $('#homeCardTitle');
  const lead = $('#homeCardLead');
  const codeEl = $('#inviteCodeLabel');
  if (on) {
    if ($('#joinCode')) $('#joinCode').value = c;
    if (title) title.textContent = 'Você foi convidado';
    if (lead) lead.textContent = 'Digite um nome para entrar. Sem um nome a sala não libera o acesso.';
    if (codeEl) codeEl.textContent = c;
  } else if (title) {
    title.textContent = 'Entrar';
    if (lead) lead.textContent = 'Escolha um nickname para ser identificado na sala.';
  }
}
function requireDisplayName() {
  const input = $('#displayName');
  const name = (input?.value || '').trim();
  if (name) {
    input?.classList.remove('homeInputError');
    return name;
  }
  input?.classList.add('homeInputError');
  input?.focus();
  toast('Digite um nome para entrar');
  return '';
}
async function log(type, details = '') { if (!sb || !S.code) return; await sb.from('rise_logs').insert({ room_code: S.code, actor_name: S.name || 'Sistema', event_type: type, details }); loadLogs(); }
async function loadLogs() { if (!sb || !S.code) return; const { data } = await sb.from('rise_logs').select('*').eq('room_code', S.code).order('created_at', { ascending: false }).limit(80); const logsEl = $('#logs'); if (logsEl) logsEl.innerHTML = (data || []).map(x => `<div class="log"><b>${esc(x.actor_name)} · ${esc(x.event_type)}</b><p>${esc(x.details || '')}<br><small>${new Date(x.created_at).toLocaleString()}</small></p></div>`).join('') || '<div class="log"><p>Sem logs ainda.</p></div>'; }
async function roomPublic(c) { const { data, error } = await sb.rpc('rise_room_public', { p_code: c.toUpperCase() }); if (error) throw error; return data?.[0] || null; }
async function createRoom() {
  if (!sb) return toast('Configure a chave publishable completa no config.js');
  try { ensureApiReady(); } catch (e) { return toast(e.userMessage || e.message); }
  S.name = requireDisplayName();
  if (!S.name) return;
  localStorage.rise_name = S.name;
  const title = fixUtf8($('#roomTitle').value.trim()) || 'Sessão Rise';
  const pass = $('#roomPassword').value;
  S.hostToken = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha(S.hostToken), passHash = pass ? await sha(pass) : null;
  const exp = new Date(Date.now() + (cfg.ROOM_TTL_HOURS || 24) * 3600e3).toISOString();
  $('#createRoom').disabled = true; $('#createRoom').textContent = 'Criando sala...';
  try {
    for (let i = 0; i < 8; i++) {
      const c = code();
      let created = false;
      const rpc = await sb.rpc('rise_create_room', { p_code: c, p_title: title, p_host_name: S.name, p_host_token_hash: tokenHash, p_password_hash: passHash, p_expires_at: exp });
      if (!rpc.error) created = rpc.data === true;
      else if (rpc.error.code === 'PGRST202' || String(rpc.error.message || '').includes('rise_create_room')) {
        const fallback = await sb.from('rise_rooms').insert({ code: c, title, host_name: S.name, host_token_hash: tokenHash, password_hash: passHash, expires_at: exp });
        if (!fallback.error) created = true;
        else if (fallback.error.code !== '23505') throw fallback.error;
      } else throw rpc.error;
      if (created) {
        S.code = c; S.host = true; S.shareAllowed = true;
        S.grants = new Set();
        saveGrants();
        localStorage.setItem('rise_host_' + c, S.hostToken);
        history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(c)}`);
        S.room = normalizeRoom(await roomPublic(c));
        if (!S.room) throw new Error('Sala criada, mas não pôde ser lida. Execute o supabase.sql.');
        S.joinedAt = new Date().toISOString();
        showApp(); await joinRealtime(); await log('SALA_CRIADA', title); toast('Sala criada com sucesso'); return;
      }
    }
    throw new Error('Não foi possível gerar um código único para a sala.');
  } catch (error) {
    console.error('Rise createRoom:', error);
    if (error?.message === 'HTTPS_REQUIRED' || error?.userMessage) toast(error.userMessage || 'Use HTTPS para criar salas.');
    else toast('Erro ao criar sala: ' + (error?.message || 'verifique o Supabase'));
  } finally { $('#createRoom').disabled = false; $('#createRoom').textContent = 'Criar sala'; }
}

async function enterRoom(c) {
  if (!sb) return toast('Configure a chave publishable completa no config.js');
  try { ensureApiReady(); } catch (e) { return toast(e.userMessage || e.message); }
  c = (c || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!c) return toast('Digite o código da sala');
  if (!c.startsWith('RISE-') && c.length === 4) c = 'RISE-' + c;
  S.name = requireDisplayName();
  if (!S.name) return;
  localStorage.rise_name = S.name;
  $('#joinRoom').disabled = true; $('#joinRoom').textContent = 'Entrando...';
  const inviteBtn = $('#joinInvite');
  if (inviteBtn) { inviteBtn.disabled = true; inviteBtn.textContent = 'Entrando...'; }
  try {
    const r = await roomPublic(c);
    if (!r) return toast('Sala não encontrada ou expirada');
    if (r.closed) return toast('Essa sala foi encerrada');

    S.hostToken = localStorage.getItem('rise_host_' + c);
    S.host = false;
    if (S.hostToken) {
      const test = await sb.rpc('rise_host_action', { p_code: c, p_host_token_hash: await sha(S.hostToken), p_action: 'title', p_value: r.title });
      if (!test.error && test.data === true) S.host = true;
      else { S.hostToken = null; localStorage.removeItem('rise_host_' + c); }
    }

    if (r.locked && !S.host) return toast('A sala está trancada pelo host');
    if (r.password_required && !S.host) {
      const p = prompt('Digite a senha da sala:');
      if (p === null) return;
      const check = await sb.rpc('rise_check_password', { p_code: c, p_password_hash: await sha(p) });
      if (check.error) throw check.error;
      if (!check.data) return toast('Senha incorreta');
    }

    S.code = c; S.room = normalizeRoom(r); S.shareAllowed = S.host;
    S.joinedAt = new Date().toISOString();
    loadGrants();
    history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(c)}`);
    showApp(); await joinRealtime(); await log('ENTROU_NA_SALA', S.role); toast('Você entrou na sala');
  } catch (error) {
    console.error('Rise enterRoom:', error);
    const msg = String(error?.message || '');
    if (msg.includes('rise_room_public') || error?.code === 'PGRST202') toast('Banco desatualizado: execute o supabase.sql');
    else toast('Erro ao entrar: ' + (msg || 'verifique sua conexão'));
  } finally {
    $('#joinRoom').disabled = false; $('#joinRoom').textContent = 'Entrar';
    if (inviteBtn) { inviteBtn.disabled = false; inviteBtn.textContent = 'Entrar na sala'; }
  }
}
async function hostAction(action, value = null) { if (!S.host) return false; const { data, error } = await sb.rpc('rise_host_action', { p_code: S.code, p_host_token_hash: await sha(S.hostToken), p_action: action, p_value: value }); if (error || !data) { toast('Falha na ação do host'); return false; } S.room = normalizeRoom(await roomPublic(S.code)) || S.room; setRoomUI(); return true; }

function normalizePresence(p) {
  if (!p || typeof p !== 'object') return null;
  const src = Array.isArray(p.metas) && p.metas[0] ? p.metas[0] : p;
  const userId = src.userId || src.user_id || p.userId || p.user_id;
  if (!userId) return null;
  return { ...src, userId };
}
function flat() {
  const out = [];
  const seen = new Set();
  for (const key of Object.keys(S.presence || {})) {
    const val = S.presence[key];
    const list = Array.isArray(val) ? val : (val ? [val] : []);
    for (const raw of list) {
      const p = normalizePresence(raw);
      if (!p || seen.has(p.userId)) continue;
      seen.add(p.userId);
      out.push(p);
    }
  }
  return out.sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')));
}
function personStatus(p, self) {
  if (self) return 'Você';
  if (p.sharing) return 'Transmitindo';
  if (p.isHost || p.shareAllowed) return 'Pode transmitir';
  if (p.role === 'participant') return 'Participante';
  return 'Na sala';
}
function resendGrantsTo(uid) {
  if (!S.host || !uid || uid === S.uid) return;
  if (!S.grants.has(uid)) return;
  const now = Date.now();
  const last = S._grantSent.get(uid) || 0;
  if (now - last < 12000) return;
  S._grantSent.set(uid, now);
  broadcastControl('share-permission', { allowed: true }, uid);
}
function renderPeople() {
  const ps = flat(), n = ps.length;
  const streamers = ps.filter(p => p.sharing);
  const mc = $('#memberCount'), rc = $('#roomCount'), sc = $('#streamCount');
  if (mc) mc.textContent = n; if (rc) rc.textContent = n; if (sc) sc.textContent = streamers.length;

  const countEl = $('#participantsCount');
  if (countEl) countEl.textContent = n === 1 ? '1 na sala' : `${n} na sala`;
  const peopleBadge = $('#peopleBadge');
  if (peopleBadge) peopleBadge.textContent = n;

  const emptyHint = $('#stageEmptyHint');
  if (emptyHint) {
    if (S.stream) {
      emptyHint.textContent = 'Você está apresentando para a sala';
    } else if (streamers.length) {
      const names = streamers.map(s => s.name).slice(0, 2).join(', ');
      emptyHint.textContent = `${names} está apresentando`;
    } else if (n > 1) {
      emptyHint.textContent = 'Ninguém está apresentando no momento';
    } else {
      emptyHint.textContent = 'Use Apresentar na barra inferior para compartilhar sua tela';
    }
  }

  const peopleEl = $('#people');
  if (peopleEl) {
    peopleEl.innerHTML = ps.map(p => {
      const self = p.userId === S.uid;
      const status = personStatus(p, self);
      let actions = '';
      if (S.host && !self && !p.isHost) {
        const allowed = p.shareAllowed || S.grants.has(p.userId);
        actions = `<div class="personActions">`;
        if (allowed) {
          actions += `<button class="revokeBtn" data-revoke="${esc(p.userId)}" title="Revogar transmissão">Revogar</button>`;
        } else {
          actions += `<button class="permitBtn" data-permit="${esc(p.userId)}" title="Liberar transmissão">Liberar tela</button>`;
        }
        actions += `<button class="kickBtn" data-kick="${esc(p.userId)}" title="Expulsar">Expulsar</button></div>`;
      }
      const hostTag = p.isHost ? '<span class="tag">HOST</span>' : '';
      const avColor = avatarColor(p.name);
      return `<div class="person"><div class="avatar" style="background:${avColor}">${esc(initials(p.name))}</div><div class="info"><b>${esc(p.name)} ${hostTag}</b><span>${esc(status)}</span></div>${actions}</div>`;
    }).join('') || '<div class="person"><div class="info"><span>Conectando...</span></div></div>';
  }

  const streamersEl = $('#streamers');
  if (streamersEl) {
    streamersEl.innerHTML = streamers.map(p => `<div class="person"><div class="avatar">${esc(initials(p.name))}</div><div class="info"><b>${esc(p.name)}</b><span>AO VIVO</span></div></div>`).join('') || '';
  }

  const info = $('#participantsInfo');
  if (info) {
    if (streamers.length) {
      const names = streamers.map(s => s.name).slice(0, 2).join(', ');
      const extra = streamers.length > 2 ? ` +${streamers.length - 2}` : '';
      info.textContent = `${n} na sala • ${names}${extra} transmitindo`;
    } else if (n > 1) {
      info.textContent = `${n} na sala • ninguém transmitindo`;
    } else if (n === 1) {
      info.textContent = 'só você na sala • compartilhe sua tela';
    } else {
      info.textContent = 'conectando...';
    }
  }

  const liveNameEl = $('#liveName');
  if (liveNameEl) {
    const sharer = streamers[0];
    liveNameEl.textContent = sharer ? sharer.name : 'transmitindo';
  }

  const badge = $('#liveBadge');
  if (badge) {
    const hasLive = streamers.length > 0 || !!S.stream;
    badge.style.display = hasLive ? 'flex' : 'none';
  }

  const shareBtn2 = $('#shareScreen2'), stopBtn = $('#stopShare'), shareBtn = $('#shareScreen');
  const iAmSharing = !!S.stream;
  if (shareBtn) shareBtn.style.display = 'none';
  if (shareBtn2) { shareBtn2.classList.toggle('hidden', iAmSharing); shareBtn2.style.display = ''; }
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !iAmSharing);
    stopBtn.style.display = '';
  }

  const sel = $('#activeStream');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Selecionar transmissão</option>' + streamers.map(p => `<option value="${esc(p.userId)}">${esc(p.name)}</option>`).join('');
    if (streamers.some(p => p.userId === cur)) {
      sel.value = cur;
    } else if (streamers.length) {
      sel.value = streamers[0].userId;
    } else {
      sel.value = '';
    }
    if (streamers.length <= 1) sel.style.display = 'none';
    else sel.style.display = 'block';
  }

  const stageSig = streamers.map(p => p.userId).join(',') + '|' + [...S.remoteStreams.keys()].join(',') + '|' + (S.stream ? 1 : 0) + '|' + (sel?.value || '') + '|' + n;
  if (S._stageSig !== stageSig) {
    S._stageSig = stageSig;
    if (!streamers.length && !S.stream) updateStageView();
    else updateStageView(sel?.value);
  } else {
    renderTileGrid();
  }

  $$('[data-kick]').forEach(b => b.onclick = () => kick(b.dataset.kick));
  $$('[data-permit]').forEach(b => b.onclick = () => permit(b.dataset.permit, true));
  $$('[data-revoke]').forEach(b => b.onclick = () => permit(b.dataset.revoke, false));
}
function schedulePeople() {
  if (S._peopleTimer) return;
  S._peopleTimer = setTimeout(() => {
    S._peopleTimer = null;
    renderPeople();
  }, 80);
}

function tileStreamFor(uid) {
  if (uid === S.uid) return S.stream || null;
  return S.remoteStreams.get(uid) || null;
}
function requestStreamFromSharers() {
  for (const p of flat()) {
    if (!p.sharing || p.userId === S.uid) continue;
    if (S.remoteStreams.has(p.userId)) continue;
    const key = 'req:' + p.userId;
    const now = Date.now();
    const last = S._reqThrottle.get(key) || 0;
    if (now - last < 1500) continue;
    S._reqThrottle.set(key, now);
    send(p.userId, 'stream-request', {});
  }
}
function tileSignature(ps, activeUid) {
  return ps.map(p => [
    p.userId,
    p.name,
    p.sharing ? 1 : 0,
    tileStreamFor(p.userId) ? 1 : 0,
    p.userId === activeUid ? 1 : 0
  ].join(':')).join('|');
}
function attachTileVideos(grid) {
  grid.querySelectorAll('[data-tile-video]').forEach(vid => {
    const uid = vid.dataset.tileVideo;
    const stream = tileStreamFor(uid);
    // #region agent log
    fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:attachTileVideos',message:'tile attach',data:{uid,hasStream:!!stream,srcObjectIsNull:vid.srcObject===null,srcObjectMatches:vid.srcObject===stream,videoW:vid.videoWidth,videoH:vid.videoH},timestamp:Date.now(),runId:'run1',hypothesisId:'H3'})}).catch(()=>{});
    // #endregion
    if (stream && vid.srcObject !== stream) {
      vid.srcObject = stream;
      vid.muted = true;
      vid.playsInline = true;
      vid.play().then(() => {
        // #region agent log
        fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:attachTileVideos',message:'play ok',data:{uid,videoW:vid.videoWidth,videoH:vid.videoHeight},timestamp:Date.now(),runId:'run1',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
      }).catch(err => {
        // #region agent log
        fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:attachTileVideos',message:'play FAIL',data:{uid,err:String(err)},timestamp:Date.now(),runId:'run1',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
      });
    } else if (!stream) {
      vid.srcObject = null;
    }
  });
}
function applyGalleryMode() {
  const stage = $('#stage');
  if (!stage) return;
  const n = flat().length;
  const sharing = !!S.stream || flat().some(p => p.sharing);
  const gallery = !sharing && n > 0;
  stage.classList.toggle('galleryMode', gallery);
  stage.dataset.count = String(n);
  const empty = $('#emptyStage');
  if (empty && gallery) empty.style.display = 'none';
  return gallery;
}
function renderTileGrid() {
  applyGalleryMode();
  const grid = $('#tileGrid');
  if (!grid) return;
  const ps = flat();
  if (!ps.length) { grid.innerHTML = ''; grid.dataset.sig = ''; return; }

  const sel = $('#activeStream');
  let activeUid = sel?.value || '';
  if (activeUid === S.uid && S.stream) activeUid = S.uid;
  else if (!activeUid || (activeUid === S.uid && !S.stream)) {
    const sharer = ps.find(p => p.sharing && p.userId !== S.uid && S.remoteStreams.has(p.userId))
      || ps.find(p => p.sharing && p.userId !== S.uid)
      || ps.find(p => p.sharing);
    if (sharer) activeUid = sharer.userId;
  }

  const sig = tileSignature(ps, activeUid);
  // #region agent log
  fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:renderTileGrid',message:'sig check',data:{oldSig:grid.dataset.sig||'',newSig:sig,selfHasStream:!!tileStreamFor(S.uid),selfSharing:ps.find(p=>p.userId===S.uid)?.sharing||false,psCount:ps.length},timestamp:Date.now(),runId:'run1',hypothesisId:'H4'})}).catch(()=>{});
  // #endregion
  if (grid.dataset.sig === sig) {
    attachTileVideos(grid);
    return;
  }
  grid.dataset.sig = sig;

  const sorted = [...ps].sort((a, b) => {
    if (a.userId === S.uid) return 1;
    if (b.userId === S.uid) return -1;
    if (a.sharing && !b.sharing) return -1;
    if (!a.sharing && b.sharing) return 1;
    return String(a.joinedAt || '').localeCompare(String(b.joinedAt || ''));
  });

  const screenIcon = '<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>';

  grid.innerHTML = sorted.map(p => {
    const self = p.userId === S.uid;
    const sharing = !!p.sharing;
    const selected = activeUid === p.userId;
    const label = self ? `${p.name || 'Você'} (você)` : (p.name || 'Participante');
    const avColor = avatarColor(p.name);
    const hasStream = !!tileStreamFor(p.userId);
    return `<button type="button" class="tile${self ? ' self' : ''}${sharing ? ' sharing' : ''}${selected ? ' selected' : ''}" data-tile-uid="${esc(p.userId)}" title="${esc(label)}">
      <div class="tileMedia">${hasStream ? `<video autoplay playsinline muted data-tile-video="${esc(p.userId)}"></video>` : `<div class="tileAvatar" style="background:${avColor}">${esc(initials(p.name))}</div>`}</div>
      <span class="tileLive">AO VIVO</span>
      <span class="tileBadge" aria-hidden="true">${screenIcon}</span>
      <span class="tileName">${esc(self ? 'Você' : p.name)}</span>
    </button>`;
  }).join('');

  attachTileVideos(grid);

  grid.querySelectorAll('[data-tile-uid]').forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.tileUid;
      if (uid === S.uid && S.stream) {
        if (sel) sel.value = S.uid;
        updateStageView(S.uid);
      } else if (S.remoteStreams.has(uid) || flat().some(p => p.userId === uid && p.sharing)) {
        if (sel) sel.value = uid;
        updateStageView(uid);
        if (!S.remoteStreams.has(uid)) send(uid, 'stream-request', {});
      } else if (!$('#stage')?.classList.contains('galleryMode')) {
        toast('Este participante não está transmitindo');
      }
      renderTileGrid();
    };
  });
}

function autoSelectIfNeeded() {
  requestStreamFromSharers();
  const sel = $('#activeStream');
  if (sel?.value && (S.remoteStreams.has(sel.value) || (sel.value === S.uid && S.stream))) {
    updateStageView(sel.value);
    return;
  }
  const streamers = flat().filter(p => p.sharing);
  for (const p of streamers) {
    if (S.remoteStreams.has(p.userId)) {
      if (sel) sel.value = p.userId;
      updateStageView(p.userId);
      return;
    }
    if (p.userId === S.uid && S.stream) {
      if (sel) sel.value = p.userId;
      updateStageView(S.uid);
      return;
    }
  }
  updateStageView();
}
function presencePayload() {
  return {
    userId: S.uid,
    name: S.name,
    isHost: S.host,
    sharing: !!S.stream,
    role: S.role,
    shareAllowed: S.shareAllowed,
    joinedAt: S.joinedAt || (S.joinedAt = new Date().toISOString())
  };
}
async function track(force = false) {
  if (!S.channel) return;
  const payload = presencePayload();
  const sig = JSON.stringify(payload);
  if (!force && S._lastTrack === sig) return;
  try {
    const res = await S.channel.track(payload);
    S._lastTrack = sig;
    return res;
  } catch (e) {
    console.warn('track falhou', e);
    S._lastTrack = null;
  }
}

function extractPresenceUsers(presences) {
  const users = [];
  for (const item of presences || []) {
    if (Array.isArray(item)) users.push(...item);
    else if (item && typeof item === 'object') users.push(item);
  }
  return users.map(normalizePresence).filter(Boolean);
}

function clearRealtimeTimers() {
  if (S._pingInt) { clearInterval(S._pingInt); S._pingInt = null; }
  if (S._roomInt) { clearInterval(S._roomInt); S._roomInt = null; }
  if (S._trackInt) { clearInterval(S._trackInt); S._trackInt = null; }
  if (S._rejoinTimer) { clearTimeout(S._rejoinTimer); S._rejoinTimer = null; }
}

function scheduleRejoin() {
  if (S._rejoinTimer || S._leaving || !S.code) return;
  S._joinAttempts = (S._joinAttempts || 0) + 1;
  const delay = Math.min(15000, 2500 * S._joinAttempts);
  S._rejoinTimer = setTimeout(() => {
    S._rejoinTimer = null;
    if (!S._leaving && S.code) joinRealtime();
  }, delay);
}

async function joinRealtime() {
  if (!sb || !S.code || S._replacing) return;
  S._leaving = false;
  S._replacing = true;
  if (!S.joined) conn(false, 'Conectando');
  if (S.channel) {
    const old = S.channel;
    S.channel = null;
    try { await sb.removeChannel(old); } catch { }
  }
  S._lastTrack = null;

  const topic = 'rise-' + String(S.code).toUpperCase();
  const ch = sb.channel(topic, {
    config: {
      private: false,
      broadcast: { self: false, ack: false },
      presence: { key: S.uid, enabled: true }
    }
  });
  S.channel = ch;
  S._replacing = false;
  ch.on('presence', { event: 'sync' }, () => {
    S.presence = ch.presenceState();
    schedulePeople();
    requestStreamFromSharers();
    if (S.stream) {
      const now = Date.now();
      if (now - S._lastAnnounce > 1200) {
        S._lastAnnounce = now;
        send(null, 'stream-available', { name: S.name });
      }
    }
    autoSelectIfNeeded();
  });
  ch.on('presence', { event: 'leave' }, ({ leftPresences }) => {
    for (const p of extractPresenceUsers(leftPresences)) {
      if (!p.userId || p.userId === S.uid) continue;
      const prev = S._leaveTimers.get(p.userId);
      if (prev) clearTimeout(prev);
      S._leaveTimers.set(p.userId, setTimeout(() => {
        S._leaveTimers.delete(p.userId);
        if (!flat().some(x => x.userId === p.userId)) closePeer(p.userId);
      }, 4000));
    }
    schedulePeople();
  });
  ch.on('presence', { event: 'join' }, ({ newPresences }) => {
    for (const p of extractPresenceUsers(newPresences)) {
      if (!p.userId) continue;
      const pending = S._leaveTimers.get(p.userId);
      if (pending) { clearTimeout(pending); S._leaveTimers.delete(p.userId); }
      if (S.host) resendGrantsTo(p.userId);
    }
    schedulePeople();
  });
  ch.on('broadcast', { event: 'signal' }, ({ payload }) => signal(payload));
  ch.on('broadcast', { event: 'control' }, ({ payload }) => control(payload));
  ch.on('broadcast', { event: 'chat' }, ({ payload }) => chatAdd(payload));
  ch.on('broadcast', { event: 'ping' }, ({ payload }) => handlePing(payload));
  ch.subscribe(async (st, err) => {
    if (S.channel !== ch) return;
    if (st === 'SUBSCRIBED') {
      S.joined = true;
      S._joinAttempts = 0;
      const tracked = await track(true);
      if (tracked && tracked !== 'ok') console.warn('presence track:', tracked);
      conn(true, 'Conectado');
      renderPeople();
      await loadLogs();
      if (!S.remoteStreams.size) {
        setTimeout(() => { if (S.channel === ch) send(null, 'stream-request', {}); }, 550);
      }
      clearRealtimeTimers();
      S._pingInt = setInterval(() => sendPing(), 15000);
      S._roomInt = setInterval(() => refreshRoom(), 20000);
    } else if (!S._leaving && !S._replacing && S.code && (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT')) {
      console.warn('Rise realtime', st, err || '');
      conn(false, 'Reconectando');
      scheduleRejoin();
    }
  });
}
async function refreshRoom() { if (!S.code) return; const r = normalizeRoom(await roomPublic(S.code)); if (!r || r.closed) { toast('Sala encerrada'); leave(false); return; } S.room = r; setRoomUI(); }
function send(to, type, data = {}) {
  if (!S.channel) return;
  S.channel.send({ type: 'broadcast', event: 'signal', payload: { from: S.uid, to, type, data } }).catch(e => console.warn('send falhou', type, e));
}
function broadcastControl(type, data = {}, to = null) { S.channel?.send({ type: 'broadcast', event: 'control', payload: { from: S.uid, to, type, data, name: S.name } }).catch(() => {}); }
async function permit(uid, allowed = true) {
  if (!S.host) return;
  if (allowed) {
    S.grants.add(uid);
    saveGrants();
    broadcastControl('share-permission', { allowed: true }, uid);
    await log('PERMISSAO_TRANSMISSAO', `Liberada para ${nameOf(uid)}`);
    toast('Permissão enviada');
  } else {
    S.grants.delete(uid);
    saveGrants();
    broadcastControl('share-permission', { allowed: false }, uid);
    await log('PERMISSAO_REVOGADA', nameOf(uid));
    toast('Permissão revogada');
  }
  renderPeople();
}
async function kick(uid) { broadcastControl('kick', {}, uid); await log('EXPULSAO', nameOf(uid)); toast('Participante expulso'); }
function nameOf(uid) { return flat().find(p => p.userId === uid)?.name || uid; }
function control(p) {
  if (p.to && p.to !== S.uid) return;
  if (p.type === 'kick') { toast('Você foi removido pelo host'); setTimeout(() => leave(), 700); }
  if (p.type === 'share-permission') {
    const allowed = !!p.data.allowed;
    const changed = S.shareAllowed !== allowed;
    S.shareAllowed = allowed;
    if (changed) track();
    if (!S.shareAllowed && S.stream) stopShare();
    if (changed) toast(S.shareAllowed ? 'Host liberou sua transmissão' : 'Transmissão bloqueada');
    renderPeople();
  }
  if (p.type === 'room-closed') { toast('Sala encerrada pelo host'); setTimeout(() => leave(), 900); }
  if (p.type === 'room-state') {
    const data = { ...p.data };
    if (data.title) data.title = fixUtf8(data.title);
    S.room = { ...S.room, ...data };
    setRoomUI();
  }
}
function rtc() { return { iceServers: cfg.ICE_SERVERS || [{ urls: 'stun:stun.l.google.com:19302' }], iceCandidatePoolSize: 10 }; }
function queueIce(uid, candidate) { if (!S.pendingIce.has(uid)) S.pendingIce.set(uid, []); S.pendingIce.get(uid).push(candidate); }
async function flushIce(uid, pc) { const list = S.pendingIce.get(uid) || []; for (const c of list) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('ICE pendente', e); } } S.pendingIce.delete(uid); }

function hasTrack(pc, track) {
  return pc.getSenders().some(s => s.track && s.track.id === track.id);
}
async function ensureLocalTracks(pc) {
  if (!S.stream) return false;
  let added = false;
  for (const track of S.stream.getTracks()) {
    if (!hasTrack(pc, track)) {
      try { pc.addTrack(track, S.stream); added = true; console.log('[Rise] track adicionada ao peer', track.kind); } catch (e) { console.warn('ensureLocalTracks addTrack falhou', e); }
    }
  }
  return added;
}
async function renegotiatePeer(uid, pc) {
  if (!pc || pc.connectionState === 'closed' || pc.signalingState !== 'stable') return false;
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    send(uid, 'offer', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    return true;
  } catch (e) {
    console.warn('renegotiatePeer', uid, e);
    return false;
  }
}

async function peer(uid, offerer = false) {
  let pc = S.peers.get(uid);
  if (pc && pc.connectionState === 'closed') { S.peers.delete(uid); pc = null; }
  if (!pc) {
    pc = new RTCPeerConnection(rtc()); S.peers.set(uid, pc);
    if (S.stream) {
      for (const tr of S.stream.getTracks()) {
        try { pc.addTrack(tr, S.stream); } catch (e) { console.warn('addTrack init', e); }
      }
    }
    pc.onicecandidate = e => {
      if (e.candidate) {
        const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
        send(uid, 'ice', { candidate: c });
      }
    };
    pc.ontrack = e => {
      // #region agent log
      fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:ontrack',message:'remote track',data:{uid,kind:e.track.kind,readyState:e.track.readyState,muted:e.track.muted,hasIncomingStream:!!e.streams?.[0],trackId:e.track.id},timestamp:Date.now(),runId:'run1',hypothesisId:'H8'})}).catch(()=>{});
      // #endregion
      let st = S.remoteStreams.get(uid);
      const incomingStream = e.streams?.[0];
      if (!st) {
        if (incomingStream) {
          st = new MediaStream(incomingStream.getTracks().slice());
        } else {
          st = new MediaStream([e.track]);
        }
        S.remoteStreams.set(uid, st);
      } else {
        const exists = st.getTracks().some(t => t.id === e.track.id);
        if (!exists) {
          try { st.addTrack(e.track); } catch { }
        }
        if (incomingStream) {
          for (const t of incomingStream.getTracks()) {
            if (!st.getTracks().some(x => x.id === t.id)) {
              try { st.addTrack(t); } catch { }
            }
          }
        }
      }
      e.track.onunmute = () => console.log('[Rise] track unmuted', uid, e.track.kind);
      e.track.onended = () => console.log('[Rise] track ended', uid, e.track.kind);
      S.remoteStreams.set(uid, st);
      renderPeople();
      const sel = $('#activeStream');
      if (!sel.value || sel.value === uid || sel.value === '') {
        sel.value = uid;
        showStream(uid);
      } else {
        const streamers = flat().filter(p => p.sharing);
        if (streamers.length && !sel.value) {
          sel.value = streamers[0].userId;
          showStream(streamers[0].userId);
        }
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') conn(true, 'Conectado');
      if (state === 'failed') {
        console.warn('WebRTC falhou com', uid, pc.iceConnectionState);
        closePeer(uid);
        setTimeout(() => send(uid, 'stream-request', {}), 900);
      }
      if (state === 'disconnected') {
        console.warn('WebRTC disconnected', uid);
        setTimeout(() => {
          if (pc.connectionState === 'disconnected') {
            closePeer(uid);
            send(uid, 'stream-request', {});
          }
        }, 2800);
      }
    };
    pc.oniceconnectionstatechange = () => { /* debug */ };
  } else {
    if (S.stream) {
      await ensureLocalTracks(pc);
    }
  }
  if (offerer && pc.signalingState === 'stable') {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      send(uid, 'offer', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (e) {
      console.warn('createOffer falhou', uid, e, 'state', pc.signalingState);
    }
  } else if (offerer && pc.signalingState !== 'stable') {
    console.log('[Rise] offer adiado, signalingState', pc.signalingState, uid);
  }
  return pc;
}
async function signal(p) {
  if (!p || (p.to && p.to !== S.uid) || p.from === S.uid) return;
  try {
    if (p.type === 'stream-request') {
      if (S.stream) {
        const now = Date.now();
        const last = S._reqThrottle.get(p.from) || 0;
        if (now - last < 800) return;
        S._reqThrottle.set(p.from, now);
        send(p.from, 'stream-available', { name: S.name });
      }
    } else if (p.type === 'stream-available') {
      // #region agent log
      fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:signal',message:'stream-available recv',data:{from:p.from,hasOld:!!S.peers.get(p.from),oldConnState:S.peers.get(p.from)?.connectionState||null,oldSigState:S.peers.get(p.from)?.signalingState||null,hasRemoteStream:S.remoteStreams.has(p.from)},timestamp:Date.now(),runId:'run1',hypothesisId:'H6'})}).catch(()=>{});
      // #endregion
      const old = S.peers.get(p.from);
      if (old && S.remoteStreams.has(p.from) && ['connected', 'connecting'].includes(old.connectionState)) {
        // #region agent log
        fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:signal',message:'stream-available SKIPPED (already connected)',data:{from:p.from},timestamp:Date.now(),runId:'run1',hypothesisId:'H6'})}).catch(()=>{});
        // #endregion
        return;
      }
      if (old && old.signalingState !== 'stable') {
        console.log('[Rise] stream-available ignorado, sinalização em progresso', p.from, old.signalingState);
        return;
      }
      await peer(p.from, true);
    } else if (p.type === 'stream-stopped') {
      const sel = $('#activeStream');
      const wasSelected = sel.value === p.from;
      closePeer(p.from);
      renderPeople();
      if (wasSelected) {
        const ps = flat().filter(x => x.sharing && x.userId !== p.from);
        const remoteStill = S.remoteStreams;
        let next = null;
        for (const cand of ps) {
          if (remoteStill.has(cand.userId) || cand.userId === S.uid) { next = cand.userId; break; }
        }
        if (!next && remoteStill.size > 0) {
          next = [...remoteStill.keys()][0];
        }
        if (next) {
          sel.value = next;
          showStream(next);
        } else if (S.stream) {
          showLocal();
        } else {
          updateStageView();
          sel.value = '';
        }
      }
    } else if (p.type === 'offer') {
      const pc = await peer(p.from, false);
      await ensureLocalTracks(pc);
      if (pc.signalingState === 'have-local-offer') {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) { console.warn('rollback offer', e); }
      }
      await pc.setRemoteDescription(new RTCSessionDescription(p.data.sdp));
      await flushIce(p.from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send(p.from, 'answer', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } else if (p.type === 'answer') {
      const pc = S.peers.get(p.from);
      if (!pc) return;
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(p.data.sdp));
        await flushIce(p.from, pc);
      } else {
        console.warn('[Rise] answer ignorado, state não é have-local-offer', pc.signalingState);
      }
    } else if (p.type === 'ice') {
      const pc = await peer(p.from, false);
      const c = p.data?.candidate;
      if (!c) return;
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('addIceCandidate falhou, enfileirando', e); queueIce(p.from, c); }
      } else {
        queueIce(p.from, c);
      }
    }
  } catch (e) { console.warn('WebRTC', p.type, p.from, e); toast('Falha na conexão da transmissão. Tentando novamente...'); }
}
function closePeer(uid) {
  const pc = S.peers.get(uid);
  if (pc) {
    try { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); } catch { }
    S.peers.delete(uid);
  }
  S.pendingIce.delete(uid);
  if (S.remoteStreams.has(uid)) {
    const st = S.remoteStreams.get(uid);
    try { st.getTracks().forEach(t => { try { t.stop(); } catch { } }); } catch { }
    S.remoteStreams.delete(uid);
  }
}
async function startShare() {
  if (!S.host && !S.shareAllowed) return toast('O host ainda não liberou sua transmissão');
  if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) return toast('A telagem precisa abrir em HTTPS para compartilhar a tela');
  try {
    if (S.stream) await stopShare(true);
    const q = $('#quality').value, fps = Number($('#fps').value) || 60; const h = q === '1080' ? 1080 : q === '720' ? 720 : 1080;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { height: { ideal: h }, frameRate: { ideal: fps, max: fps } }, audio: true });
    const vt = stream.getVideoTracks()[0]; if (!vt) throw new Error('Nenhuma tela foi selecionada');
    vt.contentHint = 'detail';
    vt.onended = () => stopShare();
    S.stream = stream;
    // #region agent log
    fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:startShare',message:'S.stream set',data:{hasStream:!!S.stream,videoTracks:S.stream.getVideoTracks().map(t=>({id:t.id,readyState:t.readyState,muted:t.muted,enabled:t.enabled,label:t.label})),audioTracks:S.stream.getAudioTracks().length},timestamp:Date.now(),runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    // Força o tile de preview local a recriar e anexar o <video> imediatamente,
    // sem esperar o sync de presença (p.sharing ainda pode estar false aqui).
    const grid0 = $('#tileGrid');
    if (grid0) { grid0.dataset.sig = ''; }
    renderTileGrid();
    for (const [uid, pc] of S.peers) {
      const added = await ensureLocalTracks(pc);
      if (added && pc.signalingState === 'stable') await renegotiatePeer(uid, pc);
    }
    await track();
    await log('TRANSMISSAO_INICIADA', `${q} · ${fps} FPS`);
    showLocal();
    renderPeople();
    S._lastAnnounce = Date.now();
    send(null, 'stream-available', { name: S.name });
    setTimeout(() => send(null, 'stream-available', { name: S.name }), 800);
    if (S.host) { await hostAction('status', 'live'); broadcastControl('room-state', { status: 'live' }); }
    toast('Transmissão iniciada');
  } catch (e) { console.error('Rise getDisplayMedia', e); if (e.name === 'NotAllowedError') toast('Compartilhamento cancelado'); else toast('Não foi possível iniciar a telagem: ' + (e.message || 'erro do navegador')); }
}
function showLocal() { updateStageView(S.uid); }
function showStream(uid) { updateStageView(uid); }

function updateStageView(preferredUid) {
  const stage = $('#stage');
  const main = $('#video');
  const empty = $('#emptyStage');
  const presenting = $('#presentingStage');
  const lb = $('#liveBadge');
  const sel = $('#activeStream');
  if (!stage) return;

  let watchUid = preferredUid || sel?.value || '';
  if (watchUid === S.uid && S.stream) {
    /* mantém S.uid para estado "apresentando" */
  } else if (watchUid === S.uid) {
    watchUid = '';
  }

  let remoteStream = null;
  if (watchUid && watchUid !== S.uid && S.remoteStreams.has(watchUid)) {
    remoteStream = S.remoteStreams.get(watchUid);
  } else if (!S.stream || (watchUid && watchUid !== S.uid)) {
    const others = flat().filter(p => p.sharing && p.userId !== S.uid);
    for (const p of others) {
      if (S.remoteStreams.has(p.userId)) {
        watchUid = p.userId;
        remoteStream = S.remoteStreams.get(p.userId);
        break;
      }
    }
  }

  if (remoteStream && main) {
    // #region agent log
    fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:updateStageView',message:'branch REMOTE',data:{watchUid,remoteStreamId:remoteStream.id,videoTracks:remoteStream.getVideoTracks().length,mainSrcObjectIsNull:main.srcObject===null,mainDisplay:main.style.display},timestamp:Date.now(),runId:'run1',hypothesisId:'H9'})}).catch(()=>{});
    // #endregion
    stage.classList.remove('presentingOnly', 'galleryMode');
    if (empty) empty.style.display = 'none';
    if (presenting) presenting.style.display = 'none';
    if (main.srcObject !== remoteStream) {
      main.srcObject = remoteStream;
      main.muted = false;
      main.playsInline = true;
      main.autoplay = true;
      main.play().then(() => {
      // #region agent log
      fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:updateStageView',message:'main play ok',data:{watchUid,videoW:main.videoWidth,videoH:main.videoHeight,muted:main.muted},timestamp:Date.now(),runId:'run1',hypothesisId:'H10'})}).catch(()=>{});
      // #endregion
    }).catch(err => {
      main.muted = true;
      main.play().catch(() => { });
      // #region agent log
      fetch('http://127.0.0.1:7647/ingest/e257b8b0-203e-46a2-b2e6-82b916c76ec7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e9b9cf'},body:JSON.stringify({sessionId:'e9b9cf',location:'app.js:updateStageView',message:'main play FAIL',data:{watchUid,err:String(err)},timestamp:Date.now(),runId:'run1',hypothesisId:'H10'})}).catch(()=>{});
      // #endregion
    });
    }
    main.style.display = 'block';
    if (sel && watchUid) sel.value = watchUid;
    if (lb) lb.style.display = 'flex';
    const ln = $('#liveName');
    if (ln) ln.textContent = nameOf(watchUid) || 'transmitindo';
  } else if (S.stream && (!watchUid || watchUid === S.uid)) {
    stage.classList.add('presentingOnly');
    stage.classList.remove('galleryMode');
    if (main) { main.srcObject = null; main.style.display = 'none'; try { main.pause(); } catch { } }
    if (empty) empty.style.display = 'none';
    if (presenting) presenting.style.display = 'flex';
    if (sel) sel.value = S.uid;
    if (lb) lb.style.display = 'flex';
    const ln = $('#liveName');
    if (ln) ln.textContent = S.name;
  } else {
    stage.classList.remove('presentingOnly');
    if (main && main.srcObject) {
      main.srcObject = null;
      main.style.display = 'none';
      try { main.pause(); } catch { }
    } else if (main) {
      main.style.display = 'none';
    }
    if (presenting) presenting.style.display = 'none';
    const hasStreamers = flat().some(p => p.sharing);
    const waitingRemote = watchUid && watchUid !== S.uid && !remoteStream && hasStreamers;
    applyGalleryMode();
    if (empty) {
      if (waitingRemote) {
        empty.style.display = 'flex';
        const hint = $('#stageEmptyHint');
        if (hint) hint.textContent = `Conectando transmissão de ${nameOf(watchUid) || 'participante'}...`;
      } else {
        empty.style.display = (stage.classList.contains('galleryMode') || hasStreamers) ? 'none' : 'flex';
      }
    }
    if (lb) lb.style.display = hasStreamers ? 'flex' : 'none';
    if (waitingRemote) send(watchUid, 'stream-request', {});
    else if (watchUid && watchUid !== S.uid && !remoteStream) send(watchUid, 'stream-request', {});
  }
  renderTileGrid();
}
async function stopShare(silent = false) {
  if (!S.stream) return;
  const oldStream = S.stream;
  S.stream = null;
  send(null, 'stream-stopped', {});
  for (const [uid, pc] of [...S.peers.entries()]) {
    try {
      const senders = pc.getSenders().filter(s => s.track && oldStream.getTracks().some(t => t.id === s.track.id));
      for (const snd of senders) {
        try { pc.removeTrack(snd); } catch (e) { console.warn('removeTrack', e); }
      }
      const hasRemote = S.remoteStreams.has(uid);
      const isSharing = flat().some(p => p.userId === uid && p.sharing);
      if (senders.length && !hasRemote && !isSharing && pc.getSenders().filter(s => s.track).length === 0) {
        try { pc.close(); } catch { }
        S.peers.delete(uid);
        S.pendingIce.delete(uid);
      } else if (senders.length && pc.signalingState === 'stable') {
        await renegotiatePeer(uid, pc);
      }
    } catch (e) { console.warn('stopShare peer', uid, e); }
  }
  try { oldStream.getTracks().forEach(t => { try { t.stop(); } catch { } }); } catch { }
  S.pendingIce.clear();
  await track();
  await log('TRANSMISSAO_ENCERRADA');
  const v = $('#video');
  const sel = $('#activeStream');
  const streamers = flat().filter(p => p.sharing);
  if (streamers.length) {
    const next = streamers.find(p => S.remoteStreams.has(p.userId)) || streamers[0];
    if (next) {
      sel.value = next.userId;
      if (next.userId === S.uid) showLocal(); else showStream(next.userId);
    }
  } else if (S.remoteStreams.size > 0) {
    const firstUid = [...S.remoteStreams.keys()][0];
    sel.value = firstUid;
    showStream(firstUid);
  } else {
    const v = $('#video');
    if (v) { v.srcObject = null; v.style.display = 'none'; try { v.pause(); } catch { } }
    $('#stage')?.classList.remove('presentingOnly');
    $('#emptyStage').style.display = 'flex';
    $('#presentingStage').style.display = 'none';
    $('#liveBadge').style.display = 'none';
    sel.value = '';
  }
  renderPeople();
  if (S.host) { await hostAction('status', 'waiting'); broadcastControl('room-state', { status: 'waiting' }); }
  if (!silent) toast('Transmissão encerrada');
}
function chatAdd(p) { const d = document.createElement('div'); d.className = 'msg'; d.innerHTML = `<b>${esc(p.name || 'Usuário')}</b><p>${esc(p.text || '')}</p>`; const cm = $('#chatMessages'); if (!cm) return; cm.appendChild(d); cm.scrollTop = 999999; }
function sendChat() { const i = $('#chatText'), t = i.value.trim(); if (!t) return; const p = { name: S.name, text: t, ts: Date.now() }; chatAdd(p); S.channel?.send({ type: 'broadcast', event: 'chat', payload: p }); i.value = ''; }
function sendPing() { const id = crypto.randomUUID(); S.pingMap.set(id, performance.now()); S.channel?.send({ type: 'broadcast', event: 'ping', payload: { kind: 'req', id, from: S.uid } }); setTimeout(() => S.pingMap.delete(id), 5000); }
function handlePing(p) { if (p.kind === 'req' && p.from !== S.uid) S.channel?.send({ type: 'broadcast', event: 'ping', payload: { kind: 'res', id: p.id, to: p.from, from: S.uid } }); if (p.kind === 'res' && p.to === S.uid && S.pingMap.has(p.id)) { const ms = Math.round(performance.now() - S.pingMap.get(p.id)); S.pingMap.delete(p.id); const pres = flat().find(x => x.userId === p.from); if (pres) pres.ping = ms; } }
function leave(logIt = true) {
  S._leaving = true;
  S.joined = false;
  if (logIt) log('SAIU_DA_SALA');
  clearRealtimeTimers();
  if (S._clockTimer) clearInterval(S._clockTimer);
  togglePeople(false);
  toggleTools(false);
  $('#togglePeople')?.classList.remove('ctrlActive');
  if (isFullscreen()) {
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) exit.call(document);
    } catch { }
  }
  syncFullscreenUI();
  if (S.stream) {
    try { S.stream.getTracks().forEach(t => t.stop()); } catch { }
    S.stream = null;
    try { send(null, 'stream-stopped', {}); } catch { }
  }
  for (const [, pc] of S.peers) { try { pc.close(); } catch { } }
  S.peers.clear(); S.remoteStreams.clear(); S.pendingIce.clear();
  if (S.channel) {
    const old = S.channel;
    S.channel = null;
    try { sb?.removeChannel(old); } catch { }
  }
  for (const t of S._leaveTimers.values()) clearTimeout(t);
  S._leaveTimers.clear();
  S._grantSent.clear();
  S.channel = null; S.presence = {}; S.code = null; S.room = null; S.host = false; S.grants = new Set();
  S.joinedAt = null; S._lastTrack = null; S._joinAttempts = 0; S._replacing = false;
  S._stageSig = null;
  S._leaving = false;
  history.replaceState({}, '', location.pathname); showLanding();
  conn(false, 'Desconectado');
}
function qr() { const body = document.createElement('div'); body.innerHTML = '<h2>QR Code da sala</h2><p>Escaneie para entrar.</p><div id="qrcode"></div>'; openModal(body); setTimeout(() => new QRCode($('#qrcode'), { text: invite(), width: 220, height: 220 }), 20); }
function openModal(node) { $('#modalBody').innerHTML = ''; $('#modalBody').appendChild(node); $('#modal').classList.add('show'); }
function closeModal() { $('#modal').classList.remove('show'); }

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}
function isFullscreen() {
  const el = fsElement();
  const app = $('#app');
  return !!el && (el === app || el === $('#stage'));
}
async function toggleFullscreen() {
  const app = $('#app');
  if (!app) return;
  try {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) await exit.call(document);
    } else {
      toggleTools(false);
      togglePeople(false);
      const req = app.requestFullscreen || app.webkitRequestFullscreen || app.msRequestFullscreen;
      if (!req) return toast('Tela cheia não suportada neste navegador');
      await req.call(app);
    }
  } catch (e) {
    console.warn('fullscreen', e);
    toast('Não foi possível alternar tela cheia');
  }
  syncFullscreenUI();
}
function syncFullscreenUI() {
  const on = isFullscreen();
  const app = $('#app');
  const btn = $('#fullscreen');
  if (app) app.classList.toggle('isFullscreen', on);
  if (btn) {
    btn.classList.toggle('ctrlActive', on);
    btn.title = on ? 'Sair da tela cheia (Esc)' : 'Tela cheia';
    const label = btn.querySelector('.ctrlLabel');
    if (label) label.textContent = on ? 'Reduzir' : 'Expandir';
    const svg = btn.querySelector('.ctrlIcon path');
    if (svg) {
      svg.setAttribute('d', on
        ? 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z'
        : 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z');
    }
  }
}
['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'].forEach(ev => {
  document.addEventListener(ev, syncFullscreenUI);
});

try {
  const elCreate = $('#createRoom'); if (elCreate) elCreate.onclick = createRoom;
  const elJoin = $('#joinRoom'); if (elJoin) elJoin.onclick = () => enterRoom($('#joinCode')?.value || '');
  const elJoinInvite = $('#joinInvite'); if (elJoinInvite) elJoinInvite.onclick = () => enterRoom($('#joinCode')?.value || new URL(location.href).searchParams.get('room') || '');
  const elCopyCode = $('#copyCode'); if (elCopyCode) elCopyCode.onclick = () => copy(S.code, 'Código copiado');
  const elRoomCode = $('#roomCode'); if (elRoomCode) elRoomCode.onclick = () => copy(S.code, 'Código copiado');
  const elCopyInvite = $('#copyInvite'); if (elCopyInvite) elCopyInvite.onclick = () => copy(invite(), 'Link copiado');
  const elShowQr = $('#showQr'); if (elShowQr) elShowQr.onclick = qr;
  const elShare = $('#shareScreen'); if (elShare) elShare.onclick = startShare;
  const elShare2 = $('#shareScreen2'); if (elShare2) elShare2.onclick = startShare;
  const elStop = $('#stopShare'); if (elStop) elStop.onclick = stopShare;
  const elLeave = $('#leaveRoom'); if (elLeave) elLeave.onclick = () => leave();
  const elLeave2 = $('#leaveRoom2'); if (elLeave2) elLeave2.onclick = () => leave();
  const elOpenTools = $('#openTools'); if (elOpenTools) elOpenTools.onclick = () => toggleTools();
  const elCloseTools = $('#closeTools'); if (elCloseTools) elCloseTools.onclick = () => toggleTools(false);
  const elLock = $('#lockBtn'); if (elLock) elLock.onclick = async () => { if (!S.host) return; const locked = !S.room?.locked; if (await hostAction('lock', String(locked))) { broadcastControl('room-state', { locked }); await log(locked ? 'SALA_TRANCADA' : 'SALA_ABERTA'); } };
  const elCloseRoom = $('#closeRoom'); if (elCloseRoom) elCloseRoom.onclick = async () => { if (confirm('Encerrar esta sala para todos?') && await hostAction('close', 'true')) { await log('SALA_ENCERRADA'); broadcastControl('room-closed'); setTimeout(() => leave(false), 500); } };
  const elRename = $('#renameSession'); if (elRename) elRename.onclick = async () => { const t = prompt('Novo nome da sessão:', S.room?.title || ''); if (t && await hostAction('title', t)) { broadcastControl('room-state', { title: t }); await log('SESSAO_RENOMEADA', t); } };
  const elEditName = $('#editName'); if (elEditName) elEditName.onclick = async () => { const n = prompt('Seu nome:', S.name); if (n?.trim()) { S.name = n.trim().slice(0, 28); localStorage.rise_name = S.name; setRoomUI(); await track(); await log('NOME_ALTERADO'); } };
  const elSendChat = $('#sendChat'); if (elSendChat) elSendChat.onclick = sendChat;
  const elChatText = $('#chatText'); if (elChatText) elChatText.onkeydown = e => { if (e.key === 'Enter') sendChat(); };
  const elActive = $('#activeStream'); if (elActive) elActive.onchange = e => showStream(e.target.value);
  const elZoomIn = $('#zoomIn'); if (elZoomIn) elZoomIn.onclick = () => { S.zoom = Math.min(2, S.zoom + .1); const v = $('#video'); if (v) v.style.transform = `scale(${S.zoom})`; };
  const elZoomOut = $('#zoomOut'); if (elZoomOut) elZoomOut.onclick = () => { S.zoom = Math.max(.5, S.zoom - .1); const v = $('#video'); if (v) v.style.transform = `scale(${S.zoom})`; };
  const elFs = $('#fullscreen'); if (elFs) elFs.onclick = () => toggleFullscreen();
  const elTogglePeople = $('#togglePeople'); if (elTogglePeople) elTogglePeople.onclick = () => togglePeople();
  const elClosePeople = $('#closePeople'); if (elClosePeople) elClosePeople.onclick = () => togglePeople(false);
  const elScrim = $('#peopleScrim'); if (elScrim) elScrim.onclick = () => { togglePeople(false); toggleTools(false); };
  const elModalClose = $('#modalClose'); if (elModalClose) elModalClose.onclick = closeModal;
  const elJoinMode = $('#joinMode'); if (elJoinMode) elJoinMode.onchange = e => { S.role = e.target.value; track(); setRoomUI(); };
  $$('.tabs button').forEach(b => b.onclick = () => { $$('.tabs button').forEach(x => x.classList.remove('active')); b.classList.add('active'); $$('.tab').forEach(x => x.classList.remove('show')); const tabEl = $('#' + b.dataset.tab + 'Tab'); if (tabEl) tabEl.classList.add('show'); if (b.dataset.tab === 'logs') loadLogs(); });
} catch (e) { console.warn('wiring fail', e); }
window.addEventListener('beforeunload', () => { S.stream?.getTracks().forEach(t => t.stop()); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.joined && !S._leaving) track();
});
(async () => {
  if (!okCfg) { toast('Falta colocar a chave publishable completa no config.js'); return; }
  const u = new URL(location.href), r = u.searchParams.get('room');
  if (localStorage.rise_name) {
    $('#displayName').value = localStorage.rise_name;
    $('#displayName')?.dispatchEvent(new Event('input'));
    S.name = localStorage.rise_name;
  }
  if (r) {
    setInviteMode(r);
    setTimeout(() => $('#displayName')?.focus(), 50);
  }
})();

const nickInput = document.querySelector('#displayName'), nickCount = document.querySelector('#nickCount');
if (nickInput && nickCount) { const upd = () => { nickCount.textContent = `${nickInput.value.length}/28`; nickInput.classList.remove('homeInputError'); }; nickInput.addEventListener('input', upd); upd(); }
const homeCard = document.querySelector('.homeCard');
if (homeCard) {
  homeCard.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.repeat) return;
    const id = e.target && e.target.id;
    if (id === 'joinCode') { e.preventDefault(); $('#joinRoom')?.click(); }
    else if (id === 'displayName' && $('#landing')?.classList.contains('inviteMode')) { e.preventDefault(); $('#joinInvite')?.click(); }
    else if (id === 'displayName' || id === 'roomTitle' || id === 'roomPassword') { e.preventDefault(); $('#createRoom')?.click(); }
  });
}
