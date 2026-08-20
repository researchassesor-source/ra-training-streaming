# Durable jobs y worker

RA Training Streaming usa PostgreSQL como fuente de verdad para trabajos largos y efectos externos. Redis queda reservado para coordinación efímera, rate limits y locks; no es autoridad de jobs.

## Arquitectura operativa

- Web process: valida autorización, crea/actualiza entidad de dominio y encola `background_jobs`.
- Worker process: reclama jobs con `FOR UPDATE SKIP LOCKED`, ejecuta handlers registrados y persiste resultado.
- Leases: cada job `RUNNING` tiene `lease_expires_at`; si un worker muere, otro puede recuperarlo cuando vence.
- Heartbeat: el worker extiende lease solo si conserva ownership por `job id + locked_by + status RUNNING`.
- Semántica: at-least-once con idempotencia, dedupe keys, máquinas de estado y reconciliación. No se promete exactly-once frente a proveedores externos.

## Comandos

```bash
npm run worker
npm run worker:once
```

En Render, el despliegue futuro debe separar:

- Web Service: comando actual del servidor.
- Background Worker: `npm run worker`.

No se debe arrancar un worker oculto desde el proceso web en producción.

## Variables

```env
WORKER_CONCURRENCY=1
JOB_POLL_INTERVAL_MS=2000
JOB_LEASE_MS=60000
JOB_HEARTBEAT_INTERVAL_MS=15000
```

El worker durable requiere `DATA_BACKEND=postgres` y `DATABASE_URL`.

## Job types actuales

- `TRANSCRIPTION_PROCESS`
- `TRANSCRIPTION_RETENTION_DELETE`
- `RECORDING_RECONCILE`
- `FACEBOOK_RECONCILE`

Los payloads guardan referencias como `transcriptionId`, `recordingId`, `meetingId`, `room`, `egressId` o `sessionId`. No deben guardar tokens, stream keys, API keys ni URLs firmadas.

## Transcripción y retención

La solicitud crea una transcripción `QUEUED` y un job en la misma transacción cuando se usa PostgreSQL. El worker resuelve la grabación y genera la URL firmada just-in-time. Al completar, programa un job de retención para `retentionUntil`.

La retención borra contenido sensible de transcript (`text`, `segments`, `words`, `speakers`, metadata de proveedor) y conserva metadata mínima auditable.

## Recording / Facebook Live

Recording y Facebook Live persisten intención/estado durable y encolan reconciliación con LiveKit Egress. Si una creación externa queda ambigua por timeout/reset, el estado pasa a reconciliación en vez de reintentar ciegamente.

## Validación

```bash
npm test
npm run test:postgres
npm run test:redis
npm run build
git diff --check
npm run package:source
```

Los tests unitarios usan fakes; no llaman Deepgram, Facebook, LiveKit Egress ni R2 reales.
