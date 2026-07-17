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
}

const VOICE_KEY = "rvbbit-lens.assistant.voice.v1"

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  elevenKey: "",
  voiceId: "",
  ttsEnabled: false,
  autoSpeak: true,
  sttEnabled: false,
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
