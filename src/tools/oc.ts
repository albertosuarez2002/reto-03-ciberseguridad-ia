import { z } from "zod"
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { MockSapAdapter } from "../sap/mock.ts"
import type { OrdenCompra } from "../sap/adapter.ts"

export type ToolContext = { directory: string; sessionId: string }

type Correo = { id: string; de: string; asunto: string; fecha: string }
type Solicitud = {
  solicitud_id: string; solicitante: string; proveedor_nombre: string; proveedor_nit?: string
  descripcion: string; centro_costo: string; subarea: string; cantidad: number; valor_unitario: number
  valor_total: number; moneda: "COP" | "USD"; indicador_iva?: string; condiciones_pago?: string; fecha_solicitud: string
}
type Cotizacion = { proveedor: string; nit: string | null; total: number; moneda: string; validez_hasta: string | null; texto: string; referencia: string | null }
type Aprobacion = { de: string; fecha: string; aprobado: boolean; texto: string }
type Factura = { numero: string; fecha: string; total: number }
export type Paquete = { correo: Correo; solicitud: Solicitud; cotizacion: Cotizacion | null; aprobacion: Aprobacion | null; factura: Factura | null }

type Proveedor = { codigo_sap: string; nit: string; nombre: string; condiciones_pago_default: string; indicador_iva_default: string; activo: boolean }
type Centro = { centro_costo: string; subareas: string[]; aprobadores: Array<{ email: string; nombre: string; tope: number }> }
export type Validacion = { apta: boolean; bloqueos: string[]; confirmaciones: string[]; derivados: Record<string, string>; retroactiva: boolean }

type ResultadoOk<T> = { ok: true; data: T }
type ResultadoError = { ok: false; error: string }

const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string() }),
  posiciones: z.array(z.object({
    numero: z.number(), descripcion: z.string().max(40), cantidad: z.number(), unidad: z.enum(["UN", "H", "MES"]),
    precio_unitario: z.number(), centro_costo: z.string(), subarea: z.string(), indicador_iva: z.string()
  })),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }))
})

const json = <T>(value: ResultadoOk<T> | ResultadoError): string => JSON.stringify(value)
const normalize = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "")
const money = (s: string): number => Number(s.replace(/\./g, "").replace(/,/g, "").replace(/[^0-9]/g, ""))
const caseDir = (ctx: ToolContext, caso: string): string => path.join(ctx.directory, "fixtures", "reto-03", "solicitudes", caso)
const maestro = (ctx: ToolContext, nombre: string): string => path.join(ctx.directory, "fixtures", "reto-03", "maestros", nombre)

async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T }

function parseCotizacion(texto: string): Cotizacion {
  const lines = texto.split(/\r?\n/)
  const ref = lines[0]?.replace(/^COTIZACI[ÓO]N\s*/i, "").trim() || null
  const proveedor = (texto.match(/Proveedor:\s*(.+)/i)?.[1] ?? "").trim()
  const nit = (texto.match(/NIT:\s*([\d.\-]+)/i)?.[1] ?? "").replace(/\D/g, "") || null
  const totalRaw = texto.match(/TOTAL[^:\n]*:\s*(?:COP|USD)?\s*([\d.,]+)/i)?.[1] ?? "0"
  const moneda = /USD/i.test(texto) ? "USD" : "COP"
  const fecha = texto.match(/Fecha:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null
  const dias = Number(texto.match(/Validez de la oferta:\s*(\d+)\s*d[ií]as/i)?.[1] ?? 0)
  let validez_hasta: string | null = null
  if (fecha && dias) { const d = new Date(`${fecha}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); validez_hasta = d.toISOString().slice(0,10) }
  return { proveedor, nit, total: money(totalRaw), moneda, validez_hasta, texto, referencia: ref }
}

function parseFactura(texto: string): Factura {
  const numero = (texto.match(/No\.\s*([^\s\n]+)/i)?.[1] ?? "SIN-NUMERO").trim()
  const fecha = texto.match(/Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? ""
  const totalRaw = texto.match(/TOTAL:\s*(?:COP|USD)?\s*([\d.,]+)/i)?.[1] ?? "0"
  return { numero, fecha, total: money(totalRaw) }
}

async function loadPaquete(ctx: ToolContext, caso: string): Promise<Paquete> {
  const dir = caseDir(ctx, caso)
  const correoRaw = await readJson<{ id: string; de: string; asunto: string; fecha: string }>(path.join(dir, "correo.json"))
  const solicitud = await readJson<Solicitud>(path.join(dir, "solicitud.json"))
  let cotizacion: Cotizacion | null = null
  let aprobacion: Aprobacion | null = null
  let factura: Factura | null = null
  try { cotizacion = parseCotizacion(await readFile(path.join(dir, "cotizacion.txt"), "utf8")) } catch { cotizacion = null }
  try {
    const a = await readJson<{ de: string; fecha: string; cuerpo: string }>(path.join(dir, "aprobacion.json"))
    aprobacion = { de: a.de, fecha: a.fecha, aprobado: /\bAprobado\b/i.test(a.cuerpo), texto: a.cuerpo }
  } catch { aprobacion = null }
  try { factura = parseFactura(await readFile(path.join(dir, "factura.txt"), "utf8")) } catch { factura = null }
  return { correo: correoRaw, solicitud, cotizacion, aprobacion, factura }
}

async function validatePaquete(ctx: ToolContext, paquete: Paquete): Promise<Validacion> {
  const proveedores = await readJson<Proveedor[]>(maestro(ctx, "proveedores.json"))
  const centros = await readJson<Centro[]>(maestro(ctx, "centros-costo.json"))
  const bloqueos: string[] = []
  const confirmaciones: string[] = []
  const derivados: Record<string, string> = {}
  const s = paquete.solicitud

  const proveedor = s.proveedor_nit
    ? proveedores.find((p) => p.nit === s.proveedor_nit)
    : proveedores.find((p) => normalize(p.nombre) === normalize(s.proveedor_nombre))
  if (!proveedor) bloqueos.push("RC1: Proveedor no existe en el maestro.")
  else if (!proveedor.activo) bloqueos.push("RC1: Proveedor existe pero está inactivo.")

  const centro = centros.find((c) => c.centro_costo === s.centro_costo)
  if (!centro) bloqueos.push(`RC4: Centro de costo ${s.centro_costo} no existe.`)
  else if (!centro.subareas.includes(s.subarea)) bloqueos.push(`RC4: Subárea ${s.subarea} no pertenece a ${s.centro_costo}.`)

  if (!paquete.aprobacion) bloqueos.push("RC2: No existe evidencia de aprobación.")
  else if (!paquete.aprobacion.aprobado) bloqueos.push("RC2: La evidencia no contiene la palabra 'Aprobado'.")
  else if (centro) {
    const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === paquete.aprobacion?.de.toLowerCase())
    if (!aprobador) bloqueos.push(`RC2: ${paquete.aprobacion.de} no es aprobador autorizado de ${s.centro_costo}.`)
    else if (s.valor_total > aprobador.tope) bloqueos.push(`RC3: Valor ${s.valor_total} supera tope ${aprobador.tope} del aprobador.`)
  }

  if (!paquete.cotizacion) confirmaciones.push("RC5: No hay cotización; requiere confirmación humana.")
  else {
    const diferencia = Math.abs(paquete.cotizacion.total - s.valor_total) / Math.max(1, s.valor_total)
    if (diferencia > 0.02) confirmaciones.push(`RC5: Cotización ${paquete.cotizacion.total} difiere de solicitud ${s.valor_total} en ${(diferencia * 100).toFixed(2)}%.`)
  }

  if (!s.indicador_iva && proveedor) {
    derivados.indicador_iva = proveedor.indicador_iva_default
    confirmaciones.push(`RC6: IVA no informado; se deriva ${proveedor.indicador_iva_default} del proveedor y requiere confirmación.`)
  }
  if (!s.condiciones_pago && proveedor) derivados.condiciones_pago = proveedor.condiciones_pago_default

  let retroactiva = false
  if (paquete.factura?.fecha && paquete.factura.fecha < s.fecha_solicitud) {
    retroactiva = true
    confirmaciones.push(`RC8: Compra retroactiva; factura ${paquete.factura.fecha} es anterior a solicitud ${s.fecha_solicitud}.`)
  }
  if (paquete.aprobacion?.fecha && paquete.aprobacion.fecha.slice(0,10) < s.fecha_solicitud) {
    confirmaciones.push(`RC9: Aprobación ${paquete.aprobacion.fecha.slice(0,10)} es anterior a solicitud ${s.fecha_solicitud}.`)
  }
  if (Math.abs((s.cantidad * s.valor_unitario) - s.valor_total) > 1) {
    bloqueos.push(`RC10: cantidad × valor_unitario (${s.cantidad * s.valor_unitario}) no coincide con valor_total (${s.valor_total}).`)
  }

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva }
}

async function approvalEvidence(ctx: ToolContext, caso: string): Promise<{ ruta: string; sha256: string }> {
  const dir = caseDir(ctx, caso)
  const a = await readJson<{ de: string; para: string; fecha: string; asunto: string; cuerpo: string }>(path.join(dir, "aprobacion.json"))
  const contenido = `De: ${a.de}\nPara: ${a.para}\nFecha: ${a.fecha}\nAsunto: ${a.asunto}\n\n${a.cuerpo}\n`
  const sha256 = createHash("sha256").update(contenido).digest("hex")
  const out = path.join(ctx.directory, "out", caso)
  await mkdir(out, { recursive: true })
  const ruta = path.join(out, "aprobacion.txt")
  await writeFile(ruta, `${contenido}\nSHA256: ${sha256}\n`, "utf8")
  return { ruta: path.relative(ctx.directory, ruta).replace(/\\/g, "/"), sha256 }
}

async function buildPayload(ctx: ToolContext, caso: string, paquete: Paquete, derivados: Record<string, string>): Promise<{ payload: OrdenCompra; trazabilidad: string }> {
  const proveedores = await readJson<Proveedor[]>(maestro(ctx, "proveedores.json"))
  const s = paquete.solicitud
  const proveedor = s.proveedor_nit
    ? proveedores.find((p) => p.nit === s.proveedor_nit)
    : proveedores.find((p) => normalize(p.nombre) === normalize(s.proveedor_nombre))
  if (!proveedor) throw new Error("No se puede construir payload: proveedor no encontrado")
  if (!paquete.aprobacion) throw new Error("No se puede construir payload: falta aprobación")
  const evidencia = await approvalEvidence(ctx, caso)
  const indicadorIva = s.indicador_iva ?? derivados.indicador_iva
  const condicionesPago = s.condiciones_pago ?? derivados.condiciones_pago
  if (!indicadorIva || !condicionesPago) throw new Error("Faltan valores obligatorios derivados")
  const payload: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: paquete.correo.id, cotizacion_ref: paquete.cotizacion?.referencia ?? null },
    sociedad: "1000", organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda, condiciones_pago: condicionesPago,
    aprobador: { email: paquete.aprobacion.de, fecha_aprobacion: paquete.aprobacion.fecha, evidencia_sha256: evidencia.sha256 },
    posiciones: [{ numero: 10, descripcion: s.descripcion.slice(0,40), cantidad: s.cantidad, unidad: "UN", precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: indicadorIva }],
    excepciones: []
  }
  OrdenCompraSchema.parse(payload)
  const trace = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": "cotizacion.referencia",
    "proveedor.codigo_sap": "maestro.proveedores.codigo_sap",
    "proveedor.nit": s.proveedor_nit ? "solicitud.proveedor_nit" : "maestro.proveedores.nit",
    "proveedor.nombre": "maestro.proveedores.nombre",
    "condiciones_pago": s.condiciones_pago ? "solicitud.condiciones_pago" : "derivado.condiciones_pago",
    "aprobador.email": "aprobacion.de",
    "posiciones[0].descripcion": "solicitud.descripcion",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud.indicador_iva" : "derivado.indicador_iva"
  }
  const out = path.join(ctx.directory, "out", caso)
  await mkdir(out, { recursive: true })
  const tracePath = path.join(out, "trazabilidad.json")
  await writeFile(tracePath, JSON.stringify(trace, null, 2), "utf8")
  return { payload, trazabilidad: path.relative(ctx.directory, tracePath).replace(/\\/g, "/") }
}

async function appendControl(ctx: ToolContext, row: { solicitud_id: string; resultado: string; numero_oc: string; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[] }): Promise<void> {
  const outDir = path.join(ctx.directory, "out")
  await mkdir(outDir, { recursive: true })
  const file = path.join(outDir, "control.csv")
  try { await readFile(file, "utf8") } catch { await writeFile(file, "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n", "utf8") }
  const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`
  const line = [row.solicitud_id, row.resultado, row.numero_oc, String(row.retroactiva), esc(row.bloqueos.join(" | ")), esc(row.confirmaciones.join(" | ")), new Date().toISOString()].join(",") + "\n"
  await appendFile(file, line, "utf8")
}

export const leer_paquete = {
  description: "Lee y normaliza correo, solicitud, cotización, aprobación y factura opcional de un caso.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try { return json({ ok: true, data: await loadPaquete(ctx, args.caso) }) } catch (e) { return json({ ok: false, error: `No fue posible leer el paquete: ${e instanceof Error ? e.message : String(e)}` }) }
  }
}

export const validar = {
  description: "Aplica RC1-RC10 y devuelve bloqueos, confirmaciones, derivados y marca de retroactividad.",
  args: { caso: z.string().describe("Caso"), paquete: z.unknown().describe("Paquete normalizado devuelto por oc_leer_paquete") },
  async execute(args: { caso: string; paquete: Paquete }, ctx: ToolContext): Promise<string> {
    try { return json({ ok: true, data: await validatePaquete(ctx, args.paquete) }) } catch (e) { return json({ ok: false, error: `Validación falló: ${e instanceof Error ? e.message : String(e)}` }) }
  }
}

export const construir_payload = {
  description: "Construye y valida el payload SAP y guarda trazabilidad campo a fuente.",
  args: { caso: z.string().describe("Caso"), paquete: z.unknown().describe("Paquete normalizado"), derivados: z.record(z.string(), z.string()).describe("Valores derivados por validación") },
  async execute(args: { caso: string; paquete: Paquete; derivados: Record<string, string> }, ctx: ToolContext): Promise<string> {
    try { return json({ ok: true, data: await buildPayload(ctx, args.caso, args.paquete, args.derivados) }) } catch (e) { return json({ ok: false, error: `No fue posible construir payload: ${e instanceof Error ? e.message : String(e)}` }) }
  }
}

export const generar_evidencia = {
  description: "Genera evidencia TXT de la aprobación con encabezados y SHA-256.",
  args: { caso: z.string().describe("Caso") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try { return json({ ok: true, data: await approvalEvidence(ctx, args.caso) }) } catch (e) { return json({ ok: false, error: `No fue posible generar evidencia: ${e instanceof Error ? e.message : String(e)}` }) }
  }
}

export const crear = {
  description: "Crea una OC idempotente en SAP simulado solo si pasa controles y confirmaciones.",
  args: { caso: z.string().describe("Caso"), payload: z.unknown().describe("Payload de OrdenCompra validado"), confirmado: z.boolean().optional().describe("Confirmación humana explícita") },
  async execute(args: { caso: string; payload: OrdenCompra; confirmado?: boolean }, ctx: ToolContext): Promise<string> {
    try {
      const paquete = await loadPaquete(ctx, args.caso)
      const v = await validatePaquete(ctx, paquete)
      const solicitudId = paquete.solicitud.solicitud_id
      if (!v.apta) {
        await appendControl(ctx, { solicitud_id: solicitudId, resultado: "BLOQUEADA", numero_oc: "", retroactiva: v.retroactiva, bloqueos: v.bloqueos, confirmaciones: v.confirmaciones })
        return json({ ok: false, error: `OC bloqueada: ${v.bloqueos.join(" | ")}` })
      }
      if (v.confirmaciones.length > 0 && args.confirmado !== true) {
        await appendControl(ctx, { solicitud_id: solicitudId, resultado: "PENDIENTE_CONFIRMACION", numero_oc: "", retroactiva: v.retroactiva, bloqueos: [], confirmaciones: v.confirmaciones })
        return json({ ok: false, error: `Requiere confirmación humana: ${v.confirmaciones.join(" | ")}` })
      }
      const parsed = OrdenCompraSchema.parse(args.payload) as OrdenCompra
      const sap = new MockSapAdapter(ctx.directory)
      const existing = await sap.buscarOrdenPorReferencia(solicitudId)
      const result = await sap.crearOrden(parsed)
      await appendControl(ctx, { solicitud_id: solicitudId, resultado: existing ? "IDEMPOTENTE" : "CREADA", numero_oc: result.numero_oc, retroactiva: v.retroactiva, bloqueos: [], confirmaciones: v.confirmaciones })
      return json({ ok: true, data: { ...result, idempotente: Boolean(existing) } })
    } catch (e) { return json({ ok: false, error: `No fue posible crear OC: ${e instanceof Error ? e.message : String(e)}` }) }
  }
}

export const tools = { oc_leer_paquete: leer_paquete, oc_validar: validar, oc_construir_payload: construir_payload, oc_generar_evidencia: generar_evidencia, oc_crear: crear }
