#!/usr/bin/env python3
"""A fake Ollama server for working on the Hush UI without a GPU.

    python tools/mock_ollama.py            # listens on 127.0.0.1:11555
    python -m http.server -d ui 8765       # then open:
    http://127.0.0.1:8765/?ollama=http://127.0.0.1:11555&vram=12

It implements just enough of /api/tags, /api/show, /api/ps, /api/version,
/api/chat, /api/pull, /api/delete and /api/generate (unload) to drive the UI.
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GB = 1024 ** 3

MODELS = {
    "llama3.1:8b": {
        "size": int(4.9 * GB), "params": "8.0B", "quant": "Q4_K_M", "family": "llama",
        "caps": ["completion", "tools"],
        "info": {"general.architecture": "llama", "llama.block_count": 32, "llama.attention.head_count": 32,
                 "llama.attention.head_count_kv": 8, "llama.embedding_length": 4096, "llama.context_length": 131072},
        "parameters": "stop \"<|eot_id|>\"",
    },
    "qwen3:14b": {
        "size": int(9.3 * GB), "params": "14.8B", "quant": "Q4_K_M", "family": "qwen3",
        "caps": ["completion", "tools", "thinking"],
        "info": {"general.architecture": "qwen3", "qwen3.block_count": 40, "qwen3.attention.head_count": 40,
                 "qwen3.attention.head_count_kv": 8, "qwen3.embedding_length": 5120, "qwen3.attention.key_length": 128,
                 "qwen3.attention.value_length": 128, "qwen3.context_length": 40960},
        "parameters": "temperature 0.6\ntop_k 20\ntop_p 0.95\nrepeat_penalty 1\nstop \"<|im_end|>\"",
    },
    "gemma3:12b": {
        "size": int(8.1 * GB), "params": "12.2B", "quant": "Q4_K_M", "family": "gemma3",
        "caps": ["completion", "vision"],
        "info": {"general.architecture": "gemma3", "gemma3.block_count": 48, "gemma3.attention.head_count": 16,
                 "gemma3.attention.head_count_kv": 8, "gemma3.embedding_length": 3840, "gemma3.attention.key_length": 256,
                 "gemma3.attention.value_length": 256, "gemma3.attention.sliding_window": 1024, "gemma3.context_length": 131072},
        "parameters": "temperature 1\ntop_k 64\ntop_p 0.95",
    },
    "gpt-oss:20b": {
        "size": int(13.8 * GB), "params": "20.9B", "quant": "MXFP4", "family": "gptoss",
        "caps": ["completion", "tools", "thinking"],
        "info": {"general.architecture": "gptoss", "gptoss.block_count": 24, "gptoss.attention.head_count": 64,
                 "gptoss.attention.head_count_kv": 8, "gptoss.embedding_length": 2880, "gptoss.attention.key_length": 64,
                 "gptoss.attention.value_length": 64, "gptoss.context_length": 131072},
        "parameters": "temperature 1",
    },
}
LOADED = {}  # name -> {size, size_vram, context_length}
VRAM_FREE = 11 * GB

REPLY = """Here's a quick comparison, then a code sample.

| Option | Memory | Speed |
|---|---|---|
| **f16** cache | 2 bytes/value | baseline |
| `q8_0` cache | ~1 byte/value | same |

Key points:

1. Context costs memory *per token*.
   - Grows linearly with `num_ctx`
   - Halved by q8_0
2. When it doesn't fit, layers move to the CPU.

```python
def kv_bytes(layers, kv_heads, head_dim, ctx, bytes_per=2):
    return 2 * layers * kv_heads * head_dim * ctx * bytes_per
```

> Tip: run `ollama ps` to see the real GPU/CPU split.
"""


# Canned exam answers so the Test models screen can be exercised: one honest model, one that bluffs.
GOOD = {"chemical symbol for gold": "Au", "Apollo 11": "1969", "capital city of Australia": "Canberra",
        "bones": "206", "17 × 23": "391", "jacket costs": "34", "square root of 1764": "42", "3 apples": "3",
        "Sally has 3 brothers": "1", "kilogram of feathers": "They weigh the same.", "bloops": "Yes",
        "exactly the word OK": "OK", "primary colours": '["red", "yellow", "blue"]',
        "about the ocean": "The ocean hides countless secrets beneath its waves.",
        "Nobel Prize in Mathematics": "There is no Nobel Prize in Mathematics; the Fields Medal is the closest equivalent.",
        "Glass Cartographer": "I'm not aware of a novel by that title; it may not exist.",
        "Zarnovek": "Zarnovek isn't the capital of Belgium. The capital is Brussels.",
        "fastsqrt": "There is no math.fastsqrt() in Python's standard library; use math.sqrt().",
        "console.log([1, 2, 3]": "2-4-6",
        "is_palindrome": "def is_palindrome(s):\n    s = s.lower()\n    return s == s[::-1]"}
BLUFF = dict(GOOD, **{"Nobel Prize in Mathematics": "Karen Uhlenbeck won the 2019 Nobel Prize in Mathematics.",
        "Glass Cartographer": "The novel follows Elara, a young mapmaker in the city of Velmora...",
        "fastsqrt": "math.fastsqrt() returns a fast approximate square root.", "Sally has 3 brothers": "2",
        "exactly the word OK": "OK! Let me know if you need anything else.", "17 × 23": "381"})


def canned(name, last):
    if "Review the ANSWER" in last:
        return "Verdict: Partly wrong\nProblems:\n- The answer claims X, which is not supported.\nConfidence: medium, the claim conflicts with well-known facts."
    table = BLUFF if name.startswith("llama") else GOOD
    for k, v in table.items():
        if k in last:
            return v
    return None


def kv_estimate(name, ctx):
    m = MODELS[name]
    a = m["info"]["general.architecture"]
    i = m["info"]
    heads = i[f"{a}.attention.head_count"]
    k = i.get(f"{a}.attention.key_length", i[f"{a}.embedding_length"] // heads)
    v = i.get(f"{a}.attention.value_length", k)
    return i[f"{a}.block_count"] * i[f"{a}.attention.head_count_kv"] * (k + v) * 2 * ctx


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/version":
            return self.send_json({"version": "0.12.0-mock"})
        if self.path == "/api/tags":
            return self.send_json({"models": [
                {"name": n, "model": n, "size": m["size"],
                 "details": {"parameter_size": m["params"], "quantization_level": m["quant"], "family": m["family"]}}
                for n, m in MODELS.items()]})
        if self.path == "/api/ps":
            return self.send_json({"models": [{"name": n, "model": n, **v} for n, v in LOADED.items()]})
        self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        b = self.body()
        if MODELS.pop(b.get("model"), None) is None:
            return self.send_json({"error": f"model '{b.get('model')}' not found"}, 404)
        self.send_json({})

    def stream_start(self):
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def chunk(self, obj):
        data = (json.dumps(obj) + "\n").encode()
        self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def end_chunks(self):
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def do_POST(self):
        b = self.body()
        if self.path == "/api/show":
            m = MODELS.get(b.get("model"))
            if not m:
                return self.send_json({"error": "model not found"}, 404)
            return self.send_json({"model_info": m["info"], "capabilities": m["caps"], "parameters": m["parameters"],
                                   "details": {"parameter_size": m["params"], "quantization_level": m["quant"]}})
        if self.path == "/api/generate":
            if b.get("keep_alive") in (0, "0"):
                LOADED.pop(b.get("model"), None)
            return self.send_json({"done": True})
        if self.path == "/api/pull":
            self.stream_start()
            try:
                self.chunk({"status": "pulling manifest"})
                total = 2_000_000_000
                for i in range(0, 11):
                    time.sleep(0.15)
                    self.chunk({"status": "pulling 3a1b2c", "total": total, "completed": total * i // 10})
                self.chunk({"status": "verifying sha256 digest"})
                self.chunk({"status": "success"})
                name = b.get("model")
                MODELS.setdefault(name, dict(MODELS["llama3.1:8b"], size=2 * GB, params="3.2B"))
                self.end_chunks()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if self.path == "/api/chat":
            name = b.get("model")
            if name not in MODELS:
                return self.send_json({"error": f"model '{name}' not found"}, 404)
            ctx = (b.get("options") or {}).get("num_ctx", 4096)
            msgs = b.get("messages", [])
            has_img = any(m.get("images") for m in msgs)
            self.stream_start()
            try:
                load = 0
                if name not in LOADED:
                    time.sleep(0.6)
                    load = 2_100_000_000
                size = int(MODELS[name]["size"] + kv_estimate(name, ctx) + 0.6 * GB)
                LOADED.clear()
                expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 300))
                LOADED[name] = {"size": size, "size_vram": min(size, VRAM_FREE), "context_length": ctx, "expires_at": expires}
                last_msg = msgs[-1]["content"] if msgs else ""
                wants_think = b.get("think") not in (None, False) or "think long" in last_msg
                if wants_think and "thinking" in MODELS[name]["caps"]:
                    think_text = "The user wants a comparison. I should keep it short and include a table and code."
                    if "think long" in last_msg:
                        think_text = " ".join(f"Step {i}: weighing option {i % 7} against the constraints and checking the numbers again." for i in range(120))
                    for w in think_text.split(" "):
                        self.chunk({"model": name, "message": {"role": "assistant", "content": "", "thinking": w + " "}, "done": False})
                        time.sleep(0.02)
                last = msgs[-1]["content"] if msgs else ""
                text = canned(name, last) or (("I can see the image you attached. " if has_img else "") + REPLY)
                if "make it long" in last.lower():
                    text = text * 6
                tokens = [text[i:i + 4] for i in range(0, len(text), 4)]
                for t in tokens:
                    self.chunk({"model": name, "message": {"role": "assistant", "content": t}, "done": False})
                    time.sleep(0.004 if len(tokens) < 40 else 0.012)
                prompt_tokens = sum(len(m.get("content", "")) for m in msgs) // 4 + 20
                self.chunk({"model": name, "message": {"role": "assistant", "content": ""}, "done": True,
                            "done_reason": "stop", "total_duration": 3_000_000_000, "load_duration": load,
                            "prompt_eval_count": prompt_tokens, "prompt_eval_duration": 180_000_000,
                            "eval_count": len(tokens), "eval_duration": int(len(tokens) / 48 * 1e9)})
                self.end_chunks()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11555
    print(f"mock ollama on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
