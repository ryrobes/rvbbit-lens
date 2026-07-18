"use client"

/**
 * Assistant voice — TTS (ElevenLabs) + STT (ElevenLabs Scribe).
 *
 * Settings are browser-local L1 (localStorage), same as persona/avatar: voice
 * is a personal preference, not a shared backend credential, and two people at
 * the same desktop may want different voices. The ElevenLabs key rides to the
 * lens server per request (same-origin) which proxies ElevenLabs — no CORS, no
 * key in the DB, streaming/multipart handled server-side.
 *
 * The VoicePlayer wraps a single AudioContext + AnalyserNode so the speaking
 * animation (VoiceOrb) can read live frequency data off whatever is playing.
 */

// ── Settings store ──────────────────────────────────────────────────────

export interface VoiceSettings {
  elevenKey: string
  voiceId: string
  ttsEnabled: boolean
  /** speak every assistant reply automatically vs. click-to-play per message. */
  autoSpeak: boolean
  sttEnabled: boolean
  /** Re-voice replies through a speech-render LLM pass before TTS: strips
   *  markdown for the ear, adds sparing ElevenLabs v3 audio tags, and lets
   *  the persona color delivery — without touching the main agent loop or
   *  the visible transcript. */
  expressive: boolean
  /** Model for the speech-render pass; "" = same model as the assistant. */
  speechModel: string
}

const VOICE_KEY = "rvbbit-lens.assistant.voice.v1"

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  elevenKey: "",
  voiceId: "",
  ttsEnabled: false,
  autoSpeak: true,
  sttEnabled: false,
  expressive: false,
  speechModel: "",
}

export function loadVoiceSettings(): VoiceSettings {
  if (typeof window === "undefined") return { ...DEFAULT_VOICE_SETTINGS }
  try {
    const raw = window.localStorage.getItem(VOICE_KEY)
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>
    return { ...DEFAULT_VOICE_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS }
  }
}

export function saveVoiceSettings(v: VoiceSettings): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(VOICE_KEY, JSON.stringify(v))
  } catch {
    // best-effort
  }
}

/** True when TTS can actually run (enabled + both credentials present). */
export function ttsReady(v: VoiceSettings): boolean {
  return v.ttsEnabled && v.elevenKey.trim().length > 0 && v.voiceId.trim().length > 0
}
export function sttReady(v: VoiceSettings): boolean {
  return v.sttEnabled && v.elevenKey.trim().length > 0
}

// ── Server calls ────────────────────────────────────────────────────────

/** Synthesize speech; returns an mp3 Blob. Throws with the server's message. */
export async function synthesizeSpeech(text: string, v: VoiceSettings): Promise<Blob> {
  const res = await fetch("/api/assistant/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voiceId: v.voiceId, key: v.elevenKey }),
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => "")
    throw new Error(msg || `TTS failed (${res.status})`)
  }
  return res.blob()
}

// ── Speech render (expressive re-voicing) ───────────────────────────────
//
// Delivery is a view-layer concern: the agent loop and the visible transcript
// never see audio tags or persona flavor. When `expressive` is on, replies
// pass through a small lens-managed operator (desktop_speech_render) that
// rewrites them as a spoken script — markdown stripped for the ear, code and
// tables compressed to a phrase, 0–2 ElevenLabs v3 audio tags, persona voice
// allowed — right before synthesis. Any failure falls back to the plain text:
// voice is icing, and so is its polish.

const SPEECH_OPERATOR = "desktop_speech_render"
const ASSISTANT_OPERATOR = "desktop_assistant_turn"

const SPEECH_SYSTEM = [
  "You turn a chat reply from a data assistant into a SPOKEN script for expressive text-to-speech.",
  "Rules:",
  "- Stay faithful: every fact, number, and name exactly as written. Never invent content.",
  "- Strip all markdown. Compress code blocks, tables, or long lists into one natural spoken phrase (e.g. 'I've put the query on screen').",
  "- You may add AT MOST two ElevenLabs v3 audio tags in square brackets where delivery genuinely benefits, chosen from tags like [warmly], [chuckles], [thoughtful], [sighs], [whispers], [excited], [pause].",
  "- If a PERSONA is given, let it color word choice and delivery — lightly, never at the expense of the information.",
  "- Keep it the same length or shorter than the original. Plain text only.",
  "- Return ONLY the script. No preamble, no quotes, no notes.",
].join("\n")

const SPEECH_USER = "PERSONA (may be empty):\n{{persona}}\n\nREPLY TO SPEAK:\n{{message}}\n\nReturn only the spoken script."

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

/** Last model the operator was ensured with, per connection — re-upserts only
 *  when the settings model actually changes. */
const ensuredModel = new Map<string, string>()
/** Rendered scripts, keyed by content+model — replaying a message is free. */
const scriptCache = new Map<string, string>()

async function dbQuery(
  connectionId: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, sql, readOnly: false, rowLimit: 1 }),
  })
  const body = (await res.json()) as { rows?: Array<Record<string, unknown>>; error?: string }
  if (!res.ok || body.error) throw new Error(body.error ?? `query failed (${res.status})`)
  return body.rows ?? []
}

async function ensureSpeechOperator(connectionId: string, model: string): Promise<void> {
  if (ensuredModel.get(connectionId) === model) return
  // "" = follow the assistant's model; resolved server-side so the two stay
  // in step even when the assistant model changes later.
  const modelExpr = model
    ? sqlLit(model)
    : `coalesce((SELECT o.model FROM rvbbit.operators o WHERE o.name = ${sqlLit(ASSISTANT_OPERATOR)}), 'openai/gpt-5.4-mini')`
  await dbQuery(
    connectionId,
    `SELECT rvbbit.create_operator(${sqlLit(SPEECH_OPERATOR)}, ARRAY['message','persona'], 'text',
       op_model := ${modelExpr},
       op_temperature := 0.7,
       op_max_tokens := 900,
       op_description := 'Lens-managed: rewrites assistant replies as spoken scripts for expressive TTS (v3 audio tags + persona flavor). Managed by the Assistant Settings window.',
       op_system := ${sqlLit(SPEECH_SYSTEM)},
       op_user := ${sqlLit(SPEECH_USER)})`,
  )
  ensuredModel.set(connectionId, model)
}

/** Render the spoken script for a reply, or null when anything at all goes
 *  wrong (caller speaks the plain text). Cached per content+model. */
export async function renderSpeechScript(args: {
  connectionId: string
  text: string
  persona: string
  model: string
}): Promise<string | null> {
  const cacheKey = `${args.model}${args.text}`
  const hit = scriptCache.get(cacheKey)
  if (hit) return hit
  try {
    await ensureSpeechOperator(args.connectionId, args.model)
    const rows = await dbQuery(
      args.connectionId,
      `SELECT rvbbit.${SPEECH_OPERATOR}(${sqlLit(args.text)}, ${sqlLit(args.persona)}) AS script`,
    )
    const script = String(rows[0]?.script ?? "").trim()
    if (!script) return null
    if (scriptCache.size > 200) scriptCache.clear()
    scriptCache.set(cacheKey, script)
    return script
  } catch {
    return null
  }
}

export interface VoiceOption {
  id: string
  name: string
  category?: string
}

/** List the account's ElevenLabs voices for the settings dropdown. */
export async function listVoices(key: string): Promise<VoiceOption[]> {
  const res = await fetch("/api/assistant/voices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  })
  const body = (await res.json()) as { voices?: VoiceOption[]; error?: string }
  if (!res.ok || body.error) throw new Error(body.error || `voices failed (${res.status})`)
  return body.voices ?? []
}

/** Transcribe recorded audio via ElevenLabs Scribe; returns the text. */
export async function transcribeSpeech(audio: Blob, v: VoiceSettings): Promise<string> {
  const fd = new FormData()
  fd.append("audio", audio, "clip.webm")
  fd.append("key", v.elevenKey)
  const res = await fetch("/api/assistant/stt", { method: "POST", body: fd })
  if (!res.ok) {
    const msg = await res.text().catch(() => "")
    throw new Error(msg || `STT failed (${res.status})`)
  }
  const body = (await res.json()) as { text?: string; error?: string }
  if (body.error) throw new Error(body.error)
  return (body.text ?? "").trim()
}

// ── Playback engine (single AudioContext + analyser) ────────────────────

type PlayerListener = (speaking: boolean) => void

/**
 * One playback engine per page. Routes decoded audio through an AnalyserNode so
 * the VoiceOrb can visualize whatever is currently speaking. requestAnimation-
 * Frame lives in the orb, not here — this only owns the audio graph.
 */
export class VoicePlayer {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: AudioBufferSourceNode | null = null
  private listeners = new Set<PlayerListener>()
  private token = 0
  speaking = false

  /** Must be called from a user gesture the first time (autoplay policy). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctor()
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.smoothingTimeConstant = 0.8
      this.analyser.connect(this.ctx.destination)
    }
    if (this.ctx.state === "suspended") void this.ctx.resume()
    return this.ctx
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }

  onChange(fn: PlayerListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(speaking: boolean) {
    this.speaking = speaking
    for (const fn of this.listeners) fn(speaking)
  }

  async play(blob: Blob): Promise<void> {
    const ctx = this.ensureContext()
    const myToken = ++this.token
    this.stopSource()
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    if (myToken !== this.token) return // superseded while decoding
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.analyser!)
    this.source = src
    this.emit(true)
    await new Promise<void>((resolve) => {
      src.onended = () => {
        if (this.source === src) this.source = null
        if (myToken === this.token) this.emit(false)
        resolve()
      }
      src.start()
    })
  }

  private stopSource() {
    if (this.source) {
      try {
        this.source.onended = null
        this.source.stop()
      } catch {
        // already stopped
      }
      this.source = null
    }
  }

  stop() {
    this.token++
    this.stopSource()
    this.emit(false)
  }
}

let sharedPlayer: VoicePlayer | null = null
export function getVoicePlayer(): VoicePlayer {
  if (!sharedPlayer) sharedPlayer = new VoicePlayer()
  return sharedPlayer
}
