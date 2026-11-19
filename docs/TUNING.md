# How local models use your GPU (and why they get slow)

Most frustration with local models comes from a few hidden mechanics. Hush's gauges exist to make them visible. Examples use a 12 GB card (like an RTX 4070).

## 1. GPU memory holds three things

| Part | What it is | Grows with |
|---|---|---|
| **Weights** | The model itself, roughly its download size | model size and quantization |
| **KV cache** | The model's working memory of the conversation it can currently see | context window |
| **Buffers** | Scratch space for the maths | context window (less with flash attention) |

The KV cache is the part people miss. For a Llama-3-style 8B model it's about **128 KB per token** at the default f16 precision:

- 8,192 tokens → about 1 GB
- 32,768 tokens → about 4 GB
- 131,072 tokens → about 16 GB, more than the whole card

So a "5 GB model" can need about 10 GB once you give it a long context.

Formula, per token: `2 (K and V) × layers × kv_heads × head_dim × bytes_per_value`.

Some models (Gemma 3, gpt-oss) use *sliding-window attention*: most layers only remember the last 1,024 (or 128) tokens, so long contexts cost much less memory. Hush's estimator accounts for this.

## 2. If it doesn't fit, Ollama silently uses the CPU

When weights + cache + buffers exceed free GPU memory, Ollama keeps some layers in system RAM and runs them on the CPU. Nothing errors. It just becomes 3–10× slower. Check with `ollama ps` (the PROCESSOR column), or watch Hush's gauge, which warns before you send and shows the real split afterwards.

"Free" GPU memory also excludes what Windows and other apps use: typically 0.5–1.5 GB for the desktop, more with a browser playing video or a game open.

## 2b. Windows-only trap: "shared GPU memory"

On Windows the NVIDIA driver can go further than Ollama does: when the card's own memory runs out, it quietly borrows normal system RAM ("Shared GPU memory" in Task Manager → Performance → GPU). Task Manager then shows *more* GPU memory in use than your card has (for example 18 GB on a 12 GB card), and everything slows to a crawl. Ollama doesn't see this happen.

Hush reads this counter and shows a red "overflowed into RAM" warning. Fixes, best first: lower the context ("How much it remembers"), use a smaller model, enable the q8_0 cache, or close other GPU-heavy apps. To get a clear error instead of a silent slowdown: NVIDIA Control Panel → Manage 3D settings → *CUDA – Sysmem Fallback Policy* → **Prefer No Sysmem Fallback**.

Rule of thumb: keep the total under about 85% of the card. Windows itself uses 0.5–1.5 GB, and other apps can grab more at any time.

## 3. The context window is silently cut

Ollama gives each request a fixed context size (`num_ctx`). When the conversation plus attachments is longer, the oldest tokens are dropped, with no error. Symptoms: the model "forgets" the start of the chat, ignores most of a pasted file, or loses its system prompt's instructions.

Ways to set it:
- Hush: the context slider (sent with every request as `num_ctx`)
- Environment variable: `OLLAMA_CONTEXT_LENGTH=16384` (server-wide default)
- In `ollama run`: `/set parameter num_ctx 16384`
- In a Modelfile: `PARAMETER num_ctx 16384`

Per-request `num_ctx` always wins, which is why Hush sends it explicitly.

Two more ways the context fills up without you noticing:
- **Long system prompts / roles.** They're sent with every message. A 3,000-token master prompt in a 2,048-token context can't even be read in full.
- **Thinking models** write their reasoning into the same context. Give them at least 8k, or turn thinking off for quick questions. Otherwise they run out of room mid-thought and keep discarding text, which is slow and confusing.

## 4. The free upgrade: flash attention + 8-bit cache

```powershell
setx OLLAMA_FLASH_ATTENTION 1
setx OLLAMA_KV_CACHE_TYPE q8_0
```

Then quit Ollama from the system tray and start it again. This roughly **halves** KV-cache memory with barely measurable quality loss, which means about twice the context in the same memory. `q4_0` quarters it but costs some quality on long contexts. Tell Hush which you use (Tune → This PC) so its estimates match.

## 5. Quantization in one minute

Weights are stored at reduced precision to save memory:

| Format | Bits per weight (approx.) | Size vs. full | Quality |
|---|---|---|---|
| F16 | 16 | 100% | reference |
| Q8_0 | 8.5 | ~53% | practically lossless |
| Q6_K | 6.6 | ~41% | excellent |
| **Q4_K_M** | 4.8 | ~30% | the usual sweet spot |
| Q3_K_M | 3.9 | ~24% | noticeable loss |

Rule of thumb: a bigger model at Q4 beats a smaller model at Q8.

## 6. What fits on 12 GB (Q4_K_M, flash attention + q8_0 cache)

| Model size | Weights | Comfortable context | Notes |
|---|---|---|---|
| 3–4B | 2–3 GB | 64k+ | fast, fine for simple tasks |
| 7–9B | 5–6 GB | 32k+ | great all-rounders |
| 12–14B | 8–9 GB | 8–16k | the best quality that fully fits |
| 20B+ | 12 GB+ | — | spills to CPU; usable but slow |

With a 7950X3D and DDR5 a small spill is tolerable, but anything past about 20% on the CPU feels sluggish.

## 7. Sampling settings

Leave them on **auto** unless you have a reason. Auto uses the model author's recommended values.

- **Temperature**: about 0.2 for code and facts, 0.7 for chat, around 1.0 for brainstorming.
- **Min P** (around 0.05) is a robust modern alternative to Top P / Top K.
- **Repeat penalty**: raise it slightly (1.1–1.15) only if the model loops.
- **Seed**: fix it to get reproducible answers while you compare prompts.

## 8. Images

Chat models output text only. For screenshots, use a **vision** model (e.g. Gemma 3, Qwen-VL, LLaVA). Generating images needs a diffusion model (Stable Diffusion, Flux), usually through ComfyUI. It's on Hush's roadmap.
