# Conocimiento del proceso

El agente prepara órdenes de compra a partir de correo, solicitud, cotización y aprobación. Las reglas RC1-RC10 se implementan exclusivamente en herramientas determinísticas. El modelo de lenguaje no modifica montos, proveedores, centros de costo, aprobadores, condiciones de pago ni IVA por fuera de los resultados de herramientas.

Estados de negocio:
- BLOQUEADA: existe al menos un bloqueo RC1, RC2, RC3, RC4 o RC10.
- PENDIENTE_CONFIRMACION: no hay bloqueos, pero existe RC5, RC6, RC8 o RC9.
- CREADA: apta y sin confirmaciones, o confirmada explícitamente.
- IDEMPOTENTE: ya existía una OC para la misma solicitud_id y se devuelve la existente.
