/**
 * ModelProvider registry + a deterministic scripted provider.
 *
 * The registry is the seam where real provider adapters (OpenAI-compatible,
 * Anthropic, ...) plug in. Phase 1A ships a deterministic provider that
 * replays fine-grained OpenCode LLM events, so the full durable pipeline —
 * including the fine→neutral event normalization — is exercised without
 * network calls.
 */

import type { LLMEvent, LLMRequest, ModelProvider } from "./kernel/llm"

export interface ProviderEntry {
  readonly model: string
  readonly provider: ModelProvider
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>()

  constructor(entries: readonly ProviderEntry[]) {
    for (const entry of entries) this.providers.set(entry.model, entry.provider)
  }

  resolve(model: string): ModelProvider {
    const provider = this.providers.get(model)
    if (!provider) throw new Error(`No model provider registered for "${model}"`)
    return provider
  }
}

export interface ScriptedTurn {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ readonly toolName: string; readonly input?: unknown }>
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly reasoningTokens?: number }
}

/**
 * Deterministic ModelProvider that replays scripted provider turns.
 *
 * Stateless like a real provider: the turn index is derived from the number
 * of assistant messages in the request history, so a fresh provider instance
 * resumes correctly from a restored session.
 */
export class ScriptModelProvider implements ModelProvider {
  readonly id = "script"

  constructor(
    private readonly turns: readonly ScriptedTurn[],
    private readonly hooks: {
      readonly onTurnStart?: (stepIndex: number) => void
    } = {},
  ) {}

  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    const stepIndex = (request.messages as ReadonlyArray<{ role?: string }>).filter((m) => m?.role === "assistant").length
    this.hooks.onTurnStart?.(stepIndex)
    const turn = this.turns[stepIndex]
    yield { type: "step-start" }
    if (!turn || signal.aborted) {
      yield { type: "finish", reason: signal.aborted ? "stop" : "stop" }
      return
    }
    if (turn.text) {
      yield { type: "text-start" }
      yield { type: "text-delta", text: turn.text }
      yield { type: "text-end" }
    }
    const calls = turn.toolCalls ?? []
    for (const [index, call] of calls.entries()) {
      const toolCallId = `call_${stepIndex}_${index}`
      const input = JSON.stringify(call.input ?? {})
      yield { type: "tool-input-start", toolCallId, toolName: call.toolName }
      yield { type: "tool-input-delta", toolCallId, inputDelta: input }
      yield { type: "tool-input-end", toolCallId }
      if (signal.aborted) break
      yield { type: "tool-call", toolCallId, toolName: call.toolName, input: call.input ?? {} }
    }
    if (turn.usage) yield { type: "usage", usage: turn.usage }
    yield { type: "step-finish" }
    yield { type: "finish", reason: calls.length > 0 ? "tool_calls" : "stop" }
  }
}
