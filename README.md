# Grok Always-Listening Voice Agent

A production-ready, **pure frontend** voice agent that talks to [xAI Grok](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) over the official realtime Speech-to-Speech WebSocket:

```
wss://api.x.ai/v1/realtime?model=grok-voice-latest
```

It captures the device microphone, streams PCM16 audio with **server-side VAD**, and plays Grok’s spoken replies through the speakers. The UI is built for a **Valve Steam Deck in Desktop Mode** — large tap targets, OLED-friendly dark theme, high contrast, landscape 1280×800.

No build step. No framework. Open `index.html` (preferably via a tiny local server) and talk.

## Features

- Continuous listening with xAI `server_vad` (barge-in / interrupt supported)
- Real-time mic capture via **AudioWorklet** (ScriptProcessor fallback)
- Base64 PCM16 playback through the Web Audio API
- Conversation transcript (live user captions + Grok text)
- Voice picker (`eve`, `ara`, `rex`, `leo`, …)
- Volume slider, speaker mute, mic mute
- Server-side **web search** and **X search** tools
- Client tools: local time, set volume, mute, stop listening
- Exponential-backoff reconnect + session resumption
- API key stored only in `localStorage`
- First-run instructions overlay
- Works offline as a static shell; only the xAI API needs the network

## Get an xAI API key

1. Create an account at [accounts.x.ai](https://accounts.x.ai) and add credits.
2. Open the console: [console.x.ai](https://console.x.ai).
3. Create a key under **API keys**.
4. Voice pricing (as of 2026): Speech-to-Speech `grok-voice-think-fast-2.0` is billed per minute of audio. See [docs.x.ai/developers/models](https://docs.x.ai/developers/models).

The model alias `grok-voice-latest` currently points at `grok-voice-think-fast-2.0`.

## How to run it locally

The page is static. Two supported ways:

### Option A — simplest HTTP server (recommended)

From this directory:

```bash
# Python 3
python3 -m http.server 8080

# or Node
npx --yes serve -l 8080
```

Then open [http://localhost:8080](http://localhost:8080) in Chrome / Chromium.

### Option B — open the file

Double-click `index.html`. Some browsers block `getUserMedia` and AudioWorklet on `file://`. If the mic prompt never appears, use Option A.

### First launch

1. Tap **?** or wait for the onboarding card.
2. Open **Settings**, paste the key, tap **Done**.
3. Tap **Start Listening** and allow the microphone.
4. Speak. When you pause, Grok answers. Talk over Grok to interrupt.

## Steam Deck tips

- Switch to **Desktop Mode**. Game Mode’s embedded browser is not a good WebRTC / getUserMedia host.
- Use **Google Chrome** or the SteamOS Chromium build. Firefox works, but Chrome’s Web Audio path is more predictable.
- The Deck is **1280×800**. The layout is two columns on that width and stacks on a narrower window.
- **Headphones** (USB-C or Bluetooth) are strongly recommended. The built-in speakers sit close to the mics and will trigger VAD echo even with browser echo cancellation.
- Grant microphone permission when Chromium asks. If you dismissed it, click the lock icon in the address bar → Site settings → Microphone → Allow.
- Keep the Deck plugged in or raise the TDP a little. Continuous WebSocket + Web Audio is light, but a very low TDP plus thermal limits can add jitter.
- If the screen sleeps mid-conversation, the page requests a **screen wake lock**. A tap on the listen button after wake will resume the AudioContext if the OS suspended it.
- Launch Chrome with a bookmark to `http://localhost:8080` if you keep a tiny server in a Konsole tab, or host the folder on any LAN machine.

## Security note about API keys

This is a **personal / handheld** client. The API key lives in `localStorage` on the device that opened the page.

- Anyone with access to this Steam Deck profile can read the key from DevTools.
- The key is sent only to `https://api.x.ai` (to mint a short-lived client secret) and never to any other origin.
- Browsers cannot set an `Authorization` header on `WebSocket`. The official xAI path is:
  1. `POST /v1/realtime/client_secrets` with the API key
  2. Connect with subprotocol `xai-client-secret.<token>`
- If that mint request is blocked by CORS (common on `file://`), the app falls back to putting the API key itself in the subprotocol so a personal Deck can still connect.
- **Do not** ship this page on a public host with a shared key. For a multi-user or internet-facing deployment, put a tiny backend in front that mints ephemeral tokens and never exposes `XAI_API_KEY` to the browser. See [Ephemeral Tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens).
- Never commit a key. `.gitignore` already excludes `.env` files.

## Project structure

```
.
├── index.html    # Steam Deck UI + first-run instructions
├── style.css     # Dark OLED theme, large tap targets
├── app.js        # Mic, WebSocket protocol, playback, tools, reconnect
├── README.md
├── LICENSE       # MIT
└── .gitignore
```

## How the protocol is used

On connect the client sends `session.update`:

| Setting | Value |
|---|---|
| `voice` | Selected built-in voice (`eve` default) |
| `turn_detection.type` | `server_vad` |
| `audio.input/output` | `audio/pcm` @ 24 kHz |
| `audio.input.transcription.model` | `grok-transcribe` (live captions) |
| `tools` | `web_search`, `x_search`, plus local functions |
| `resumption.enabled` | `true` (reconnect keeps conversation context) |

Then:

1. Mic frames → `input_audio_buffer.append` (base64 PCM16)
2. VAD `speech_started` / `speech_stopped` drive the UI
3. `response.output_audio.delta` is decoded and scheduled for playback
4. `response.function_call_arguments.done` runs a local tool; the result is returned with `conversation.item.create` (`function_call_output`) and a later `response.create` after playback finishes (avoids overlapping speech)

## Troubleshooting

**Microphone permission denied**  
Chromium site settings → Microphone → Allow. Reload and tap Start again. `file://` often cannot prompt — serve over `http://localhost`.

**“Add an xAI API key”**  
Open Settings and paste a key from [console.x.ai](https://console.x.ai). Confirm the account has credits.

**Socket connects then errors with 401 / unauthorized**  
The key is wrong, revoked, or out of credits. Create a new key. If you opened the page from a remote origin, CORS may have blocked token minting — run locally.

**Grok never starts talking / “hearing you” never appears**  
- Lower **VAD threshold** in Settings (try `0.40`) if the Deck mic is quiet.  
- Raise **Silence to end turn** if it cuts you off mid-sentence.  
- Check that **Mic on** is not muted.  
- Confirm the listen button is red / pressed.

**Grok talks over itself or you hear an echo**  
Use headphones. Lower speaker volume. Mute the speakers with the Mute pill if you only want the transcript.

**AudioContext / no sound**  
The first tap on **Start Listening** creates the AudioContext (required by autoplay policy). If you slept the Deck, tap Start once more. Check the OS mixer is not muted.

**Constant reconnecting**  
Wi-Fi drops on the Deck are common. The client retries with backoff (1s → 15s) and resumes the conversation id. If it loops, the key/token expired — stop and start again.

**Tools do nothing**  
Web search and X search run **on xAI’s servers**. Leave the checkboxes on. Current-events questions need those tools; Grok has no live knowledge otherwise.

**High latency**  
24 kHz PCM is already the API default. Close other Chromium tabs. Prefer 5 GHz Wi-Fi. A USB-C Ethernet dongle on the Deck is noticeably more stable.

**Page looks cramped in Game Mode**  
Switch to Desktop Mode. This is a desktop web app, not a Steam overlay.

## Docs

- [Speech to Speech](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech)
- [Voice API reference](https://docs.x.ai/developers/rest-api-reference/inference/voice)
- [Ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens)
- [Models & pricing](https://docs.x.ai/developers/models)

## License

MIT. See [LICENSE](LICENSE).
