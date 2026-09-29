export type OrdenCompra = {
  referencia: { solicitud_id: string; correo_id: string; cotizacion_ref: string | null }
  sociedad: "1000"
  organizacion_compras: "1000"
  proveedor: { codigo_sap: string; nit: string; nombre: string }
  moneda: "COP" | "USD"
  condiciones_pago: string
  aprobador: { email: string; fecha_aprobacion: string; evidencia_sha256: string }
  posiciones: Array<{
    numero: number
    descripcion: string
    cantidad: number
    unidad: "UN" | "H" | "MES"
    precio_unitario: number
    centro_costo: string
    subarea: string
    indicador_iva: string
  }>
  excepciones: Array<{ codigo: string; detalle: string; confirmado_por: string | null }>
}

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
