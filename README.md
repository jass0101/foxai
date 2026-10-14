# Fox AI

**Open-source, BYOK (bring-your-own-key) desktop assistant for live transcription + AI answers.**
Electron · React · TypeScript · Vite.

It listens to your microphone and system audio, transcribes both channels in
real time, and streams AI answers into a small always-on-top window. Keys,
transcripts and history stay on your machine — the only network traffic is what
you explicitly send to the transcription service and the model provider you
chose.

- **Transcription:** Deepgram `nova-3` over WebSocket (one stream per audio channel).
- **Models:** Groq (default), OpenAI, Anthropic, Google, OpenRouter, or a local [Ollama](https://ollama.com) server.
- **Context:** resume/background PDF, role/topic notes, extra instructions.

---

## Requirements

| | |
|---|---|
| OS | **Windows 10 (any recent build) or Windows 11**, 64-bit — full screen-share exclusion needs version **2004 (build 19041)** or later, see [Platform support](#platform-support) |
| Node.js | **22.12 or later** (`electron@44` and `@electron/packager@20` declare `engines.node >=22.12.0`) |
| npm | 10+ (ships with Node 22) |
| Accounts | one [Deepgram](https://www.deepgram.com/) API key (free tier is enough) **plus** one model-provider key, or a local [Ollama](https://ollama.com) install |
| Network | Required for transcription (Deepgram) and answers; only the model side can go local with Ollama |

> Windows 7/8/8.1 and 32-bit Windows are not supported — Electron 44 ships
> `x64`/`arm64` builds for Windows 10 and up only.

## Quick start

```bash
git clone https://github.com/jass0101/foxai.git
cd foxai
npm install
npm run dev
```

The window opens immediately. Go to **Settings** and save your keys:

1. **Deepgram API key** → required for the live transcript.
2. **Provider key** (Groq/OpenAI/Anthropic/Google/OpenRouter) → required for answers.
   Pick a model next to it; press **Fetch models** to load the provider's list.
   With **Ollama** selected, set the URL (default `http://localhost:11434`) instead of a key.

Keys are stored encrypted (see [Your data](#your-data)) and can be removed again from
the same field (**Remove**).

## Using it

Four tabs:

| Tab | What it does |
|---|---|
| **Live** | `Start/Stop listening`, the two-channel transcript (You / Other), the streaming answer panel, plus `Answer now`, `Screenshot` and `Clear`. With **auto-answer** enabled in Settings, detected questions are answered automatically. A mic meter warns when no sound is coming in |
| **Mock** | Practice loop: `Next question` (read aloud) → `🔊 Repeat` → `I'm answering` → speak → `Evaluate` |
| **History** | Reopen a saved session → `Summarize + flashcards` (summary, key points, flashcards), `Export .md`, `Export Anki`, `Delete`. Sessions are saved when you press **Stop** or **Clear** |
| **Settings** | Keys, provider/model (`Fetch models`), language, microphone and system-audio sources, window behaviour (opacity, always-on-top, capture exclusion), context: resume via `Load PDF / text…`, role/topic notes, extra instructions |

The `⤡` button in the title bar switches to a compact overlay.

### Global shortcuts

Registered in [`src/main/index.ts`](src/main/index.ts) — edit them there if they clash
with something else you use.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+A` | Ask the model now |
| `Ctrl+Shift+C` | Clear the current session |
| `Ctrl+Shift+S` | Screenshot the primary screen and ask about it |
| `Ctrl+Shift+H` | Hide / show the window |
| `Ctrl+Shift+P` | Toggle *exclude from screen capture* |

### Window behaviour

- **Always on top** and adjustable opacity (Settings).
- **Close button hides to tray** — it never quits. Quit from the tray menu
  (right-click the tray icon); double-click or use the menu to show the window.
- **No taskbar button** and **hidden from the Alt+Tab switcher** (applied via
  `WS_EX_TOOLWINDOW`), so it stays out of the way of whatever you are sharing.
- **Single instance:** launching the exe again shows the running window instead
  of a second copy.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run in development mode with hot reload |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`) |
| `npm run build` | Compile main/preload/renderer into `out/` |
| `npm run start` | Run the compiled build (`electron-vite preview`) |
| `npm run package` | `build` + package a Windows x64 folder build into `dist/` |

## Packaging

```bash
npm run package
# → dist/Fox AI-win32-x64/Fox AI.exe
```

That folder is a portable app — copy it anywhere (for example
`%LOCALAPPDATA%\Fox AI\`) and run the exe; no installer needed. The
packaging configuration (app name, icon, Win32 version metadata) lives in
[`package.mjs`](package.mjs), and the icons in [`build/`](build/).

**To avoid a broken build:** a clean `npm install` prunes anything not listed in
`dependencies`. Keep runtime packages (including `zod`) in `dependencies`, not
`devDependencies`, or the packaged app will fail to start with a
`Cannot find module` error.

## Platform support

| Platform | Status |
|---|---|
| **Windows 11** | ✅ Supported — Electron 44 officially supports Windows 10 and up, and the app uses the same Win32 APIs (`SetWindowDisplayAffinity`, `SetWindowLongPtr`, `RegisterHotKey`, `Shell_NotifyIcon`). Not yet verified on a Windows 11 machine |
| **Windows 10 2004+ (build 19041)** | ✅ Primary target — verified on **Windows 10 Enterprise 22H2, build 19045** (Node 22.22.2, npm 10.9.7): dev, typecheck, build and package all pass |
| Windows 10 before 2004 | ⚠️ Runs, but capture exclusion degrades — see below |
| Windows 7 / 8 / 8.1, 32-bit Windows | ❌ Not supported (Electron 44 requirement) |
| macOS | ⚠️ Should run; capture exclusion uses `NSWindowSharingNone`, which ScreenCaptureKit-based apps may ignore. The packaging script targets `win32` |
| Linux | ⚠️ Should run; no capture-exclusion API exists, so the app uses the detection fallback below. Packaged builds are not configured |

### Excluding the window from screen capture (Windows)

The **"Hidden from screen share"** checkbox in Settings (toggled live with
`Ctrl+Shift+P`) maps to the `contentProtect` setting, which calls Electron's
`setContentProtection()` → `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`:

- **Windows 10 2004+ / Windows 11** — the window is removed from captures
  entirely: it will not appear in screen shares (Zoom, Meet, Teams, …), in
  screenshots, or in capture-based remote-access tools.
- **Older Windows 10** — the window is captured as a solid black rectangle
  instead; its *content* is still never captured.
- The change takes effect on the next desktop composition, so a capture started
  in the very same instant can still see the window.
- It also applies inside remote sessions: a remote-desktop client still shows
  the window to the remote user, but software that works by capturing the
  desktop (VNC, AnyDesk) cannot see it. That is why `Ctrl+Shift+P` exists —
  press it to bring the window back into your own remote view, and again before
  you share.

**Linux** has no equivalent API, so [`src/main/sharewatch.ts`](src/main/sharewatch.ts)
polls `pw-dump` and `ps` every 2 s and hides the window while an actual screen
cast or recorder process (`wf-recorder`, `byzanz-record`, `ffmpeg … x11grab`) is
running. Meeting apps that are merely *open* are deliberately not matched.

## Your data

Everything is stored under the app data folder:

```
%APPDATA%\Fox AI\
├─ settings.json   # preferences
├─ keys.json       # API keys, encrypted with Electron safeStorage (DPAPI on Windows)
└─ sessions\       # transcripts, summaries, flashcards
```

- **BYOK** — keys are encrypted at rest with the OS keychain and sent only to
  the provider they belong to. Nothing is uploaded anywhere else, there is no
  account, and there is no telemetry.
- Changing `productName` in `package.json` changes this folder; the app migrates
  data from older folder names (`parakeet-ai`, `Notes Viewer`) on first launch.

## Project structure

```
├─ electron.vite.config.ts   # Vite config for main / preload / renderer
├─ tsconfig.json
├─ package.mjs               # electron-packager config (name, icon, Win32 metadata)
├─ build/                    # app + tray icons (icon.ico, tray.png, tray@2x.png)
├─ src/
│  ├─ main/                  # Electron main process
│  │  ├─ index.ts            # window, tray, global shortcuts, IPC, screenshots, streaming
│  │  ├─ config.ts           # settings + encrypted key storage
│  │  ├─ llm.ts              # providers and streaming helpers
│  │  ├─ stt.ts              # Deepgram WebSocket streams (one per channel)
│  │  ├─ session.ts          # session, summary, flashcard persistence
│  │  ├─ detect.ts           # question-detection heuristic for auto-answer
│  │  ├─ sharewatch.ts       # Linux share-detection fallback
│  │  └─ pdf-parse.d.ts
│  ├─ preload/
│  │  └─ index.ts            # contextBridge API (window.api)
│  └─ renderer/
│     ├─ index.html
│     ├─ public/pcm-worklet.js   # audio worklet → 16 kHz mono PCM
│     └─ src/                # App.tsx, audio.ts, styles.css, main.tsx
├─ out/                       # build output (git-ignored)
└─ dist/                      # packaged app (git-ignored)
```

Data flow: the `renderer` captures mic + system audio and streams 16 kHz mono
PCM over the preload bridge → `main` keeps one Deepgram socket per channel and
sends interim/complete utterances back → the transcript drives `detect.ts`, and
when a question is found (or you press `Answer now`) `llm.ts` streams the model
reply back into the answer panel as `answer:start / delta / done` events.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module 'zod/v4'` (or similar) in a packaged build | Run a clean `npm install` and re-package; the module belongs in `dependencies` |
| `Deepgram rejected the connection (HTTP 401)` | The Deepgram key is missing, wrong or revoked — re-save it in Settings |
| Transcript never appears | Check Settings → **Microphone**; on Windows also *Settings → Privacy → Microphone*; try language `multi` |
| No system audio | Windows: Settings → **Other speaker source** → `System audio (loopback)`. Linux: pick the `Monitor of …` device |
| Window is invisible in your own VNC/AnyDesk view | Expected while capture exclusion is on — press `Ctrl+Shift+P` |
| Window missing from Alt+Tab and the taskbar | By design — use the tray icon (Show hidden icons `^`) or `Ctrl+Shift+H` |
| Nothing happens on launch after packaging | Start it from a normal local folder (not a synced cloud folder) and check the tray for the window |
| `npm install` refuses to run | Upgrade Node to 22.12+ (`node -v`) |

## Contributing

Issues and pull requests are welcome. Before opening a PR:

```bash
npm run typecheck
npm run build
npm run package   # Windows only
```

## License

[MIT](LICENSE)
