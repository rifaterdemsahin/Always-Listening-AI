/**
 * Grok Always-Listening Voice Agent
 *
 * Pure-frontend client for xAI's Speech-to-Speech Realtime API.
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
 *
 * Flow:
 *   1. Mint a short-lived client secret (or fall back to the API key as a
 *      WebSocket subprotocol — browsers cannot set Authorization headers).
 *   2. Open wss://api.x.ai/v1/realtime?model=grok-voice-latest
 *   3. session.update with server_vad + voice + tools
 *   4. Stream 24 kHz PCM16 mic frames as input_audio_buffer.append
 *   5. Play response.output_audio.delta chunks through Web Audio
 */

"use strict";

const REALTIME_URL = "wss://api.x.ai/v1/realtime";
const MODEL = "grok-voice-latest";
const CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets";
const IMAGES_URL = "https://api.x.ai/v1/images/generations";
const IMAGE_MODEL = "grok-imagine-image-2.0";
const APP_VERSION = "1.6.0";
const SETTINGS_COOKIE = "grok-voice-settings";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const KOKORO_BASE = "https://secondbrain-kokoro.fly.dev";
const KOKORO_VOICES_FALLBACK = [
  { id: "af_heart", name: "American Female — Heart" },
  { id: "af_bella", name: "American Female — Bella" },
  { id: "af_nicole", name: "American Female — Nicole" },
  { id: "am_adam", name: "American Male — Adam" },
  { id: "am_michael", name: "American Male — Michael" },
  { id: "bf_emma", name: "British Female — Emma" },
  { id: "bm_george", name: "British Male — George" },
  { id: "tr-TR-AhmetNeural", name: "TR Ahmet — Male" },
  { id: "tr-TR-EmelNeural", name: "TR Emel — Female" },
];
const SESSION_MIN_MS = 3 * 60 * 1000;
const SAMPLE_RATE = 24000;
const FRAME_MS = 100;
const MAX_RECONNECT_DELAY_MS = 15000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

const STORAGE = {
  key: "grok-voice.apiKey",
  voice: "grok-voice.voice",
  volume: "grok-voice.volume",
  instructions: "grok-voice.instructions",
  vad: "grok-voice.vad",
  silence: "grok-voice.silence",
  web: "grok-voice.toolWeb",
  x: "grok-voice.toolX",
  greeting: "grok-voice.greeting",
  onboarded: "grok-voice.onboarded",
  images: "grok-voice.toolImages",
  usage: "grok-voice.dailyUsage",
  kokoroOn: "grok-voice.kokoroOn",
  kokoroVoice: "grok-voice.kokoroVoice",
  kokoroSpeed: "grok-voice.kokoroSpeed",
};

const IMAGE_RULES = [
  "You have a visible screen on this device and working image tools. You CAN show pictures.",
  "Never say you are voice-only, have no canvas, or cannot draw.",
  "When the user wants a picture, immediately call generate_image (new art) or show_image (an existing https URL).",
  "Then say one short sentence about what you drew. Do not only describe the picture.",
].join(" ");

const DEFAULT_INSTRUCTIONS = [
  IMAGE_RULES,
  "You are Grok, an always-listening voice companion running on a handheld Steam Deck in Desktop Mode.",
  "Keep spoken answers short and conversational — this is a voice call, not an essay.",
  "Match the language the user is speaking. Switch languages mid-conversation if they do.",
  "Use web_search or x_search when you need current information.",
  "If the user asks you to change volume, mute, unmute, or stop listening, call the matching tool.",
  "Keep generate_image prompts concrete and visual. Prefer 1:1 unless they ask for a wide or tall frame.",
  "Be a useful handheld companion: clear, quick, and a little dry.",
].join(" ");

/** Built-in Speech-to-Speech / TTS voices (GET /v1/tts/voices). */
const VOICES = [
  { id: "eve", name: "Eve" },
  { id: "ara", name: "Ara" },
  { id: "rex", name: "Rex" },
  { id: "leo", name: "Leo" },
  { id: "sal", name: "Sal" },
  { id: "luna", name: "Luna" },
  { id: "orion", name: "Orion" },
  { id: "iris", name: "Iris" },
  { id: "helix", name: "Helix" },
  { id: "atlas", name: "Atlas" },
  { id: "carina", name: "Carina" },
  { id: "zagan", name: "Zagan" },
  { id: "altair", name: "Altair" },
  { id: "zenith", name: "Zenith" },
  { id: "perseus", name: "Perseus" },
  { id: "helios", name: "Helios" },
  { id: "lux", name: "Lux" },
  { id: "kepler", name: "Kepler" },
  { id: "rigel", name: "Rigel" },
  { id: "cosmo", name: "Cosmo" },
  { id: "celeste", name: "Celeste" },
  { id: "ursa", name: "Ursa" },
  { id: "sirius", name: "Sirius" },
  { id: "lumen", name: "Lumen" },
  { id: "castor", name: "Castor" },
  { id: "naksh", name: "Naksh" },
];

const PHASE_COPY = {
  idle: ["Say “Grok” to start", "Wake word is Grok. Session stays online at least 3 minutes."],
  connecting: ["Connecting to Grok…", "Requesting microphone and opening the realtime socket."],
  listening: ["Listening", "Speak naturally. Grok waits for a pause, then answers."],
  user: ["Hearing you", "Server-side VAD detected speech."],
  thinking: ["Thinking", "Grok is working — search or a tool may be running."],
  speaking: ["Speaking", "Tap the button to stop, or just talk over Grok."],
  reconnecting: ["Reconnecting…", "Holding the mic open and retrying the socket."],
  error: ["Something broke", "Check the toast and Settings, then try again."],
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function cookiePath() {
  return location.pathname.indexOf("/Always-Listening-AI") === 0 ? "/Always-Listening-AI/" : "/";
}

function readCookie(name) {
  const prefix = `${name}=`;
  const parts = document.cookie.split("; ");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf(prefix) === 0) {
      try {
        return decodeURIComponent(parts[i].slice(prefix.length));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function writeCookie(name, value) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE}; Path=${cookiePath()}; SameSite=Lax${secure}`;
}

function loadSettingsBag() {
  try {
    const raw = readCookie(SETTINGS_COOKIE);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore bad cookie */ }
  try {
    const raw = localStorage.getItem(SETTINGS_COOKIE);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveSettingsBag(partial) {
  const bag = Object.assign(loadSettingsBag(), partial);
  const json = JSON.stringify(bag);
  try {
    localStorage.setItem(SETTINGS_COOKIE, json);
  } catch { /* quota */ }
  try {
    writeCookie(SETTINGS_COOKIE, json);
  } catch { /* cookie blocked */ }
}

function load(key, fallback) {
  const bag = loadSettingsBag();
  if (Object.prototype.hasOwnProperty.call(bag, key) && bag[key] !== null && bag[key] !== undefined) {
    return String(bag[key]);
  }
  const value = localStorage.getItem(key);
  return value === null ? fallback : value;
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* quota */ }
  saveSettingsBag({ [key]: value });
}

function formatKokoroCall(text, voice, speed) {
  const body = {
    text: String(text || "Hello from Grok Voice.").slice(0, 5000),
    voice: voice || "af_heart",
    speed: Number(speed) || 1,
  };
  return {
    url: `${KOKORO_BASE}/api/speak`,
    method: "POST",
    body,
    curl: [
      `curl -X POST ${KOKORO_BASE}/api/speak \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${JSON.stringify(body)}' \\`,
      `  --output speech.mp3`,
    ].join("\n"),
  };
}

function floatToPcm16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

function pcm16ToFloat32(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** Chunked encoder — `btoa(String.fromCharCode(...bigArray))` can overflow. */
function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.round(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    output[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return output;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function wantsReadAloud(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\bread it(\s+out loud|\s+aloud)?\b/.test(t) ||
    /\bread (that|this)(\s+back)?\b/.test(t)
  );
}

function wantsImage(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  if (/\b(draw|drawing|drew|paint|painting|sketch|sketched|doodle|illustrate|illustrated|render)\b/.test(t)) {
    return true;
  }
  if (/\b(image|picture|pic|photo|photograph|illustration|artwork|poster|wallpaper)\b/.test(t)) {
    return true;
  }
  if (/\bshow me (a|an)\b/.test(t)) return true;
  if (/\b(visualize|visualise|looks like)\b/.test(t)) return true;
  return false;
}

function isImageRefusal(text) {
  const t = String(text || "").toLowerCase();
  return (
    /\b(can'?t|cannot|unable to|don't|do not)\s+(draw|paint|generate|create|show|make)\b/.test(t) ||
    /\bno canvas\b/.test(t) ||
    /\ball voice\b/.test(t) ||
    /\bvoice[ -]?only\b/.test(t) ||
    /\bno (pictures|images|visuals)\b/.test(t)
  );
}

function imagePromptFrom(text) {
  const cleaned = String(text || "")
    .replace(/^(hey|hi|hello|please|ok|okay)[,.\s]+/i, "")
    .replace(/^(can you|could you|would you|will you)\s+/i, "")
    .replace(/^(please\s+)?(draw|paint|sketch|doodle|illustrate|generate|create|make|show|visualize|visualise)\s+(me\s+)?(an?\s+)?(image|picture|pic|photo|illustration|drawing|poster)?\s*(of\s+)?/i, "")
    .trim();
  return cleaned || String(text || "").trim();
}

function sessionInstructions() {
  const custom = ($("instructions").value || "").trim() || DEFAULT_INSTRUCTIONS;
  if (/\bgenerate_image\b/.test(custom) && /never say you/i.test(custom)) return custom;
  return `${IMAGE_RULES} ${custom}`;
}

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Per-calendar-day counters kept in localStorage. Resets at local midnight. */
class DailyUsage {
  constructor(storageKey) {
    this.storageKey = storageKey;
    this.state = this._read();
  }

  _blank() {
    return { date: localDayKey(), queries: 0, images: 0 };
  }

  _read() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.storageKey) || "null");
      if (!raw || raw.date !== localDayKey()) return this._blank();
      return {
        date: raw.date,
        queries: Number(raw.queries) || 0,
        images: Number(raw.images) || 0,
      };
    } catch {
      return this._blank();
    }
  }

  _write() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.state));
  }

  refresh() {
    if (this.state.date !== localDayKey()) this.state = this._blank();
    return this.state;
  }

  bump(field) {
    this.refresh();
    this.state[field] = (this.state[field] || 0) + 1;
    this._write();
    return this.state;
  }

  reset() {
    this.state = this._blank();
    this._write();
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Audio capture — AudioWorklet preferred, ScriptProcessor fallback
// ---------------------------------------------------------------------------

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor("grok-capture", CaptureProcessor);
`;

class MicCapture {
  constructor({ onFrame, onLevel }) {
    this.onFrame = onFrame;
    this.onLevel = onLevel;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.analyser = null;
    this.running = false;
    this.muted = false;
    this._leftover = new Float32Array(0);
    this._raf = 0;
  }

  async start() {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    // Prefer a 24 kHz context so the browser resamples the mic for us.
    try {
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    } catch {
      this.context = new AudioContext({ latencyHint: "interactive" });
    }
    if (this.context.state === "suspended") await this.context.resume();

    this.source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.source.connect(this.analyser);

    const hooked = await this._tryWorklet();
    if (!hooked) this._useScriptProcessor();

    this.running = true;
    this._pumpLevels();
  }

  async _tryWorklet() {
    if (!this.context.audioWorklet) return false;
    try {
      const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await this.context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.context, "grok-capture");
      this.node.port.onmessage = (event) => this._ingest(event.data);
      this.source.connect(this.node);
      // Worklet nodes must be connected somewhere to keep processing.
      const sink = this.context.createGain();
      sink.gain.value = 0;
      this.node.connect(sink);
      sink.connect(this.context.destination);
      return true;
    } catch (err) {
      console.warn("AudioWorklet unavailable, falling back:", err);
      return false;
    }
  }

  _useScriptProcessor() {
    const bufferSize = 4096;
    this.node = this.context.createScriptProcessor(bufferSize, 1, 1);
    this.node.onaudioprocess = (event) => {
      this._ingest(event.inputBuffer.getChannelData(0));
    };
    this.source.connect(this.node);
    const sink = this.context.createGain();
    sink.gain.value = 0;
    this.node.connect(sink);
    sink.connect(this.context.destination);
  }

  _ingest(floatChunk) {
    if (!this.running || this.muted) return;

    const inputRate = this.context.sampleRate;
    const resampled = resampleLinear(floatChunk, inputRate, SAMPLE_RATE);

    // Assemble ~100 ms frames so the socket is not flooded with tiny messages.
    const merged = new Float32Array(this._leftover.length + resampled.length);
    merged.set(this._leftover);
    merged.set(resampled, this._leftover.length);

    const frameSize = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
    let offset = 0;
    while (offset + frameSize <= merged.length) {
      const slice = merged.subarray(offset, offset + frameSize);
      const pcm = floatToPcm16(slice);
      const bytes = new Uint8Array(pcm.buffer);
      this.onFrame(bytesToBase64(bytes));
      offset += frameSize;
    }
    this._leftover = merged.slice(offset);
  }

  _pumpLevels() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.running) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      this.onLevel(this.muted ? 0 : Math.sqrt(sum / data.length));
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.stream) {
      this.stream.getAudioTracks().forEach((t) => {
        t.enabled = !muted;
      });
    }
  }

  async stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._leftover = new Float32Array(0);
    try {
      this.node && this.node.disconnect();
    } catch { /* already gone */ }
    try {
      this.source && this.source.disconnect();
    } catch { /* already gone */ }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.node = this.source = this.stream = this.context = this.analyser = null;
  }
}

// ---------------------------------------------------------------------------
// Playback — scheduled PCM16 buffers, interruptible for barge-in
// ---------------------------------------------------------------------------

class Speaker {
  constructor() {
    this.context = null;
    this.gain = null;
    this.nextTime = 0;
    this.sources = new Set();
    this.volume = 0.9;
    this.muted = false;
    this._idleWaiters = [];
  }

  async ensure() {
    if (this.context && this.context.state !== "closed") {
      if (this.context.state === "suspended") await this.context.resume();
      return;
    }
    try {
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    } catch {
      this.context = new AudioContext({ latencyHint: "interactive" });
    }
    this.gain = this.context.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.gain.connect(this.context.destination);
    if (this.context.state === "suspended") await this.context.resume();
    this.nextTime = this.context.currentTime;
  }

  enqueueBase64(b64) {
    if (!this.context || this.context.state === "closed") return;
    const bytes = base64ToBytes(b64);
    // Int16Array needs an even, aligned buffer.
    const aligned = bytes.byteOffset % 2 === 0 && bytes.byteLength % 2 === 0
      ? bytes
      : bytes.slice();
    const pcm = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 2));
    const samples = pcm16ToFloat32(pcm);
    if (!samples.length) return;

    const buffer = this.context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const startAt = Math.max(this.context.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this._flushIdle();
    };
  }

  isPlaying() {
    if (!this.context) return false;
    return this.sources.size > 0 || this.nextTime > this.context.currentTime + 0.04;
  }

  waitUntilIdle() {
    if (!this.isPlaying()) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  _flushIdle() {
    if (this.isPlaying()) return;
    const waiters = this._idleWaiters.splice(0);
    waiters.forEach((fn) => fn());
  }

  stop() {
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch { /* already stopped */ }
    });
    this.sources.clear();
    if (this.context) this.nextTime = this.context.currentTime;
    this._flushIdle();
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume;
  }
}

// ---------------------------------------------------------------------------
// Realtime socket
// ---------------------------------------------------------------------------

class RealtimeSession {
  constructor(app) {
    this.app = app;
    this.ws = null;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.conversationId = null;
    this.wanted = false;
    this.reconnects = 0;
    this.reconnectTimer = 0;
    this.pendingFns = 0;
    this.sessionReady = false;
    this._earlyAudio = [];
    this._lastUserText = "";
    this._imageHandled = false;
    this._lastImageKey = "";
    this._lastImageAt = 0;
    this._readHandledAt = 0;
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  async connect() {
    this.wanted = true;
    this.sessionReady = false;
    clearTimeout(this.reconnectTimer);

    const apiKey = this.app.apiKey();
    if (!apiKey) throw new Error("Add an xAI API key in Settings first.");

    const auth = await this._authenticate(apiKey);
    const params = new URLSearchParams({ model: MODEL });
    if (this.conversationId) params.set("conversation_id", this.conversationId);
    const url = `${REALTIME_URL}?${params.toString()}`;

    // Browsers cannot set Authorization on WebSocket. xAI accepts the
    // ephemeral secret (or, as a fallback, the API key) via subprotocol.
    this.ws = new WebSocket(url, [`xai-client-secret.${auth}`]);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.reconnects = 0;
      this._configureSession();
    };

    this.ws.onmessage = (event) => this._onMessage(event);
    this.ws.onerror = () => {
      // onclose follows with the real reason
    };
    this.ws.onclose = (event) => this._onClose(event);
  }

  /**
   * Prefer a 1-hour ephemeral client secret so the long-lived API key is
   * not sitting on every WebSocket handshake. If CORS blocks minting from
   * a file:// or odd origin, fall back to the key itself.
   */
  async _authenticate(apiKey) {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.token;
    }
    try {
      const response = await fetch(CLIENT_SECRETS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expires_after: { seconds: 3600 } }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`client_secrets ${response.status}: ${text.slice(0, 180)}`);
      }
      const data = await response.json();
      this.token = data.value;
      this.tokenExpiresAt = (data.expires_at || Math.floor(Date.now() / 1000) + 3600) * 1000;
      return this.token;
    } catch (err) {
      console.warn("Ephemeral token mint failed, using API key as subprotocol:", err);
      this.token = apiKey;
      this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
      return apiKey;
    }
  }

  _configureSession() {
    const tools = [];
    if ($("tool-web").checked) {
      tools.push({ type: "web_search", enable_image_understanding: true });
    }
    if ($("tool-x").checked) {
      tools.push({ type: "x_search", enable_image_understanding: true });
    }
    if ($("tool-images").checked) {
      tools.push(
        {
          type: "function",
          name: "generate_image",
          description:
            "Generate a new picture with Grok Imagine and show it on the user's screen. Use when they ask to see, draw, or generate something.",
          parameters: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Detailed visual prompt for the image model.",
              },
              aspect_ratio: {
                type: "string",
                description: "Optional aspect ratio such as 1:1, 16:9, or 9:16.",
              },
              caption: {
                type: "string",
                description: "Short on-screen caption for the picture.",
              },
            },
            required: ["prompt"],
          },
        },
        {
          type: "function",
          name: "show_image",
          description:
            "Display one or more existing https image URLs on the user's screen (photos found via search, known links, etc.).",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Single image URL." },
              urls: {
                type: "array",
                items: { type: "string" },
                description: "Multiple image URLs.",
              },
              caption: { type: "string", description: "Caption for a single image." },
              images: {
                type: "array",
                description: "List of {url, caption} objects.",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    caption: { type: "string" },
                  },
                },
              },
            },
          },
        }
      );
    }
    tools.push(
      {
        type: "function",
        name: "get_current_time",
        description: "Return the user's local date and time.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        type: "function",
        name: "set_volume",
        description: "Set speaker volume from 0 to 100.",
        parameters: {
          type: "object",
          properties: {
            level: { type: "number", description: "Volume 0–100" },
          },
          required: ["level"],
        },
      },
      {
        type: "function",
        name: "set_muted",
        description: "Mute or unmute Grok's speakers.",
        parameters: {
          type: "object",
          properties: {
            muted: { type: "boolean" },
          },
          required: ["muted"],
        },
      },
      {
        type: "function",
        name: "stop_listening",
        description: "End the always-listening session when the user says goodbye or asks you to stop.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }
    );

    this.send({
      type: "session.update",
      session: {
        voice: $("voice").value || "eve",
        instructions: sessionInstructions(),
        turn_detection: {
          type: "server_vad",
          threshold: Number($("vad-threshold").value),
          silence_duration_ms: Number($("silence-ms").value),
          prefix_padding_ms: 300,
        },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: SAMPLE_RATE },
            transcription: {
              model: "grok-transcribe",
              language_hint: "en",
              keyterms: ["Grok", "xAI", "Steam Deck", "Always Listening"],
            },
          },
          output: {
            format: { type: "audio/pcm", rate: SAMPLE_RATE },
          },
        },
        tools,
        resumption: { enabled: true },
      },
    });
  }

  appendAudio(b64) {
    if (!this.wanted) return;
    if (!this.sessionReady) {
      // Keep ~1s of speech so a slow handshake does not clip the first words.
      this._earlyAudio.push(b64);
      if (this._earlyAudio.length > 10) this._earlyAudio.shift();
      return;
    }
    this.send({ type: "input_audio_buffer.append", audio: b64 });
  }

  _flushEarlyAudio() {
    const queued = this._earlyAudio.splice(0);
    queued.forEach((b64) => this.send({ type: "input_audio_buffer.append", audio: b64 }));
  }

  sendText(text) {
    this._lastUserText = text;
    this._imageHandled = false;
    if (this.fulfillReadAloud(text, true)) return;
    if (this.fulfillImageRequest(text, true)) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.send({ type: "response.create" });
  }

  _catchImageRefusal(explicitText) {
    const bubble = this.app.transcript.live.assistant;
    const spoken = explicitText || (bubble && bubble.querySelector(".body").textContent) || "";
    if (!isImageRefusal(spoken)) return;
    if (!this._lastUserText) return;
    this.fulfillImageRequest(this._lastUserText, true);
  }

  fulfillReadAloud(userText, final) {
    if (!$("kokoro-on").checked) return false;
    if (!wantsReadAloud(userText)) return false;
    if (!final && String(userText).trim().length < 6) return false;
    if (Date.now() - this._readHandledAt < 4000) return true;
    this._readHandledAt = Date.now();
    this.app.speaker.stop();
    this.send({ type: "response.cancel" });
    const last = this.app.lastAssistantText();
    if (!last) {
      this.app.toast("Nothing to read yet. Ask Grok something first, then say “read it”.");
      this.app.setPhase("listening");
      return true;
    }
    this.app.setPhase("speaking");
    this.app.transcript.tool("Reading last reply with Kokoro…");
    this.app.readAloud(last);
    return true;
  }

  /**
   * Voice models often refuse to "draw". Don't wait for a tool call —
   * detect the request, cancel the refusal, and generate on-screen.
   */
  fulfillImageRequest(userText, final) {
    if (!$("tool-images").checked) return false;
    if (!wantsImage(userText)) return false;
    const prompt = imagePromptFrom(userText);
    if (!final && prompt.length < 8) return false;
    const key = prompt.toLowerCase();
    if (this._lastImageKey === key && Date.now() - this._lastImageAt < 20000) return false;
    this._imageHandled = true;
    this._lastImageKey = key;
    this._lastImageAt = Date.now();
    this.app.speaker.stop();
    this.send({ type: "response.cancel" });
    this.app.setPhase("thinking");
    this.app.transcript.tool("Drawing…");
    this.app.generateImage({ prompt, caption: prompt }).then((result) => {
      if (result && result.shown) {
        this.send({
          type: "conversation.item.create",
          item: {
            type: "force_message",
            role: "assistant",
            interruptible: true,
            content: [{ type: "output_text", text: "Here you go. It's on your screen." }],
          },
        });
        return;
      }
      this.app.transcript.tool(`Image error: ${(result && result.error) || "unknown"}`);
      this.app.setPhase("listening");
    }).catch((err) => {
      this.app.transcript.tool(`Image error: ${err.message || err}`);
      this.app.setPhase("listening");
    });
    return true;
  }

  _onMessage(event) {
    if (typeof event.data !== "string") {
      // Binary frames are unused in json transport mode.
      return;
    }

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "session.created":
      case "session.updated":
        this.sessionReady = true;
        this._flushEarlyAudio();
        if (this.app.phase === "connecting" || this.app.phase === "reconnecting") {
          this.app.setPhase("listening");
        }
        if (msg.type === "session.updated" && $("greeting").checked && !this._greeted) {
          this._greeted = true;
          this.send({
            type: "conversation.item.create",
            item: {
              type: "force_message",
              role: "assistant",
              interruptible: true,
              content: [{ type: "output_text", text: "Hey. I'm Grok. I can talk, and I can put pictures on your screen." }],
            },
          });
        }
        break;

      case "conversation.created":
        if (msg.conversation && msg.conversation.id) {
          this.conversationId = msg.conversation.id;
        }
        break;

      case "input_audio_buffer.speech_started":
        this.app.speaker.stop();
        this.app.setPhase("user");
        this.app.transcript.begin("user");
        break;

      case "input_audio_buffer.speech_stopped":
        this.app.setPhase("thinking");
        break;

      case "conversation.item.input_audio_transcription.updated": {
        const live = msg.transcript || msg.text || "";
        this.app.transcript.update("user", live, true);
        if (live) this._lastUserText = live;
        if (!this.fulfillReadAloud(live, false)) this.fulfillImageRequest(live, false);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const finalText = msg.transcript || msg.text || "";
        this.app.transcript.update("user", finalText, false);
        if (String(finalText).trim()) {
          this._lastUserText = finalText;
          if (this.fulfillReadAloud(finalText, true)) break;
          this.app.noteQuery();
          this.fulfillImageRequest(finalText, true);
        }
        break;
      }

      case "response.created":
        this.app.setPhase("thinking");
        this.app.transcript.begin("assistant");
        break;

      case "response.output_audio_transcript.delta":
        this.app.setPhase("speaking");
        this.app.transcript.append("assistant", msg.delta || "");
        this._catchImageRefusal();
        break;

      case "response.output_audio_transcript.done":
        this.app.transcript.finalize("assistant", msg.transcript);
        this._catchImageRefusal(msg.transcript);
        break;

      case "response.output_audio.delta":
      case "response.audio.delta":
        this.app.setPhase("speaking");
        this.app.speaker.enqueueBase64(msg.delta || msg.audio || "");
        break;

      case "response.output_text.delta":
      case "response.text.delta":
        this.app.transcript.append("assistant", msg.delta || "");
        break;

      case "response.function_call_arguments.done":
        this._handleFunction(msg);
        break;

      case "response.output_item.done":
        this._maybeShowServerImage(msg.item || msg);
        break;

      case "response.mcp_call.in_progress":
      case "mcp_list_tools.in_progress":
        this.app.setPhase("thinking");
        this.app.transcript.tool("Looking something up…");
        break;

      case "response.done":
        if (this.app.phase === "speaking" || this.app.phase === "thinking") {
          this.app.setPhase("listening");
        }
        break;

      case "error": {
        const err = msg.error || msg;
        const text = err.message || err.code || "Realtime error";
        // Most errors are recoverable and leave the socket open.
        this.app.toast(text);
        if (String(err.code || "").includes("auth") || /api key|unauthor/i.test(text)) {
          this.app.setPhase("error");
        }
        break;
      }

      default:
        break;
    }
  }

  async _handleFunction(msg) {
    const name = msg.name;
    const callId = msg.call_id;
    let args = {};
    try {
      args = msg.arguments ? JSON.parse(msg.arguments) : {};
    } catch {
      args = {};
    }

    this.pendingFns += 1;
    this.app.setPhase("thinking");
    this.app.transcript.tool(`Tool · ${name}`);

    let result;
    try {
      result = await this.app.runTool(name, args);
    } catch (err) {
      result = { error: String(err.message || err) };
    }

    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });

    this.pendingFns -= 1;
    if (this.pendingFns > 0) return;

    // Wait out the current spoken turn so the follow-up does not overlap.
    await this.app.speaker.waitUntilIdle();
    if (this.wanted) this.send({ type: "response.create" });
  }

  _maybeShowServerImage(item) {
    if (!item || item.type !== "image_generation_call") return;
    const result = item.result;
    if (!result) return;
    const src = String(result).startsWith("http")
      ? result
      : `data:image/jpeg;base64,${result}`;
    this.app.transcript.addImages([{ src, caption: item.prompt || "Generated image" }]);
    this.app.noteImage();
  }

  _onClose(event) {
    this.sessionReady = false;
    this.ws = null;
    if (!this.wanted) return;

    this.reconnects += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnects - 1, 4), MAX_RECONNECT_DELAY_MS);
    this.app.setPhase("reconnecting");
    this.app.toast(`Disconnected (${event.code || "socket"}). Retrying in ${Math.round(delay / 1000)}s…`);
    this.reconnectTimer = setTimeout(() => {
      if (this.wanted) this.connect().catch((err) => this.app.fail(err));
    }, delay);
  }

  disconnect() {
    this.wanted = false;
    this._greeted = false;
    this.sessionReady = false;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close(1000, "client stop");
      } catch { /* ignore */ }
    }
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Transcript DOM
// ---------------------------------------------------------------------------

class TranscriptView {
  constructor(root) {
    this.root = root;
    this.live = { user: null, assistant: null };
    this._lastFinalUser = "";
  }

  begin(role) {
    if (this.live[role]) return this.live[role];
    const el = document.createElement("article");
    el.className = `bubble ${role} interim`;
    el.innerHTML = `<div class="bubble-head"><span class="who">${role === "user" ? "You" : "Grok"} · ${nowLabel()}</span><button type="button" class="read-aloud">Read</button></div><div class="body"></div>`;
    this.root.appendChild(el);
    this.live[role] = el;
    this._scroll();
    return el;
  }

  update(role, text, interim) {
    if (!text) return;
    if (role === "user" && !interim && this._lastFinalUser === text) {
      if (this.live.user) {
        this.live.user.querySelector(".body").textContent = text;
        this.live.user.classList.remove("interim");
        this.live.user = null;
      }
      return;
    }
    const el = this.begin(role);
    el.querySelector(".body").textContent = text;
    el.classList.toggle("interim", Boolean(interim));
    if (!interim) {
      if (role === "user") this._lastFinalUser = text;
      this.live[role] = null;
    }
    this._scroll();
  }

  append(role, delta) {
    if (!delta) return;
    const el = this.begin(role);
    el.querySelector(".body").textContent += delta;
    this._scroll();
  }

  finalize(role, text) {
    const el = this.live[role] || (text ? this.begin(role) : null);
    if (!el) return;
    if (text) el.querySelector(".body").textContent = text;
    el.classList.remove("interim");
    this.live[role] = null;
    this._scroll();
  }

  tool(text) {
    const el = document.createElement("article");
    el.className = "bubble tool";
    el.innerHTML = `<span class="who">System</span><div class="body"></div>`;
    el.querySelector(".body").textContent = text;
    this.root.appendChild(el);
    this._scroll();
  }

  addImages(images) {
    const list = (images || []).filter((img) => img && img.src);
    if (!list.length) return;

    const el = document.createElement("article");
    el.className = "bubble image";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = `Image · ${nowLabel()}`;
    const grid = document.createElement("div");
    grid.className = "image-grid";

    list.forEach((img) => {
      const card = document.createElement("figure");
      card.className = "image-card";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb";
      btn.dataset.src = img.src;
      btn.dataset.caption = img.caption || "";
      const picture = document.createElement("img");
      picture.src = img.src;
      picture.alt = img.caption || "Generated image";
      picture.referrerPolicy = "no-referrer";
      picture.loading = "lazy";
      btn.appendChild(picture);
      card.appendChild(btn);
      if (img.caption) {
        const cap = document.createElement("figcaption");
        cap.textContent = img.caption;
        card.appendChild(cap);
      }
      grid.appendChild(card);
    });

    el.appendChild(who);
    el.appendChild(grid);
    this.root.appendChild(el);
    this._scroll();
  }

  clear() {
    this.root.innerHTML = "";
    this.live = { user: null, assistant: null };
    this._lastFinalUser = "";
  }

  _scroll() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Visualizer
// ---------------------------------------------------------------------------

class OrbViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.level = 0;
    this.target = 0;
    this.phase = "idle";
    this.t = 0;
    this._raf = 0;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      this.draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.level = 0;
    this.draw();
  }

  setLevel(rms) {
    this.target = Math.min(1, rms * 4);
  }

  setPhase(phase) {
    this.phase = phase;
  }

  draw() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    this.level += (this.target - this.level) * 0.18;
    this.t += 0.02;

    ctx.clearRect(0, 0, w, h);

    const palette = {
      idle: "#35506e",
      connecting: "#ffb020",
      listening: "#3dffb0",
      user: "#ffb020",
      thinking: "#8b7cff",
      speaking: "#3dffb0",
      reconnecting: "#ffb020",
      error: "#ff4d6d",
    };
    const color = palette[this.phase] || palette.idle;
    const rings = 3;
    for (let i = 0; i < rings; i++) {
      const pulse = 0.55 + this.level * 0.7 + Math.sin(this.t + i) * 0.04;
      const radius = 78 + i * 22 * pulse;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.18 - i * 0.04 + this.level * 0.25;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Kokoro read-aloud — https://secondbrain-kokoro.fly.dev
// ---------------------------------------------------------------------------

class KokoroReader {
  constructor() {
    this.audio = new Audio();
    this.objectUrl = "";
    this.playing = false;
    this.audio.addEventListener("ended", () => {
      this.playing = false;
    });
  }

  setVolume(value) {
    this.audio.volume = Math.max(0, Math.min(1, value));
  }

  setMuted(muted) {
    this.audio.muted = muted;
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.playing = false;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = "";
    }
  }

  async speak(text, voice, speed) {
    const clean = String(text || "").trim();
    if (!clean) return { error: "Nothing to read." };

    this.stop();
    const call = formatKokoroCall(clean, voice, speed);
    const response = await fetch(call.url, {
      method: call.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(call.body),
    });

    if (!response.ok) {
      const raw = await response.text();
      const err = new Error(raw.slice(0, 180) || `Kokoro ${response.status}`);
      err.call = call;
      err.status = response.status;
      throw err;
    }

    const blob = await response.blob();
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
    this.playing = true;
    await this.audio.play();
    return { ok: true, call, status: response.status, bytes: blob.size };
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

class App {
  constructor() {
    this.phase = "idle";
    this.active = false;
    this._starting = false;
    this.wakeLock = null;
    this.holdUntil = 0;
    this._wake = null;
    this._wakeWanted = false;
    this._timerTick = 0;
    this.speaker = new Speaker();
    this.session = new RealtimeSession(this);
    this.transcript = new TranscriptView($("transcript"));
    this.usage = new DailyUsage(STORAGE.usage);
    this.kokoro = new KokoroReader();
    this.viz = new OrbViz($("viz"));
    this.mic = new MicCapture({
      onFrame: (b64) => this.session.appendAudio(b64),
      onLevel: (rms) => this.viz.setLevel(rms),
    });
  }

  apiKey() {
    return $("api-key").value.trim();
  }

  setPhase(phase) {
    if (!this.active && phase !== "idle" && phase !== "error") return;
    this.phase = phase;
    const [title, hint] = PHASE_COPY[phase] || PHASE_COPY.idle;
    $("phase-label").textContent = title;
    $("phase-hint").textContent = hint;
    $("conn-label").textContent = title;
    $("conn-chip").dataset.state = phase === "user" ? "listening" : phase;
    this.viz.setPhase(phase);
  }

  toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 5200);
  }

  fail(err) {
    console.error(err);
    this.setPhase("error");
    this.toast(err.message || String(err));
  }

  async start() {
    if (this.active || this._starting) return;
    if (!this.apiKey()) {
      this.openSettings();
      this.toast("Paste your xAI API key to start.");
      return;
    }
    this._starting = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("This browser cannot access the microphone. Use Chromium over http://localhost.");
      }

      this.active = true;
      this.stopWakeWord();
      this.holdUntil = Date.now() + SESSION_MIN_MS;
      this.renderSessionTimer();
      $("listen-btn").setAttribute("aria-pressed", "true");
      $("listen-text").textContent = "Stop";
      this.setPhase("connecting");
      this.viz.start();

      // AudioContext must be created inside the click handler (Safari / some Deck browsers).
      await this.speaker.ensure();
      await Promise.all([this.mic.start(), this.session.connect()]);
      await this._requestWakeLock();
    } finally {
      this._starting = false;
    }
  }

  async stop() {
    this.active = false;
    this.session.disconnect();
    this.speaker.stop();
    await this.mic.stop();
    this.viz.stop();
    this._releaseWakeLock();
    $("listen-btn").setAttribute("aria-pressed", "false");
    $("listen-text").textContent = "Start Listening";
    this.holdUntil = 0;
    this.setPhase("idle");
    this.renderSessionTimer();
    this.startWakeWord();
  }

  sessionHoldRemaining() {
    if (!this.active) return 0;
    return Math.max(0, this.holdUntil - Date.now());
  }

  renderSessionTimer() {
    const el = $("session-timer");
    const chip = $("session-chip");
    if (!this.active) {
      el.textContent = "Say Grok";
      chip.dataset.state = "idle";
      chip.title = "Say Grok to start. Stays online at least 3 minutes.";
      return;
    }
    const left = this.sessionHoldRemaining();
    if (left > 0) {
      el.textContent = formatClock(left);
      chip.dataset.state = "hold";
      chip.title = `Guaranteed online for ${formatClock(left)} more`;
    } else {
      el.textContent = "Online";
      chip.dataset.state = "online";
      chip.title = "Past the 3-minute minimum. Still listening.";
    }
  }

  startWakeWord() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec || this.active || this._wake) return;
    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) => {
      if (this.active || this._starting) return;
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript || "";
      }
      if (!/\bgrok\b/i.test(text)) return;
      this.toggle().catch((err) => this.fail(err));
    };
    rec.onend = () => {
      this._wake = null;
      if (this._wakeWanted && !this.active) {
        setTimeout(() => this.startWakeWord(), 250);
      }
    };
    rec.onerror = () => {};
    this._wake = rec;
    this._wakeWanted = true;
    try {
      rec.start();
    } catch {
      this._wake = null;
    }
  }

  stopWakeWord() {
    this._wakeWanted = false;
    if (!this._wake) return;
    try {
      this._wake.onend = null;
      this._wake.stop();
    } catch { /* already stopped */ }
    this._wake = null;
  }

  async toggle() {
    try {
      if (this.active) await this.stop();
      else await this.start();
    } catch (err) {
      await this.stop();
      this.fail(err);
    }
  }

  async runTool(name, args) {
    switch (name) {
      case "get_current_time":
        return {
          iso: new Date().toISOString(),
          local: new Date().toLocaleString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      case "set_volume": {
        const level = Math.max(0, Math.min(100, Number(args.level)));
        $("volume").value = String(level);
        this.applyVolume(level);
        return { level };
      }
      case "set_muted":
        this.applySpeakerMute(Boolean(args.muted));
        return { muted: Boolean(args.muted) };
      case "stop_listening":
        if (this.sessionHoldRemaining() > 0) {
          return { stopped: false, reason: "Session has a 3-minute minimum. Still online." };
        }
        setTimeout(() => this.stop(), 400);
        return { stopped: true };
      case "generate_image":
        return this.generateImage(args);
      case "show_image":
        return this.showImage(args);
      default:
        return { error: `Unknown tool ${name}` };
    }
  }

  noteQuery() {
    this.usage.bump("queries");
    this.renderUsage();
  }

  noteImage() {
    this.usage.bump("images");
    this.renderUsage();
  }

  renderUsage() {
    const { queries, images } = this.usage.refresh();
    $("query-count").textContent = String(queries);
    const imageBit = images ? ` · ${images} image${images === 1 ? "" : "s"}` : "";
    $("query-detail").textContent = `${queries} ${queries === 1 ? "query" : "queries"}${imageBit}`;
    $("query-chip").title = `${queries} spoken or typed turns today. Resets at local midnight.`;
  }

  async generateImage(args) {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return { error: "prompt is required" };
    if (!$("tool-images").checked) return { error: "Images are turned off in the UI." };

    const aspect = String(args.aspect_ratio || "1:1").trim() || "1:1";
    const caption = String(args.caption || prompt).trim();

    try {
      const xai = await this._generateViaXai(prompt, aspect);
      if (xai) {
        this.transcript.addImages([{ src: xai.src, caption }]);
        this.noteImage();
        return { shown: true, caption, model: xai.model };
      }
    } catch (err) {
      console.warn("xAI Imagine failed:", err);
    }

    // Browsers on GitHub Pages usually cannot POST to api.x.ai (CORS).
    // Fall back to a prompt-to-image URL the <img> tag can load directly.
    const fallback = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&model=flux`;
    try {
      await this._waitForImage(fallback, 28000);
      this.transcript.addImages([{ src: fallback, caption: caption || prompt }]);
      this.noteImage();
      return { shown: true, caption, model: "pollinations-fallback" };
    } catch (err) {
      const message = err.message || String(err);
      this.toast(`Image failed: ${message}`);
      return { error: message };
    }
  }

  async _generateViaXai(prompt, aspect) {
    const models = [IMAGE_MODEL, "grok-imagine-image-quality", "grok-imagine-image"];
    const formats = ["url", "b64_json"];
    for (const model of models) {
      for (const response_format of formats) {
        const response = await fetch(IMAGES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: aspect, response_format }),
        });
        const raw = await response.text();
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          continue;
        }
        if (!response.ok) continue;
        const item = (data.data && data.data[0]) || data;
        const b64 = item.b64_json || item.b64 || "";
        const url = item.url || "";
        const src = b64 ? `data:image/jpeg;base64,${b64}` : url;
        if (src) return { src, model };
      }
    }
    return null;
  }

  _waitForImage(src, timeoutMs) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => reject(new Error("image timed out")), timeoutMs);
      img.onload = () => {
        clearTimeout(timer);
        resolve(src);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error("image failed to load"));
      };
      img.referrerPolicy = "no-referrer";
      img.src = src;
    });
  }

  showImage(args) {
    const collected = [];
    const push = (url, caption) => {
      const href = String(url || "").trim();
      if (!href || !/^(https?:|data:image\/)/i.test(href)) return;
      collected.push({ src: href, caption: caption ? String(caption) : "" });
    };

    if (Array.isArray(args.images)) {
      args.images.forEach((img) => {
        if (typeof img === "string") push(img, args.caption);
        else push(img && img.url, (img && img.caption) || args.caption);
      });
    }
    if (Array.isArray(args.urls)) args.urls.forEach((url) => push(url, args.caption));
    if (args.url) push(args.url, args.caption);

    if (!collected.length) return { error: "No image URL provided." };
    this.transcript.addImages(collected);
    this.noteImage();
    return { shown: collected.length };
  }

  openLightbox(src, caption) {
    const dialog = $("lightbox");
    $("lightbox-img").src = src;
    $("lightbox-img").alt = caption || "Image";
    $("lightbox-caption").textContent = caption || "";
    if (typeof dialog.showModal === "function") dialog.showModal();
  }

  fillKokoroVoices(list) {
    const select = $("kokoro-voice");
    const previous = load(STORAGE.kokoroVoice, "af_heart");
    select.innerHTML = "";
    list.forEach((voice) => {
      const opt = document.createElement("option");
      opt.value = voice.id;
      opt.textContent = voice.name;
      select.appendChild(opt);
    });
    select.value = previous;
    if (!select.value && list[0]) select.value = list[0].id;
  }

  async loadKokoroVoices() {
    try {
      const response = await fetch(`${KOKORO_BASE}/voices`);
      if (!response.ok) throw new Error(`voices ${response.status}`);
      const data = await response.json();
      const raw = data.voices || data;
      const list = Object.keys(raw).map((id) => ({
        id,
        name: (raw[id] && (raw[id].name || raw[id].Name)) || id,
      }));
      if (list.length) {
        this.fillKokoroVoices(list);
        this.showKokoroCall("Hello from Grok Voice.");
      }
    } catch (err) {
      console.warn("Kokoro /voices failed, using built-in list:", err);
    }
  }

  showKokoroCall(text, extra) {
    const call = formatKokoroCall(text, $("kokoro-voice").value, $("kokoro-speed").value);
    const lines = [
      `${call.method} ${call.url}`,
      "Content-Type: application/json",
      JSON.stringify(call.body, null, 2),
    ];
    if (extra) lines.push("", extra);
    $("kokoro-call").textContent = lines.join("\n");
    this._lastKokoroCurl = call.curl;
    return call;
  }

  async readAloud(text) {
    const clean = String(text || "").trim();
    if (!clean) {
      this.toast("Nothing to read.");
      return;
    }
    this.speaker.stop();
    this.showKokoroCall(clean, "Sending…");
    try {
      const result = await this.kokoro.speak(clean, $("kokoro-voice").value, $("kokoro-speed").value);
      this.showKokoroCall(clean, `HTTP ${result.status} · ${result.bytes} bytes audio/mpeg`);
      this.transcript.tool(`Kokoro POST /api/speak · ${$("kokoro-voice").value} · HTTP ${result.status}`);
    } catch (err) {
      this.showKokoroCall(clean, `Failed: ${err.message || err}`);
      this.transcript.tool(`Kokoro API error: ${err.message || err}`);
      this.toast(`Read aloud failed: ${err.message || err}`);
    }
  }

  lastAssistantText() {
    const bubbles = $("transcript").querySelectorAll(".bubble.assistant .body");
    const last = bubbles[bubbles.length - 1];
    return last ? last.textContent.trim() : "";
  }

  readLast() {
    const bubbles = $("transcript").querySelectorAll(".bubble:not(.tool):not(.image) .body");
    const last = bubbles[bubbles.length - 1];
    this.readAloud(last ? last.textContent : "");
  }

  applyVolume(percent) {
    const value = Number(percent);
    this.speaker.setVolume(value / 100);
    this.kokoro.setVolume(value / 100);
    $("volume-readout").textContent = `${value}%`;
    save(STORAGE.volume, String(value));
  }

  applySpeakerMute(muted) {
    this.speaker.setMuted(muted);
    this.kokoro.setMuted(muted);
    $("mute-btn").setAttribute("aria-pressed", String(muted));
    $("mute-label").textContent = muted ? "Unmute" : "Mute";
    $("mute-icon").textContent = muted ? "🔇" : "🔊";
  }

  applyMicMute(muted) {
    this.mic.setMuted(muted);
    $("mic-mute-btn").setAttribute("aria-pressed", String(muted));
    $("mic-mute-label").textContent = muted ? "Mic off" : "Mic on";
  }

  openSettings() {
    $("settings-panel").hidden = false;
    $("settings-btn").setAttribute("aria-expanded", "true");
    $("api-key").focus();
  }

  closeSettings() {
    $("settings-panel").hidden = true;
    $("settings-btn").setAttribute("aria-expanded", "false");
  }

  persistSettings() {
    save(STORAGE.key, this.apiKey());
    save(STORAGE.voice, $("voice").value);
    save(STORAGE.instructions, $("instructions").value);
    save(STORAGE.vad, $("vad-threshold").value);
    save(STORAGE.silence, $("silence-ms").value);
    save(STORAGE.web, String($("tool-web").checked));
    save(STORAGE.x, String($("tool-x").checked));
    save(STORAGE.images, String($("tool-images").checked));
    save(STORAGE.greeting, String($("greeting").checked));
    save(STORAGE.kokoroOn, String($("kokoro-on").checked));
    save(STORAGE.kokoroVoice, $("kokoro-voice").value);
    save(STORAGE.kokoroSpeed, $("kokoro-speed").value);
  }

  restore() {
    const select = $("voice");
    VOICES.forEach((voice) => {
      const opt = document.createElement("option");
      opt.value = voice.id;
      opt.textContent = voice.name;
      select.appendChild(opt);
    });

    $("api-key").value = load(STORAGE.key, "");
    $("voice").value = load(STORAGE.voice, "eve");
    $("instructions").value = load(STORAGE.instructions, "");
    $("instructions").value = sessionInstructions();
    save(STORAGE.instructions, $("instructions").value);
    $("vad-threshold").value = load(STORAGE.vad, "0.60");
    $("silence-ms").value = load(STORAGE.silence, "800");
    $("tool-web").checked = load(STORAGE.web, "true") === "true";
    $("tool-x").checked = load(STORAGE.x, "true") === "true";
    $("tool-images").checked = load(STORAGE.images, "true") === "true";
    $("greeting").checked = load(STORAGE.greeting, "true") === "true";
    $("kokoro-on").checked = load(STORAGE.kokoroOn, "true") === "true";
    $("kokoro-speed").value = load(STORAGE.kokoroSpeed, "1");
    $("kokoro-speed-readout").textContent = `${Number($("kokoro-speed").value).toFixed(2)}×`;
    $("app-version").textContent = `v${APP_VERSION}`;
    this.fillKokoroVoices(KOKORO_VOICES_FALLBACK);
    this.loadKokoroVoices();
    this.showKokoroCall("Hello from Grok Voice.");
    this.renderUsage();
    this.renderSessionTimer();
    $("volume").value = load(STORAGE.volume, "90");
    this.applyVolume($("volume").value);
    $("vad-readout").textContent = Number($("vad-threshold").value).toFixed(2);
    $("silence-readout").textContent = `${$("silence-ms").value} ms`;

    if (!load(STORAGE.onboarded, "")) {
      const dialog = $("onboarding");
      if (typeof dialog.showModal === "function") dialog.showModal();
    }
  }

  bind() {
    $("listen-btn").addEventListener("click", () => this.toggle());
    $("settings-btn").addEventListener("click", () => this.openSettings());
    $("settings-close").addEventListener("click", () => this.closeSettings());
    $("settings-done").addEventListener("click", () => {
      this.persistSettings();
      this.closeSettings();
    });
    $("settings-panel").addEventListener("click", (event) => {
      if (event.target === $("settings-panel")) this.closeSettings();
    });
    $("help-btn").addEventListener("click", () => $("onboarding").showModal());
    $("onboarding").addEventListener("close", () => {
      save(STORAGE.onboarded, "1");
      this.startWakeWord();
    });

    $("mute-btn").addEventListener("click", () => {
      const next = $("mute-btn").getAttribute("aria-pressed") !== "true";
      this.applySpeakerMute(next);
    });
    $("mic-mute-btn").addEventListener("click", () => {
      const next = $("mic-mute-btn").getAttribute("aria-pressed") !== "true";
      this.applyMicMute(next);
    });
    $("volume").addEventListener("input", (event) => this.applyVolume(event.target.value));

    $("vad-threshold").addEventListener("input", (event) => {
      $("vad-readout").textContent = Number(event.target.value).toFixed(2);
    });
    $("silence-ms").addEventListener("input", (event) => {
      $("silence-readout").textContent = `${event.target.value} ms`;
    });

    $("toggle-key").addEventListener("click", () => {
      const input = $("api-key");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("toggle-key").textContent = show ? "Hide" : "Show";
      $("toggle-key").setAttribute("aria-pressed", String(show));
    });
    $("api-key").addEventListener("change", () => save(STORAGE.key, this.apiKey()));
    $("forget-key").addEventListener("click", () => {
      $("api-key").value = "";
      localStorage.removeItem(STORAGE.key);
      save(STORAGE.key, "");
      this.toast("API key removed from this browser.");
    });

    ["voice", "instructions", "vad-threshold", "silence-ms", "tool-web", "tool-x", "tool-images", "greeting", "kokoro-on", "kokoro-voice", "kokoro-speed"].forEach((id) => {
      $(id).addEventListener("change", () => {
        this.persistSettings();
        if (this.active && this.session.sessionReady) this.session._configureSession();
      });
    });

    $("kokoro-speed").addEventListener("input", (event) => {
      $("kokoro-speed-readout").textContent = `${Number(event.target.value).toFixed(2)}×`;
      this.showKokoroCall("Hello from Grok Voice.");
    });
    $("kokoro-voice").addEventListener("change", () => this.showKokoroCall("Hello from Grok Voice."));
    $("copy-kokoro-call").addEventListener("click", async () => {
      const text = this._lastKokoroCurl || $("kokoro-call").textContent;
      try {
        await navigator.clipboard.writeText(text);
        this.toast("Kokoro curl copied.");
      } catch {
        this.toast("Could not copy. Select the API box instead.");
      }
    });
    $("read-last").addEventListener("click", () => this.readLast());
    $("stop-read").addEventListener("click", () => this.kokoro.stop());
    $("clear-transcript").addEventListener("click", () => this.transcript.clear());
    $("reset-queries").addEventListener("click", () => {
      this.usage.reset();
      this.renderUsage();
      this.toast("Today’s query count was reset.");
    });

    $("transcript").addEventListener("click", (event) => {
      const readBtn = event.target.closest(".read-aloud");
      if (readBtn) {
        const bubble = readBtn.closest(".bubble");
        const text = bubble ? bubble.querySelector(".body").textContent : "";
        this.readAloud(text);
        return;
      }
      const thumb = event.target.closest("button.thumb");
      if (!thumb) return;
      this.openLightbox(thumb.dataset.src, thumb.dataset.caption);
    });

    $("composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("text-input");
      const text = input.value.trim();
      if (!text) return;
      if (!this.active) {
        this.toast("Start listening first so the socket is open.");
        return;
      }
      this.transcript.update("user", text, false);
      if (this.session.fulfillReadAloud(text, true)) {
        input.value = "";
        return;
      }
      this.noteQuery();
      this.session.sendText(text);
      input.value = "";
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.renderUsage();
        this._requestWakeLock();
        if (this.speaker.context && this.speaker.context.state === "suspended") {
          this.speaker.context.resume();
        }
      }
    });

    window.addEventListener("beforeunload", () => {
      if (this.active) this.session.disconnect();
    });

    window.addEventListener("unhandledrejection", (event) => {
      if (this.active) this.toast(event.reason && event.reason.message ? event.reason.message : "Unexpected error");
    });

    setInterval(() => this.renderUsage(), 60_000);
    this._timerTick = setInterval(() => this.renderSessionTimer(), 250);
    this.startWakeWord();
  }

  async _requestWakeLock() {
    if (!this.active || !navigator.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // Not fatal — Deck may deny wake lock without a secure context.
    }
  }

  _releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }
}

const app = new App();
app.restore();
app.bind();
app.viz.start();
app.viz.stop();
