import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { generate } from './llm'
import { getSettings } from './config'

export interface Line { channel: 'me' | 'other'; text: string; ts: number }
export interface Card { q: string; a: string }
export interface Session {
  id: string
  started: number
  lines: Line[]
  summary?: string
  keyPoints?: string[]
  flashcards?: Card[]
}

const dir = (): string => {
  const d = join(app.getPath('userData'), 'sessions')
  mkdirSync(d, { recursive: true })
  return d
}
const path = (id: string): string => join(dir(), `${id.replace(/\W/g, '')}.json`)

export function saveSession(id: string, lines: Line[]): void {
  if (!lines.length) return
  const prev: Partial<Session> = existsSync(path(id)) ? JSON.parse(readFileSync(path(id), 'utf8')) : {}
  writeFileSync(path(id), JSON.stringify({ ...prev, id, started: lines[0].ts, lines }))
}

export const getSession = (id: string): Session | null =>
  existsSync(path(id)) ? JSON.parse(readFileSync(path(id), 'utf8')) : null

export function deleteSession(id: string): void {
  if (existsSync(path(id))) unlinkSync(path(id))
}

export function listSessions(): { id: string; started: number; count: number; preview: string; summarized: boolean }[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir(), f), 'utf8')) as Session)
    .sort((a, b) => b.started - a.started)
    .map((s) => ({ id: s.id, started: s.started, count: s.lines.length, preview: s.lines[0]?.text.slice(0, 80) ?? '', summarized: Boolean(s.summary) }))
}

export async function summarize(id: string): Promise<Session> {
  const s = getSession(id)
  if (!s) throw new Error('Session not found')
  const text = s.lines.map((l) => `${l.channel === 'me' ? 'ME' : 'OTHER'}: ${l.text}`).join('\n').slice(-30000)
  const system =
    'You turn a study/practice session transcript into notes. Reply with ONLY valid JSON (no markdown fences, no comments, escape all quotes inside strings): {"summary": string (3-5 sentences), "keyPoints": string[], "flashcards": [{"q": string, "a": string}]} with 5-12 flashcards covering questions asked and concepts discussed.'
  let parsed: { summary: string; keyPoints?: string[]; flashcards?: Card[] } | null = null
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    const json = (await generate(getSettings(), system, text)).match(/\{[\s\S]*\}/)?.[0]
    try {
      parsed = json ? JSON.parse(json) : null
    } catch { /* malformed JSON: retry */ }
  }
  if (!parsed) throw new Error('The model did not return valid notes after 3 tries. Try again or pick another model.')
  const next: Session = { ...s, summary: parsed.summary, keyPoints: parsed.keyPoints ?? [], flashcards: parsed.flashcards ?? [] }
  writeFileSync(path(id), JSON.stringify(next))
  return next
}

export function toMarkdown(s: Session): string {
  const date = new Date(s.started).toLocaleString()
  return [
    `# Session ${date}`,
    `\n## Summary\n${s.summary ?? '(not summarized)'}`,
    `\n## Key points\n${(s.keyPoints ?? []).map((k) => `- ${k}`).join('\n')}`,
    `\n## Flashcards\n${(s.flashcards ?? []).map((c) => `**Q:** ${c.q}\n**A:** ${c.a}\n`).join('\n')}`,
    `\n## Transcript\n${s.lines.map((l) => `**${l.channel === 'me' ? 'You' : 'Other'}:** ${l.text}`).join('\n\n')}`
  ].join('\n')
}

// Anki "Basic" import: tab-separated front/back.
export const toAnki = (s: Session): string =>
  (s.flashcards ?? []).map((c) => `${c.q.replace(/\t|\n/g, ' ')}\t${c.a.replace(/\t|\n/g, ' ')}`).join('\n')
