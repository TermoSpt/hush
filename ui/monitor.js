// Live monitor: what the graphics card and the model are doing, second by second.
// Headline numbers as tiles, then one small chart per measure (never two scales on
// one chart). Only drawn while the panel is open, and samples are taken once a
// second only while it's open or a model is answering.
'use strict';
/* global S, $, esc, fmtInt, Backend, toast, errText, refreshPs, renderGauge, renderHardware, activeChat, loadedEntry, unloadIn, overflowState, overflowGB, Est */

const MON = { samples: [], hover: null, lastTok: null };
const MON_WINDOW = 120000; // 2 minutes

function currentGenLive() {
  if (!S.gen) return null;
  const chat = S.chats.find((c) => c.id === S.gen.chatId);
  const m = chat && chat.messages.find((x) => x.id === S.gen.msgId);
  return m && m.live ? m.live : null;
}

function recordMonitorSample() {
  const g = S.gpu[0];
  if (!g) return;
  const now = Date.now();
  const L = currentGenLive();
  let rate = null;
  let phase = 'idle';
  if (L) {
    const tok = L.thinkTok + L.ansTok;
    phase = L.ansTok ? 'answering' : L.thinkTok ? 'thinking' : 'reading';
    if (MON.lastTok && MON.lastTok.t0 === L.t0) {
      const dt = (now - MON.lastTok.at) / 1000;
      if (dt > 0.3) rate = Math.max(0, (tok - MON.lastTok.tok) / dt);
    }
    MON.lastTok = { t0: L.t0, tok, at: now };
  } else MON.lastTok = null;
  MON.samples.push({
    t: now, phase, rate,
    util: g.util_pct ?? null, memu: g.mem_util_pct ?? null,
    vram: g.used_mb / 1024, total: g.total_mb / 1024,
    temp: g.temp_c ?? null, power: g.power_w ?? null,
  });
  while (MON.samples.length && now - MON.samples[0].t > MON_WINDOW + 5000) MON.samples.shift();
  if (!$('#monitor').hidden) renderMonitor();
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function chartHtml(key, title, fmt, get, fixedMax) {
  const now = Date.now();
  const W = 300;
  const H = 64;
  const pts = MON.samples.map((s) => ({ t: s.t, v: get(s), s })).filter((p) => p.v !== null && p.v !== undefined && !Number.isNaN(p.v));
  const latest = pts.length ? pts[pts.length - 1].v : null;
  const max = fixedMax || niceMax(Math.max(1, ...pts.map((p) => p.v)) * 1.1);
  const x = (t) => ((t - (now - MON_WINDOW)) / MON_WINDOW) * W;
  const y = (v) => H - (Math.min(v, max) / max) * (H - 2) - 1;
  // Break the line where samples are missing (idle polling, app hidden).
  const segs = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    if (i && pts[i].t - pts[i - 1].t > 6500) { if (cur.length) segs.push(cur); cur = []; }
    cur.push(pts[i]);
  }
  if (cur.length) segs.push(cur);
  const line = segs.map((sg) => `<polyline class="ln" points="${sg.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>`).join('');
  const area = segs.filter((sg) => sg.length > 1).map((sg) => `<polygon class="ar" points="${x(sg[0].t).toFixed(1)},${H} ${sg.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')} ${x(sg[sg.length - 1].t).toFixed(1)},${H}"/>`).join('');
  let hover = '';
  if (MON.hover && MON.hover.key === key && pts.length) {
    const ht = now - MON_WINDOW + MON.hover.frac * MON_WINDOW;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - ht) < Math.abs(best.t - ht)) best = p;
    const left = Math.max(0, Math.min(100, (x(best.t) / W) * 100));
    hover = `<span class="ch-cross" style="left:${left}%"></span><span class="ch-tip" style="left:${Math.min(left, 62)}%"><b>${esc(fmt(best.v))}</b> · ${Math.round((now - best.t) / 1000)} s ago${best.s.phase !== 'idle' ? ` · ${best.s.phase}` : ''}</span>`;
  }
  return `<div class="chart" data-chart="${key}"><div class="ch-head"><span>${esc(title)}</span><b>${latest === null ? '–' : esc(fmt(latest))}</b></div>
    <div class="ch-plot" data-chart="${key}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line class="gr" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/><line class="gr" x1="0" x2="${W}" y1="1" y2="1"/>${area}${line}</svg>
      <span class="ch-max">${esc(fmt(max))}</span>${hover}</div>
    <div class="ch-foot"><span>2 min ago</span><span>now</span></div></div>`;
}

function tile(label, value, sub, title) {
  return `<div class="tile" title="${esc(title || '')}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
}

function lastReplyStats() {
  const chat = activeChat();
  if (!chat) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === 'assistant' && m.stats) return { m, st: m.stats };
  }
  return null;
}

function diagnosis(g) {
  const tips = [];
  const chat = activeChat();
  const lr = lastReplyStats();
  const loaded = chat && chat.model ? loadedEntry(chat.model) : null;
  const gpuPct = loaded && loaded.size ? Math.round(((loaded.size_vram || 0) / loaded.size) * 100) : 100;
  const writeRate = lr && lr.st.eval_count && lr.st.eval_duration ? lr.st.eval_count / (lr.st.eval_duration / 1e9) : null;
  if (overflowState() === 'sustained') tips.push(['bad', `${overflowGB().toFixed(1)} GB of the model has overflowed into normal RAM through the Windows driver. That's the main reason for slow answers. Lower the memory setting in Tune or use a smaller model.`]);
  else if (gpuPct < 95) tips.push(['bad', `${100 - gpuPct}% of the model runs on the CPU because it doesn't fit in graphics memory. Expect several times slower writing. Lower the memory setting in Tune or pick a smaller model.`]);
  if (g && g.temp_c >= 83) tips.push(['warn', `The card is at ${g.temp_c}°C. Cards slow themselves down when this hot. Check airflow and dust.`]);
  if (writeRate !== null && writeRate >= 25 && gpuPct >= 95) tips.push(['ok', `Healthy: the whole model is in graphics memory and writes at ${writeRate.toFixed(0)} tokens/s.`]);
  if (!tips.length && !lr) tips.push(['info', 'Send a message to see how fast this model reads and writes on your PC.']);
  return tips;
}

function renderMonitor() {
  const body = $('#mon-body');
  if (!body || $('#monitor').hidden) return;
  const g = S.gpu[0];
  if (!g) {
    body.innerHTML = `<p class="help">No NVIDIA graphics card detected, so live graphics readings aren't available. The model speed numbers below still work.</p>${replyHtml()}`;
    return;
  }
  const L = currentGenLive();
  const last = MON.samples[MON.samples.length - 1] || {};
  const lr = lastReplyStats();
  const lastWrite = lr && lr.st.eval_count && lr.st.eval_duration ? lr.st.eval_count / (lr.st.eval_duration / 1e9) : null;
  const ps = S.ps;
  let status;
  if (L) {
    const words = { reading: 'Reading your prompt', thinking: 'Thinking', answering: 'Answering' }[last.phase] || 'Working';
    status = `<span class="live-dot"></span>${words}${last.rate ? ` · ${last.rate.toFixed(0)} tok/s` : ''}`;
  } else {
    status = ps.length ? `Idle · ${esc(ps.map((p) => `${p.name} loaded, ${unloadIn(p)}`).join('; '))}` : 'Idle · no model loaded';
  }
  let html = `<div class="mon-status">${status}</div><div class="tiles">`;
  html += tile('Writing speed', L && last.rate ? `${last.rate.toFixed(0)}<small> tok/s</small>` : lastWrite ? `${lastWrite.toFixed(0)}<small> tok/s</small>` : '–', L ? 'right now' : lastWrite ? 'last reply' : '', 'Tokens the model writes per second. About 0.75 words per token.');
  html += tile('Compute', g.util_pct !== null && g.util_pct !== undefined ? `${g.util_pct}<small>%</small>` : '–', 'how hard it works', 'Share of time the graphics card is busy computing.');
  html += tile('Graphics memory', `${(g.used_mb / 1024).toFixed(1)}<small> / ${(g.total_mb / 1024).toFixed(1)} GB</small>`, 'reserved space', 'Space taken in the card\'s memory. A loaded model keeps its space even when idle.');
  html += tile('Memory bus', g.mem_util_pct !== null && g.mem_util_pct !== undefined ? `${g.mem_util_pct}<small>%</small>` : '–', 'reading the model', 'How busy the link to graphics memory is. Writing text is mostly limited by this, not by compute.');
  html += tile('Temperature', g.temp_c ? `${g.temp_c}<small>°C</small>` : '–', g.fan_pct !== null && g.fan_pct !== undefined ? `fan ${g.fan_pct}%` : '', 'Most cards start slowing down above roughly 83–87°C.');
  html += tile('Power', g.power_w ? `${Math.round(g.power_w)}<small> W</small>` : '–', g.power_limit_w ? `of ${Math.round(g.power_limit_w)} W limit` : '', 'Electrical power the card draws right now.');
  html += '</div>';
  for (const [kind, text] of diagnosis(g)) html += `<div class="note ${kind === 'ok' ? 'good' : kind}">${esc(text)}</div>`;
  html += chartHtml('rate', 'Writing speed', (v) => `${v.toFixed(0)} tok/s`, (s) => s.rate);
  html += chartHtml('util', 'Compute', (v) => `${Math.round(v)}%`, (s) => s.util, 100);
  html += chartHtml('vram', 'Graphics memory', (v) => `${v.toFixed(1)} GB`, (s) => s.vram, Math.ceil(g.total_mb / 1024));
  html += chartHtml('power', 'Power', (v) => `${Math.round(v)} W`, (s) => s.power, g.power_limit_w ? niceMax(g.power_limit_w) : 0);
  html += replyHtml();
  if (ps.length) {
    html += '<div class="t-sec">Loaded models</div>';
    for (const p of ps) {
      const pct = p.size ? Math.round(((p.size_vram || 0) / p.size) * 100) : 100;
      html += `<div class="mon-model"><div><b class="mono">${esc(p.name)}</b><div class="def">${Est.fmtGB(p.size || 0)} · ${pct}% on graphics card${p.context_length ? ` · ${fmtInt(p.context_length)} context` : ''} · ${esc(unloadIn(p))}</div></div><button class="btn small" data-mon-unload="${esc(p.name)}" type="button">Unload</button></div>`;
    }
  }
  html += `<details class="guide-box"><summary>What do these numbers mean?</summary><ul>
    <li><b>Graphics memory</b> is <i>space</i>. A loaded model reserves it even while doing nothing, so 8 GB used at 0% compute is normal. It's freed when the model unloads.</li>
    <li><b>Compute</b> is <i>work</i>. It's high while the model reads your prompt or writes, and near 0 when idle.</li>
    <li><b>Reading</b> your prompt is fast because it's done in big batches. <b>Writing</b> is one token at a time and is mostly limited by the <b>memory bus</b>: how fast the card can read the whole model for every token. That's why smaller or more compressed models write faster.</li>
    <li>If writing is slow while compute stays low, part of the model is usually outside graphics memory (on the CPU or overflowed into RAM).</li></ul></details>`;
  body.innerHTML = html;
}

function replyHtml() {
  const lr = lastReplyStats();
  if (!lr) return '';
  const st = lr.st;
  const rate = (n, d) => (n && d ? `${(n / (d / 1e9)).toFixed(0)} tok/s` : '–');
  const sec = (d) => (d ? `${(d / 1e9).toFixed(1)} s` : '–');
  return `<div class="t-sec">Last reply (${esc(lr.m.model || '')})</div><div class="reply-grid">
    <span>Loading the model</span><b>${st.load_duration > 5e8 ? sec(st.load_duration) : 'already loaded'}</b>
    <span>Reading ${fmtInt(st.prompt_eval_count || 0)} prompt tokens</span><b>${rate(st.prompt_eval_count, st.prompt_eval_duration)}</b>
    <span>Writing ${fmtInt(st.eval_count || 0)} tokens</span><b>${rate(st.eval_count, st.eval_duration)}</b>
    <span>Time to first word</span><b>${sec((st.load_duration || 0) + (st.prompt_eval_duration || 0))}</b>
    <span>Total</span><b>${sec(st.total_duration)}</b></div>`;
}

function toggleMonitor(force) {
  const m = $('#monitor');
  const show = force !== undefined ? force : m.hidden;
  m.hidden = !show;
  if (show) { $('#tune').hidden = true; renderMonitor(); }
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  const body = $('#mon-body');
  body.addEventListener('mousemove', (e) => {
    const plot = e.target.closest('.ch-plot');
    if (!plot) { if (MON.hover) { MON.hover = null; renderMonitor(); } return; }
    const r = plot.getBoundingClientRect();
    MON.hover = { key: plot.dataset.chart, frac: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) };
    renderMonitor();
  });
  body.addEventListener('mouseleave', () => { MON.hover = null; renderMonitor(); });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mon-unload]');
    if (!b) return;
    await Backend.post('/api/generate', { model: b.dataset.monUnload, keep_alive: 0 }).catch((err) => toast(errText(err), 'bad'));
    await refreshPs(); renderGauge(); renderHardware(); renderMonitor();
  });
});
