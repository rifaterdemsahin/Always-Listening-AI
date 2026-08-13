# How Grok Always-Listening works

This page is the voice agent at [rifaterdemsahin.github.io/Always-Listening-AI](https://rifaterdemsahin.github.io/Always-Listening-AI/). It is a static HTML/CSS/JS app. Your microphone goes to xAI Grok over a WebSocket. Grok talks back through the speakers. Pictures and Kokoro read-aloud are extra paths that only run when you ask.

Current site version: **v1.6.0**

## The loop in one picture

```
  You say “Grok”          (wake word, Chrome Speech Recognition)
          │
          ▼
  Start session           mic + wss://api.x.ai/v1/realtime
          │
          ▼
  You talk ──► 24 kHz PCM16 ──► input_audio_buffer.append
          │
          ▼
  Server VAD decides you finished
          │
          ├── “draw me a car”  → Imagine / fallback image in the transcript
          ├── “read it”        → Kokoro POST /api/speak reads the last Grok reply
          └── anything else    → Grok thinks, speaks, transcript updates
          │
          ▼
  Stay online at least 3:00 (timer in the header)
```

## 1. Start: say “Grok”

While idle, the page listens with the browser’s **Speech Recognition** API (not xAI). When it hears the word **Grok**, it:

1. Asks for the microphone (once).
2. Opens `wss://api.x.ai/v1/realtime?model=grok-voice-latest`.
3. Starts a **3:00** hold timer at the top. The socket will not drop during that window.

You can also tap **Start Listening**. You need an xAI API key in Settings ([console.x.ai](https://console.x.ai)).

Browsers cannot put an `Authorization` header on a WebSocket. The app mints a short-lived client secret (`POST /v1/realtime/client_secrets`) and connects with subprotocol `xai-client-secret.<token>`. If that mint is blocked, it falls back to the key itself in the subprotocol.

## 2. Talking: server-side VAD

After connect, the client sends `session.update`:

- Voice (Eve, Ara, Rex, …)
- `turn_detection.type = server_vad` so **you do not press a push-to-talk key**
- 24 kHz PCM in and out
- Tools: web search, X search, image functions

Mic frames are captured with an **AudioWorklet**, resampled to 24 kHz PCM16, and sent as `input_audio_buffer.append`.

When the server hears speech it emits `speech_started` / `speech_stopped`. After a pause it generates a reply. Audio comes back as `response.output_audio.delta` (base64 PCM) and is scheduled on the Web Audio API. Transcripts stream in as you and Grok speak.

Say something new while Grok is talking to interrupt (barge-in). The client stops local playback.

## 3. Pictures: “draw me a car”

Grok Voice often says it has no canvas. The page does **not** wait for a tool call.

If your transcript matches a draw/show/picture request:

1. `response.cancel` stops the “I can’t draw” reply.
2. The client calls xAI Imagine (`POST /v1/images/generations`).
3. GitHub Pages usually cannot POST to `api.x.ai` (CORS). If that fails, it loads a picture from a prompt-to-image URL so something still appears.
4. The image lands in the transcript. Tap it to enlarge.

Leave the **Images** toggle on.

## 4. Read aloud: wait for “read it”

Kokoro does **not** speak every Grok reply. It waits for you.

After Grok has answered, say:

- **“read it”**
- “read it out loud”
- “read that” / “read this”

What happens:

1. The phrase is spotted in the live transcript.
2. Grok’s next reply is cancelled (so it does not discuss the command).
3. The **last Grok bubble** is sent to Kokoro:

```
POST https://secondbrain-kokoro.fly.dev/api/speak
Content-Type: application/json

{
  "text": "<last Grok reply>",
  "voice": "af_heart",
  "speed": 1
}
```

4. The MP3 is played through the same volume / mute controls.
5. The **Kokoro API** box on the page shows that exact call. **Copy curl** copies it.

The toggle **Say “read it”** must stay on (it is on by default). You can still tap **Read** on a bubble or **Read last** if you do not want to speak.

Voices come from [GET /voices](https://secondbrain-kokoro.fly.dev/voices). Speed is in Settings.

## 5. Settings cookie

Every setting (API key, Grok voice, Kokoro voice, toggles, volume, instructions) is written to:

- Cookie `grok-voice-settings` (1 year, `SameSite=Lax`, path `/Always-Listening-AI/` on GitHub Pages)
- `localStorage` as a backup (and for older visits)

The key never leaves this device except to `api.x.ai` (session) and is not sent to Kokoro.

## 6. Header chips

| Chip | Meaning |
|---|---|
| **Say Grok** / **3:00** / **Online** | Idle wake word, then guaranteed session time |
| **N today** | Spoken or typed turns since local midnight |
| **Idle / Listening / Speaking…** | Connection phase |
| **v1.6.0** | Site version |

## Files

```
index.html   UI
style.css    OLED / Steam Deck layout
app.js       mic, WebSocket, images, Kokoro, cookies
GUIDE.md     this guide
guide.html   same guide as a page on GitHub Pages
```

## Steam Deck

Desktop Mode + Chrome/Chromium. Headphones help — the speakers sit next to the mics. Grant microphone permission when asked so both the wake word and Grok can hear you.

## If something fails

- **No mic** — serve over `https://` or `http://localhost`, not `file://`.
- **401** — new key and credits at console.x.ai.
- **Drawing… but no picture** — wait a few seconds; fallback image should appear. Check the transcript for `Image error:`.
- **“read it” does nothing** — leave **Say “read it”** on, wait until Grok has a reply in the transcript, then say it again.
- **Kokoro API error** — the Fly machine may be waking up. Retry once. The API box shows the HTTP status.
