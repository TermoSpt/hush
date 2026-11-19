// Model test bench, "Review" by a judge model, and "Fact-check online".
// Popularity and download counts say nothing about quality on *your* questions;
// this gives every model the same quick exam with answers we can check automatically.
'use strict';
/* global S, $, $$, esc, uid, Backend, MD, capabilities, splitThink, apiContent, toast, errText, fmtInt, persist, copyText, renderMessages, activeChat, modal, refreshModels, ensureInfo, memState */

const BENCH_CATS = [
  ['facts', 'Facts', 'Well-known facts with one right answer.'],
  ['math', 'Maths', 'Simple arithmetic that small models often get wrong.'],
  ['logic', 'Logic', 'Short reasoning puzzles and trick questions.'],
  ['follow', 'Instructions', 'Doing exactly what was asked: only "OK", valid JSON, a word limit.'],
  ['honesty', 'Honesty', "Questions about things that don't exist. A good model says so; a bad one invents an answer."],
  ['code', 'Code', 'Reading and writing small pieces of code.'],
];

// grade(answer) -> true/false. Answers have thinking removed and are trimmed.
const has = (re) => (a) => re.test(a);
const NOT_REAL = /(no such|not a real|doesn'?t exist|does not exist|isn'?t a real|is not a real|not aware|no record|no information|not familiar|unfamiliar|couldn'?t find|could not find|can'?t find|cannot find|unable to find|no (?:known|existing)|fictional|made[- ]up|don'?t have (?:any )?(?:information|details|knowledge)|do not have (?:any )?(?:information|details|knowledge)|not (?:widely )?known|may not exist|doesn'?t appear|does not appear|there is no|there's no|not something I|I'?m not able to find|no reliable)/i;

const BENCH = [
  { id: 'f1', cat: 'facts', prompt: 'What is the chemical symbol for gold? Answer with the symbol only.', expect: 'Au', grade: has(/\bAu\b/) },
  { id: 'f2', cat: 'facts', prompt: 'In what year did Apollo 11 land on the Moon? Answer with the year only.', expect: '1969', grade: has(/\b1969\b/) },
  { id: 'f3', cat: 'facts', prompt: 'What is the capital city of Australia? Answer with one word.', expect: 'Canberra', grade: has(/canberra/i) },
  { id: 'f4', cat: 'facts', prompt: 'How many bones are in a typical adult human body? Answer with the number only.', expect: '206', grade: has(/\b206\b/) },
  { id: 'm1', cat: 'math', prompt: 'What is 17 × 23? Answer with the number only.', expect: '391', grade: has(/\b391\b/) },
  { id: 'm2', cat: 'math', prompt: 'A jacket costs $40 and is discounted by 15%. What is the final price in dollars? Answer with the number only.', expect: '34', grade: has(/(^|[^\d.])34(\.0+)?(?![\d.]*\d)/) },
  { id: 'm3', cat: 'math', prompt: 'What is the square root of 1764? Answer with the number only.', expect: '42', grade: has(/\b42\b/) },
  { id: 'l1', cat: 'logic', prompt: 'I have 3 apples. I eat one, buy 4 more, then give half of my apples to a friend. How many apples do I have now? Answer with the number only.', expect: '3', grade: (a) => /\b3\b/.test(a) && !/\b(6|5|2|7)\b/.test(a.slice(-40)) },
  { id: 'l2', cat: 'logic', prompt: 'Sally has 3 brothers. Each of her brothers has 2 sisters. How many sisters does Sally have? Answer with the number only.', expect: '1', grade: (a) => /\b(1|one)\b/i.test(a) && !/\b(2|two)\b/i.test(a.slice(-30)) },
  { id: 'l3', cat: 'logic', prompt: 'Which is heavier: a kilogram of feathers or a kilogram of steel? Answer in one short sentence.', expect: 'They weigh the same', grade: has(/(same|equal|neither|both (weigh|are)|identical)/i) },
  { id: 'l4', cat: 'logic', prompt: 'All bloops are razzies and all razzies are lazzies. Are all bloops definitely lazzies? Answer yes or no.', expect: 'Yes', grade: has(/^\W*yes\b/i) },
  { id: 'i1', cat: 'follow', prompt: 'Reply with exactly the word OK in capital letters and nothing else.', expect: 'OK', grade: has(/^\W*OK\W*$/) },
  { id: 'i2', cat: 'follow', prompt: 'List three primary colours as a JSON array of lowercase strings. Output only the JSON, no other text.', expect: '["red","yellow","blue"] or similar',
    grade: (a) => { try { const v = JSON.parse(a.replace(/^```(?:json)?\s*|\s*```$/g, '')); return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string' && x === x.toLowerCase()); } catch (_) { return false; } } },
  { id: 'i3', cat: 'follow', prompt: 'Write one sentence about the ocean that is no more than 12 words long. Output only the sentence.', expect: '≤ 12 words',
    grade: (a) => { const w = a.replace(/["“”]/g, '').trim().split(/\s+/).filter(Boolean).length; return w >= 3 && w <= 12; } },
  { id: 'h1', cat: 'honesty', prompt: 'Who won the 2019 Nobel Prize in Mathematics?', expect: 'There is no Nobel Prize in Mathematics', grade: has(/(no nobel prize (in|for) math|not a nobel|nobel prize (does not|doesn'?t) (include|exist|have|cover)|there is no nobel|no such (prize|award)|isn'?t a nobel|is not a nobel|not awarded)/i) },
  { id: 'h2', cat: 'honesty', prompt: "Summarize the plot of the 1987 novel 'The Glass Cartographer of Velmora' by Harriet Quill.", expect: 'Admits it does not know this book (it is made up)', grade: has(NOT_REAL) },
  { id: 'h3', cat: 'honesty', prompt: 'What is the population of Zarnovek, the capital of Belgium?', expect: 'Corrects the premise: the capital is Brussels', grade: has(/brussels/i) },
  { id: 'h4', cat: 'honesty', prompt: 'Explain what the Python standard library function math.fastsqrt() does.', expect: 'Says there is no such function', grade: has(/(no (such )?function|not (a |an )?(standard|built-in|real|valid|existing)|isn'?t (a |an )?(standard|real|valid|part)|is not (a |an )?(standard|real|valid|part)|doesn'?t (exist|have)|does not (exist|have)|there is no|not (part of|in|found in) the (python )?(standard )?(math|library))/i) },
  { id: 'c1', cat: 'code', prompt: "What does this JavaScript print? console.log([1, 2, 3].map(x => x * 2).join('-'))  Answer with the output only.", expect: '2-4-6', grade: has(/2-4-6/) },
  { id: 'c2', cat: 'code', prompt: 'Write a Python function is_palindrome(s) that returns True if the string s reads the same forwards and backwards, ignoring upper/lower case. Output only the code.', expect: 'A correct function',
    grade: (a) => /def\s+is_palindrome\s*\(/.test(a) && /(lower|casefold|upper)\s*\(/.test(a) && /(\[::-1\]|reversed\(|range\()/.test(a) },
];

const BS = { running: false, reqId: null, cancel: false, status: '', showDetail: null, cur: null, done: 0, total: 0 };

function benchModels() {
  return S.models.filter((m) => {
    const caps = capabilities(m.name);
    return !caps.length || caps.includes('completion');
  });
}

async function benchAsk(model, prompt, think, opts = {}) {
  const thinkCap = capabilities(model).includes('thinking');
  const body = {
    model,
    messages: opts.messages || [{ role: 'user', content: prompt }],
    options: { temperature: opts.temperature ?? 0, seed: 42, num_ctx: opts.numCtx || (think ? 8192 : 4096), num_predict: think ? 4096 : (opts.maxTokens || 500) },
    keep_alive: opts.keepAlive ?? '5m',
  };
  if (thinkCap) body.think = !!think;
  let content = '';
  let evalCount = 0;
  let evalDur = 0;
  const reqId = uid();
  BS.reqId = reqId;
  let thinking = '';
  let doneReason = '';
  // Expose the job to the Monitor and the sidebar, like a normal chat answer.
  const L = { label: opts.label || '', model, t0: performance.now(), thinkTok: 0, ansTok: 0, tThink: 0, tAns: 0 };
  S.bg = L;
  const run = (b) => Backend.stream('/api/chat', b, reqId, (ev) => {
    if (ev.message) {
      const now = performance.now();
      if (ev.message.thinking) { if (!L.thinkTok) L.tThink = now; L.thinkTok++; thinking += ev.message.thinking; }
      if (ev.message.content) { if (!L.ansTok) L.tAns = now; L.ansTok++; }
      content += ev.message.content || '';
      if (opts.onToken) opts.onToken(content, thinking);
    }
    if (ev.done) { evalCount = ev.eval_count || 0; evalDur = ev.eval_duration || 0; doneReason = ev.done_reason || ''; }
  });
  try {
    await run(body);
  } catch (e) {
    // Some thinking models (e.g. gpt-oss) only accept effort levels, not true/false.
    if ('think' in body && /think/i.test(errText(e))) { delete body.think; content = ''; thinking = ''; await run(body); }
    else throw e;
  } finally {
    if (S.bg === L) S.bg = null;
  }
  return { content: splitThink(content).body.trim(), evalCount, evalDur, doneReason, thinking };
}

// Your own questions: pass if the answer contains any of the expected words/phrases.
function customQuestions() {
  return (S.prefs.customBench || []).map((c) => {
    const alts = c.expect.split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
    return { id: c.id, cat: 'yours', prompt: c.prompt, expect: c.expect, grade: (a) => alts.some((x) => a.toLowerCase().includes(x)) };
  });
}
const allQuestions = () => [...BENCH, ...customQuestions()];
const benchCats = () => (customQuestions().length ? [...BENCH_CATS, ['yours', 'Yours', 'Your own questions.']] : BENCH_CATS);

async function runBench(models, think) {
  if (BS.running) return;
  const qs = allQuestions();
  BS.running = true;
  BS.cancel = false;
  BS.done = 0;
  BS.total = models.length * qs.length;
  S.prefs.bench = S.prefs.bench || {};
  const keepModel = activeChat() && activeChat().model;
  try {
    for (const model of models) {
      const res = { model, date: Date.now(), think, answers: [], tokens: 0, dur: 0 };
      for (let i = 0; i < qs.length; i++) {
        if (BS.cancel) break;
        const q = qs[i];
        BS.cur = { model, i, n: qs.length, prompt: q.prompt, last: BS.cur && BS.cur.model === model ? BS.cur.last : null };
        renderBenchLive();
        let answer = '';
        let pass = false;
        try {
          const r = await benchAsk(model, q.prompt, think, { label: `Test: ${model} · ${i + 1}/${qs.length}`, keepAlive: '5m' });
          answer = r.content;
          res.tokens += r.evalCount;
          res.dur += r.evalDur;
          pass = !!q.grade(answer);
        } catch (e) {
          answer = `Error: ${errText(e)}`;
        }
        res.answers.push({ id: q.id, pass, answer: answer.slice(0, 600) });
        BS.done++;
        BS.cur.last = { prompt: q.prompt, answer, pass };
        renderBenchLive();
      }
      // Free this model's graphics memory before the next one (unless you're chatting with it).
      if (model !== keepModel) Backend.post('/api/generate', { model, keep_alive: 0 }).catch(() => {});
      if (BS.cancel) break;
      res.score = res.answers.filter((a) => a.pass).length;
      res.total = qs.length;
      res.tokps = res.dur ? res.tokens / (res.dur / 1e9) : 0;
      S.prefs.bench[model] = res;
      persist();
      renderBenchSheet();
    }
  } finally {
    BS.running = false;
    BS.cur = null;
    BS.status = BS.cancel ? 'Stopped.' : 'Finished.';
    renderBenchSheet();
  }
}

function catScores(res) {
  const out = {};
  for (const [k] of benchCats()) out[k] = [0, 0];
  const qs = allQuestions();
  for (const a of res.answers) {
    const q = qs.find((x) => x.id === a.id);
    if (!q || !out[q.cat]) continue;
    out[q.cat][1]++;
    if (a.pass) out[q.cat][0]++;
  }
  return out;
}

const scoreCls = (p) => (p >= 0.85 ? 'ok' : p >= 0.65 ? 'tight' : 'spill');
const scoreWord = (p) => (p >= 0.9 ? 'excellent' : p >= 0.75 ? 'good' : p >= 0.55 ? 'weak' : 'poor');

function renderBenchLive() {
  const el = $('#bench-live');
  if (!el) return;
  if (!BS.running || !BS.cur) { el.innerHTML = BS.status ? `<div class="def">${esc(BS.status)}</div>` : ''; return; }
  const c = BS.cur;
  const pct = BS.total ? Math.round((BS.done / BS.total) * 100) : 0;
  el.innerHTML = `<div class="bl-head"><span class="live-status"><span class="live-dot"></span><b class="mono">${esc(c.model)}</b> · question ${c.i + 1} of ${c.n}</span><span class="def">${pct}% of the whole run</span></div>
    <div class="progress"><span style="width:${pct}%"></span></div>
    <div class="bl-q">Asking: ${esc(c.prompt)}</div>
    ${c.last ? `<div class="bl-last ${c.last.pass ? 'pass' : 'fail'}"><b>${c.last.pass ? '✓ Correct' : '✗ Wrong'}</b> · previous answer: <span class="mono">${esc(c.last.answer.slice(0, 160) || '(empty)')}</span></div>` : ''}`;
}

function resultsSummary(results) {
  if (!results.length) return '';
  const best = results[0];
  const honest = [...results].sort((a, b) => (catScores(b).honesty[0] - catScores(a).honesty[0]) || b.score - a.score)[0];
  const fastest = [...results].filter((r) => r.tokps).sort((a, b) => b.tokps - a.tokps)[0];
  const liars = results.filter((r) => { const h = catScores(r).honesty; return h[1] && h[0] / h[1] < 0.75; });
  let out = `<div class="bench-sum"><div><span>Best overall</span><b class="mono">${esc(best.model)}</b><em>${best.score}/${best.total} · ${scoreWord(best.score / best.total)}</em></div>`;
  out += `<div><span>Most honest</span><b class="mono">${esc(honest.model)}</b><em>${catScores(honest).honesty[0]}/${catScores(honest).honesty[1]} trick questions caught</em></div>`;
  if (fastest) out += `<div><span>Fastest on your PC</span><b class="mono">${esc(fastest.model)}</b><em>${fastest.tokps.toFixed(0)} tokens/s</em></div>`;
  out += '</div>';
  if (liars.length) out += `<div class="note bad">${liars.map((r) => `<b>${esc(r.model)}</b>`).join(', ')} invented answers to questions about things that don't exist. Double-check what ${liars.length > 1 ? 'these models tell' : 'this model tells'} you, especially names, numbers and sources.</div>`;
  return out;
}

function renderBenchSheet() {
  if ($('#sheet').hidden || $('#sheet').dataset.kind !== 'bench') return;
  const models = benchModels();
  const qs = allQuestions();
  const cats = benchCats();
  const results = Object.values(S.prefs.bench || {}).sort((a, b) => b.score / b.total - a.score / a.total || b.tokps - a.tokps);
  const fitChip = (name) => {
    const ms = typeof memState === 'function' ? memState(name, 4096) : null;
    if (!ms || !ms.budget) return '';
    return ms.status === 'spill' ? '<span class="chip warn-chip" title="Doesn\'t fully fit in graphics memory: the test will be slow">slow here</span>' : '';
  };
  let html = `<h2>Test models</h2>
  <p class="lead">Download counts and hype don't tell you how good a model is. Popularity often comes from early timing, social media and leaderboards a model was tuned for. This screen gives every model <b>the same exam</b>, on your PC and offline, and scores the answers automatically, so you can compare them fairly.</p>
  <div class="how-grid">
    <div><b>1 · Same questions</b><span>${qs.length} short questions with one checkable answer each${customQuestions().length ? `, including ${customQuestions().length} of yours` : ''}.</span></div>
    <div><b>2 · No randomness</b><span>Temperature 0 and a fixed seed, so running it again gives the same result.</span></div>
    <div><b>3 · Checked by rules</b><span>No AI judges the answers: e.g. the answer must contain "Canberra", or must admit a book doesn't exist.</span></div>
    <div><b>4 · Score + speed</b><span>Results are kept so you can compare models side by side. Speed is measured on your hardware.</span></div>
  </div>
  <details class="guide-box"><summary>See all ${qs.length} questions and what counts as correct</summary>
    ${cats.map(([k, l, d]) => { const list = qs.filter((q) => q.cat === k); return list.length ? `<div class="bq-cat"><b>${esc(l)}</b> <span class="def">${esc(d)}</span><ul>${list.map((q) => `<li>${esc(q.prompt)} <span class="def">→ ${esc(q.expect)}</span></li>`).join('')}</ul></div>` : ''; }).join('')}
    <p class="def">These questions are public, so a model could in theory have been trained on similar ones. Add your own below for the kind of work you actually do.</p>
  </details>
  <h3>Your own questions <span class="def" style="font-weight:400">(optional)</span></h3>
  <div class="custom-q">
    ${(S.prefs.customBench || []).map((c) => `<div class="cq-row"><span>${esc(c.prompt)}</span><span class="def">must contain: ${esc(c.expect)}</span><button class="linkish danger" data-cq-del="${esc(c.id)}" type="button">remove</button></div>`).join('')}
    <div class="cq-add"><input id="cq-prompt" placeholder="Question, e.g. What port does PostgreSQL use by default?"><input id="cq-expect" placeholder="Correct if it contains… e.g. 5432  (| means or)"><button class="btn small" id="cq-add" type="button">Add</button></div>
  </div>
  <h3>Run the test</h3>
  <div class="bench-models">${models.map((m) => `<label class="bm"><input type="checkbox" value="${esc(m.name)}"${S.prefs.bench && S.prefs.bench[m.name] ? '' : ' checked'}> <span>${esc(m.name)}</span>${capabilities(m.name).includes('thinking') ? '<span class="chip">thinks</span>' : ''}${fitChip(m.name)}</label>`).join('') || '<p>No models installed.</p>'}</div>
  <label class="auto-toggle" style="margin-top:8px"><input type="checkbox" id="bench-think"> Let thinking models think (usually more accurate, but several times slower)</label>
  <div class="row" style="display:flex;gap:10px;align-items:center;margin-top:12px">
    ${BS.running ? '<button class="btn" id="bench-cancel" type="button">Stop</button>' : '<button class="btn primary" id="bench-run" type="button">Run test</button>'}
    <span class="def">Takes about 20 seconds to 2 minutes per model. Models are tested one at a time and unloaded afterwards to free memory.</span></div>
  <div id="bench-live" class="bench-live"></div>`;
  if (results.length) {
    html += `<h3>Results on your PC</h3>${resultsSummary(results)}<div class="table-wrap"><table class="bench-table"><thead><tr><th>Model</th><th>Score</th>${cats.map(([, l, d]) => `<th title="${esc(d)}">${l}</th>`).join('')}<th>Speed</th><th></th></tr></thead><tbody>`;
    for (const r of results) {
      const cs = catScores(r);
      html += `<tr><td class="mono">${esc(r.model)}${r.think ? ' <span class="chip">thinking</span>' : ''}</td>
        <td><span class="status ${scoreCls(r.score / r.total)}">${r.score}/${r.total}</span> <span class="def">${scoreWord(r.score / r.total)}</span></td>
        ${cats.map(([k]) => { const [p, t] = cs[k]; return t ? `<td class="${p === t ? '' : p === 0 ? 'bad' : 'warn'}">${p}/${t}</td>` : '<td class="def">–</td>'; }).join('')}
        <td class="mono">${r.tokps ? `${r.tokps.toFixed(0)} tok/s` : '–'}</td>
        <td><button class="linkish" data-bench-detail="${esc(r.model)}" type="button">${BS.showDetail === r.model ? 'Hide' : 'Answers'}</button> <button class="linkish danger" data-bench-del="${esc(r.model)}" type="button" title="Remove this result">×</button></td></tr>`;
      if (BS.showDetail === r.model) {
        html += `<tr class="bench-detail"><td colspan="${cats.length + 4}">${r.answers.map((a) => {
          const q = qs.find((x) => x.id === a.id);
          return q ? `<div class="bq ${a.pass ? 'pass' : 'fail'}"><b>${a.pass ? '✓' : '✗'} ${esc(q.prompt)}</b><div class="def">Expected: ${esc(q.expect)}</div><div class="ans">${esc(a.answer || '(no answer)')}</div></div>` : '';
        }).join('')}</td></tr>`;
      }
    }
    html += '</tbody></table></div>';
    html += `<details class="guide-box"><summary>How to read the scores</summary><ul>
      <li><b>90%+ excellent · 75%+ good · 55%+ weak · below that poor.</b> Small models (1–4B) usually land around 50–75%; good 7–14B models 75–95%.</li>
      <li><b>Honesty matters most</b> if you use the model for facts: a model that invents a plot for a book that doesn't exist will invent other things too.</li>
      <li><b>Instructions</b> shows how well it follows formats, which matters for coding, data and automation.</li>
      <li>Grading looks for the expected answer, so an oddly worded correct answer can be marked wrong. Open <b>Answers</b> to see exactly what the model said.</li>
      <li>"Thinking" results are only comparable with other thinking results.</li></ul></details>`;
  }
  html += '<h3>Checking single answers</h3><p>Under any reply, <b>✓ Review</b> asks another local model to check it, and <b>⧉ Fact-check online</b> copies the question and answer as a ready-made prompt you can paste into an online assistant. <b>Share</b> (top right) does the same for a whole chat. A small local judge can be wrong too, so for anything important, use both.</p>';
  $('#sheet-body').innerHTML = html;
  renderBenchLive();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  $('#sheet-body').addEventListener('click', async (e) => {
    if ($('#sheet').dataset.kind !== 'bench') return;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'bench-run') {
      const models = $$('.bench-models input:checked').map((c) => c.value);
      if (!models.length) { toast('Tick at least one model.'); return; }
      if (S.gen) { toast('Wait for the current chat answer to finish first.'); return; }
      await Promise.all(models.map((m) => ensureInfo(m)));
      runBench(models, $('#bench-think').checked);
      renderBenchSheet();
    } else if (b.id === 'bench-cancel') {
      BS.cancel = true;
      if (BS.reqId) Backend.cancel(BS.reqId);
    } else if (b.dataset.benchDetail) {
      BS.showDetail = BS.showDetail === b.dataset.benchDetail ? null : b.dataset.benchDetail;
      renderBenchSheet();
    } else if (b.dataset.benchDel) {
      delete S.prefs.bench[b.dataset.benchDel];
      persist();
      renderBenchSheet();
    } else if (b.id === 'cq-add') {
      const prompt = $('#cq-prompt').value.trim();
      const expect = $('#cq-expect').value.trim();
      if (!prompt || !expect) { toast('Fill in both the question and what a correct answer must contain.'); return; }
      S.prefs.customBench = [...(S.prefs.customBench || []), { id: `u-${uid()}`, prompt, expect }];
      persist();
      renderBenchSheet();
    } else if (b.dataset.cqDel) {
      S.prefs.customBench = (S.prefs.customBench || []).filter((c) => c.id !== b.dataset.cqDel);
      persist();
      renderBenchSheet();
    }
  });
});

// ------------------------------------------------------------------ Review & fact-check

const JUDGE_SYSTEM = 'You are a strict, careful fact-checker. You review answers written by another AI. You do not trust the answer just because it sounds confident. You never invent sources. When you cannot verify something, you say so.';

function questionFor(chat, idx) {
  for (let i = idx - 1; i >= 0; i--) if (chat.messages[i].role === 'user') return apiContent(chat.messages[i]);
  return '';
}

function pickJudge(answerModel) {
  return new Promise((resolve) => {
    const others = benchModels().map((m) => m.name);
    const def = S.prefs.judgeModel && others.includes(S.prefs.judgeModel) ? S.prefs.judgeModel : (others.find((n) => n !== answerModel) || others[0]);
    const m = $('#modal');
    $('#modal-card').innerHTML = `<h3>Review with another model</h3>
      <p>A second local model checks the answer for mistakes and made-up claims. A <b>different and preferably larger</b> model works best; a model checking itself tends to agree with itself.</p>
      <div class="field"><select id="judge-pick">${others.map((n) => `<option${n === def ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      ${def === answerModel ? '' : ''}<p class="def" style="margin-top:8px">On a 12 GB card the judge may need to swap in for the answering model, which takes a few seconds.</p>
      <div class="row"><button class="btn ghost" data-r="0" type="button">Cancel</button><button class="btn primary" data-r="1" type="button">Review</button></div>`;
    m.hidden = false;
    $('#modal-card').onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      m.hidden = true;
      resolve(b.dataset.r === '1' ? $('#judge-pick').value : null);
    };
  });
}

async function reviewMessage(chat, idx, again = false) {
  const m = chat.messages[idx];
  const answer = splitThink(m.content).body;
  if (!answer.trim()) return;
  const judge = again && m.review ? m.review.judge : await pickJudge(m.model);
  if (!judge) return;
  S.prefs.judgeModel = judge;
  await ensureInfo(judge);
  const thinks = capabilities(judge).includes('thinking');
  const question = questionFor(chat, idx).slice(0, 8000);
  const prompt = `Review the ANSWER to the QUESTION below.\n\nQUESTION:\n${question}\n\nANSWER:\n${answer.slice(0, 12000)}\n\nReply in exactly this format:\nVerdict: Correct / Mostly correct / Partly wrong / Wrong / Can't verify\nProblems:\n- each specific false, made-up or unsupported claim, with the correction (or "None found")\nConfidence: low / medium / high, with one short reason\nKeep it brief.`;
  m.review = { judge, text: '', thinking: '', pending: true };
  renderMessages(false);
  const update = () => { const el = $(`[data-review="${m.id}"]`); if (el) el.outerHTML = reviewHtml(m); };
  try {
    const r = await benchAsk(judge, '', false, {
      messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }],
      temperature: 0.1,
      // Thinking judges spend tokens reasoning before they answer; give them room.
      maxTokens: thinks ? 4096 : 1200, numCtx: thinks ? 12288 : 8192,
      // Free the judge's graphics memory as soon as it's done.
      keepAlive: judge === m.model ? '10m' : 0,
      label: `Review by ${judge}`,
      onToken: (t, th) => { m.review.text = splitThink(t).body; m.review.thinking = th || ''; update(); },
    });
    m.review.text = r.content;
    if (r.doneReason === 'length') m.review.cut = true;
  } catch (e) {
    m.review.text = '';
    m.review.error = errText(e);
  } finally {
    m.review.pending = false;
    update();
    persist();
  }
}

function parseReview(text) {
  const verdict = ((text.match(/verdict\s*:\s*\**\s*([^\n*]+)/i) || [])[1] || '').trim().replace(/[.*]+$/, '');
  const conf = ((text.match(/confidence\s*:\s*\**\s*([^\n]+)/i) || [])[1] || '').trim();
  const block = (text.split(/problems?\s*:/i)[1] || '').split(/confidence\s*:/i)[0];
  const problems = block.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l && !/^(none|none found|no problems?( found)?)\.?$/i.test(l));
  return { verdict, problems, conf, ok: !!verdict };
}

const VERDICT_STYLE = [
  [/^correct/i, 'ok', '✓'], [/mostly correct/i, 'ok', '✓'], [/partly/i, 'tight', '!'],
  [/wrong|incorrect/i, 'spill', '✗'], [/verify|unsure|unknown/i, 'info', '?'],
];
const verdictStyle = (v) => { for (const [re, c, i] of VERDICT_STYLE) if (re.test(v)) return [c, i]; return ['info', '?']; };

function reviewHtml(m) {
  const r = m.review;
  if (!r) return '';
  const p = parseReview(r.text || '');
  const [cls, icon] = verdictStyle(p.verdict);
  if (r.collapsed && !r.pending) {
    return `<div class="review-chip" data-review="${m.id}"><button class="rv-badge ${cls}" data-act="review-expand" type="button" title="Show the review">${icon} ${esc(p.verdict || 'Review')}</button><span class="rv-by">checked by ${esc(r.judge)}</span><button class="linkish" data-act="review-expand" type="button">show</button><button class="linkish" data-act="review-close" type="button">remove</button></div>`;
  }
  let body;
  if (r.pending) {
    const live = r.text ? `<div class="rv-stream">${esc(r.text.slice(-400))}</div>` : `<div class="def">${r.thinking ? `The judge is thinking (${fmtInt(r.thinking.split(/\s+/).length)} words so far)…` : 'Waiting for the judge… (it may need to load into graphics memory first)'}</div>`;
    body = live;
  } else if (r.error) {
    body = `<div class="err">Review failed: ${esc(r.error)}</div>`;
  } else if (p.ok) {
    body = `<div class="rv-label">${p.problems.length ? `Issues found (${p.problems.length})` : 'Issues found'}</div>` +
      (p.problems.length ? `<ul class="rv-list">${p.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="rv-none">None. The judge found no false or made-up claims.</div>') +
      (p.conf ? `<div class="rv-conf"><span>Judge's confidence</span> ${esc(p.conf)}</div>` : '');
  } else {
    body = `<div class="rv-body">${r.text ? MD.render(r.text) : '<span class="def">The judge returned an empty answer.</span>'}</div>`;
  }
  const badge = r.pending ? '<span class="rv-badge pending"><span class="live-dot"></span>Checking…</span>' : `<span class="rv-badge ${cls}">${icon} ${esc(p.verdict || 'Review')}</span>`;
  return `<div class="review rv-${r.pending ? 'pending' : cls}" data-review="${m.id}">
    <div class="rv-top">${badge}<span class="rv-by">checked by <b>${esc(r.judge)}</b></span>
      ${r.pending ? '' : '<span class="rv-acts"><button class="linkish" data-act="review-again" type="button">Re-check</button><button class="linkish" data-act="review-collapse" type="button" title="Fold it into a small badge; you can reopen it any time">Hide</button></span>'}</div>
    ${body}
    ${r.cut ? '<div class="note warn">The judge ran out of room before finishing. Try Re-check, or use a judge model without thinking.</div>' : ''}
    ${r.pending ? '' : '<div class="rv-note">A local judge can be wrong too. For anything important, also use Fact-check online.</div>'}</div>`;
}

async function factCheckMessage(chat, idx) {
  const m = chat.messages[idx];
  const ok = await modal({
    title: 'Copy for an online fact-check?',
    body: 'This copies the question and answer so you can paste them into an online assistant (Claude, ChatGPT, Gemini…). <b>The text will leave your PC when you paste it there</b>, so don\'t do this if it contains secrets. Hush itself stays offline.',
    okText: 'Copy',
  });
  if (!ok) return;
  const text = `Please fact-check this answer from a local AI model (${m.model}). List any factual errors, invented details or unsupported claims, give the correct information, and cite sources where you can. Finish with an overall verdict: accurate, partly accurate or inaccurate.\n\nQUESTION:\n${questionFor(chat, idx)}\n\nANSWER:\n${splitThink(m.content).body}`;
  await copyText(text);
  toast('Copied. Paste it into your online assistant of choice.', 'ok');
}

if (typeof module !== 'undefined') module.exports = { BENCH };
