export type LlmMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string }
export type ToolCall = { id: string; name: string; arguments: string }
export type LlmReply = { content: string; toolCalls: ToolCall[] }
export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  complete(messages: LlmMessage[], tools: object[]): Promise<LlmReply>
}
