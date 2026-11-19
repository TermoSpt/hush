// Thin layer over the Rust core. In the desktop app everything goes through Tauri IPC.
// Opened in a normal browser (for UI development), it falls back to talking to
// Ollama directly and keeps a fake, unencrypted, in-memory vault.
'use strict';

const Backend = (() => {
  const T = window.__TAURI__;
  if (T && T.core && T.core.invoke) {
    const inv = T.core.invoke;
    return {
      native: true,
      getUrl: () => inv('ollama_get_url'),
      setUrl: (url) => inv('ollama_set_url', { url }),
      get: (path) => inv('ollama_get', { path }),
      post: (path, body) => inv('ollama_post', { path, body }),
      deleteModel: (model) => inv('ollama_delete_model', { model }),
      stream(path, body, requestId, onEvent) {
        const ch = new T.core.Channel();
        ch.onmessage = onEvent;
        return inv('ollama_stream', { requestId, path, body, onEvent: ch });
      },
      cancel: (requestId) => inv('ollama_cancel', { requestId }),
      vaultStatus: () => inv('vault_status'),
      vaultCreate: (passphrase, data) => inv('vault_create', { passphrase, data }),
      vaultUnlock: (passphrase) => inv('vault_unlock', { passphrase }),
      vaultSave: (data) => inv('vault_save', { data }),
      vaultLock: () => inv('vault_lock'),
      vaultDestroy: () => inv('vault_destroy'),
      gpuInfo: () => inv('gpu_info'),
      gpuShared: () => inv('gpu_shared'),
      ollamaEnv: () => inv('ollama_env'),
      setOllamaEnv: (name, value) => inv('set_ollama_env', { name, value }),
      dataMap: () => inv('data_map'),
      shredFiles: (paths) => inv('shred_files', { paths }),
      pdfText: (dataB64) => inv('extract_pdf_text', { dataB64 }),
    };
  }

  // ---------------- browser dev mode ----------------
  const params = new URLSearchParams(location.search);
  let base = params.get('ollama') || 'http://127.0.0.1:11434';
  const aborts = new Map();
  let fakeVault = null; // { pass, data }
  let unlocked = false;
  const devEnv = { OLLAMA_NUM_PARALLEL: '4' };

  async function json(resp) {
    const text = await resp.text();
    if (!resp.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch (_) { /* plain text */ }
      throw `Ollama error (${resp.status}): ${msg}`;
    }
    return text.trim() ? JSON.parse(text) : null;
  }
  const net = (e) => { throw (e && e.name === 'AbortError') ? e : "Can't reach Ollama. Start the Ollama app (or run `ollama serve`) and try again."; };

  return {
    native: false,
    getUrl: async () => base,
    setUrl: async (url) => { base = url.startsWith('http') ? url : 'http://' + url; return base; },
    get: (path) => fetch(base + path).catch(net).then(json),
    post: (path, body) => fetch(base + path, { method: 'POST', body: JSON.stringify({ ...body, stream: false }) }).catch(net).then(json),
    deleteModel: (model) => fetch(base + '/api/delete', { method: 'DELETE', body: JSON.stringify({ model }) }).catch(net).then(json),
    async stream(path, body, requestId, onEvent) {
      const ac = new AbortController();
      aborts.set(requestId, ac);
      try {
        const resp = await fetch(base + path, { method: 'POST', body: JSON.stringify({ ...body, stream: true }), signal: ac.signal }).catch(net);
        if (!resp.ok) await json(resp);
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.error) throw ev.error;
            onEvent(ev);
          }
        }
        if (buf.trim()) onEvent(JSON.parse(buf));
      } catch (e) {
        if (e && e.name === 'AbortError') { onEvent({ hush_cancelled: true }); return; }
        throw e;
      } finally {
        aborts.delete(requestId);
      }
    },
    cancel: async (requestId) => { const ac = aborts.get(requestId); if (ac) ac.abort(); },
    vaultStatus: async () => ({ exists: !!fakeVault, unlocked, path: '(browser dev mode: in-memory, NOT encrypted)' }),
    vaultCreate: async (passphrase, data) => {
      if (fakeVault) throw 'A vault already exists.';
      if (passphrase.length < 8) throw 'Use a passphrase of at least 8 characters.';
      fakeVault = { pass: passphrase, data }; unlocked = true;
    },
    vaultUnlock: async (passphrase) => {
      await new Promise((r) => setTimeout(r, 400));
      if (!fakeVault) throw 'No vault found.';
      if (passphrase !== fakeVault.pass) throw 'Wrong passphrase (or the vault file is damaged).';
      unlocked = true; return fakeVault.data;
    },
    vaultSave: async (data) => { if (!unlocked) throw 'The vault is locked.'; fakeVault.data = data; },
    vaultLock: async () => { unlocked = false; },
    vaultDestroy: async () => { fakeVault = null; unlocked = false; },
    gpuInfo: async () => {
      const v = parseFloat(params.get('vram'));
      return v ? [{ name: 'Dev GPU', total_mb: Math.round(v * 1024), used_mb: 900, util_pct: Math.round(20 + Math.random() * 70), temp_c: 54 }] : [];
    },
    ollamaEnv: async () => ({ ...devEnv }),
    setOllamaEnv: async (name, value) => { if (value) devEnv[name] = value; else delete devEnv[name]; },
    gpuShared: async () => {
      const sh = parseFloat(params.get('shared'));
      return isNaN(sh) ? null : { dedicated_mb: 11800, shared_mb: Math.round(sh * 1024) };
    },
    dataMap: async () => [
      { id: 'hush-data', title: 'Hush: your vault', note: 'Browser dev mode: nothing is written to disk.', root: '(memory)', exists: true, deletable: false, summary_only: false, total_bytes: 0, file_count: 0, truncated: false, files: [] },
      { id: 'ollama-history', title: 'Ollama: terminal prompt history', note: 'Every line you typed into `ollama run` in a terminal.', root: '~/.ollama/history', exists: true, deletable: true, summary_only: false, total_bytes: 2048, file_count: 1, truncated: false, files: [{ path: '~/.ollama/history', size: 2048 }] },
    ],
    shredFiles: async (paths) => paths.map((path) => ({ path, ok: true, error: null })),
    pdfText: async () => { throw 'PDF reading needs the desktop app.'; },
  };
})();
