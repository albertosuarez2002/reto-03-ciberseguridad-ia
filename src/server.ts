import http from "node:http"
import { readFile, appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tools, type Paquete, type Validacion } from "./tools/oc.ts"
import { OpenAIAdapter } from "./llm/openai.ts"
import type { LlmMessage } from "./llm/adapter.ts"

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const port = Number(process.env.PORT ?? 3000)
const maxIterations = Number(process.env.MAX_AGENT_ITERATIONS ?? 12)
const apiKey = process.env.OPENAI_API_KEY ?? ""
const model = process.env.OPENAI_MODEL ?? "gpt-5-mini"
const llm = apiKey ? new OpenAIAdapter(apiKey, model) : null

type Session = { messages: Array<{ role: "user" | "assistant"; content: string }>; pendingCase?: string; pendingPayload?: unknown }
const sessions = new Map<string, Session>()

const toolSpecs = [
  { type: "function", function: { name: "oc_leer_paquete", description: tools.oc_leer_paquete.description, parameters: { type: "object", properties: { caso: { type: "string" } }, required: ["caso"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_validar", description: tools.oc_validar.description, parameters: { type: "object", properties: { caso: { type: "string" }, paquete: { type: "object" } }, required: ["caso", "paquete"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_construir_payload", description: tools.oc_construir_payload.description, parameters: { type: "object", properties: { caso: { type: "string" }, paquete: { type: "object" }, derivados: { type: "object" } }, required: ["caso", "paquete", "derivados"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_generar_evidencia", description: tools.oc_generar_evidencia.description, parameters: { type: "object", properties: { caso: { type: "string" } }, required: ["caso"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_crear", description: tools.oc_crear.description, parameters: { type: "object", properties: { caso: { type: "string" }, payload: { type: "object" }, confirmado: { type: "boolean" } }, required: ["caso", "payload"], additionalProperties: false } } }
]

async function logTool(entry: object): Promise<void> {
  await mkdir(path.join(directory, "out"), { recursive: true })
  await appendFile(path.join(directory, "out", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8")
}

function extractCase(message: string): string | null { return message.match(/sol-00[1-6]/i)?.[0].toLowerCase() ?? null }
function isConfirmation(message: string): boolean { return /\b(confirmo|confirmar|sí|si|proceder|procede|crear)\b/i.test(message) }

type ToolEvent = { name: string; arguments: object; result: unknown }

async function deterministicTurn(sessionId: string, message: string): Promise<{ reply: string; toolCalls: ToolEvent[]; needsConfirmation: boolean }> {
  const session = sessions.get(sessionId) ?? { messages: [] }
  sessions.set(sessionId, session)
  const ctx = { directory, sessionId }
  const events: ToolEvent[] = []

  if (session.pendingCase && session.pendingPayload && isConfirmation(message)) {
    const args = { caso: session.pendingCase, payload: session.pendingPayload, confirmado: true }
    const raw = await tools.oc_crear.execute(args as never, ctx)
    const result = JSON.parse(raw) as { ok: boolean; data?: { numero_oc: string }; error?: string }
    events.push({ name: "oc_crear", arguments: { caso: session.pendingCase, confirmado: true }, result })
    await logTool(events.at(-1) ?? {})
    if (result.ok) {
      session.pendingCase = undefined; session.pendingPayload = undefined
      return { reply: `Confirmación recibida. La OC fue creada con número ${result.data?.numero_oc}.`, toolCalls: events, needsConfirmation: false }
    }
    return { reply: result.error ?? "No fue posible crear la OC.", toolCalls: events, needsConfirmation: false }
  }

  const caso = extractCase(message)
  if (!caso) return { reply: "Indica un caso entre sol-001 y sol-006. Ejemplo: 'Procesa sol-004'.", toolCalls: [], needsConfirmation: false }

  const r1 = JSON.parse(await tools.oc_leer_paquete.execute({ caso }, ctx)) as { ok: boolean; data?: Paquete; error?: string }
  events.push({ name: "oc_leer_paquete", arguments: { caso }, result: r1 }); await logTool(events.at(-1) ?? {})
  if (!r1.ok || !r1.data) return { reply: r1.error ?? "No pude leer el paquete.", toolCalls: events, needsConfirmation: false }
  const r2 = JSON.parse(await tools.oc_validar.execute({ caso, paquete: r1.data }, ctx)) as { ok: boolean; data?: Validacion; error?: string }
  events.push({ name: "oc_validar", arguments: { caso, paquete: "[paquete normalizado]" }, result: r2 }); await logTool(events.at(-1) ?? {})
  if (!r2.ok || !r2.data) return { reply: r2.error ?? "No pude validar.", toolCalls: events, needsConfirmation: false }
  if (!r2.data.apta) return { reply: `OC BLOQUEADA. ${r2.data.bloqueos.join(" ")} Acción sugerida: corregir el dato o conseguir una aprobación válida antes de reintentar.`, toolCalls: events, needsConfirmation: false }

  const r3 = JSON.parse(await tools.oc_construir_payload.execute({ caso, paquete: r1.data, derivados: r2.data.derivados }, ctx)) as { ok: boolean; data?: { payload: unknown; trazabilidad: string }; error?: string }
  events.push({ name: "oc_construir_payload", arguments: { caso, derivados: r2.data.derivados }, result: r3 }); await logTool(events.at(-1) ?? {})
  if (!r3.ok || !r3.data) return { reply: r3.error ?? "No pude construir el payload.", toolCalls: events, needsConfirmation: false }

  if (r2.data.confirmaciones.length) {
    session.pendingCase = caso; session.pendingPayload = r3.data.payload
    return { reply: `La solicitud es apta, pero requiere confirmación humana:\n- ${r2.data.confirmaciones.join("\n- ")}\n\nValores derivados: ${JSON.stringify(r2.data.derivados)}\n¿Confirmas que debo crear la OC?`, toolCalls: events, needsConfirmation: true }
  }

  const r4 = JSON.parse(await tools.oc_crear.execute({ caso, payload: r3.data.payload }, ctx)) as { ok: boolean; data?: { numero_oc: string; idempotente: boolean }; error?: string }
  events.push({ name: "oc_crear", arguments: { caso }, result: r4 }); await logTool(events.at(-1) ?? {})
  return r4.ok ? { reply: `OC creada correctamente. Número: ${r4.data?.numero_oc}${r4.data?.idempotente ? " (ya existía; respuesta idempotente)" : ""}.`, toolCalls: events, needsConfirmation: false } : { reply: r4.error ?? "No fue posible crear la OC.", toolCalls: events, needsConfirmation: false }
}

async function llmTurn(sessionId: string, message: string): Promise<{ reply: string; toolCalls: ToolEvent[]; needsConfirmation: boolean }> {
  // El modo LLM está diseñado como capa conversacional. Las decisiones de control siguen en herramientas.
  // Para una demo estable, primero resolvemos la acción con las herramientas determinísticas y luego el LLM puede reformular la explicación.
  const base = await deterministicTurn(sessionId, message)
  if (!llm) return base
  try {
    const system = await readFile(path.join(directory, "agent", "prompt.md"), "utf8")
    const msgs: LlmMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `Mensaje del usuario: ${message}\nResultado determinístico de herramientas: ${base.reply}\nReformula de forma clara sin cambiar ningún valor.` }
    ]
    // Se mantiene soporte de tools en el adaptador para evolucionar a un loop de function-calling; aquí evitamos duplicar acciones de escritura.
    const reply = await llm.complete(msgs, toolSpecs)
    return { ...base, reply: reply.content || base.reply }
  } catch (e) {
    return { ...base, reply: `${base.reply}\n\nNota: el proveedor LLM no respondió (${e instanceof Error ? e.message : String(e)}); se mantuvo el resultado determinístico.` }
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url === "/" ? "/index.html" : req.url ?? "/index.html"
  const safe = path.normalize(url).replace(/^([.][.][/\\])+/, "")
  const file = path.join(directory, "web", safe)
  try {
    const body = await readFile(file)
    const ext = path.extname(file)
    const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : "application/octet-stream"
    res.writeHead(200, { "Content-Type": type }); res.end(body)
  } catch { res.writeHead(404); res.end("Not found") }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, provider: llm?.provider ?? "deterministic-fallback", model: llm?.model ?? "none" })); return
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = ""; for await (const chunk of req) body += chunk
    try {
      const input = JSON.parse(body) as { sessionId?: string; message?: string }
      const sessionId = input.sessionId ?? crypto.randomUUID()
      const result = await llmTurn(sessionId, input.message ?? "")
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ sessionId, ...result })); return
    } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); return }
  }
  if (req.method === "GET" && req.url?.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(req.url.split("/").at(-1) ?? "")
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(sessions.get(id) ?? { messages: [] })); return
  }
  await serveStatic(req, res)
})

server.listen(port, () => console.log(`Reto 03 activo en http://localhost:${port} | LLM=${llm ? `${llm.provider}/${llm.model}` : "fallback determinístico"} | maxIterations=${maxIterations}`))
