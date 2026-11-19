# Hush

**A private, offline desktop app for local AI models.** Simple to use, with every setting that matters visible and explained.

Hush sits on top of [Ollama](https://ollama.com) (which runs the models) and adds what Ollama's own app is missing: a context-window slider with a live GPU-memory gauge, drag-and-drop and pasted screenshots, per-chat tuning, model management, and a privacy model you can actually check.

![Hush](docs/screenshot.png)

## What it does

- **Memory gauge that tells the truth.** Before you send, it estimates model + conversation memory + working space + what other apps use, against your real GPU memory (with a safety margin). After the first reply it switches to the number Ollama actually measured. On Windows it also watches "shared GPU memory", so it catches the driver quietly moving the model into normal RAM. Task Manager can then show more than your card has, and replies crawl.
- **Live monitor.** One panel for everything happening while you prompt: writing speed, compute load, graphics memory, memory bus, temperature, power, and two-minute charts of each. It also breaks down the last reply (load, reading speed, writing speed, time to first word) and gives a plain-language diagnosis such as "12% of the model runs on the CPU".
- **Memory-full handling.** A banner warns when the conversation is about to outgrow the model's memory. It offers to **summarize into a new chat** (carrying the important parts forward) or to add more memory. Messages the model can no longer see are dimmed behind a clear "out of memory" line, and you're asked before sending a message that won't fit.
- **Live progress.** While it works: loading, reading your prompt, thinking, answering, with a timer and tokens per second, and a plain explanation when it's slow.
- **Live hardware strip.** GPU memory, load, temperature and the loaded model, always visible in the sidebar.
- **Roles.** Ten built-in roles (developer, code reviewer, debugger, editor, explain-it-simply, translator, analyst, and more), plus your own saved roles. It warns when a role is too big for the memory setting.
- **Simple and Advanced tuning.** Simple: how much it remembers, style (Precise / Balanced / Creative), thinking on/off, role. Advanced adds every sampling control, cache type, GPU size and the Ollama address.
- **Per-model settings.** "Remember for this model" makes every new chat with that model start with your memory, style and thinking setup.
- **Context you can see.** A slider with a "Fit to GPU" button, plus a bar showing how full the conversation is, so you notice before Ollama silently cuts off the start.
- **Attachments.** Drag and drop, paste, or click + to see exactly what's supported: images (for vision models, with a clear can/can't-see indicator), PDF, Word .docx, Excel .xlsx, PowerPoint .pptx, and text, data and code files. Everything is read locally.
- **Per-chat tuning.** Temperature, Top P/K, Min P, repeat penalty, seed, max length, thinking on/off/effort, and a system prompt. Each one says in plain words what it does, and **auto** uses the model author's recommended value (shown under the slider).
- **Models screen.** Download, delete and unload models, see each one's capabilities, and check how much context fits on your GPU.
- **Test models.** Download counts aren't quality. Every model takes the same 20-question exam (facts, maths, logic, instructions, code, and *honesty traps* that catch made-up answers) at temperature 0. Answers are checked by fixed rules rather than another AI. You can add your own questions, watch progress live, and get a summary: best overall, most honest, fastest on your PC.
- **Share a whole chat.** Copy it as text, have your local model summarize it (nothing leaves your PC), start a fresh chat from a summary, or copy it with instructions for an online fact-check or for continuing in another AI.
- **Keyboard shortcuts you can change.** See and rebind them under *Keyboard shortcuts* (Ctrl+/).
- **Review and Fact-check.** Under any answer: *Review* asks a second local model to check it; *Fact-check online* copies a ready-made prompt for Claude, ChatGPT and so on (Hush stays offline; you choose what leaves).
- **Setup check.** Detects how Ollama is configured and applies the recommended settings in one click on Windows (flash attention, q8_0 cache, a single parallel slot, no terminal history). It also shows and changes where models are stored.
- **Model guide.** A "Will it fit?" calculator before you download, and a plain explanation of model names (size, instruct/base, quantization, MoE).
- **Two session modes.** *Ephemeral*: nothing ever touches the disk. *Encrypted vault*: chats are saved in one encrypted file.
- **Wipe in one click** (Ctrl+Shift+L). Erases or locks the session, unloads models from GPU memory and clears the clipboard.
- **Data map.** Lists every file Hush *and Ollama* keep on your PC, including Ollama's logs and its plain-text terminal prompt history, and lets you shred them.

## Light on your PC

Hush is meant to leave as much of your hardware as possible to the model:

- **No graphics memory for the interface.** Hush draws its own window on the CPU (WebView2 with GPU acceleration off), so it doesn't hold the 100–200 MB of graphics memory a window like this normally takes.
- **Quiet when idle.** Hardware checks run every 5 seconds when nothing is happening, every second only while a model is answering or the Monitor is open, and the Windows overflow counter only while a model is loaded. Nothing runs while the window is minimized.
- **Cheap streaming.** Long answers redraw less often as they grow, and charts are only drawn while the Monitor is open.
- **Small.** No frameworks and no bundled browser. The installer is a few MB, and nothing runs in the background after you close it.

## Privacy, precisely

| | |
|---|---|
| Network | Hush never connects to the internet. The window's security policy blocks every network request; the Rust core only talks to Ollama on `127.0.0.1`/`localhost`/`[::1]`, refuses other addresses and ignores system proxies. The HTTP client is built without TLS, so it can't reach HTTPS sites at all. |
| Telemetry | None. No analytics, crash reports or update checks. |
| Ephemeral mode | Chats, attachments and settings exist only in memory. |
| Vault | One file, `vault.hush` in the app-data folder. XChaCha20-Poly1305, with the key derived from your passphrase by Argon2id (64 MiB, 3 passes). The key is held in memory only while unlocked and zeroed on lock. |
| Web engine | The window runs in private (incognito) mode: no cache, cookies or web storage are kept. |
| Settings | Hush only changes Ollama settings when you click, and only from a fixed list (flash attention, cache type, parallel slots, history, models folder). Every value is validated, and nothing goes through a shell. |
| Plugins | None. No filesystem, shell, HTTP or opener plugins. The UI can only call Hush's own commands. |

**What Hush can't control,** stated plainly:
- **Ollama** keeps its own logs, and its own chat history if you use its chat window. The data map shows them and can shred them. Set `OLLAMA_NOHISTORY=1` to stop `ollama run` saving terminal history.
- **Windows** can write RAM to `pagefile.sys` and `hiberfil.sys`. Use BitLocker (or VeraCrypt) full-disk encryption to cover those.
- **SSDs** can keep old copies of overwritten blocks (wear levelling), so "shredding" a file on an SSD is best effort. That's why Hush relies on encryption for anything it stores: without the passphrase, leftover blocks are unreadable.

## Install

### About the Windows "protected your PC" warning

Windows SmartScreen warns about any program that isn't **code-signed** by a known publisher, however safe it is. Until Hush releases are signed, click **More info → Run anyway** once on the installer. After installing, start Hush from the Start menu; the warning belongs to the downloaded installer, not the installed app.

The proper fix for everyone who downloads Hush is signing the releases:
- **SignPath Foundation** gives qualifying open-source projects a free code-signing certificate, built from the public GitHub repository (used by projects like Notepad++ and WinSCP). Hush is MIT-licensed, so it can apply.
- **Azure Artifact Signing** (formerly Trusted Signing) costs about $9.99 a month. Individual developers can only use it in the USA and Canada; organizations also in the EU and UK.

Even after signing, a brand-new certificate builds SmartScreen reputation over the first downloads. Turning off Defender or SmartScreen is not the answer: it lowers protection for everything else on the PC.

### Steps

1. Install [Ollama](https://ollama.com/download) and download at least one model (or do it later from Hush's Models screen).
2. Download Hush from the [Releases](../../releases) page (`.exe` installer for Windows).
3. Start Hush, pick *Ephemeral* or *Encrypted vault*, and chat.

## Build from source (Windows)

You need:
- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) LTS
- Microsoft C++ Build Tools ("Desktop development with C++")
- WebView2 (already included in Windows 10/11)

```powershell
git clone <your repo url> hush
cd hush
npm install
npm run dev      # run it
npm run build    # make installers in src-tauri/target/release/bundle/
```

macOS and Linux work too. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for each.

### Working on the UI without a GPU

```bash
python tools/mock_ollama.py                # a fake Ollama on port 11555
python -m http.server -d ui 8765
# open http://127.0.0.1:8765/?ollama=http://127.0.0.1:11555&vram=12
```

In a normal browser the UI runs in "dev mode": it talks to Ollama directly and uses a fake, **unencrypted** in-memory vault.

### Releasing

Push a tag (`git tag v0.1.0 && git push --tags`). GitHub Actions builds Windows, macOS and Linux installers and attaches them to a draft release.

## Layout

```
ui/                 the interface: plain HTML/CSS/JS, no build step, no dependencies
  app.js            app logic
  roles.js          built-in roles, by category
  bench.js          test bench, judge review, fact-check prompt
  setup.js          setup check, models folder, fit calculator
  monitor.js        live monitor panel
  keys.js           keyboard shortcuts (changeable)
  office.js         text from .docx / .xlsx / .pptx (built-in unzip, no libraries)
  estimate.js       GPU memory estimator (weights + KV cache + buffers)
  markdown.js       small, safe markdown renderer
  backend.js        calls into the Rust core (or a browser dev fallback)
src-tauri/src/
  ollama.rs         localhost-only Ollama bridge with streaming and cancel
  vault.rs          encrypted vault
  system.rs         GPU info, shared-memory overflow, data map, shredding, PDF text
  env.rs            read/apply Ollama settings (whitelisted, validated)
tools/mock_ollama.py
docs/TUNING.md      how local models actually use memory, in plain language
```

## Roadmap

- Image generation through a local ComfyUI
- Ask questions across a folder of documents (local embeddings, kept inside the vault)
- Change the vault passphrase; export a chat as Markdown
- Voice input with local Whisper

## License

MIT
