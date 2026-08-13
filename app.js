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
};

const DEFAULT_INSTRUCTIONS = [
  "You are Grok, an always-listening voice companion running on a handheld Steam Deck in Desktop Mode.",
  "Keep spoken answers short and conversational — this is a voice call, not an essay.",
  "Match the language the user is speaking. Switch languages mid-conversation if they do.",
  "Use web_search or x_search when you need current information.",
  "If the user asks you to change volume, mute, unmute, or stop listening, call the matching tool.",
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
  idle: ["Ready when you are", "Paste an xAI API key, then tap Start Listening."],
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

function load(key, fallback) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value;
}

function save(key, value) {
  localStorage.setItem(key, value);
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
    if ($("tool-web").checked) tools.push({ type: "web_search" });
    if ($("tool-x").checked) tools.push({ type: "x_search" });
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
        instructions: $("instructions").value.trim() || DEFAULT_INSTRUCTIONS,
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
              content: [{ type: "output_text", text: "Hey. I'm Grok. I'm listening." }],
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

      case "conversation.item.input_audio_transcription.updated":
        this.app.transcript.update("user", msg.transcript || msg.text || "", true);
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.app.transcript.update("user", msg.transcript || msg.text || "", false);
        break;

      case "response.created":
        this.app.setPhase("thinking");
        this.app.transcript.begin("assistant");
        break;

      case "response.output_audio_transcript.delta":
        this.app.setPhase("speaking");
        this.app.transcript.append("assistant", msg.delta || "");
        break;

      case "response.output_audio_transcript.done":
        this.app.transcript.finalize("assistant", msg.transcript);
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
  }

  begin(role) {
    if (this.live[role]) return this.live[role];
    const el = document.createElement("article");
    el.className = `bubble ${role} interim`;
    el.innerHTML = `<span class="who">${role === "user" ? "You" : "Grok"} · ${nowLabel()}</span><div class="body"></div>`;
    this.root.appendChild(el);
    this.live[role] = el;
    this._scroll();
    return el;
  }

  update(role, text, interim) {
    if (!text) return;
    const el = this.begin(role);
    el.querySelector(".body").textContent = text;
    el.classList.toggle("interim", Boolean(interim));
    if (!interim) this.live[role] = null;
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

  clear() {
    this.root.innerHTML = "";
    this.live = { user: null, assistant: null };
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
// App
// ---------------------------------------------------------------------------

class App {
  constructor() {
    this.phase = "idle";
    this.active = false;
    this.wakeLock = null;
    this.speaker = new Speaker();
    this.session = new RealtimeSession(this);
    this.transcript = new TranscriptView($("transcript"));
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
    if (this.active) return;
    if (!this.apiKey()) {
      this.openSettings();
      this.toast("Paste your xAI API key to start.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser cannot access the microphone. Use Chromium over http://localhost.");
    }

    this.active = true;
    $("listen-btn").setAttribute("aria-pressed", "true");
    $("listen-text").textContent = "Stop";
    this.setPhase("connecting");
    this.viz.start();

    // AudioContext must be created inside the click handler (Safari / some Deck browsers).
    await this.speaker.ensure();

    await Promise.all([this.mic.start(), this.session.connect()]);
    await this._requestWakeLock();
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
    this.setPhase("idle");
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
        setTimeout(() => this.stop(), 400);
        return { stopped: true };
      default:
        return { error: `Unknown tool ${name}` };
    }
  }

  applyVolume(percent) {
    const value = Number(percent);
    this.speaker.setVolume(value / 100);
    $("volume-readout").textContent = `${value}%`;
    save(STORAGE.volume, String(value));
  }

  applySpeakerMute(muted) {
    this.speaker.setMuted(muted);
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
    save(STORAGE.greeting, String($("greeting").checked));
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
    $("instructions").value = load(STORAGE.instructions, DEFAULT_INSTRUCTIONS);
    $("vad-threshold").value = load(STORAGE.vad, "0.60");
    $("silence-ms").value = load(STORAGE.silence, "800");
    $("tool-web").checked = load(STORAGE.web, "true") === "true";
    $("tool-x").checked = load(STORAGE.x, "true") === "true";
    $("greeting").checked = load(STORAGE.greeting, "true") === "true";
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
    $("onboarding").addEventListener("close", () => save(STORAGE.onboarded, "1"));

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
      this.toast("API key removed from this browser.");
    });

    ["voice", "instructions", "vad-threshold", "silence-ms", "tool-web", "tool-x", "greeting"].forEach((id) => {
      $(id).addEventListener("change", () => {
        this.persistSettings();
        if (this.active && this.session.sessionReady) this.session._configureSession();
      });
    });

    $("clear-transcript").addEventListener("click", () => this.transcript.clear());

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
      this.session.sendText(text);
      input.value = "";
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
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
