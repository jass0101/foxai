import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const PROVIDERS = ['groq', 'openai', 'anthropic', 'google', 'openrouter', 'ollama'] as const
export type ProviderId = (typeof PROVIDERS)[number]
export type KeyId = ProviderId | 'deepgram'

export interface Settings {
  provider: ProviderId
  models: Record<ProviderId, string>
  ollamaUrl: string
  language: string // Deepgram language code, or "multi"
  autoAnswer: boolean
  alwaysOnTop: boolean
  contentProtect: boolean // keep this window out of screen shares (Windows/macOS only)
  opacity: number // window opacity 0.3-1
  micDeviceId: string // "" = default mic, "off" = disabled
  otherSource: string // "system" = loopback, "off" = disabled, else an input deviceId
  resume: string
  jobDescription: string
  instructions: string
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'groq',
  models: {
    groq: 'openai/gpt-oss-20b',
    openai: 'gpt-4.1-mini',
    anthropic: 'claude-haiku-4-5',
    google: 'gemini-2.5-flash',
    openrouter: 'openai/gpt-4o-mini',
    ollama: 'llama3.1'
  },
  ollamaUrl: 'http://localhost:11434/v1',
  language: 'en',
  autoAnswer: true,
  alwaysOnTop: false,
  contentProtect: true,
  opacity: 1,
  micDeviceId: '',
  otherSource: 'system',
  resume: '',
  jobDescription: '',
  instructions: ''
}

const file = (name: string): string => join(app.getPath('userData'), name)

function readJson<T>(name: string, fallback: T): T {
  try {
    return existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : fallback
  } catch {
    return fallback
  }
}

export function getSettings(): Settings {
  const saved = readJson<Partial<Settings>>('settings.json', {})
  return { ...DEFAULT_SETTINGS, ...saved, models: { ...DEFAULT_SETTINGS.models, ...saved.models } }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  writeFileSync(file('settings.json'), JSON.stringify(next, null, 2))
  return next
}

// API keys never leave the main process. They are encrypted with the OS keychain
// (safeStorage) when available; on Linux without a keyring they fall back to base64.
type KeyStore = Partial<Record<KeyId, { enc: boolean; value: string }>>

export function setKey(id: KeyId, key: string): void {
  const store = readJson<KeyStore>('keys.json', {})
  if (!key) delete store[id]
  else if (safeStorage.isEncryptionAvailable())
    store[id] = { enc: true, value: safeStorage.encryptString(key).toString('base64') }
  else store[id] = { enc: false, value: Buffer.from(key).toString('base64') }
  writeFileSync(file('keys.json'), JSON.stringify(store), { mode: 0o600 })
}

export function getKey(id: KeyId): string {
  const entry = readJson<KeyStore>('keys.json', {})[id]
  if (!entry) return ''
  const buf = Buffer.from(entry.value, 'base64')
  try {
    return entry.enc ? safeStorage.decryptString(buf) : buf.toString()
  } catch {
    throw new Error(`Saved ${id} key can't be decrypted. Re-enter it in Settings.`)
  }
}

export function keyStatus(): Record<KeyId, boolean> {
  const store = readJson<KeyStore>('keys.json', {})
  return Object.fromEntries(
    [...PROVIDERS, 'deepgram'].map((id) => [id, Boolean(store[id as KeyId])])
  ) as Record<KeyId, boolean>
}
