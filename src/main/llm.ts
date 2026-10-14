import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { getKey, type ProviderId, type Settings } from './config'

// Providers whose default chat model has no vision get a vision-capable override for screenshots.
export const VISION_MODEL: Partial<Record<ProviderId, string>> = {
  groq: 'qwen/qwen3.8-27b'
}

function model(s: Settings, id = s.models[s.provider]): LanguageModel {
  const apiKey = getKey(s.provider)
  if (s.provider !== 'ollama' && !apiKey)
    throw new Error(`No API key saved for "${s.provider}". Add it in Settings.`)
  switch (s.provider) {
    case 'groq':
      return createGroq({ apiKey })(id)
    case 'openai':
      return createOpenAI({ apiKey })(id)
    case 'anthropic':
      return createAnthropic({ apiKey })(id)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(id)
    case 'openrouter':
      return createOpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' }).chat(id)
    case 'ollama':
      return createOpenAI({ apiKey: 'ollama', baseURL: s.ollamaUrl }).chat(id)
  }
}

export function systemPrompt(s: Settings): string {
  const parts = [
    'You are a real-time study and practice assistant listening to a live conversation.',
    'Answer the latest question so the user can learn and respond well.',
    'Start with a short, natural spoken-style answer (2-4 sentences), then key points as bullets.',
    'For coding questions give the approach, complexity, and a fenced code block.',
    'Be concise. Never invent facts about the user that are not in their background.'
  ]
  if (s.resume.trim()) parts.push(`\n## User background / resume\n${s.resume.trim()}`)
  if (s.jobDescription.trim()) parts.push(`\n## Role / topic\n${s.jobDescription.trim()}`)
  if (s.instructions.trim()) parts.push(`\n## Extra instructions\n${s.instructions.trim()}`)
  return parts.join('\n')
}

export async function streamTask(
  s: Settings,
  system: string,
  messages: ModelMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  modelId?: string
): Promise<void> {
  const result = streamText({ model: model(s, modelId), system, messages, abortSignal: signal })
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') onDelta(part.text)
    else if (part.type === 'error') throw part.error
  }
}

export async function streamAnswer(
  s: Settings,
  transcript: string,
  question: string,
  signal: AbortSignal,
  onDelta: (text: string) => void
): Promise<void> {
  const content = `Recent transcript (ME = user, OTHER = other speaker):\n${transcript || '(empty)'}\n\nQuestion to answer:\n${question}`
  return streamTask(s, systemPrompt(s), [{ role: 'user', content }], signal, onDelta)
}

export async function generate(s: Settings, system: string, prompt: string): Promise<string> {
  return (await generateText({ model: model(s), system, prompt, maxOutputTokens: 6000 })).text
}
