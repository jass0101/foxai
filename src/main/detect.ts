const STARTERS =
  /^(what|why|how|when|where|who|which|whose|can|could|would|will|should|do|does|did|is|are|was|were|have|has|tell me|explain|describe|walk me|give me|share|talk about|define|compare|implement|write|design|solve)\b/i
const CUES = /\b(can you|could you|would you|tell me|walk me through|what is|what's|how do|how would|explain)\b/i

// Cheap heuristic: good enough to trigger auto-answers. Manual "Answer now" covers misses.
export function isQuestion(text: string): boolean {
  const t = text.trim()
  if (t.split(/\s+/).length < 3) return false
  return t.endsWith('?') || STARTERS.test(t) || CUES.test(t)
}
