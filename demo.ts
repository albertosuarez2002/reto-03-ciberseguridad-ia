import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { leer_paquete, validar, construir_payload, crear, type Paquete, type Validacion } from "./src/tools/oc.ts"
import type { OrdenCompra } from "./src/sap/adapter.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory, sessionId: "demo" }

type R<T> = { ok: true; data: T } | { ok: false; error: string }
const parse = <T>(s: string): R<T> => JSON.parse(s) as R<T>

async function processCase(caso: string, confirmado = false): Promise<{ payload?: OrdenCompra; numero?: string }> {
  const p = parse<Paquete>(await leer_paquete.execute({ caso }, ctx))
  if (!p.ok) { console.log(`${caso}: ERROR ${p.error}`); return {} }
  const v = parse<Validacion>(await validar.execute({ caso, paquete: p.data }, ctx))
  if (!v.ok) { console.log(`${caso}: ERROR ${v.error}`); return {} }
  console.log(`\n${caso}`)
  console.log(`  apta: ${v.data.apta}`)
  console.log(`  bloqueos: ${v.data.bloqueos.length ? v.data.bloqueos.join(" | ") : "ninguno"}`)
  console.log(`  confirmaciones: ${v.data.confirmaciones.length ? v.data.confirmaciones.join(" | ") : "ninguna"}`)
  console.log(`  retroactiva: ${v.data.retroactiva}`)
  if (!v.data.apta) {
    console.log("  resultado: BLOQUEADA")
    return {}
  }
  const b = parse<{ payload: OrdenCompra; trazabilidad: string }>(await construir_payload.execute({ caso, paquete: p.data, derivados: v.data.derivados }, ctx))
  if (!b.ok) { console.log(`  resultado: ERROR ${b.error}`); return {} }
  const c = parse<{ numero_oc: string; fecha: string; idempotente: boolean }>(await crear.execute({ caso, payload: b.data.payload, confirmado }, ctx))
  if (!c.ok) { console.log(`  resultado: ${v.data.confirmaciones.length ? "PENDIENTE_CONFIRMACION" : "ERROR"}`); console.log(`  motivo: ${c.error}`); return { payload: b.data.payload } }
  console.log(`  resultado: CREADA${c.data.idempotente ? " (IDEMPOTENTE)" : ""}`)
  console.log(`  numero_oc: ${c.data.numero_oc}`)
  return { payload: b.data.payload, numero: c.data.numero_oc }
}

await rm(path.join(directory, "out"), { recursive: true, force: true })

const r1 = await processCase("sol-001")
await processCase("sol-002")
await processCase("sol-003")
const r4 = await processCase("sol-004")
if (r4.payload) {
  console.log("  -> DEMO: usuario confirma explícitamente sol-004")
  const c = parse<{ numero_oc: string; fecha: string; idempotente: boolean }>(await crear.execute({ caso: "sol-004", payload: r4.payload, confirmado: true }, ctx))
  console.log(c.ok ? `  -> creada tras confirmar: ${c.data.numero_oc}` : `  -> error: ${c.error}`)
}
await processCase("sol-005")
await processCase("sol-006")
if (r1.payload) {
  console.log("\nIdempotencia sol-001 (segunda ejecución):")
  const again = parse<{ numero_oc: string; fecha: string; idempotente: boolean }>(await crear.execute({ caso: "sol-001", payload: r1.payload }, ctx))
  console.log(again.ok ? `  ${again.data.numero_oc}, idempotente=${again.data.idempotente}` : `  ERROR ${again.error}`)
}
