import type { LlmAdapter, LlmMessage, LlmReply } from "./adapter.ts"

export class OpenAIAdapter implements LlmAdapter {
  readonly provider = "OpenAI"
  readonly model: string
  private readonly apiKey: string
  constructor(apiKey: string, model: string) { this.apiKey = apiKey; this.model = model }

  async complete(messages: LlmMessage[], tools: object[]): Promise<LlmReply> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages, tools, tool_choice: "auto", temperature: 0.1 }),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Proveedor LLM respondió HTTP ${response.status}`)
      const body = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }
      const msg = body.choices?.[0]?.message
      return { content: msg?.content ?? "", toolCalls: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })) }
    } finally { clearTimeout(timer) }
  }
}
