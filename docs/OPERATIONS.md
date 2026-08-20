# Operaciones backend

## Procesos

- Web: `npm start`
- Worker: `npm run worker`
- Worker manual/debug: `npm run worker:once`

Producción debe ejecutar web y worker como procesos separados. El web no arranca un worker oculto.

## Health checks

- `GET /live`: liveness del proceso Node. No consulta PostgreSQL, Redis ni proveedores.
- `GET /ready`: readiness del proceso web. Devuelve `503` si PostgreSQL o Redis requerido no están disponibles.
- `GET /health`: diagnóstico resumido. Devuelve `200` para `healthy/degraded` y `503` para `unhealthy`.

`/health` solo muestra métricas agregadas de cola/worker/webhooks y estado sanitizado de dependencias. No expone payloads, tokens ni connection strings.

## Startup y shutdown

Startup valida configuración y comprueba PostgreSQL/Redis cuando son requeridos antes de escuchar tráfico. Shutdown ante `SIGTERM`/`SIGINT` deja de aceptar conexiones, cierra Redis/PostgreSQL y tiene timeout interno. `uncaughtException` y `unhandledRejection` disparan shutdown controlado.

## Release futuro

Orden recomendado, sin ejecutar automáticamente contra producción desde Codex:

```bash
npm ci
npm run build
npm test
npm run db:migrate
npm run db:status
npm start
npm run worker
```

`npm run check:release` ejecuta checks locales reproducibles sin servicios externos: tests y build.

## Migraciones

`npm run db:migrate` usa advisory lock. Debe ejecutarse una vez por release desde CI/pre-deploy/manual controlado antes de mover tráfico. `DATABASE_URL_DIRECT` queda reservado para migraciones/admin; runtime usa `DATABASE_URL`.

## Render

`render.yaml` define conceptualmente:

- Web Service: `npm ci && npm run build`, `npm start`, health `/ready`.
- Background Worker: `npm ci && npm run build`, `npm run worker`.

Ambos comparten variables de runtime como `DATABASE_URL`, `REDIS_URL`, LiveKit, storage y transcripción cuando aplique. No se incluyen valores secretos en el YAML.
