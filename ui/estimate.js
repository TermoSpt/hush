// GPU memory estimator.
// A loaded model needs: weights + KV cache (grows with context) + compute buffers.
// Ollama reports the real number once a model is loaded (/api/ps); until then we estimate
// from the model's architecture (/api/show), and we calibrate against the real number.
'use strict';

const Est = (() => {
  const GiB = 1024 ** 3;
  // Bytes per cached element for each OLLAMA_KV_CACHE_TYPE.
  const KV_BYTES = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };
  const CTX_STEPS = [2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144];

  function arch(modelInfo) {
    if (!modelInfo) return null;
    const a = modelInfo['general.architecture'];
    if (!a) return null;
    const g = (k) => modelInfo[`${a}.${k}`];
    const layers = g('block_count');
    const embd = g('embedding_length');
    if (!layers || !embd) return null;
    const heads = g('attention.head_count');
    const headsN = Array.isArray(heads) ? Math.max(...heads) : heads;
    const kLen = g('attention.key_length') || (headsN ? embd / headsN : 128);
    const vLen = g('attention.value_length') || kLen;
    let kv = g('attention.head_count_kv');
    const perLayer = Array.isArray(kv) ? kv : Array(layers).fill(kv ?? headsN ?? 8);
    const elemsPerToken = perLayer.reduce((s, h) => s + (h || 0) * (kLen + vLen), 0);
    const window = g('attention.sliding_window') || 0;
    // Interleaved sliding-window models: only every Nth layer keeps the full context,
    // the others keep just the last `window` tokens.
    const SWA_EVERY = { gemma3: 6, gemma2: 2, gptoss: 2 };
    const every = window && SWA_EVERY[a];
    return {
      name: a,
      layers,
      elemsPerToken,
      maxCtx: g('context_length') || null,
      window,
      globalFrac: every ? 1 / every : 1,
      slidingWindow: !!window && !every,
      latentAttention: !!g('attention.kv_lora_rank'),
    };
  }

  function estimate({ weightsBytes, archInfo, ctx, kvType = 'f16', flashAttention = false, calibration = 1 }) {
    const bytesPer = KV_BYTES[kvType] || 2;
    // Fallback when the architecture is unknown: a typical 8B model (128 KB/token at f16).
    const perToken = archInfo ? archInfo.elemsPerToken * bytesPer : 65536 * bytesPer;
    const gf = archInfo ? archInfo.globalFrac : 1;
    const kv = perToken * (gf * ctx + (1 - gf) * Math.min(ctx, archInfo ? archInfo.window || ctx : ctx));
    const overhead = 0.4 * GiB + ctx * (flashAttention ? 6 : 28) * 1024;
    const raw = weightsBytes + kv + overhead;
    return {
      weights: weightsBytes,
      kv,
      overhead,
      perToken,
      total: raw * calibration,
      approximate: !archInfo || archInfo.slidingWindow || archInfo.latentAttention,
    };
  }

  // Largest context step that keeps everything on the GPU with a little headroom.
  function fitCtx(opts, freeBytes, maxCtx) {
    let best = null;
    for (const c of CTX_STEPS) {
      if (maxCtx && c > maxCtx) break;
      if (estimate({ ...opts, ctx: c }).total <= freeBytes * 0.92) best = c;
    }
    return best;
  }

  const fmtGB = (b) => (b / GiB >= 10 ? (b / GiB).toFixed(1) : (b / GiB).toFixed(2)) + ' GB';
  const pages = (tokens) => Math.max(1, Math.round((tokens * 0.75) / 500));

  return { arch, estimate, fitCtx, fmtGB, pages, GiB, CTX_STEPS, KV_BYTES };
})();

if (typeof module !== 'undefined') module.exports = Est;
