# Reto 03 — Agente de Órdenes de Compra SAP

## Arranque local

Requiere Node.js 20+.

```bash
npm install
npm run dev
```

Abrir `http://localhost:3000`.

La aplicación puede funcionar en modo determinístico sin clave. Para activar la capa conversacional con modelo, copie `.env.example` a `.env` o configure variables de entorno antes de iniciar:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `PORT` (opcional)
- `MAX_AGENT_ITERATIONS` (opcional)

La clave nunca se envía al frontend ni se registra en logs.

## Verificación sin modelo

```bash
npm install
npm run demo
```

`demo.ts` limpia `out/`, ejecuta los seis casos, confirma explícitamente `sol-004` y vuelve a ejecutar `sol-001` para demostrar idempotencia.

## Casos esperados

- sol-001: crea OC automáticamente.
- sol-002: bloquea por proveedor inexistente.
- sol-003: bloquea por aprobador no autorizado.
- sol-004: solicita confirmación por diferencia superior al 2%; tras confirmar, crea.
- sol-005: solicita confirmación y marca retroactiva.
- sol-006: deriva IVA del proveedor y solicita confirmación.

## Link de prueba

Pendiente de desplegar. Para Render/Railway: comando de build `npm install`; comando de inicio `npm start`; Node 20+.
