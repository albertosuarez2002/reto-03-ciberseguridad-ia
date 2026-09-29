# SOLUCIÓN — Reto técnico 03

## 1. Problema en una frase
La analista administrativa pierde tiempo y asume riesgo operativo al digitar y validar manualmente órdenes de compra; la solución automatiza el flujo normal y devuelve las excepciones al humano con evidencia y trazabilidad.

## 2. Arquitectura

```text
Usuario / Analista
       |
       v
Front chat (web/)
       |
       v
Backend (src/server.ts)
       |
       +--> agent/prompt.md  [comportamiento]
       +--> LLM adapter      [capa conversacional opcional]
       |
       v
Herramientas Zod (src/tools/oc.ts) [ejecución y controles RC1-RC10]
       |                    \
       v                     v
fixtures/ (solo lectura)   out/ (evidencias, control, logs)
                              |
                              v
                      SapAdapter -> MockSapAdapter
```

Separación deliberada: el prompt define comportamiento, `knowledge/` explica el proceso y `tools/` contiene las reglas ejecutables. Los valores críticos no dependen de lo que “crea” el modelo.

## 3. Ciclo del agente
1. Identifica el caso solicitado.
2. `oc_leer_paquete` normaliza los datos.
3. `oc_validar` ejecuta RC1-RC10.
4. Si hay bloqueos, termina sin crear.
5. Si no hay bloqueos, `oc_construir_payload` construye el objeto SAP y trazabilidad.
6. Si existen confirmaciones, el turno termina con una pregunta explícita y se conserva el payload pendiente.
7. Solo ante una confirmación posterior se llama `oc_crear(..., confirmado=true)`.
8. Toda llamada se registra en `out/log.jsonl` y se muestra en el frontend.

El servidor expone límite de iteraciones configurable (`MAX_AGENT_ITERATIONS`, valor por defecto 12). Las acciones de escritura están deliberadamente fuera de cualquier bucle de reformulación del LLM para evitar duplicados; además, el adaptador SAP es idempotente por `solicitud_id`.

## 4. Elección del modelo
La solución incluye un adaptador para un modelo de OpenAI configurable por `OPENAI_MODEL`; si no hay clave, mantiene una ruta determinística para que la demostración no dependa del proveedor. La clave solo vive en variable de entorno del backend.

Para estimar costo por caso en producción usaría: `tokens_entrada × tarifa_entrada + tokens_salida × tarifa_salida`, midiendo primero una muestra real de 100 casos. No fijo una cifra en este documento porque las tarifas y el modelo elegido pueden cambiar; el límite de tokens y de iteraciones debe ser configurable.

## 5. Matriz de controles RC1-RC10

| Regla | Implementación | Resultado |
|---|---|---|
| RC1 | Busca proveedor por NIT; si falta, por nombre normalizado; valida `activo`. | Bloqueo |
| RC2 | Exige evidencia, palabra “Aprobado” y correo listado para el centro de costo. | Bloqueo |
| RC3 | Compara `valor_total` con el `tope` del aprobador autorizado. | Bloqueo |
| RC4 | Verifica que la subárea pertenezca al centro de costo. | Bloqueo |
| RC5 | Calcula diferencia relativa entre cotización y solicitud; >2% requiere confirmación. | Confirmación |
| RC6 | Si falta IVA, toma `indicador_iva_default` del proveedor y exige confirmación. | Derivado + confirmación |
| RC7 | Si faltan condiciones de pago, deriva el valor del proveedor. | Derivado |
| RC8 | Si factura.fecha < solicitud.fecha, marca `retroactiva=true`. | Confirmación |
| RC9 | Si aprobación es anterior a la solicitud, pide confirmación. | Confirmación |
| RC10 | Verifica `cantidad × valor_unitario` contra total con tolerancia de 1. | Bloqueo |

La regla más delicada fue RC2/RC3: primero se debe acreditar que el correo pertenece a un aprobador del centro; solo entonces su tope puede utilizarse. No se “busca un tope conveniente”.

## 6. Diseño del adaptador SAP real
### Opción primaria
Usaría una capa de integración desacoplada mediante SAP Integration Suite cuando esté disponible. Dado que la viabilidad de conexión no está confirmada, la aplicación depende de `SapAdapter`, no de un protocolo SAP concreto. Detrás de esa interfaz se podría implementar OData `API_PURCHASEORDER_PROCESS_SRV` o, si el paisaje exige RFC, `BAPI_PO_CREATE1`.

### Mapeo
- `proveedor.codigo_sap` -> identificador de proveedor SAP.
- `sociedad` y `organizacion_compras` -> datos de cabecera.
- `condiciones_pago` -> término de pago.
- cada `posicion` -> item de la OC con descripción, cantidad, precio, centro de costo e IVA.
- `referencia.solicitud_id` -> referencia externa para idempotencia y auditoría.
- evidencia de aprobación -> adjunto o repositorio documental referenciado según capacidades del sistema.

### Autenticación y secretos
Credenciales en un gestor de secretos de la plataforma de ejecución, nunca en prompt, repositorio o frontend. La identidad del backend recibe solo permisos necesarios para consultar proveedor y crear OC.

### Idempotencia y errores parciales
Antes de crear, buscar por referencia externa. En reintentos devolver la OC existente. Si SAP confirma cabecera pero falla una operación posterior (por ejemplo adjunto), registrar estado parcial y ejecutar una reconciliación; no repetir ciegamente la creación.

### Plan B
Si no existe integración viable, generar payload validado, evidencia y un archivo/tabla listo para carga o copia controlada en SAP. Se conserva el mayor ahorro: lectura, validación, derivación y trazabilidad.

## 7. Lectura del proceso: OC retroactivas
Una OC retroactiva no debe normalizarse como “flujo exitoso”. Es evidencia de que el compromiso de gasto ocurrió antes del control formal. Propongo medir el porcentaje mensual de retroactivas por área, proveedor y solicitante, con causa registrada. En una segunda etapa, el proceso debería exigir solicitud y aprobación antes de aceptar la factura, reservando una excepción formal para urgencias con responsable y justificación. El reto no define si deben bloquearse; por eso la solución las marca y exige confirmación, tal como pide el PRD.

## 8. Decisiones y trade-offs
1. **Reglas determinísticas vs. reglas en prompt.** Elegí código determinístico para RC1-RC10. Alternativa descartada: pedir al LLM que “revise” montos y aprobadores. Motivo: menor trazabilidad y riesgo de alucinación.
2. **Adaptador SAP vs. llamadas directas desde herramientas.** Elegí interfaz `SapAdapter`. Alternativa descartada: acoplar herramientas al mock. Motivo: permite sustituir mock por OData/RFC sin reescribir reglas.
3. **Confirmación por estado de sesión vs. inferir confirmación en el mismo turno.** Elegí turno separado. Alternativa descartada: crear cuando el usuario diga “procesa”. Motivo: el PRD exige confirmación humana explícita para excepciones.
4. **Fallback determinístico vs. dependencia obligatoria del LLM.** Elegí fallback para demo y continuidad. El LLM mejora conversación, pero no es un punto único de falla para validaciones.

## 9. Supuestos
- Los maestros son completos y confiables para el reto.
- La aprobación por correo es evidencia suficiente en este alcance.
- Las monedas de fixtures son COP/USD.
- Cada solicitud contiene una posición; el esquema soporta ampliar a múltiples posiciones.
- El NIT de solicitud es la fuente primaria para identificar proveedor; si falta se utiliza nombre normalizado.

## 10. Cobertura

| Historia | Estado | Nota |
|---|---|---|
| HU-1 leer paquete | Hecho | JSON/TXT según fixtures; ausencias se normalizan cuando son opcionales. |
| HU-2 validar | Hecho | RC1-RC10. |
| HU-3 payload + trazabilidad | Hecho | `trazabilidad.json`. |
| HU-4 evidencia | Hecho P0 | TXT + SHA-256; PDF P1 no implementado. |
| HU-5 SAP simulado | Hecho | secuencial, JSONL, idempotencia, control.csv. |
| HU-6 errores | Hecho | herramientas retornan `{ok:false,error}`. |
| Front chat | Hecho | historial visual, tool calls, confirmación resaltada. |
| LLM | Parcial | adaptador configurable; fallback determinístico. |
| Link público | Pendiente | desplegar en Render/Railway/Vercel compatible con Node. |
| Lectura XLSX real | No hecho | P1 opcional. |

## 11. Uso de IA
Se utilizó ChatGPT para: analizar el PRD, estructurar la arquitectura, generar un primer borrador de código, revisar reglas RC1-RC10, preparar documentación y explicar decisiones. No se delegó a la IA la decisión final sobre controles: cada regla fue contrastada con el PRD y llevada a código determinístico. Se descartó la idea de permitir que el modelo alterara montos o resolviera excepciones sin confirmación, porque contradice el requisito de trazabilidad y aumenta el riesgo de alucinación.

## 12. Riesgos de producción y mitigaciones
- **Prompt injection en adjuntos**: documentos se tratan como datos; herramientas no ejecutan instrucciones de los documentos.
- **Datos maestros desactualizados**: consulta a SAP en tiempo real o sincronización con control de versión/frescura.
- **Aprobación falsificada**: integrar identidad/firma del correo y controles de origen; no confiar solo en texto “Aprobado”.
- **Exceso de privilegios SAP**: cuenta técnica con mínimo privilegio y segregación de funciones.
- **Duplicados por reintento**: idempotencia por `solicitud_id`/referencia externa.
- **Filtración de secretos**: secretos solo en backend y gestor de secretos; sanitización de logs.
- **Costo/abuso del LLM**: límites de iteraciones/tokens, rate limiting y autenticación en producción.
- **Errores del modelo**: ningún valor crítico se toma del modelo; herramientas y esquemas validan el estado final.
