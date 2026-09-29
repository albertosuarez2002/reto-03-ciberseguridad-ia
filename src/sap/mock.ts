import { mkdir, readFile, appendFile } from "node:fs/promises"
import path from "node:path"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

type ProveedorMaestro = { codigo_sap: string; nit: string; activo: boolean }
type OrdenPersistida = { numero_oc: string; fecha: string; orden: OrdenCompra }

export class MockSapAdapter implements SapAdapter {
  private readonly directory: string
  constructor(directory: string) { this.directory = directory }

  private get sapDir(): string { return path.join(this.directory, "out", "sap") }
  private get ordenesPath(): string { return path.join(this.sapDir, "ordenes.jsonl") }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const raw = await readFile(path.join(this.directory, "fixtures", "reto-03", "maestros", "proveedores.json"), "utf8")
    const proveedores = JSON.parse(raw) as ProveedorMaestro[]
    return proveedores.find((p) => p.nit === nit) ?? null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    try {
      const raw = await readFile(this.ordenesPath, "utf8")
      const lineas = raw.split(/\r?\n/).filter(Boolean)
      for (const linea of lineas) {
        const row = JSON.parse(linea) as OrdenPersistida
        if (row.orden.referencia.solicitud_id === solicitud_id) return { numero_oc: row.numero_oc }
      }
      return null
    } catch {
      return null
    }
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    await mkdir(this.sapDir, { recursive: true })
    const existente = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id)
    if (existente) return { numero_oc: existente.numero_oc, fecha: new Date().toISOString() }

    let count = 0
    try {
      const raw = await readFile(this.ordenesPath, "utf8")
      count = raw.split(/\r?\n/).filter(Boolean).length
    } catch { count = 0 }
    const numero_oc = String(4500000001 + count)
    const fecha = new Date().toISOString()
    await appendFile(this.ordenesPath, JSON.stringify({ numero_oc, fecha, orden }) + "\n", "utf8")
    return { numero_oc, fecha }
  }
}
