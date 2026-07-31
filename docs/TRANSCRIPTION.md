# Transcripciones

## Alcance y flujo real

La aplicación crea una transcripción desde una grabación `RoomComposite` finalizada por LiveKit Egress y almacenada en un bucket R2 privado. No captura audio directamente desde el navegador ni publica el bucket.

1. ADMIN u ORGANIZER solicita la transcripción de una reunión completada que tenga `allowTranscription=true`.
2. El backend comprueba rol, propiedad, CSRF, rate limit, asociación reunión/grabación, estado `READY`, duración y tamaño.
3. `server/app.js` genera una URL S3 presignada de R2 con vigencia de 5 a 15 minutos; Preview usa 600 segundos.
4. `server/transcription-providers/deepgram.js` envía `POST https://api.deepgram.com/v1/listen` con `Authorization: Token …` y cuerpo JSON `{ "url": "<url-temporal>" }`.
5. Deepgram descarga el MP4 privado, procesa el audio y devuelve canales, alternativa, palabras, utterances, párrafos y metadata.
6. El adaptador descarta la forma externa, normaliza a un modelo interno neutral y persiste únicamente campos permitidos bajo `transcriptions/<id>.json`.
7. La UI consulta el trabajo, permite filtrar, corregir texto, renombrar hablantes y exportar TXT, JSON, WebVTT o SRT.

La URL firmada se usa solo dentro del proceso servidor→Deepgram: no se guarda en la transcripción ni se devuelve en el detalle de transcripción. Las pantallas de grabaciones conservan su mecanismo autorizado e independiente de reproducción/descarga.

## Proveedor Deepgram

Configuración actual validada contra la documentación oficial de audio pregrabado:

- endpoint exacto: `https://api.deepgram.com/v1/listen`;
- autenticación server-side: `Authorization: Token <TRANSCRIPTION_API_KEY>`;
- modelo: `nova-3`;
- idioma: `es`;
- `punctuate=true`;
- `smart_format=true`;
- `utterances=true`;
- `paragraphs=true`;
- `diarize_model=latest` cuando la diarización está habilitada;
- timestamps y confianza a nivel de palabra desde `alternatives[0].words`.

El proveedor acepta una URL remota según [Pre-recorded audio](https://developers.deepgram.com/docs/pre-recorded-audio). La forma de respuesta y los parámetros corresponden a [Listen Pre-Recorded](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded?explorer=true), [Utterances](https://developers.deepgram.com/docs/utterances) y [Paragraphs](https://developers.deepgram.com/docs/paragraphs). `diarize_model=latest` evita fijar el modelo de diarización legado.

No se implementó envío binario porque el contrato documentado admite URL remota y todavía no existe evidencia real de que Deepgram no pueda leer una URL presignada de R2. Si una prueba aislada demuestra esa incompatibilidad, el fallback deberá ser un stream R2→backend→Deepgram con backpressure, límite de bytes, timeout y aborto; nunca hacer público el bucket ni cargar una grabación completa en memoria.

El adaptador HTTP genérico anterior continúa disponible como compatibilidad para proveedores internos que implementen su contrato `/jobs`. No es el adaptador usado por Deepgram.

## Modelo neutral persistido

La versión 2 conserva, entre otros, `provider`, `providerRequestId`, idioma, duración, confianza, texto, speakers, segmentos, palabras, estado, revisión, auditoría temporal y `retentionUntil`. Cada segmento usa milisegundos internamente y contiene un `speakerId` estable, etiqueta, nombre corregible, inicio, fin, confianza, texto y palabras sanitizadas.

Solo se conserva metadata de proveedor permitida: identificador de solicitud, modelo y fecha. No se persisten respuesta cruda, header `Authorization`, API key ni URL presignada. `providerJobId` permanece interno y se elimina de todas las respuestas públicas.

Las transcripciones históricas sin `schemaVersion`, `speakerId`, `words` o `providerMetadata` se normalizan al leerlas sin reescribir ni borrar el objeto original. Los estados del proveedor anterior siguen siendo reconocidos.

## Estados, progreso y reinicios

Estados actuales de Deepgram: `PENDING`, `VALIDATING`, `FETCHING_RECORDING`, `SUBMITTING`, `PROCESSING`, `COMPLETED`, `FAILED` y `CANCELLED`. También se aceptan estados heredados: `QUEUED`, `PROCESSING_AUDIO`, `IDENTIFYING_PARTICIPANTS`, `GENERATING_TRANSCRIPT` y `COMPLETED_WITH_WARNINGS`.

Los porcentajes representan etapas del flujo, no porcentaje de audio reconocido. La llamada pregrabada de Deepgram es síncrona; el backend la ejecuta fuera de la respuesta HTTP y mantiene su `AbortController` en memoria. Cancelar aborta una solicitud o espera de reintento y las comprobaciones de carrera impiden que una finalización sobrescriba `CANCELLED`.

Limitación operativa: los jobs Deepgram activos viven en memoria del proceso. Un reinicio o despliegue pierde ese controlador; la siguiente consulta marca `PROVIDER_JOB_NOT_FOUND` como fallo seguro y el operador puede reintentar desde la grabación persistida. Antes de escalar a varias instancias debe incorporarse una cola duradera con idempotencia y leasing.

## Diarización y nombres

Deepgram asigna números de speaker que se convierten en `speaker-0`, `speaker-1`, etc., visibles inicialmente como “Hablante 1”, “Hablante 2”. La normalización prefiere utterances; si faltan, usa sentences de paragraphs; si tampoco existen, agrupa palabras contiguas por speaker. Una transcripción sin texto utilizable falla de forma explícita.

Room Composite mezcla las voces y no ofrece una relación fiable entre el número de diarización y una identidad LiveKit. Solo se asigna un nombre real cuando el resultado trae `participantIdentity`/`trackSid` verificable contra la metadata de Egress. En cualquier otro caso se conserva el hablante genérico y ADMIN/ORGANIZER puede renombrarlo manualmente; el cambio afecta todos sus segmentos, incrementa `revision` y queda auditado. No se atribuyen nombres por orden o conjetura.

## Configuración

| Variable | Uso |
|---|---|
| `TRANSCRIPTION_ENABLED` | Interruptor general; `false` deshabilita sin borrar datos. |
| `TRANSCRIPTION_PROVIDER` | `deepgram` en Preview; `http` conserva compatibilidad; `mock` solo pruebas/desarrollo. |
| `TRANSCRIPTION_API_URL` | Para Deepgram debe ser exactamente `https://api.deepgram.com/v1/listen`. |
| `TRANSCRIPTION_API_KEY` | Clave exclusiva del entorno; solo servidor. |
| `TRANSCRIPTION_ALLOWED_HOSTS` | Para Deepgram: `api.deepgram.com`. |
| `TRANSCRIPTION_LANGUAGE` | Idioma predeterminado; Preview usa `es`. |
| `TRANSCRIPTION_DEEPGRAM_MODEL` | Modelo speech-to-text; Preview usa `nova-3`. |
| `TRANSCRIPTION_DEEPGRAM_DIARIZE` | Activa `diarize_model=latest`. |
| `TRANSCRIPTION_DEEPGRAM_SMART_FORMAT` | Activa smart formatting. |
| `TRANSCRIPTION_DEEPGRAM_UTTERANCES` | Solicita utterances. |
| `TRANSCRIPTION_DEEPGRAM_PARAGRAPHS` | Solicita paragraphs. |
| `TRANSCRIPTION_MAX_DURATION_MINUTES` | Rechazo previo por duración; Preview usa 240. |
| `TRANSCRIPTION_MAX_AUDIO_BYTES` | Rechazo previo por tamaño; Preview usa 2 GiB. |
| `TRANSCRIPTION_REQUEST_TIMEOUT_MS` | Cubre conexión y lectura de respuesta; Preview usa 600000. |
| `TRANSCRIPTION_PRESIGNED_URL_TTL_SECONDS` | Entre 300 y 900; Preview usa 600. |
| `TRANSCRIPTION_RETRY_MAX` | Reintentos internos, de 0 a 5; Preview usa 2. |
| `TRANSCRIPTION_RETENTION_DAYS` | Fecha objetivo `retentionUntil`; Preview usa 90. |
| `TRANSCRIPTION_RATE_LIMIT_MAX` | Solicitudes/reintentos por hora y usuario. |

Preview exige proveedor `deepgram`; una configuración habilitada inválida impide arrancar. Producción y Preview exigen HTTPS, host allowlist y endpoint sin credenciales, query ni fragmento. `mock` está prohibido con `NODE_ENV=production`.

## Seguridad de red y secretos

- Host y path de Deepgram exactos, sin credenciales ni query configurada.
- Bloqueo de localhost, IP privada, loopback y link-local; en entornos publicados se resuelve DNS para detectar rebinding.
- `redirect: "error"`; también se rechazan respuestas 3xx/redirected.
- Timeout con `AbortController` durante fetch y lectura completa del cuerpo.
- Respuesta limitada a 25 MiB, `Content-Type` JSON obligatorio y parseo defensivo.
- API key únicamente en el header `Token`; nunca en URL, logs, persistencia, auditoría o respuesta al navegador.
- La API pública aplica sesión, roles, propiedad, CSRF en mutaciones y revisión optimista.
- La creación se serializa por reunión+grabación para impedir dos trabajos simultáneos en una instancia.

## Errores, reintentos y health

Se reintentan únicamente `429`, `500`, `502`, `503` y `504`, con máximo configurable, backoff acotado y respeto de `Retry-After` hasta 30 segundos. No se reintentan automáticamente errores de autenticación o solicitudes inválidas. Los principales códigos seguros son:

| Código | Acción operativa |
|---|---|
| `TRANSCRIPTION_DEEPGRAM_AUTH_FAILED` | Verificar vigencia/permisos de la clave y rotarla si corresponde. |
| `TRANSCRIPTION_DEEPGRAM_RATE_LIMITED` | Esperar, revisar cuota/crédito y reintentar. |
| `TRANSCRIPTION_DEEPGRAM_TIMEOUT` | Revisar tamaño, conectividad y timeout; reintentar una vez. |
| `TRANSCRIPTION_DEEPGRAM_UNAVAILABLE` | Revisar estado del proveedor/red y reintentar. |
| `TRANSCRIPTION_DEEPGRAM_BAD_REQUEST` | Revisar MP4 y URL temporal. |
| `TRANSCRIPTION_AUDIO_UNSUPPORTED` | Regenerar en un formato compatible. |
| `TRANSCRIPTION_RECORDING_NOT_FOUND/NOT_READY/TOO_LONG/TOO_LARGE` | Corregir la grabación antes de enviar. |
| `TRANSCRIPTION_STORAGE_UNAVAILABLE` | Recuperar acceso a R2; no confundir con objeto inexistente. |
| `PROVIDER_JOB_NOT_FOUND` | El proceso reinició; usar Reintentar. |

`/health` nunca consume minutos ni realiza una transcripción de prueba. Antes del primer trabajo real exitoso, Deepgram aparece configurado pero `degraded`/`not-probed`; después de una transcripción real exitosa aparece disponible en ese proceso. Un fallo real posterior lo devuelve a degradado.

## Operaciones, permisos y auditoría

| Acción | ADMIN | ORGANIZER autorizado | PANELIST permitido | VIEWER |
|---|---:|---:|---:|---:|
| Ver y exportar | Sí | Sí | Sí | No |
| Crear, reintentar o cancelar | Sí | Sí | No | No |
| Editar, renombrar o eliminar | Sí | Sí | No | No |

PANELIST debe ser `trainerId` y tener `allowPanelistTranscriptAccess=true`. Se auditan solicitud, validación fallida, creación, inicio, envío al proveedor, finalización/fallo, cancelación, reintento, edición, renombrado, exportación y eliminación sin URL, texto, clave ni header sensible.

TXT incluye reunión, fecha, idioma, proveedor, timestamps y hablante. JSON entrega el esquema neutral público con palabras. WebVTT y SRT se validan automáticamente: cabecera/numeración, timestamps ordenados, fin posterior al inicio y cues no vacíos.

## Privacidad, retención y coste

La transcripción hereda la sensibilidad del audio. Debe existir aviso, base legal/consentimiento aplicable, acceso mínimo y un responsable de eliminación. `retentionUntil` registra 90 días en Preview, pero todavía no existe un scheduler automático: el borrado autorizado de la aplicación elimina el registro interno, y la política externa de Deepgram/R2 debe verificarse por separado.

El crédito inicial de Preview no se considera permanente. El consumo depende de minutos, modelo y reintentos; configura alertas y revisa la facturación del proveedor sin copiar datos sensibles. La aplicación no calcula ni afirma coste si el proveedor no lo expone.

Las claves deben ser exclusivas por entorno, con alcance mínimo, fecha de expiración y responsable. Para rotar: crear una clave nueva en Deepgram, cambiarla en el gestor secreto de Preview, desplegar manualmente, ejecutar una prueba autorizada, revocar la anterior y revisar auditoría. Nunca copiarla a `.env.example`, Git, capturas o tickets.

## Validación y rollback

Automatizado, sin API real:

```powershell
npm ci
npm test
npm run build:track-processors
git diff --check
```

La prueba real debe usar audio sintético/autorizado de 30–90 segundos con dos voces y consentimiento, creado por Egress Preview y almacenado en R2 Preview. Registrar duración, tamaño, tiempo, segmentos, speakers, confianza y exportaciones sin publicar el contenido ni la URL firmada.

Para deshabilitar de inmediato, fija `TRANSCRIPTION_ENABLED=false` y redeploy del Preview. Los datos existentes quedan intactos. Ante un fallo de versión, vuelve a desplegar el SHA Preview anterior; no borres objetos R2, no reutilices secretos productivos y no cambies `main` ni Producción.
