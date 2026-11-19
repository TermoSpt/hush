'use strict';
/* global MD, Est, Backend */

// =====================================================================
// helpers
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = MD.esc;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
const fmtCtx = (n) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));
const errText = (e) => (typeof e === 'string' ? e : (e && e.message) || String(e));
const GiB = Est.GiB;

function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}

function modal({ title, body = '', okText = 'OK', cancelText = 'Cancel', danger = false, input = null }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    const card = $('#modal-card');
    card.innerHTML = `<h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ''}` +
      (input ? `<input id="modal-input" type="${input.type || 'text'}" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}">` : '') +
      `<div class="row">${cancelText ? `<button class="btn ghost" data-r="0" type="button">${esc(cancelText)}</button>` : ''}` +
      `<button class="btn ${danger ? 'danger' : 'primary'}" data-r="1" type="button">${esc(okText)}</button></div>`;
    m.hidden = false;
    const inp = $('#modal-input');
    (inp || card.querySelector('[data-r="1"]')).focus();
    const done = (ok) => {
      m.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(input ? (ok ? inp.value : null) : ok);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    document.addEventListener('keydown', onKey, true);
    card.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); };
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Copied');
}

const readB64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

// =====================================================================
// state
// =====================================================================
const DEFAULT_CHAT = {
  num_ctx: 8192, temperature: null, top_p: null, top_k: null, min_p: null,
  repeat_penalty: null, num_predict: null, seed: null, think: 'default', system: '',
};
const DEFAULT_PREFS = {
  defaults: clone(DEFAULT_CHAT),
  defaultModel: '',
  keepAlive: '10m',
  kvType: 'f16',
  flashAttention: false,
  vramOverrideGB: 0,
  ollamaUrl: '127.0.0.1:11434',
  autoLockMin: 15,
};

const S = {
  mode: null,            // 'ephemeral' | 'vault'
  chats: [],
  activeId: null,
  prefs: clone(DEFAULT_PREFS),
  calib: {},             // model -> ratio between Ollama's real size and our estimate
  models: [],
  info: {},              // model -> /api/show
  ps: [],
  gpu: [],
  connected: null,
  version: '',
  gen: null,             // { reqId, chatId, msgId }
  pending: [],           // attachments for the next message
  pulls: {},             // model -> { status, pct, reqId }
  lastActivity: Date.now(),
};

const activeChat = () => S.chats.find((c) => c.id === S.activeId) || null;

function newChat(select = true) {
  const chat = {
    id: uid(),
    title: 'New chat',
    created: Date.now(),
    updated: Date.now(),
    model: S.prefs.defaultModel && S.models.some((m) => m.name === S.prefs.defaultModel) ? S.prefs.defaultModel : (S.models[0] && S.models[0].name) || '',
    settings: clone(S.prefs.defaults),
    ephemeral: false,
    messages: [],
  };
  S.chats.unshift(chat);
  if (select) S.activeId = chat.id;
  if (chat.model) ensureInfo(chat.model);
  return chat;
}

// ---------------------------------------------------------------- persistence
let saveTimer = null;
function serialize() {
  return JSON.stringify({
    v: 1,
    prefs: S.prefs,
    calib: S.calib,
    activeId: S.activeId,
    chats: S.chats.filter((c) => !c.ephemeral).map((c) => ({ ...c, messages: c.messages.filter((m) => !m.pending) })),
  });
}
function persist() {
  if (S.mode !== 'vault') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPersist, 700);
}
async function flushPersist() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (S.mode !== 'vault') return;
  try { await Backend.vaultSave(serialize()); }
  catch (e) { toast(`Couldn't save to the vault: ${errText(e)}`, 'bad'); }
}
function loadVaultData(text) {
  let data = {};
  try { data = JSON.parse(text || '{}'); } catch (_) { toast('Vault data looked damaged; starting fresh.', 'bad'); }
  S.prefs = { ...clone(DEFAULT_PREFS), ...(data.prefs || {}) };
  S.prefs.defaults = { ...clone(DEFAULT_CHAT), ...(S.prefs.defaults || {}) };
  S.calib = data.calib || {};
  S.chats = (data.chats || []).map((c) => ({ ...c, settings: { ...clone(DEFAULT_CHAT), ...(c.settings || {}) } }));
  S.activeId = S.chats.some((c) => c.id === data.activeId) ? data.activeId : (S.chats[0] && S.chats[0].id) || null;
}

// =====================================================================
// Ollama
// =====================================================================
async function refreshModels() {
  try {
    const tags = await Backend.get('/api/tags');
    S.models = (tags.models || []).sort((a, b) => a.name.localeCompare(b.name));
    if (!S.connected) {
      S.connected = true;
      try { S.version = (await Backend.get('/api/version')).version || ''; } catch (_) { /* optional */ }
    }
    const chat = activeChat();
    if (chat && !chat.model && S.models[0]) { chat.model = S.models[0].name; }
    if (chat && chat.model) await ensureInfo(chat.model);
  } catch (e) {
    S.connected = false;
    S.connError = errText(e);
  }
  renderConn();
  renderTopbar();
}

async function ensureInfo(model) {
  if (!model || S.info[model]) return S.info[model];
  try {
    S.info[model] = await Backend.post('/api/show', { model });
    if (activeChat() && activeChat().model === model) { renderTopbar(); renderTune(); }
  } catch (_) { /* model may have been deleted */ }
  return S.info[model];
}

async function refreshPs() {
  try { S.ps = (await Backend.get('/api/ps')).models || []; } catch (_) { S.ps = []; }
  calibrate();
}
async function refreshGpu() {
  try { S.gpu = await Backend.gpuInfo(); } catch (_) { S.gpu = []; }
}

function capabilities(model) {
  const info = S.info[model];
  if (!info) return [];
  if (Array.isArray(info.capabilities)) return info.capabilities;
  return [];
}

function modelDefaults(model) {
  const out = {};
  const p = S.info[model] && S.info[model].parameters;
  if (!p) return out;
  for (const line of p.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(.+)$/);
    if (m && !isNaN(parseFloat(m[2]))) out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

function loadedEntry(model) {
  return S.ps.find((p) => p.name === model || p.model === model);
}

// ---------------------------------------------------------------- memory model
function vramBudget() {
  if (S.prefs.vramOverrideGB > 0) return { total: S.prefs.vramOverrideGB * GiB, other: 0, source: 'manual', name: 'Manual setting' };
  const g = S.gpu[0];
  if (!g) return null;
  const total = g.total_mb * 1048576;
  const ollamaVram = S.ps.reduce((s, p) => s + (p.size_vram || 0), 0);
  const other = Math.max(0, g.used_mb * 1048576 - ollamaVram);
  return { total, other, source: 'nvidia-smi', name: g.name };
}

function estimateFor(model, ctx, withCalibration = true) {
  const m = S.models.find((x) => x.name === model);
  if (!m) return null;
  const info = S.info[model];
  return Est.estimate({
    weightsBytes: m.size || 0,
    archInfo: info ? Est.arch(info.model_info) : null,
    ctx,
    kvType: S.prefs.kvType,
    flashAttention: S.prefs.flashAttention,
    calibration: withCalibration ? S.calib[model] || 1 : 1,
  });
}

function calibrate() {
  for (const p of S.ps) {
    if (!p.context_length || !p.size) continue;
    const raw = estimateFor(p.name, p.context_length, false);
    if (!raw || !raw.total) continue;
    const ratio = p.size / raw.total;
    if (ratio > 0.6 && ratio < 1.6) S.calib[p.name] = ratio;
  }
}

function memState(model, ctx) {
  const est = estimateFor(model, ctx);
  if (!est) return null;
  const budget = vramBudget();
  const loaded = loadedEntry(model);
  let status = 'unknown';
  let gpuShare = null;
  if (budget) {
    const free = budget.total - budget.other;
    const ratio = est.total / free;
    status = ratio <= 0.92 ? 'ok' : ratio <= 1 ? 'tight' : 'spill';
    gpuShare = Math.max(0, Math.min(1, free / est.total));
  }
  let actual = null;
  if (loaded && loaded.size) {
    actual = { size: loaded.size, vram: loaded.size_vram || 0, ctx: loaded.context_length || null };
    actual.gpuPct = Math.round((actual.vram / actual.size) * 100);
  }
  return { est, budget, status, gpuShare, actual };
}

function maxCtxFor(model) {
  const info = S.info[model];
  const a = info ? Est.arch(info.model_info) : null;
  return (a && a.maxCtx) || 131072;
}

function fitCtxFor(model) {
  const budget = vramBudget();
  const m = S.models.find((x) => x.name === model);
  if (!budget || !m) return null;
  const info = S.info[model];
  return Est.fitCtx({
    weightsBytes: m.size || 0,
    archInfo: info ? Est.arch(info.model_info) : null,
    kvType: S.prefs.kvType,
    flashAttention: S.prefs.flashAttention,
    calibration: S.calib[model] || 1,
  }, budget.total - budget.other, maxCtxFor(model));
}

// =====================================================================
// chat <-> API
// =====================================================================
function splitThink(content) {
  const m = (content || '').match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { think: '', body: content || '', open: false };
  return { think: m[1], body: content.slice(m[0].length).replace(/^\s+/, ''), open: !m[2] };
}

function apiContent(m) {
  let text = m.role === 'assistant' ? splitThink(m.content).body : m.content || '';
  for (const f of m.files || []) text += `\n\n<file name="${f.name}">\n${f.text}\n</file>`;
  return text;
}

function toApiMessages(chat) {
  const out = [];
  if (chat.settings.system && chat.settings.system.trim()) out.push({ role: 'system', content: chat.settings.system });
  for (const m of chat.messages) {
    if (m.pending) continue;
    if (m.role === 'assistant' && (m.error || !m.content)) continue;
    const msg = { role: m.role, content: apiContent(m) };
    if (m.images && m.images.length) msg.images = m.images.map((i) => i.b64);
    out.push(msg);
  }
  return out;
}

function buildOptions(cs) {
  const o = { num_ctx: Number(cs.num_ctx) || 8192 };
  for (const k of ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'num_predict', 'seed']) {
    if (cs[k] !== null && cs[k] !== undefined && cs[k] !== '') o[k] = Number(cs[k]);
  }
  return o;
}

function keepAliveValue() {
  const v = S.prefs.keepAlive;
  if (v === '0') return 0;
  if (v === '-1') return -1;
  return v;
}

const estTokens = (text) => Math.ceil((text || '').length / 3.8);

function ctxUsage(chat) {
  const pendingText = $('#input').value + S.pending.filter((a) => a.kind === 'text').map((a) => a.text).join('');
  const pendingImgs = S.pending.filter((a) => a.kind === 'image').length;
  const msgs = chat.messages.filter((m) => !m.pending);
  let lastIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant' && msgs[i].stats) { lastIdx = i; break; }
  let used = 0;
  let exact = false;
  if (lastIdx >= 0) {
    const st = msgs[lastIdx].stats;
    used = (st.prompt_eval_count || 0) + (st.eval_count || 0);
    exact = true;
  } else if (chat.settings.system) used += estTokens(chat.settings.system);
  for (const m of msgs.slice(lastIdx + 1)) {
    used += estTokens(apiContent(m)) + (m.images ? m.images.length * 768 : 0);
    exact = false;
  }
  used += estTokens(pendingText) + pendingImgs * 768;
  if (pendingText || pendingImgs) exact = false;
  return { used, exact, limit: Number(chat.settings.num_ctx) || 8192 };
}

// ---------------------------------------------------------------- sending
async function send() {
  if (S.gen) return;
  let chat = activeChat();
  if (!chat) chat = newChat();
  const text = $('#input').value.trim();
  if (!text && !S.pending.length) return;
  if (!S.connected) { toast(S.connError || "Can't reach Ollama.", 'bad'); return; }
  if (!chat.model) { toast('Pick a model first (top left).', 'bad'); return; }
  await ensureInfo(chat.model);
  const images = S.pending.filter((a) => a.kind === 'image');
  if (images.length && !capabilities(chat.model).includes('vision')) {
    toast(`${chat.model} can't see images. Pick a model tagged "vision", or remove the image.`, 'bad');
    return;
  }
  const msg = {
    id: uid(), role: 'user', content: text,
    images: images.map(({ name, mime, b64 }) => ({ name, mime, b64 })),
    files: S.pending.filter((a) => a.kind === 'text').map(({ name, size, text: t }) => ({ name, size, text: t })),
  };
  chat.messages.push(msg);
  if (chat.title === 'New chat') chat.title = (text || msg.files.map((f) => f.name).join(', ') || 'Image').replace(/\s+/g, ' ').slice(0, 52);
  $('#input').value = '';
  autoGrow();
  S.pending = [];
  renderAttachments();
  await generate(chat);
}

async function generate(chat) {
  const asst = { id: uid(), role: 'assistant', content: '', thinking: '', model: chat.model, pending: true, stats: null };
  asst.loadingNote = loadedEntry(chat.model) ? 'Reading your message…' : 'Loading the model into memory…';
  chat.messages.push(asst);
  chat.updated = Date.now();
  const body = {
    model: chat.model,
    messages: toApiMessages(chat),
    options: buildOptions(chat.settings),
    keep_alive: keepAliveValue(),
  };
  const think = chat.settings.think;
  if (think && think !== 'default' && capabilities(chat.model).includes('thinking')) {
    body.think = think === 'on' ? true : think === 'off' ? false : think;
  }
  const reqId = uid();
  S.gen = { reqId, chatId: chat.id, msgId: asst.id };
  let gotDone = false;
  renderSidebar();
  renderMessages(true);
  renderComposerState();
  try {
    await Backend.stream('/api/chat', body, reqId, (ev) => {
      if (ev.hush_cancelled) { asst.stopped = true; gotDone = true; return; }
      if (ev.message) {
        asst.content += ev.message.content || '';
        asst.thinking += ev.message.thinking || '';
      }
      if (ev.done) {
        gotDone = true;
        asst.stats = {
          prompt_eval_count: ev.prompt_eval_count, prompt_eval_duration: ev.prompt_eval_duration,
          eval_count: ev.eval_count, eval_duration: ev.eval_duration,
          load_duration: ev.load_duration, total_duration: ev.total_duration, done_reason: ev.done_reason,
        };
      }
      scheduleStreamRender(asst);
    });
    for (let i = 0; i < 10 && !gotDone; i++) await sleep(50); // let trailing events land
  } catch (e) {
    asst.error = errText(e);
  } finally {
    asst.pending = false;
    delete asst.loadingNote;
    S.gen = null;
    chat.updated = Date.now();
    if (chat.id === S.activeId) renderMessages(false);
    renderComposerState();
    renderCtxBar();
    persist();
    await refreshPs();
    renderTopbar();
    if (!$('#tune').hidden) renderMemCard();
  }
}

function stop() {
  if (S.gen) Backend.cancel(S.gen.reqId);
}

let streamFrame = null;
function scheduleStreamRender(m) {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = null;
    if (!S.gen || S.gen.chatId !== S.activeId) return;
    const node = $(`.msg[data-id="${m.id}"]`);
    if (!node) return;
    const box = $('#messages');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const bubble = $('.bubble', node);
    bubble.innerHTML = assistantBody(m);
    bubble.classList.toggle('cursor', !!m.pending && !!splitThink(m.content).body);
    if (stick) box.scrollTop = box.scrollHeight;
  });
}

// =====================================================================
// rendering
// =====================================================================
function renderAll() {
  renderSidebar();
  renderTopbar();
  renderMessages(true);
  renderComposerState();
  renderAttachments();
  renderCtxBar();
  if (!$('#tune').hidden) renderTune();
}

function renderConn() {
  const c = $('#conn');
  c.className = 'conn' + (S.connected ? ' on' : '');
  c.innerHTML = S.connected
    ? `<i></i> Ollama ${esc(S.version)} · on this PC`
    : `<i></i> Ollama not reachable`;
  c.title = S.connected ? '' : S.connError || '';
}

function renderSidebar() {
  const b = $('#mode-badge');
  if (S.mode === 'vault') {
    b.className = 'mode-badge vault';
    b.innerHTML = '<b>Vault unlocked</b><br>Chats saved encrypted · click to lock';
  } else {
    b.className = 'mode-badge';
    b.innerHTML = '<b>Ephemeral session</b><br>Nothing is written to disk';
  }
  const list = $('#chat-list');
  const chats = [...S.chats].sort((a, b) => b.updated - a.updated);
  list.innerHTML = chats.length ? '' : '<div class="chat-empty">No chats yet.</div>';
  for (const c of chats) {
    const d = document.createElement('div');
    d.className = 'chat-item' + (c.id === S.activeId ? ' active' : '');
    d.dataset.id = c.id;
    const live = S.gen && S.gen.chatId === c.id ? ' ●' : '';
    const ghost = S.mode === 'vault' && c.ephemeral ? '<span class="chip" title="Not saved to the vault">not saved</span>' : '';
    d.innerHTML = `<span class="t" title="Double-click to rename">${esc(c.title)}${live}</span>${ghost}<button class="x" title="Delete chat" type="button">×</button>`;
    list.appendChild(d);
  }
}

function renderTopbar() {
  const sel = $('#model-select');
  const chat = activeChat();
  const current = chat ? chat.model : '';
  sel.innerHTML = S.models.length
    ? S.models.map((m) => `<option value="${esc(m.name)}"${m.name === current ? ' selected' : ''}>${esc(m.name)}</option>`).join('')
    : `<option value="">${S.connected ? 'No models installed' : 'Ollama not running'}</option>`;
  if (current && !S.models.some((m) => m.name === current)) {
    sel.insertAdjacentHTML('afterbegin', `<option value="${esc(current)}" selected>${esc(current)} (missing)</option>`);
  }
  const caps = capabilities(current);
  const show = ['vision', 'thinking', 'tools'];
  $('#caps').innerHTML = caps.filter((c) => show.includes(c)).map((c) => `<span class="chip on">${esc(c)}</span>`).join('');
  renderGauge();
}

function gaugeBar(ms) {
  const { est, budget } = ms;
  const cap = budget ? Math.max(budget.total, budget.other + est.total) : est.total;
  const pct = (b) => `${Math.max(0, (b / cap) * 100).toFixed(2)}%`;
  let html = '';
  if (budget && budget.other) html += `<span class="seg-other" style="width:${pct(budget.other)}" title="Used by other apps"></span>`;
  html += `<span class="seg-w" style="width:${pct(est.weights)}"></span><span class="seg-kv" style="width:${pct(est.kv)}"></span><span class="seg-o" style="width:${pct(est.overhead)}"></span>`;
  if (budget && budget.other + est.total > budget.total) {
    html = `<span style="position:absolute;left:${pct(budget.total)};top:0;bottom:0;width:2px;background:var(--text)"></span>` + html;
  }
  return `<span class="gauge-bar">${html}</span>`;
}

const STATUS_TEXT = { ok: 'fits on GPU', tight: 'tight fit', spill: 'spills to CPU', unknown: '' };

function renderGauge() {
  const g = $('#mem-gauge');
  const chat = activeChat();
  const ms = chat && chat.model ? memState(chat.model, chat.settings.num_ctx) : null;
  if (!ms) { g.innerHTML = ''; return; }
  const total = ms.budget ? Est.fmtGB(ms.budget.total) : '?';
  let text;
  if (ms.budget) {
    text = `≈ ${Est.fmtGB(ms.est.total + ms.budget.other).replace(' GB', '')} / ${total} · <span class="status ${ms.status}">${STATUS_TEXT[ms.status]}</span>`;
  } else {
    text = `≈ ${Est.fmtGB(ms.est.total)} needed · <span class="status tight">set GPU size in Tune</span>`;
  }
  if (ms.actual && ms.actual.gpuPct < 95) text += ` · <span class="status spill">now ${ms.actual.gpuPct}% GPU</span>`;
  g.innerHTML = gaugeBar(ms) + `<span>${text}</span>`;
}

function renderCtxBar() {
  const chat = activeChat();
  const bar = $('#ctx-bar');
  if (!chat) { bar.innerHTML = ''; return; }
  const u = ctxUsage(chat);
  const pct = Math.min(100, (u.used / u.limit) * 100);
  bar.className = 'ctx-bar' + (u.used > u.limit ? ' bad' : pct > 85 ? ' warn' : '');
  let label = `${u.exact ? '' : '≈ '}${fmtInt(u.used)} / ${fmtInt(u.limit)} tokens of context`;
  if (u.used > u.limit) label += ' · the oldest messages no longer fit and will be cut off. Raise the context or start a new chat.';
  else if (pct > 85) label += ' · almost full';
  bar.innerHTML = `<span>${label}</span><span class="ctx-track"><span class="ctx-fill" style="width:${pct}%"></span></span>`;
}

function fmtStats(st) {
  if (!st) return '';
  const parts = [];
  if (st.eval_count && st.eval_duration) parts.push(`${(st.eval_count / (st.eval_duration / 1e9)).toFixed(1)} tok/s`);
  if (st.eval_count) parts.push(`${fmtInt(st.eval_count)} tokens`);
  const first = (st.load_duration || 0) + (st.prompt_eval_duration || 0);
  if (first) parts.push(`first token ${(first / 1e9).toFixed(1)}s`);
  if (st.load_duration > 1e9) parts.push(`model load ${(st.load_duration / 1e9).toFixed(1)}s`);
  let html = parts.map(esc).join(' · ');
  if (st.done_reason === 'length') html += ' · <span class="warn">hit the max response length</span>';
  return html;
}

function assistantBody(m) {
  const t = splitThink(m.content);
  const thinking = (m.thinking || '') + t.think;
  const body = t.body;
  let html = '';
  if (thinking) {
    const live = m.pending && !body;
    const open = live || m.thinkOpen;
    const words = thinking.trim().split(/\s+/).length;
    html += `<details class="think"${open ? ' open' : ''} data-msg="${m.id}"><summary>${live ? 'Thinking…' : 'Thought process'} · ${fmtInt(words)} words</summary><div class="think-body">${esc(thinking)}</div></details>`;
  }
  if (body) html += MD.render(body);
  else if (m.pending && !thinking) html += `<div class="waiting">${esc(m.loadingNote || 'Waiting for the model…')}</div>`;
  if (m.stopped && !m.pending) html += '<div class="msg-meta"><span class="warn">Stopped</span></div>';
  if (m.error) html += `<div class="err">${esc(m.error)}</div>`;
  return html;
}

function messageHtml(m, isLast) {
  const user = m.role === 'user';
  let files = '';
  if (m.images && m.images.length) files += m.images.map((i) => `<img src="data:${esc(i.mime || 'image/png')};base64,${i.b64}" alt="${esc(i.name || 'image')}">`).join('');
  if (m.files && m.files.length) files += m.files.map((f) => `<span class="file-chip">📄 ${esc(f.name)} · ${fmtInt(estTokens(f.text))} tokens</span>`).join('');
  const body = user ? esc(m.content) : assistantBody(m);
  const actions = user
    ? '<button data-act="edit" type="button">Edit</button><button data-act="copy" type="button">Copy</button><button data-act="del" type="button">Delete</button>'
    : `<button data-act="copy" type="button">Copy</button>${isLast ? '<button data-act="regen" type="button">Regenerate</button>' : ''}<button data-act="del" type="button">Delete</button>`;
  const who = user ? 'You' : esc(m.model || 'Assistant');
  return `<div class="msg ${m.role}" data-id="${m.id}"><div class="avatar">${user ? 'you' : 'ai'}</div><div>` +
    `<div class="who">${who}</div>${files ? `<div class="msg-files">${files}</div>` : ''}` +
    `<div class="bubble${!user && m.pending && splitThink(m.content).body ? ' cursor' : ''}">${body}</div>` +
    `<div class="msg-meta">${user ? '' : fmtStats(m.stats)}${m.pending ? '' : `<span class="msg-actions">${actions}</span>`}</div></div></div>`;
}

function emptyState() {
  const fit = activeChat() && activeChat().model ? fitCtxFor(activeChat().model) : null;
  return `<div class="empty-state"><h1>${S.mode === 'vault' ? 'Private, saved, encrypted.' : 'Private. Nothing gets saved.'}</h1>` +
    `<p>Everything runs on this PC through Ollama. ${S.mode === 'vault' ? 'This chat is stored in your encrypted vault.' : 'Close Hush or press Wipe and this conversation is gone.'}</p>` +
    '<div class="tips">' +
    '<div class="tip"><b>Paste or drop anything</b>Screenshots go to vision models. Code, text and PDFs are added to your message.</div>' +
    `<div class="tip"><b>Watch the memory gauge</b>Top right. Green means the model and its context fit on your GPU${fit ? `, up to about ${fmtCtx(fit)} tokens for this model` : ''}.</div>` +
    '<div class="tip"><b>Tune per chat</b>Context size, creativity, thinking and a system prompt. Every setting says what it does.</div>' +
    '<div class="tip"><b>Wipe in one click</b>Ctrl+Shift+L clears the session, unloads the model from GPU memory and empties the clipboard.</div>' +
    '</div></div>';
}

function renderMessages(scrollToEnd) {
  const box = $('#messages');
  const chat = activeChat();
  if (!chat || !chat.messages.length) { box.innerHTML = emptyState(); renderCtxBar(); return; }
  const lastAsst = [...chat.messages].reverse().find((m) => m.role === 'assistant');
  box.innerHTML = chat.messages.map((m) => messageHtml(m, lastAsst && m.id === lastAsst.id && m === chat.messages[chat.messages.length - 1])).join('');
  if (scrollToEnd) box.scrollTop = box.scrollHeight;
  renderCtxBar();
}

function renderComposerState() {
  const btn = $('#send-btn');
  const busy = !!S.gen;
  btn.textContent = busy ? 'Stop' : 'Send';
  btn.classList.toggle('stop', busy);
}

function renderAttachments() {
  const chat = activeChat();
  const vision = chat && capabilities(chat.model).includes('vision');
  $('#attachments').innerHTML = S.pending.map((a, i) => {
    if (a.kind === 'image') {
      const warn = chat && chat.model && S.info[chat.model] && !vision;
      return `<div class="att${warn ? ' warn' : ''}" title="${warn ? 'This model cannot see images' : ''}"><img src="data:${esc(a.mime)};base64,${a.b64}" alt=""><span class="n">${esc(a.name)}<small>${warn ? 'model can’t see images' : 'image'}</small></span><button class="rm" data-i="${i}" type="button">×</button></div>`;
    }
    return `<div class="att"><span class="n">📄 ${esc(a.name)}<small>≈ ${fmtInt(estTokens(a.text))} tokens${a.from === 'pdf' ? ' · from PDF' : ''}</small></span><button class="rm" data-i="${i}" type="button">×</button></div>`;
  }).join('');
  renderCtxBar();
}

// =====================================================================
// tune panel
// =====================================================================
const FIELDS = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05, fallback: 0.8,
    help: 'How adventurous word choice is. 0.1–0.4 for code and facts, around 0.7 for conversation, above 1 for brainstorming.' },
  { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01, fallback: 0.9,
    help: 'Only pick from the most likely words whose chances add up to this. Lower is safer and more focused.' },
  { key: 'min_p', label: 'Min P', min: 0, max: 0.5, step: 0.01, fallback: 0.05,
    help: 'Ignore words less than this fraction as likely as the top choice. A modern, gentler alternative to Top P.' },
  { key: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, fallback: 40,
    help: 'Only consider the K most likely next words. 0 turns it off.' },
  { key: 'repeat_penalty', label: 'Repeat penalty', min: 0.8, max: 2, step: 0.01, fallback: 1.1,
    help: 'Discourages repeating itself. 1.0 is off. Too high and the text gets strange.' },
  { key: 'num_predict', label: 'Max response length', min: 64, max: 32768, step: 64, fallback: 2048,
    help: 'Hard cap on tokens per answer. Auto lets the model finish on its own (or until the context is full).' },
  { key: 'seed', label: 'Seed', number: true, fallback: 42,
    help: 'Same seed + same settings + same conversation gives the same answer. Auto picks a random one each time.' },
];

function ctxSteps(model) {
  const max = maxCtxFor(model);
  const steps = Est.CTX_STEPS.filter((c) => c <= max);
  if (!steps.includes(max) && max < Est.CTX_STEPS[Est.CTX_STEPS.length - 1]) steps.push(max);
  return steps;
}

function renderTune() {
  const chat = activeChat();
  const body = $('#tune-body');
  if (!chat) { body.innerHTML = '<p class="help">Start a chat to tune it.</p>'; return; }
  const cs = chat.settings;
  const model = chat.model;
  const steps = ctxSteps(model);
  let idx = steps.findIndex((s) => s >= cs.num_ctx);
  if (idx < 0) idx = steps.length - 1;
  const maxCtx = maxCtxFor(model);
  const defs = modelDefaults(model);
  const caps = capabilities(model);
  const fit = fitCtxFor(model);

  let html = `<div id="mem-card" class="mem-card"></div>
    <div class="field"><label>Context window <span class="val" id="ctx-val">${fmtInt(cs.num_ctx)} tokens</span></label>
      <input type="range" id="ctx-range" min="0" max="${steps.length - 1}" step="1" value="${idx}">
      <div class="row" style="justify-content:space-between"><span class="def" id="ctx-pages">≈ ${Est.pages(cs.num_ctx)} pages of text · model max ${fmtCtx(maxCtx)}</span>
      ${fit ? `<button class="btn small" id="ctx-fit" type="button" title="Largest context that keeps everything on the GPU">Fit to GPU (${fmtCtx(fit)})</button>` : ''}</div>
      <p class="help">How much of the conversation (and attached files) the model can see at once. Anything beyond this is silently cut from the start. Bigger needs more GPU memory: watch the gauge.</p></div>`;

  if (caps.includes('thinking')) {
    const opts = [['default', 'Model default'], ['on', 'On'], ['off', 'Off'], ['low', 'Low effort'], ['medium', 'Medium effort'], ['high', 'High effort']];
    html += `<div class="field"><label>Thinking</label><select id="think">${opts.map(([v, l]) => `<option value="${v}"${cs.think === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <p class="help">Lets the model reason before answering (shown folded above the answer). Better for hard problems, slower and uses more context. Effort levels only work on models that support them (like gpt-oss).</p></div>`;
  }

  html += `<div class="field"><label>System prompt</label><textarea id="system" placeholder="e.g. You are a senior Rust engineer. Answer concisely.">${esc(cs.system || '')}</textarea>
    <p class="help">Standing instructions for this chat. Uses context like any message.</p></div>`;

  html += '<div class="t-sec">Sampling</div>';
  for (const f of FIELDS) {
    const auto = cs[f.key] === null || cs[f.key] === undefined || cs[f.key] === '';
    const md = defs[f.key];
    const val = auto ? (md !== undefined ? md : f.fallback) : cs[f.key];
    const defLabel = md !== undefined ? `model default ${md}` : 'Ollama default';
    const input = f.number
      ? `<input type="number" data-k="${f.key}" value="${esc(val)}"${auto ? ' disabled' : ''}>`
      : `<input type="range" data-k="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${esc(val)}"${auto ? ' disabled' : ''}>`;
    html += `<div class="field${auto ? ' is-auto' : ''}" data-field="${f.key}"><label>${f.label}
      <span class="row" style="margin:0"><span class="val">${auto ? 'auto' : esc(val)}</span>
      <span class="auto-toggle"><input type="checkbox" data-auto="${f.key}"${auto ? ' checked' : ''}>auto</span></span></label>
      ${input}<div class="def">${esc(defLabel)}</div><p class="help">${f.help}</p></div>`;
  }

  if (S.mode === 'vault') {
    html += `<div class="field"><label><span>Keep this chat out of the vault</span><input type="checkbox" id="chat-eph"${chat.ephemeral ? ' checked' : ''}></label>
      <p class="help">The chat stays in memory only and disappears when you lock or close Hush.</p></div>`;
  }
  html += '<div class="row" style="display:flex;gap:8px"><button class="btn small" id="save-defaults" type="button">Use these for new chats</button><button class="btn small ghost" id="reset-chat" type="button">Reset to defaults</button></div>';

  // ---- global
  const kvOpts = [['f16', 'f16 (Ollama default)'], ['q8_0', 'q8_0 (half the memory, near-identical quality)'], ['q4_0', 'q4_0 (quarter memory, some quality loss)']];
  const kaOpts = [['0', 'Unload right after each answer'], ['5m', '5 minutes'], ['10m', '10 minutes'], ['30m', '30 minutes'], ['-1', 'Until I wipe or quit Ollama']];
  const gpu = S.gpu[0];
  html += `<div class="t-sec">This PC (all chats)</div>
    <div class="field"><label>Keep model in GPU memory</label><select id="keep-alive">${kaOpts.map(([v, l]) => `<option value="${v}"${S.prefs.keepAlive === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <p class="help">Loading a model takes seconds; keeping it loaded makes replies start instantly but holds the GPU memory. Unloading also clears your conversation from GPU memory.</p></div>
    <div class="field"><label>Ollama KV cache type</label><select id="kv-type">${kvOpts.map(([v, l]) => `<option value="${v}"${S.prefs.kvType === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <div class="row"><label class="auto-toggle"><input type="checkbox" id="flash"${S.prefs.flashAttention ? ' checked' : ''}> Flash attention is on</label></div>
      <p class="help">These are Ollama server settings, so Hush can't change them. Tell Hush what you've set so the memory estimate is right. To enable them on Windows, run this once in a terminal, then quit Ollama from the tray and start it again:</p>
      <code class="code-inline">setx OLLAMA_FLASH_ATTENTION 1\nsetx OLLAMA_KV_CACHE_TYPE q8_0</code></div>
    <div class="field"><label>GPU memory <span class="val">${gpu ? esc(gpu.name) : 'not detected'}</span></label>
      <div class="row"><input type="number" id="vram" min="0" step="0.5" value="${S.prefs.vramOverrideGB || ''}" placeholder="${gpu ? `auto: ${(gpu.total_mb / 1024).toFixed(1)} GB` : 'e.g. 12'}"><span class="def">GB</span></div>
      <p class="help">Detected automatically on NVIDIA cards. Enter a number to override (for AMD or Intel GPUs).</p></div>
    <div class="field"><label>Ollama address</label><div class="row"><input type="text" id="ollama-url" value="${esc(S.prefs.ollamaUrl)}"><button class="btn small" id="url-save" type="button">Apply</button></div>
      <p class="help">Only addresses on this computer are accepted.</p></div>`;
  if (S.mode === 'vault') {
    html += `<div class="field"><label>Auto-lock after inactivity</label><select id="autolock">${[0, 5, 15, 30, 60].map((m) => `<option value="${m}"${Number(S.prefs.autoLockMin) === m ? ' selected' : ''}>${m ? `${m} minutes` : 'Never'}</option>`).join('')}</select></div>`;
  }
  body.innerHTML = html;
  renderMemCard();
}

function renderMemCard() {
  const card = $('#mem-card');
  const chat = activeChat();
  if (!card || !chat) return;
  if (!chat.model) { card.innerHTML = '<span class="help">Pick a model to see its memory use.</span>'; return; }
  const ms = memState(chat.model, chat.settings.num_ctx);
  if (!ms) { card.innerHTML = '<span class="help">Waiting for model details…</span>'; return; }
  const { est, budget, status, actual } = ms;
  let html = `<div style="display:flex;justify-content:space-between"><b>GPU memory</b><span class="status ${status}">${STATUS_TEXT[status] || ''}</span></div>`;
  html += gaugeBar(ms);
  html += '<div class="legend">';
  if (budget && budget.other) html += `<span><i style="background:var(--other)"></i>Other apps &amp; Windows</span><b>${Est.fmtGB(budget.other)}</b>`;
  html += `<span><i style="background:var(--weights)"></i>Model weights</span><b>${Est.fmtGB(est.weights)}</b>`;
  html += `<span><i style="background:var(--kv)"></i>Context memory (KV cache)</span><b>${Est.fmtGB(est.kv)}</b>`;
  html += `<span><i style="background:var(--over)"></i>Working buffers</span><b>${Est.fmtGB(est.overhead)}</b>`;
  html += `<span>Total${est.approximate ? ' (upper estimate)' : ' (estimate)'}</span><b>${Est.fmtGB(est.total + (budget ? budget.other : 0))}${budget ? ` / ${Est.fmtGB(budget.total)}` : ''}</b>`;
  html += '</div>';
  html += `<div class="def">Each 1k tokens of context costs ≈ ${(est.perToken * 1024 / 1048576).toFixed(0)} MB with ${esc(S.prefs.kvType)} cache.</div>`;
  if (actual) {
    const same = !actual.ctx || actual.ctx === Number(chat.settings.num_ctx);
    const slow = actual.gpuPct < 95;
    html += `<div class="note${slow ? ' bad' : ''}">Loaded right now: ${Est.fmtGB(actual.size)}, <b>${actual.gpuPct}% on GPU</b>${actual.gpuPct < 100 ? ` and ${100 - actual.gpuPct}% on CPU.${slow ? ' Expect much slower answers.' : ' A small spill like this costs a little speed.'}` : '.'}${same ? '' : ` (loaded with ${fmtCtx(actual.ctx)} context; it reloads with your setting on the next message)`}</div>`;
  }
  if (status === 'spill') html += '<div class="note bad">This won\'t fit on your GPU. Ollama will quietly run part of the model on the CPU, often 3–10× slower. Lower the context, switch the cache to q8_0, or pick a smaller model.</div>';
  else if (status === 'tight') html += '<div class="note warn">Very close to the limit. Another app using the GPU (a game, a browser with video) could push it over.</div>';
  if (!budget) html += '<div class="note warn">GPU memory unknown. Enter it below under "This PC".</div>';
  card.innerHTML = html;
}

function onTuneInput(e) {
  const chat = activeChat();
  if (!chat) return;
  const t = e.target;
  const cs = chat.settings;
  if (t.id === 'ctx-range') {
    const steps = ctxSteps(chat.model);
    cs.num_ctx = steps[Number(t.value)];
    $('#ctx-val').textContent = `${fmtInt(cs.num_ctx)} tokens`;
    $('#ctx-pages').textContent = `≈ ${Est.pages(cs.num_ctx)} pages of text · model max ${fmtCtx(maxCtxFor(chat.model))}`;
    renderMemCard(); renderGauge(); renderCtxBar();
  } else if (t.dataset.k) {
    const f = FIELDS.find((x) => x.key === t.dataset.k);
    cs[f.key] = t.value === '' ? null : Number(t.value);
    const v = t.closest('.field').querySelector('.val');
    if (v) v.textContent = t.value;
  } else if (t.dataset.auto) {
    const key = t.dataset.auto;
    const f = FIELDS.find((x) => x.key === key);
    if (t.checked) cs[key] = null;
    else { const md = modelDefaults(chat.model)[key]; cs[key] = md !== undefined ? md : f.fallback; }
    renderTune();
  } else if (t.id === 'system') cs.system = t.value;
  else if (t.id === 'think') cs.think = t.value;
  else if (t.id === 'chat-eph') { chat.ephemeral = t.checked; renderSidebar(); }
  else if (t.id === 'keep-alive') S.prefs.keepAlive = t.value;
  else if (t.id === 'kv-type') { S.prefs.kvType = t.value; S.calib = {}; renderTune(); renderGauge(); }
  else if (t.id === 'flash') { S.prefs.flashAttention = t.checked; S.calib = {}; renderMemCard(); renderGauge(); }
  else if (t.id === 'vram') { S.prefs.vramOverrideGB = parseFloat(t.value) || 0; renderMemCard(); renderGauge(); }
  else if (t.id === 'autolock') S.prefs.autoLockMin = Number(t.value);
  persist();
}

async function onTuneClick(e) {
  const chat = activeChat();
  const id = e.target.id;
  if (id === 'ctx-fit' && chat) {
    const fit = fitCtxFor(chat.model);
    if (fit) { chat.settings.num_ctx = fit; renderTune(); renderGauge(); renderCtxBar(); persist(); }
  } else if (id === 'save-defaults' && chat) {
    S.prefs.defaults = clone(chat.settings);
    S.prefs.defaultModel = chat.model;
    persist();
    toast(S.mode === 'vault' ? 'Saved as defaults for new chats.' : 'Defaults set for this session (ephemeral sessions don\'t save settings).');
  } else if (id === 'reset-chat' && chat) {
    chat.settings = clone(DEFAULT_CHAT);
    renderTune(); renderGauge(); renderCtxBar(); persist();
  } else if (id === 'url-save') {
    try {
      const url = await Backend.setUrl($('#ollama-url').value);
      S.prefs.ollamaUrl = url.replace(/^http:\/\//, '');
      S.connected = null; S.info = {};
      await refreshModels(); await refreshPs();
      toast(S.connected ? 'Connected.' : 'Saved, but Ollama is not answering there.', S.connected ? 'ok' : 'bad');
      persist();
    } catch (err) { toast(errText(err), 'bad'); }
  }
}

function toggleTune(force) {
  const t = $('#tune');
  const show = force !== undefined ? force : t.hidden;
  t.hidden = !show;
  if (show) renderTune();
}

// =====================================================================
// attachments
// =====================================================================
const TEXT_EXT = /\.(txt|md|markdown|rst|csv|tsv|json|jsonl|ndjson|xml|html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|ipynb|rb|go|rs|java|kt|kts|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|fish|ps1|psm1|bat|cmd|sql|ya?ml|toml|ini|cfg|conf|properties|log|env|lua|r|swift|scala|pl|tex|srt|vtt|dockerfile|gradle|cmake|make|mk)$/i;
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;

async function looksLikeText(file) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  return !head.includes(0);
}

async function addFiles(fileList) {
  for (const f of [...fileList]) {
    const name = f.name || `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
    try {
      if (f.type.startsWith('image/')) {
        if (f.size > MAX_IMAGE) { toast(`${name} is too large (max 25 MB).`, 'bad'); continue; }
        S.pending.push({ kind: 'image', name, mime: f.type, b64: await readB64(f), size: f.size });
      } else if (f.type === 'application/pdf' || /\.pdf$/i.test(name)) {
        toast(`Reading ${name}…`);
        const text = await Backend.pdfText(await readB64(f));
        if (!text.trim()) { toast(`${name} has no text layer (it's probably scanned). Take a screenshot of the page and use a vision model instead.`, 'bad'); continue; }
        S.pending.push({ kind: 'text', name, text: text.trim(), size: f.size, from: 'pdf' });
      } else if (TEXT_EXT.test(name) || f.type.startsWith('text/') || (f.size < MAX_TEXT && await looksLikeText(f))) {
        if (f.size > MAX_TEXT) { toast(`${name} is too large to add as text (max 8 MB).`, 'bad'); continue; }
        S.pending.push({ kind: 'text', name, text: await f.text(), size: f.size });
      } else {
        toast(`${name}: this file type isn't supported yet.`, 'bad');
      }
    } catch (e) {
      toast(`${name}: ${errText(e)}`, 'bad');
    }
  }
  renderAttachments();
  const chat = activeChat();
  if (chat) {
    const u = ctxUsage(chat);
    if (u.used > u.limit) toast(`That's about ${fmtInt(u.used)} tokens, more than this chat's ${fmtInt(u.limit)}-token context. Raise the context in Tune or the start will be cut off.`, 'bad');
  }
}

// =====================================================================
// sheets: models / privacy / guide
// =====================================================================
function openSheet(kind) {
  $('#sheet').hidden = false;
  $('#sheet').dataset.kind = kind;
  if (kind === 'models') renderModelsSheet(true);
  if (kind === 'privacy') renderPrivacySheet();
  if (kind === 'guide') renderGuideSheet();
}
function closeSheet() { $('#sheet').hidden = true; }

async function renderModelsSheet(refresh) {
  const box = $('#sheet-body');
  if (refresh) {
    box.innerHTML = '<h2>Models</h2><p class="lead">Loading…</p>';
    await refreshModels();
    await refreshPs();
    await Promise.all(S.models.map((m) => ensureInfo(m.name)));
  }
  if ($('#sheet').hidden || $('#sheet').dataset.kind !== 'models') return;
  const budget = vramBudget();
  let html = `<h2>Models</h2><p class="lead">Installed in Ollama on this PC${budget ? `. Fit is checked against your ${esc(budget.name)} (${Est.fmtGB(budget.total)}, ${Est.fmtGB(budget.total - budget.other)} free)` : ''}.</p>`;
  html += `<h3>Download a model</h3><div class="pull-row"><input id="pull-name" placeholder="Model name from ollama.com/library, e.g. qwen3:14b or gemma3:12b"><button class="btn primary" id="pull-go" type="button">Download</button></div>
    <p class="def" style="margin-top:6px">Downloading is the only thing that goes online, and it's Ollama doing it (to ollama.com), not Hush.</p><div id="pulls"></div>`;
  html += '<h3>Installed</h3>';
  if (!S.models.length) html += `<p>${S.connected ? 'No models yet. Download one above.' : esc(S.connError || 'Ollama is not reachable.')}</p>`;
  for (const m of S.models) {
    const info = S.info[m.name];
    const a = info ? Est.arch(info.model_info) : null;
    const caps = capabilities(m.name).filter((c) => c !== 'completion');
    const d = m.details || {};
    const fit = budget ? fitCtxFor(m.name) : null;
    let fitHtml = '';
    if (budget) {
      if (fit) fitHtml = `<span class="fit status ok">Fits on GPU up to ≈ ${fmtCtx(fit)} context</span>`;
      else {
        const ms = memState(m.name, 4096);
        fitHtml = `<span class="fit status spill">Too big for this GPU: ≈ ${Math.round((ms.gpuShare || 0) * 100)}% GPU at 4k context, rest on CPU (slow)</span>`;
      }
    }
    const loaded = loadedEntry(m.name);
    html += `<div class="model-row"><div><div class="nm">${esc(m.name)}</div><div class="sub">
      <span>${esc(d.parameter_size || '?')} params</span><span>${esc(d.quantization_level || '')}</span><span>${Est.fmtGB(m.size)}</span>
      ${a && a.maxCtx ? `<span>max ${fmtCtx(a.maxCtx)} context</span>` : ''}
      ${caps.map((c) => `<span class="chip on">${esc(c)}</span>`).join('')}</div>
      <div class="sub" style="margin-top:4px">${fitHtml}${loaded ? `<span class="chip">in memory: ${Est.fmtGB(loaded.size)}, ${Math.round(((loaded.size_vram || 0) / loaded.size) * 100)}% GPU</span>` : ''}</div></div>
      <div class="acts">${loaded ? `<button class="btn small" data-unload="${esc(m.name)}" type="button">Unload</button>` : ''}
      <button class="btn small" data-use="${esc(m.name)}" type="button">Use</button>
      <button class="btn small danger" data-delete="${esc(m.name)}" type="button">Delete</button></div></div>`;
  }
  box.innerHTML = html;
  renderPulls();
}

function renderPulls() {
  const box = $('#pulls');
  if (!box) return;
  box.innerHTML = Object.entries(S.pulls).map(([name, p]) =>
    `<div style="margin-top:10px"><div class="row" style="display:flex;justify-content:space-between;font-size:12.5px"><span><b>${esc(name)}</b> · ${esc(p.status)}</span>
     ${p.done ? '' : `<button class="linkish" data-cancel-pull="${esc(name)}" type="button">Cancel</button>`}</div>
     <div class="progress"><span style="width:${p.pct || 0}%"></span></div></div>`).join('');
}

async function pullModel(name) {
  name = name.trim();
  if (!name || S.pulls[name] && !S.pulls[name].done) return;
  const reqId = uid();
  S.pulls[name] = { status: 'starting…', pct: 0, reqId };
  renderPulls();
  try {
    await Backend.stream('/api/pull', { model: name }, reqId, (ev) => {
      const p = S.pulls[name];
      if (ev.hush_cancelled) { p.status = 'cancelled'; p.done = true; }
      else {
        p.status = ev.status || p.status;
        if (ev.total) p.pct = Math.round(((ev.completed || 0) / ev.total) * 100);
        if (ev.status === 'success') { p.pct = 100; p.done = true; }
      }
      renderPulls();
    });
    S.pulls[name].done = true;
    if (S.pulls[name].status === 'success') { toast(`${name} is ready.`, 'ok'); setTimeout(() => { delete S.pulls[name]; renderPulls(); }, 4000); }
  } catch (e) {
    S.pulls[name] = { status: errText(e), pct: 0, done: true };
  }
  renderPulls();
  if (!$('#sheet').hidden && $('#sheet').dataset.kind === 'models') renderModelsSheet(true);
  else refreshModels();
}

async function onSheetClick(e) {
  const t = e.target.closest('button, [data-shred-all]');
  if (!t) return;
  if (t.id === 'pull-go') return pullModel($('#pull-name').value);
  if (t.dataset.cancelPull) { const p = S.pulls[t.dataset.cancelPull]; if (p) Backend.cancel(p.reqId); return; }
  if (t.dataset.use) {
    const chat = activeChat() || newChat();
    chat.model = t.dataset.use;
    await ensureInfo(chat.model);
    closeSheet(); renderAll(); persist();
    return;
  }
  if (t.dataset.unload) {
    await Backend.post('/api/generate', { model: t.dataset.unload, keep_alive: 0 }).catch((err) => toast(errText(err), 'bad'));
    await refreshPs(); renderModelsSheet(false); renderTopbar();
    return;
  }
  if (t.dataset.delete) {
    const name = t.dataset.delete;
    if (!await modal({ title: `Delete ${name}?`, body: 'This removes the model files from disk. You can download it again later.', okText: 'Delete', danger: true })) return;
    try { await Backend.deleteModel(name); toast(`${name} deleted.`); delete S.info[name]; }
    catch (err) { toast(errText(err), 'bad'); }
    return renderModelsSheet(true);
  }
  // privacy
  if (t.id === 'pv-lock') return lockVault();
  if (t.id === 'pv-create') return createVaultFromSession();
  if (t.id === 'pv-destroy') return destroyVault();
  if (t.id === 'pv-refresh') return renderPrivacySheet();
  if (t.dataset.shred) {
    const group = t.closest('.group');
    const paths = $$('input[type=checkbox]:checked', group).map((c) => c.value);
    if (!paths.length) { toast('Select files first.'); return; }
    if (!await modal({ title: `Shred ${paths.length} file${paths.length > 1 ? 's' : ''}?`, body: 'Each file is overwritten with random data, renamed and deleted. On SSDs this is best effort: the drive itself may keep old copies of the data internally.', okText: 'Shred', danger: true })) return;
    const res = await Backend.shredFiles(paths);
    const bad = res.filter((r) => !r.ok);
    toast(bad.length ? `${res.length - bad.length} shredded, ${bad.length} failed (often because Ollama is running and has them open: quit it from the tray and try again).` : `${res.length} file${res.length > 1 ? 's' : ''} shredded.`, bad.length ? 'bad' : 'ok');
    return renderPrivacySheet();
  }
  if (t.dataset.selAll !== undefined) {
    const group = t.closest('.group');
    const boxes = $$('input[type=checkbox]', group);
    const all = boxes.every((c) => c.checked);
    boxes.forEach((c) => { c.checked = !all; });
  }
}

async function renderPrivacySheet() {
  const box = $('#sheet-body');
  const vs = await Backend.vaultStatus().catch(() => ({ exists: false, unlocked: false, path: '' }));
  let html = `<h2>Privacy &amp; data</h2><p class="lead">Exactly what Hush does with your data, and every file on this PC that Hush or Ollama keeps.</p>
  <ul class="decl">
    <li><b>Hush never connects to the internet.</b> The window is blocked from making any network request by its security policy. The core only talks to Ollama on this computer (127.0.0.1) and refuses any other address. It also ignores system proxy settings.</li>
    <li><b>No telemetry, analytics, crash reports or update checks.</b> Not even optional ones.</li>
    <li><b>Ephemeral chats exist only in memory.</b> They're never written to disk. Wipe, lock or close Hush and they're gone.</li>
    <li><b>Saved chats live in one encrypted file.</b> vault.hush, encrypted with XChaCha20-Poly1305 using a key derived from your passphrase with Argon2id (64 MB, 3 passes). The key only exists in memory while unlocked and is zeroed on lock.</li>
    <li><b>Attachments and screenshots are never saved as separate files.</b> They stay in memory, or inside the encrypted vault if the chat is saved.</li>
    <li><b>The web engine runs in private mode,</b> so no page cache, cookies or web storage are kept.</li>
  </ul>
  <h3>What Hush can't control</h3>
  <p><b>Ollama</b> runs separately and keeps its own logs (and, if you used its own chat window, its own chat history). They're listed below and you can shred them. <b>Windows</b> may write memory to the page file or hibernation file, and those can contain anything that was in memory. Turning on BitLocker (or VeraCrypt full-disk encryption) covers them. <b>SSDs</b> can keep old copies of overwritten data, which is why Hush relies on encryption, not overwriting, for what it stores itself.</p>
  <h3>Vault</h3>`;
  if (S.mode === 'vault') {
    html += `<p>Unlocked. File: <code>${esc(vs.path)}</code></p><div style="display:flex;gap:8px"><button class="btn" id="pv-lock" type="button">Lock now</button><button class="btn danger" id="pv-destroy" type="button">Destroy vault…</button></div>`;
  } else if (vs.exists) {
    html += `<p>A vault exists but is locked; this session is ephemeral. File: <code>${esc(vs.path)}</code></p><button class="btn danger" id="pv-destroy" type="button">Destroy vault…</button>`;
  } else {
    html += '<p>No vault. This session is ephemeral. Create a vault to save chats (your current chats move into it).</p><button class="btn" id="pv-create" type="button">Create vault…</button>';
  }
  html += '<h3 style="display:flex;justify-content:space-between;align-items:center">Files on this PC <button class="btn small ghost" id="pv-refresh" type="button">Rescan</button></h3><div id="dm">Scanning…</div>';
  box.innerHTML = html;
  let groups = [];
  try { groups = await Backend.dataMap(); } catch (e) { $('#dm').textContent = errText(e); return; }
  $('#dm').innerHTML = groups.map((g) => {
    const head = `<div class="group-head"><div><b>${esc(g.title)}</b><small>${esc(g.root)}</small></div><span class="def">${g.exists ? `${fmtInt(g.file_count)} file${g.file_count === 1 ? '' : 's'} · ${Est.fmtGB(g.total_bytes)}` : 'not present'}</span></div>`;
    const note = `<div class="gnote">${esc(g.note)}</div>`;
    let files = '';
    if (g.exists && !g.summary_only && g.files.length) {
      files = '<div class="files">' + g.files.map((f) => `<label>${g.deletable ? `<input type="checkbox" value="${esc(f.path)}">` : ''}<span>${esc(f.path)}</span>${Est.fmtGB(f.size).replace(' GB', '')} GB</label>`).join('') +
        (g.truncated ? '<label><span>… more files not listed</span></label>' : '') + '</div>';
      if (g.deletable) files += `<div class="group-foot"><button class="btn small ghost" data-sel-all type="button">Select all</button><button class="btn small danger" data-shred="1" type="button">Shred selected</button></div>`;
    }
    return `<div class="group">${head}${note}${files}</div>`;
  }).join('');
}

function renderGuideSheet() {
  const gpu = S.gpu[0];
  const vram = S.prefs.vramOverrideGB || (gpu ? gpu.total_mb / 1024 : 12);
  $('#sheet-body').innerHTML = `<div class="guide"><h2>How tuning works</h2>
  <p class="lead">Local models fail in a few predictable ways. They're easy to fix once you can see them, which is what the gauges in Hush are for.</p>
  <h3>1. GPU memory holds three things, not one</h3>
  <p>A loaded model needs its <b>weights</b> (the download size), a <b>KV cache</b> that holds the conversation it can currently see (grows with the context window), and some <b>working buffers</b>. A 5 GB model with a large context can easily need 9–10 GB. The gauge shows all three, plus what Windows and other apps are already using.</p>
  <h3>2. When it doesn't fit, Ollama quietly uses the CPU</h3>
  <p>If the total is bigger than free GPU memory, Ollama puts part of the model in system RAM and runs it on the CPU. It still works, but often 3–10× slower, with no warning. Hush shows "spills to CPU" before you send, and the real GPU percentage once the model is loaded. The terminal equivalent is <code>ollama ps</code>.</p>
  <h3>3. The context window is silently cut</h3>
  <p>Ollama uses a fixed context size per request. When the conversation plus attachments is longer, the oldest part is dropped with no error. That's why models "forget" the start of a chat or ignore half of a pasted file. The bar above the message box shows how full the context is, using Ollama's real token counts once there's a reply.</p>
  <h3>4. Halve the cache for free</h3>
  <p>Turning on flash attention and an 8-bit KV cache roughly halves context memory with barely measurable quality loss. It's an Ollama setting (see Tune → This PC). On a ${vram.toFixed(0)} GB card it's the single biggest upgrade.</p>
  <h3>5. Rough sizing for ${vram.toFixed(0)} GB of GPU memory (Q4 models)</h3>
  <table><tr><th>Model size</th><th>Weights</th><th>Comfortable context</th></tr>
  <tr><td>3–4B</td><td>2–3 GB</td><td>64k+</td></tr>
  <tr><td>7–9B</td><td>5–6 GB</td><td>16–32k (more with q8_0 cache)</td></tr>
  <tr><td>12–14B</td><td>8–9 GB</td><td>8–16k</td></tr>
  <tr><td>20B+</td><td>12 GB+</td><td>spills to CPU on 12 GB cards</td></tr></table>
  <p>"Q4" (Q4_K_M) is the usual quantization: weights stored at about 4.5 bits instead of 16. It's about a quarter of the size with a small quality cost. Q8 is near-lossless but twice as big.</p>
  <h3>6. Sampling in one paragraph</h3>
  <p>Leave everything on <b>auto</b> unless you have a reason. Auto uses the values the model's authors recommend (shown under each slider). For code and facts, lower the temperature to around 0.2. For brainstorming, raise it to around 1.0. If a model loops or repeats itself, raise the repeat penalty slightly, to 1.1–1.15.</p>
  <h3>7. Images</h3>
  <p>Chat models only produce text. To ask about a screenshot, use a model tagged <b>vision</b> (for example the Gemma 3 or Qwen-VL families). Generating images needs a different kind of model entirely (Stable Diffusion or Flux, usually through ComfyUI). That's on the roadmap.</p></div>`;
}

// =====================================================================
// vault / session lifecycle
// =====================================================================
function showGate(view) {
  const gate = $('#gate');
  gate.hidden = false;
  const head = '<h1><span class="logo"></span>Hush</h1>';
  if (view === 'unlock') {
    gate.innerHTML = `<div class="gate-inner">${head}<p class="lead">Your vault is locked.</p>
      <div class="choice unlock-card"><input type="password" id="g-pass" placeholder="Passphrase" autocomplete="off">
      <div class="err-line" id="g-err"></div><button class="btn primary" id="g-unlock" type="button">Unlock</button>
      <div style="display:flex;justify-content:space-between;gap:10px;margin-top:4px"><button class="linkish" id="g-eph" type="button">Continue without unlocking (ephemeral)</button>
      <button class="linkish danger" id="g-destroy" type="button">Destroy vault…</button></div></div></div>`;
    setTimeout(() => $('#g-pass').focus(), 30);
  } else {
    gate.innerHTML = `<div class="gate-inner">${head}<p class="lead">Private chats with AI models running on this PC. Nothing leaves your computer. Pick how this session works:</p>
      <div class="choices">
        <div class="choice"><h2>Ephemeral</h2><p>Chats exist only in memory. Close Hush or press Wipe and they're gone for good. Nothing is ever written to disk.</p>
          <ul><li>Best for secrets and one-off work</li><li>Settings reset each launch</li></ul>
          <button class="btn primary" id="g-eph" type="button">Start ephemeral session</button></div>
        <div class="choice"><h2>Encrypted vault</h2><p>Chats and settings are saved in a single encrypted file that only your passphrase opens.</p>
          <input type="password" id="g-p1" placeholder="Passphrase (8+ characters)" autocomplete="off">
          <input type="password" id="g-p2" placeholder="Repeat passphrase" autocomplete="off">
          <div class="err-line" id="g-err"></div>
          <button class="btn" id="g-create" type="button">Create vault</button>
          <p class="def">There's no recovery. If you forget the passphrase, nobody can read the vault, by design.</p></div>
      </div></div>`;
  }
}

function enterSession(mode) {
  S.mode = mode;
  $('#gate').hidden = true;
  if (!S.chats.length) newChat();
  if (!activeChat()) S.activeId = S.chats[0].id;
  S.lastActivity = Date.now();
  renderAll();
  $('#input').focus();
  if (S.prefs.ollamaUrl && S.prefs.ollamaUrl !== '127.0.0.1:11434') {
    Backend.setUrl(S.prefs.ollamaUrl).then(() => { S.connected = null; refreshModels(); }).catch(() => {});
  }
  refreshModels();
}

async function onGateClick(e) {
  const id = e.target.id;
  const err = $('#g-err');
  if (id === 'g-eph') {
    S.chats = []; S.prefs = clone(DEFAULT_PREFS);
    enterSession('ephemeral');
  } else if (id === 'g-create') {
    const p1 = $('#g-p1').value; const p2 = $('#g-p2').value;
    if (p1.length < 8) { err.textContent = 'Use at least 8 characters. A short sentence is best.'; return; }
    if (p1 !== p2) { err.textContent = "The passphrases don't match."; return; }
    e.target.disabled = true; e.target.textContent = 'Creating…';
    try {
      S.chats = []; S.prefs = clone(DEFAULT_PREFS);
      await Backend.vaultCreate(p1, serialize());
      enterSession('vault');
      toast('Vault created.', 'ok');
    } catch (ex) { err.textContent = errText(ex); e.target.disabled = false; e.target.textContent = 'Create vault'; }
  } else if (id === 'g-unlock') {
    const pass = $('#g-pass').value;
    if (!pass) return;
    e.target.disabled = true; e.target.textContent = 'Unlocking…';
    try {
      loadVaultData(await Backend.vaultUnlock(pass));
      $('#g-pass').value = '';
      enterSession('vault');
    } catch (ex) { err.textContent = errText(ex); e.target.disabled = false; e.target.textContent = 'Unlock'; $('#g-pass').select(); }
  } else if (id === 'g-destroy') {
    if (await destroyVault()) showGate('welcome');
  }
}

async function createVaultFromSession() {
  const p1 = await modal({ title: 'Create an encrypted vault', body: 'Your current chats will move into it. There is no recovery if you forget the passphrase.', okText: 'Next', input: { type: 'password', placeholder: 'Passphrase (8+ characters)' } });
  if (p1 === null) return;
  if (p1.length < 8) { toast('Use at least 8 characters.', 'bad'); return; }
  const p2 = await modal({ title: 'Repeat the passphrase', okText: 'Create vault', input: { type: 'password', placeholder: 'Repeat passphrase' } });
  if (p2 === null) return;
  if (p1 !== p2) { toast("The passphrases don't match.", 'bad'); return; }
  try {
    await Backend.vaultCreate(p1, serialize());
    S.mode = 'vault';
    toast('Vault created. Chats are now saved encrypted.', 'ok');
    renderAll();
    renderPrivacySheet();
  } catch (e) { toast(errText(e), 'bad'); }
}

async function destroyVault() {
  const typed = await modal({ title: 'Destroy the vault?', body: 'Every saved chat and setting will be permanently deleted. Type <b>DESTROY</b> to confirm.', okText: 'Destroy', danger: true, input: { placeholder: 'DESTROY' } });
  if (typed === null) return false;
  if (typed.trim() !== 'DESTROY') { toast('Not destroyed: the confirmation word didn\'t match.'); return false; }
  try {
    await Backend.vaultDestroy();
    if (S.mode === 'vault') { S.mode = 'ephemeral'; S.chats = S.chats.filter((c) => c.ephemeral); if (!S.chats.length) newChat(); renderAll(); }
    toast('Vault destroyed.', 'ok');
    if (!$('#sheet').hidden && $('#sheet').dataset.kind === 'privacy') renderPrivacySheet();
    return true;
  } catch (e) { toast(errText(e), 'bad'); return false; }
}

async function clearSensitive() {
  if (S.gen) { stop(); await sleep(150); }
  for (const p of S.ps) Backend.post('/api/generate', { model: p.name, keep_alive: 0 }).catch(() => {});
  try { await navigator.clipboard.writeText(''); } catch (_) { /* window may be unfocused */ }
  Object.values(S.pulls).forEach((p) => p.reqId && !p.done && Backend.cancel(p.reqId));
  S.pending = [];
  $('#input').value = '';
  closeSheet();
  toggleTune(false);
}

async function lockVault() {
  await flushPersist();
  await clearSensitive();
  await Backend.vaultLock();
  S.chats = []; S.activeId = null; S.prefs = clone(DEFAULT_PREFS); S.calib = {}; S.mode = null;
  $('#messages').innerHTML = '';
  showGate('unlock');
}

async function wipeSession() {
  const vault = S.mode === 'vault';
  const ok = await modal({
    title: vault ? 'Wipe and lock?' : 'Wipe this session?',
    body: vault
      ? 'Closes every chat, unloads models from GPU memory, clears the clipboard and locks the vault. Saved chats stay encrypted on disk; chats marked "not saved" are erased.'
      : 'Erases every chat in this session from memory, unloads models from GPU memory and clears the clipboard. This can\'t be undone.',
    okText: vault ? 'Wipe and lock' : 'Wipe', danger: true,
  });
  if (!ok) return;
  if (vault) return lockVault();
  await clearSensitive();
  S.chats = []; S.activeId = null;
  newChat();
  renderAll();
  toast('Session wiped.', 'ok');
}

// =====================================================================
// wiring
// =====================================================================
function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
}

function switchChat(id) {
  if (S.activeId === id) return;
  S.activeId = id;
  const chat = activeChat();
  if (chat && chat.model) ensureInfo(chat.model);
  renderAll();
  persist();
}

function bind() {
  $('#new-chat').onclick = () => { newChat(); renderAll(); $('#input').focus(); persist(); };
  $('#mode-badge').onclick = () => (S.mode === 'vault' ? lockVault() : openSheet('privacy'));
  $('#wipe-btn').onclick = wipeSession;
  $$('[data-open]').forEach((b) => { b.onclick = () => openSheet(b.dataset.open); });
  $('#sheet-close').onclick = closeSheet;
  $('#sheet').addEventListener('mousedown', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#sheet-body').addEventListener('click', onSheetClick);
  $('#sheet-body').addEventListener('keydown', (e) => { if (e.target.id === 'pull-name' && e.key === 'Enter') pullModel(e.target.value); });
  $('#gate').addEventListener('click', onGateClick);
  $('#gate').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'g-pass') $('#g-unlock').click();
    if (e.target.id === 'g-p2') $('#g-create').click();
  });
  $('#tune-toggle').onclick = () => toggleTune();
  $('#mem-gauge').onclick = () => toggleTune(true);
  $('#tune-close').onclick = () => toggleTune(false);
  $('#tune-body').addEventListener('input', onTuneInput);
  $('#tune-body').addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') onTuneInput(e); });
  $('#tune-body').addEventListener('click', onTuneClick);

  $('#model-select').onchange = async (e) => {
    const chat = activeChat() || newChat();
    chat.model = e.target.value;
    const max = maxCtxFor(chat.model);
    await ensureInfo(chat.model);
    if (chat.settings.num_ctx > maxCtxFor(chat.model)) chat.settings.num_ctx = maxCtxFor(chat.model) || max;
    renderTopbar(); renderAttachments(); renderCtxBar();
    if (!$('#tune').hidden) renderTune();
    persist();
  };

  // chat list
  const list = $('#chat-list');
  list.addEventListener('click', async (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    if (e.target.classList.contains('x')) {
      const chat = S.chats.find((c) => c.id === item.dataset.id);
      if (chat.messages.length && !await modal({ title: 'Delete this chat?', body: esc(chat.title), okText: 'Delete', danger: true })) return;
      if (S.gen && S.gen.chatId === chat.id) stop();
      S.chats = S.chats.filter((c) => c.id !== chat.id);
      if (S.activeId === chat.id) S.activeId = S.chats[0] ? S.chats[0].id : newChat().id;
      renderAll(); persist();
      return;
    }
    if (e.target.tagName !== 'INPUT') switchChat(item.dataset.id);
  });
  list.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.chat-item');
    if (!item || e.target.classList.contains('x')) return;
    const chat = S.chats.find((c) => c.id === item.dataset.id);
    const t = $('.t', item);
    const inp = document.createElement('input');
    inp.value = chat.title;
    t.replaceWith(inp);
    inp.focus(); inp.select();
    const done = (save) => { if (save && inp.value.trim()) chat.title = inp.value.trim().slice(0, 80); renderSidebar(); persist(); };
    inp.onkeydown = (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  });

  // messages
  const box = $('#messages');
  box.addEventListener('toggle', (e) => {
    if (e.target.matches('details.think')) {
      const chat = activeChat();
      const m = chat && chat.messages.find((x) => x.id === e.target.dataset.msg);
      if (m && !m.pending) m.thinkOpen = e.target.open;
    }
  }, true);
  box.addEventListener('click', async (e) => {
    const cc = e.target.closest('.copy-code');
    if (cc) { copyText($('pre', cc.closest('.code')).textContent); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const chat = activeChat();
    const node = b.closest('.msg');
    const idx = chat.messages.findIndex((m) => m.id === node.dataset.id);
    const m = chat.messages[idx];
    const act = b.dataset.act;
    if (act === 'copy') copyText(m.role === 'assistant' ? splitThink(m.content).body : m.content);
    if (act === 'del') { chat.messages.splice(idx, 1); renderMessages(false); persist(); }
    if (act === 'regen' && !S.gen) { chat.messages.splice(idx, 1); generate(chat); }
    if (act === 'edit' && !S.gen) {
      const bubble = $('.bubble', node);
      bubble.outerHTML = `<div class="edit-box"><textarea>${esc(m.content)}</textarea><div class="row"><button class="btn small ghost" data-edit="cancel" type="button">Cancel</button><button class="btn small primary" data-edit="send" type="button">Save &amp; resend</button></div></div>`;
      const ta = $('.edit-box textarea', node);
      ta.focus();
      $('.edit-box', node).onclick = (ev) => {
        const which = ev.target.dataset.edit;
        if (which === 'cancel') renderMessages(false);
        if (which === 'send') { m.content = ta.value; chat.messages.splice(idx + 1); generate(chat); }
      };
    }
  });

  // composer
  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(); renderCtxBarSoon(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData && e.clipboardData.files) || []];
    if (files.length && !e.clipboardData.getData('text/plain')) { e.preventDefault(); addFiles(files); }
  });
  $('#send-btn').onclick = () => (S.gen ? stop() : send());
  $('#attach-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('#attachments').addEventListener('click', (e) => {
    const rm = e.target.closest('.rm');
    if (rm) { S.pending.splice(Number(rm.dataset.i), 1); renderAttachments(); }
  });

  // drag and drop anywhere
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || S.mode === null) return; e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
    if (S.mode !== null) addFiles(e.dataTransfer.files);
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    S.lastActivity = Date.now();
    if (S.mode === null) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); wipeSession(); }
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#new-chat').click(); }
    else if (mod && e.key === ',') { e.preventDefault(); toggleTune(); }
    else if (e.key === 'Escape') {
      if (!$('#modal').hidden) return;
      if (S.gen) stop();
      else if (!$('#sheet').hidden) closeSheet();
      else if (!$('#tune').hidden) toggleTune(false);
    }
  });
  ['mousemove', 'mousedown', 'wheel'].forEach((ev) => document.addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));
  window.addEventListener('focus', () => { if (S.mode) refreshModels(); });
}

let ctxTimer = null;
function renderCtxBarSoon() { clearTimeout(ctxTimer); ctxTimer = setTimeout(renderCtxBar, 150); }

async function poll() {
  if (document.hidden) return;
  await Promise.all([refreshGpu(), refreshPs()]);
  if (S.mode) {
    renderGauge();
    if (!$('#tune').hidden) renderMemCard();
  }
}

function autoLockTick() {
  if (S.mode !== 'vault' || !S.prefs.autoLockMin || S.gen) return;
  if (Date.now() - S.lastActivity > S.prefs.autoLockMin * 60000) {
    lockVault();
    toast('Locked after inactivity.');
  }
}

async function boot() {
  bind();
  if (!Backend.native) console.info('Hush is running in browser dev mode (no encryption, no file access).');
  await refreshGpu();
  const vs = await Backend.vaultStatus().catch(() => ({ exists: false }));
  showGate(vs.exists ? 'unlock' : 'welcome');
  refreshModels();
  setInterval(poll, 4000);
  setInterval(() => { if (S.mode) refreshModels(); }, 30000);
  setInterval(autoLockTick, 20000);
}

boot();
