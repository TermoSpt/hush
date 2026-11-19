// "Setup check": detects how Ollama is configured and applies the recommended
// settings in one click (Windows). Also adds model storage, a name guide and a
// "will it fit?" calculator to the Models screen.
'use strict';
/* global S, $, esc, Backend, Est, toast, errText, fmtInt, persist, modal, vramBudget, renderGauge, renderMemCard, refreshModels */

let ENV = null;
let restartNeeded = false;

const isOn = (v) => v === '1' || v === 'true';

const SETUP_ITEMS = [
  { name: 'OLLAMA_FLASH_ATTENTION', title: 'Flash attention', rec: '1', good: isOn,
    show: (v) => (isOn(v) ? 'On' : v ? 'Off' : 'Not set (Ollama decides)'),
    why: 'A faster way of handling long conversations, and required for the memory-saving setting below. Safe on NVIDIA cards.' },
  { name: 'OLLAMA_KV_CACHE_TYPE', title: 'Conversation memory format', rec: 'q8_0', good: (v) => ['q8_0', 'q4_0', 'f16'].includes(v),
    show: (v) => (v === 'f16' ? 'f16 (chosen for speed)' : v || 'f16 (default)'),
    alt: { 'q8_0': ['f16', 'Prefer speed (f16)'], f16: ['q8_0', 'Prefer memory (q8_0)'] },
    why: 'A trade-off. q8_0 halves the memory each conversation needs (about twice the context on the same card) with almost no quality loss, but it can be slightly slower on some cards. f16 is the fastest when your models already fit comfortably. Needs flash attention on.' },
  { name: 'OLLAMA_NUM_PARALLEL', title: 'Parallel requests', rec: '1', good: (v) => !v || v === '1',
    show: (v) => v || 'Not set (Ollama decides)',
    why: 'Every parallel slot reserves its own conversation memory. For one person on one PC, 1 is best: more room for context.' },
  { name: 'OLLAMA_NOHISTORY', title: 'Terminal prompt history', rec: '1', good: isOn,
    show: (v) => (isOn(v) ? 'Off: nothing saved' : 'On: saved in plain text'),
    why: '`ollama run` in a terminal saves everything you type to a plain-text file (~/.ollama/history). Turn it off for privacy.' },
];

async function loadEnv() {
  try { ENV = await Backend.ollamaEnv(); } catch (_) { ENV = {}; }
  return ENV;
}

// Keep Hush's memory estimates in line with how Ollama is actually configured.
async function detectOllamaEnv() {
  const env = await loadEnv();
  const fa = isOn(env.OLLAMA_FLASH_ATTENTION);
  S.prefs.flashAttention = fa;
  S.prefs.kvType = fa && ['q8_0', 'q4_0'].includes(env.OLLAMA_KV_CACHE_TYPE) ? env.OLLAMA_KV_CACHE_TYPE : 'f16';
  if (S.mode) { renderGauge(); if (!$('#tune').hidden) renderMemCard(); }
}

async function applyEnv(name, value) {
  try {
    await Backend.setOllamaEnv(name, value);
    restartNeeded = true;
    return true;
  } catch (e) {
    toast(errText(e), 'bad');
    return false;
  }
}

async function renderSetupSheet() {
  const box = $('#sheet-body');
  box.innerHTML = '<h2>Setup check</h2><p class="lead">Checking…</p>';
  await Promise.all([loadEnv(), refreshModels()]);
  if ($('#sheet').hidden || $('#sheet').dataset.kind !== 'setup') return;
  const g = S.gpu[0];
  const budget = vramBudget();
  const row = (ok, title, detail, action = '') => `<div class="sc-row"><span class="sc-ic ${ok === true ? 'ok' : ok === false ? 'bad' : 'info'}">${ok === true ? '✓' : ok === false ? '!' : 'i'}</span><div class="sc-main"><b>${title}</b><div class="def">${detail}</div></div>${action}</div>`;
  let html = `<h2>Setup check</h2><p class="lead">Everything Hush can check about your local AI setup, with one-click fixes. You don't need to edit config files.</p>`;
  if (restartNeeded) {
    html += `<div class="note warn" style="margin-bottom:12px"><b>Restart Ollama to apply your changes:</b> right-click the llama icon in the system tray (bottom right, maybe under ^) → <b>Quit Ollama</b>, then start Ollama again from the Start menu. Hush reconnects by itself.</div>`;
  }
  html += '<h3>Basics</h3>';
  html += row(!!S.connected, S.connected ? `Ollama is running${S.version ? ` (version ${esc(S.version)})` : ''}` : 'Ollama is not running',
    S.connected ? 'Hush talks to it on this PC only (127.0.0.1).' : 'Install it from ollama.com/download, start it, then reopen this screen. On Windows it runs in the system tray.');
  html += row(S.models.length ? true : false, S.models.length ? `${S.models.length} model${S.models.length > 1 ? 's' : ''} installed` : 'No models installed yet',
    S.models.length ? 'Manage them on the Models screen, and compare them with Test models.' : 'Open Models and download one. On a 12 GB card, a 7–9B model is a good start.',
    S.models.length ? '' : '<button class="btn small" data-open-sheet="models" type="button">Open Models</button>');
  html += row(g ? true : budget ? null : false, g ? `${esc(g.name)}: ${(g.total_mb / 1024).toFixed(1)} GB graphics memory` : budget ? `Graphics memory set manually: ${(budget.total / 1073741824).toFixed(1)} GB` : 'Graphics card not detected',
    g ? 'Detected automatically. Hush checks every model against this.' : 'Hush detects NVIDIA cards automatically. For AMD or Intel, enter your graphics memory under Tune → Advanced → This PC.');

  html += '<h3 style="display:flex;justify-content:space-between;align-items:center">Ollama performance &amp; privacy settings <button class="btn small primary" id="sc-all" type="button">Apply all recommended</button></h3>';
  for (const it of SETUP_ITEMS) {
    const v = ENV[it.name] || '';
    const good = it.good(v);
    html += row(good, `${it.title}: ${esc(it.show(v))}`, `${esc(it.why)} <span class="mono">${it.name}</span>`,
      good ? (it.alt && it.alt[v] ? `<button class="btn small ghost" data-env="${it.name}" data-val="${it.alt[v][0]}" type="button">${it.alt[v][1]}</button>` : '')
        : `<button class="btn small" data-env="${it.name}" data-val="${it.rec}" type="button">Use recommended</button>`);
  }
  const ctxEnv = ENV.OLLAMA_CONTEXT_LENGTH;
  html += row(null, `Default context length: ${ctxEnv ? fmtInt(ctxEnv) : 'not set'}`, 'Hush sends the context size for every chat itself (Tune → "How much it remembers"), so you don\'t need this setting. It only affects other apps and the terminal.');
  const kaEnv = ENV.OLLAMA_KEEP_ALIVE;
  html += row(null, `Keep models loaded: ${kaEnv ? esc(kaEnv) : 'default (5 minutes)'}`, 'Hush sets this per request (Tune → Advanced → Keep model in GPU memory).');
  html += `<p class="def" style="margin-top:12px">These are saved as Windows user environment variables, which is how Ollama reads its settings. They take effect after Ollama restarts. Hush only changes the settings listed here, and only when you click.</p>`;
  html += '<h3>Where your models are stored</h3><div id="sc-storage" class="def">Checking…</div>';
  box.innerHTML = html;
  fillStorage('#sc-storage');
}

async function fillStorage(sel) {
  const el = $(sel);
  if (!el) return;
  let group = null;
  try { group = (await Backend.dataMap()).find((x) => x.id === 'ollama-models'); } catch (_) { /* ignore */ }
  const custom = ENV && ENV.OLLAMA_MODELS;
  el.innerHTML = `<div class="sc-row"><span class="sc-ic info">i</span><div class="sc-main"><b class="mono">${esc(custom || (group && group.root) || 'unknown')}</b>
    <div class="def">${group && group.exists ? `${fmtInt(group.file_count)} files · ${Est.fmtGB(group.total_bytes)}` : 'Folder not found yet (it appears after the first download).'}${custom ? ' · custom location (OLLAMA_MODELS)' : ' · Ollama\'s default location'}</div>
    <div class="def">Models are downloaded by Ollama into this folder, whether you use Hush, the Ollama app or the terminal. To keep them on a bigger or faster drive, change it here.</div></div>
    <button class="btn small" id="sc-move" type="button">Change…</button></div>`;
}

async function changeModelsFolder() {
  const cur = (ENV && ENV.OLLAMA_MODELS) || '';
  const path = await modal({ title: 'Store models in another folder', body: 'Enter a full folder path, for example <b>D:\\Ollama\\models</b>. An SSD is best: models load much faster than from a hard disk. Leave empty to go back to the default.', okText: 'Save', input: { placeholder: 'D:\\Ollama\\models', value: cur } });
  if (path === null) return;
  if (await applyEnv('OLLAMA_MODELS', path.trim())) {
    await modal({ title: 'Almost done', body: '1. Quit Ollama (tray icon → <b>Quit Ollama</b>).<br>2. Move the contents of the old models folder into the new one, or skip this and download models again.<br>3. Start Ollama again.', okText: 'Got it', cancelText: '' });
    await loadEnv();
    const kind = $('#sheet').dataset.kind;
    if (kind === 'setup') renderSetupSheet();
    else fillStorage('#mx-storage');
  }
}

// ------------------------------------------------------------------ Models screen extras

const QUANTS = [
  // Effective bits per weight in real files (some layers are kept at higher precision).
  ['Q4_K_M', 5.0, 'the usual default: good quality, small'],
  ['Q5_K_M', 5.9, 'a bit better, a bit bigger'],
  ['Q6_K', 6.8, 'very close to the original'],
  ['Q8_0', 8.6, 'practically lossless, twice Q4'],
  ['F16', 16, 'full size, rarely worth it locally'],
];

function modelsExtrasHtml() {
  return `<h3>Where models are stored</h3><div id="mx-storage" class="def">Checking…</div>
  <h3>Will it fit? <span class="def" style="font-weight:400">Check before you download</span></h3>
  <div class="calc">
    <label>Model size <input id="cx-params" type="number" min="0.5" max="700" step="0.5" value="14"> <span class="def">billion parameters (the "14b" in qwen3:14b)</span></label>
    <label>Quantization <select id="cx-quant">${QUANTS.map(([q, , d], i) => `<option value="${i}">${q}: ${d}</option>`).join('')}</select></label>
    <label>Context <select id="cx-ctx">${[4096, 8192, 16384, 32768, 65536].map((c) => `<option value="${c}"${c === 8192 ? ' selected' : ''}>${c / 1024}k tokens (≈ ${Est.pages(c)} pages)</option>`).join('')}</select></label>
    <div id="cx-out" class="cx-out"></div>
  </div>
  <details class="guide-box"><summary>How to read model names (and why "most downloaded" ≠ best)</summary>
    <p><span class="mono">qwen3:14b-instruct-q4_K_M</span> reads as <b>family</b> : <b>size</b> - <b>variant</b> - <b>quantization</b>.</p>
    <ul>
      <li><b>Size</b> (7b, 14b, 32b…): billions of parameters. Bigger usually means smarter but slower and needs more memory. Roughly, the Q4 download is about 0.6 GB per billion.</li>
      <li><b>latest</b>: the tag Ollama picks by default, usually a mid-size model at Q4_K_M. Check what it actually is before relying on it.</li>
      <li><b>instruct / chat / it</b>: tuned to follow instructions; what you want for chatting. <b>base</b> or <b>text</b> models just continue text and are poor at conversation.</li>
      <li><b>coder</b>: tuned for programming. <b>vl / vision</b>: can see images. <b>embed</b>: makes search vectors, can't chat.</li>
      <li><b>Quantization</b> (q4_K_M, q8_0…): how compressed the weights are. A bigger model at Q4 usually beats a smaller one at Q8.</li>
      <li><b>MoE</b> ("30b-a3b"): a mixture-of-experts model. It needs memory for all 30B, but each word only uses 3B, so it's fast for its size.</li>
    </ul>
    <p><b>Popularity isn't quality.</b> Download counts mostly reflect timing, hype and which models were promoted on Discord, Reddit or YouTube. Fine-tunes and merges with exciting names are often worse than the original model, and some models are tuned to look good on public leaderboards. The only test that counts is yours: run <b>Test models</b>, and try your own typical questions.</p>
  </details>`;
}

function updateCalc() {
  const out = $('#cx-out');
  if (!out) return;
  const params = parseFloat($('#cx-params').value) || 0;
  const [qName, bits] = QUANTS[Number($('#cx-quant').value)];
  const ctx = Number($('#cx-ctx').value);
  const weights = (params * 1e9 * bits) / 8;
  // Typical grouped-query-attention models: KV per token grows slower than size.
  const kvPerTok = 20480 * Math.pow(params, 0.8) * (S.prefs.kvType === 'q8_0' ? 0.53 : S.prefs.kvType === 'q4_0' ? 0.28 : 1);
  const est = Est.estimate({ weightsBytes: weights, archInfo: { elemsPerToken: kvPerTok / 2, globalFrac: 1, window: 0, layers: 40 }, ctx, kvType: 'f16', flashAttention: S.prefs.flashAttention });
  const budget = vramBudget();
  let verdict = '';
  if (budget) {
    const free = budget.total - budget.other;
    const r = est.total / free;
    const cls = r <= Est.OK_RATIO ? 'ok' : r <= Est.TIGHT_RATIO ? 'tight' : 'spill';
    verdict = `<span class="status ${cls}">${cls === 'ok' ? '✓ Fits in your graphics card' : cls === 'tight' ? '⚠ Only just fits' : `✗ Too big: about ${Math.round((1 - Math.min(1, free / est.total)) * 100)}% would run from normal RAM (slow)`}</span>`;
  }
  out.innerHTML = `<div>Download ≈ <b>${Est.fmtGB(weights)}</b> · needs ≈ <b>${Est.fmtGB(est.total)}</b> of graphics memory at ${ctx / 1024}k context (${esc(qName)})${budget ? `, with ${Est.fmtGB(budget.total - budget.other)} free on your card` : ''}.</div>${verdict}<div class="def">A rough guide; the exact need depends on the model's design. Hush shows the real figure once it's downloaded.</div>`;
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  const body = $('#sheet-body');
  body.addEventListener('click', async (e) => {
    const kind = $('#sheet').dataset.kind;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'sc-move') return changeModelsFolder();
    if (kind !== 'setup') return;
    if (b.dataset.openSheet) { openSheet(b.dataset.openSheet); return; }
    if (b.dataset.env) {
      if (await applyEnv(b.dataset.env, b.dataset.val)) { toast('Saved. Restart Ollama to apply.', 'ok'); await detectOllamaEnv(); renderSetupSheet(); }
    } else if (b.id === 'sc-all') {
      let n = 0;
      for (const it of SETUP_ITEMS) if (!it.good(ENV[it.name] || '') && await applyEnv(it.name, it.rec)) n++;
      if (n) toast(`${n} setting${n > 1 ? 's' : ''} saved. Restart Ollama to apply.`, 'ok');
      else toast('Everything is already set as recommended.');
      await detectOllamaEnv();
      renderSetupSheet();
    }
  });
  body.addEventListener('input', (e) => { if (e.target.id && e.target.id.startsWith('cx-')) updateCalc(); });
  body.addEventListener('change', (e) => { if (e.target.id && e.target.id.startsWith('cx-')) updateCalc(); });
});
