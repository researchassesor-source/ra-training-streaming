# R.A. Training Streaming

Plataforma web para webinars, clases y sesiones en vivo de R.A. Training. Combina un panel organizador, calendario, administración de credenciales, invitaciones seguras y salas LiveKit con chat, preguntas, mano levantada, grabación, transcripciones revisables y una ventana complementaria Picture-in-Picture.

## Arquitectura

- **Node.js + Express:** APIs, cookies de sesión, roles, validaciones, rate limiting y archivos estáticos.
- **LiveKit:** señalización WebRTC, audio, video, pantalla, permisos de participantes y Egress.
- **Cloudflare R2 / S3 compatible:** usuarios, reuniones, invitaciones, auditoría, archivos de chat y grabaciones.
- **Persistencia local:** JSON atómico bajo `.local-data/` cuando S3 no está configurado.
- **Transcripción desacoplada:** interfaz `TranscriptionProvider`, adaptador dedicado Deepgram para audio pregrabado privado, compatibilidad HTTP heredada y mock seguro para pruebas.
- **Frontend vanilla:** HTML, CSS y JavaScript sin framework; vistas específicas para administración, escritorio, tablet y móvil.

Los tokens de invitación nuevos se guardan como HMAC-SHA-256 con un secreto independiente. Los hashes SHA-256 históricos siguen siendo legibles para no romper invitaciones antiguas. Al abrir `/i/<token>`, el servidor valida expiración, revocación y usos, crea una cookie HttpOnly de sala y redirige a una URL sin token. El navegador nunca decide su rol, sala ni identidad LiveKit.

Consulta [Experiencia de reunión](docs/MEETING_EXPERIENCE.md), [Arquitectura](docs/ARCHITECTURE.md), [Transcripción](docs/TRANSCRIPTION.md), [Seguridad](docs/SECURITY.md), [Preview aislado](docs/PREVIEW_DEPLOYMENT.md) y [Promoción a Producción](docs/PRODUCTION_PROMOTION.md) para el diseño completo.

## Experiencia de reunión

- Controles directos de micrófono, cámara, pantalla, chat, participantes, más opciones y salida; en móvil se priorizan seis acciones y pantalla/participantes pasan al panel **Más**.
- Document Picture-in-Picture con estado, temporizador y controles sincronizados. Si la API no existe o falla al abrir, se conserva un panel arrastrable dentro de la pestaña con la limitación explicada al usuario.
- Pantalla en spotlight, cámara local persistente como miniatura arrastrable o avatar, indicador veraz de audio de pantalla y recuperación del evento `ended`.
- Q&A persistente con edición propia pendiente, votos, respuesta escrita/en vivo, destacado, descarte y orden por votos o fecha.
- Bloqueo reversible de sala, invitaciones creadas dentro de la reunión, moderación con consentimiento, reacciones, toasts agrupados, notificaciones y atajos.
- Temporizador desde conexión confirmada, calidad de red de LiveKit y grabación mostrada únicamente cuando Egress confirma `RECORDING`.

## Requisitos

- Node.js 20 o superior.
- npm.
- LiveKit local o remoto para pruebas de medios.
- R2/S3 y LiveKit Egress solo si se van a probar archivos o grabaciones.

## Instalación

```powershell
npm ci
Copy-Item .env.example .env
npm run livekit:up
npm start
```

Abre `http://localhost:3000`. No reutilices credenciales productivas en `.env` local.

## Variables

| Variable | Propósito |
|---|---|
| `NODE_ENV` | Runtime Node: `development`, `test` o `production`. Preview usa `production`. |
| `APP_ENV`, `APP_DISPLAY_ENV` | Identidad central: `development`, `test`, `preview` o `production`, y su nombre visible. |
| `APP_NAME`, `APP_PUBLIC_URL` | Marca y origen canónico para invitaciones; HTTPS obligatorio fuera de desarrollo/pruebas. |
| `APP_TIME_ZONE`, `APP_TIME_ZONE_LABEL` | Zona IANA y etiqueta humana empleadas en invitaciones. |
| `PREVIEW_ISOLATION_ACK` | Confirmación explícita de recursos aislados; obligatoria solo en Preview. |
| `PORT` | Puerto HTTP. |
| `SESSION_SECRET` | Firma de sesiones; obligatorio y aleatorio en Producción. |
| `INVITATION_HASH_SECRET` | HMAC de invitaciones nuevas; independiente y de 32+ caracteres en Preview/Producción. |
| `SESSION_TTL_HOURS` | Caducidad de sesión administrativa. |
| `ROOM_SESSION_TTL_HOURS` | Caducidad de sesión de reunión. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Administrador bootstrap de recuperación. |
| `COOKIE_SECURE` | Debe ser `true` en Producción. |
| `ALLOW_OPEN_DEV_ROOMS` | Modo abierto explícito, solo fuera de Producción. |
| `INVITATION_TOKEN_TTL_MINUTES` | Caducidad predeterminada de invitación. |
| `LOGIN_RATE_LIMIT_WINDOW`, `LOGIN_RATE_LIMIT_MAX` | Ventana en segundos y máximo de intentos. |
| `CHAT_RATE_LIMIT_MAX` | Mensajes/eventos por minuto y sesión de sala. |
| `MEETING_RATE_LIMIT_MAX` | Creaciones de reunión por hora e IP. |
| `TRANSCRIPTION_RATE_LIMIT_MAX` | Creaciones/regeneraciones de transcripción por hora y usuario. |
| `MAX_JSON_PAYLOAD` | Límite de cuerpos JSON. |
| `MAX_CHAT_MESSAGE_LENGTH` | Longitud máxima de mensaje. |
| `MAX_CHAT_FILE_SIZE` | Tamaño máximo de archivo en bytes. |
| `ALLOWED_CHAT_MIME_TYPES` | MIME permitidos, separados por coma. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` | Conexión LiveKit. |
| `RECORDING_S3_*` | Credenciales, bucket, región y endpoint de R2/S3/Egress. |
| `TRANSCRIPTION_ENABLED` | Habilita explícitamente la integración; `false` por defecto. |
| `TRANSCRIPTION_PROVIDER` | `deepgram` para la integración oficial, `http` para el contrato genérico heredado o `mock` en pruebas. |
| `TRANSCRIPTION_LANGUAGE` | Idioma esperado predeterminado. |
| `TRANSCRIPTION_MAX_DURATION_MINUTES` | Duración máxima aceptada por trabajo. |
| `TRANSCRIPTION_RETENTION_DAYS` | Retención predeterminada del texto. |
| `TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY` | Endpoint y secreto del proveedor HTTP; nunca llegan al cliente. |
| `TRANSCRIPTION_ALLOWED_HOSTS` | Hostnames autorizados del proveedor HTTP, separados por coma; obligatorio fuera de desarrollo/pruebas. |
| `TRANSCRIPTION_DEEPGRAM_*` | Modelo `nova-3` y opciones de diarización, smart format, utterances y paragraphs. |
| `TRANSCRIPTION_REQUEST_TIMEOUT_MS`, `TRANSCRIPTION_RETRY_MAX` | Timeout total y reintentos acotados para 429/5xx. |
| `TRANSCRIPTION_MAX_AUDIO_BYTES` | Límite previo de tamaño de la grabación. |
| `TRANSCRIPTION_PRESIGNED_URL_TTL_SECONDS` | Vigencia de 300–900 segundos para la URL R2 enviada al proveedor. |
| `LOCAL_DATA_DIR` | Sobrescribe la carpeta local; útil para pruebas aisladas. |

Los valores seguros de ejemplo están en [.env.example](.env.example). En Render, configura los secretos exclusivamente en el servicio Preview aislado y completa el checklist antes del despliegue manual.

## Desarrollo local

Sin S3, usuarios, salas, reuniones, invitaciones y auditoría persisten en `.local-data/`. Esta carpeta, `.tools/`, `.local-runtime/` y `.env` están ignoradas por Git. `npm run livekit:up` usa Docker cuando está operativo o el binario local oficial instalado con `npm run livekit:install`. Si LiveKit no responde, el panel informa **no disponible** y no marca reuniones como En vivo.

Comandos del servicio local:

```powershell
npm run livekit:install # solo si Docker no está disponible
npm run livekit:up
npm run livekit:logs
npm run livekit:down
npm run dev             # LiveKit + Node, con apagado coordinado
```

Más detalles: [Desarrollo local](docs/LOCAL_DEVELOPMENT.md).

## Pruebas y build

```powershell
npm test
npm run build:track-processors
node --check server\index.js
git diff --check
```

`npm test` usa `node:test`, servidores HTTP efímeros, almacenamiento temporal y servicios LiveKit/transcripción simulados. Cubre compatibilidad legada, bloqueo, Q&A, controles flotantes, notificaciones, grabación, permisos, exportaciones y sanitización sin tocar Producción.

## Flujo Git

1. Trabaja únicamente en una rama `feature/*`.
2. Confirma `git branch --show-current` y `git status` antes de editar.
3. Ejecuta pruebas y build antes de commit.
4. Revisa `git diff main...HEAD --stat`.
5. Sigue el alcance autorizado de cada entrega; nunca hagas merge o despliegue a Producción sin aprobación humana explícita.

## Render, LiveKit y R2

- Render ejecuta `npm start`; no necesita un paso de compilación para servir la aplicación.
- `npm run build:track-processors` regenera el bundle local de efectos LiveKit antes de release.
- LiveKit debe usar una URL `wss://` en entornos publicados.
- R2 se consume mediante su API S3 compatible; el bucket permanece privado y los archivos se entregan con URL firmada corta.
- LiveKit Egress usa las variables `RECORDING_S3_*` sin exponerlas al frontend.
- La Preview aislada se configura con [`render.preview.yaml`](render.preview.yaml) y [su guía](docs/PREVIEW_DEPLOYMENT.md); no modifica el Blueprint existente.

## Limitaciones conocidas

- Los rate limits son en memoria por proceso. Una instalación con varias instancias debe migrarlos a un almacén compartido.
- La persistencia JSON/S3 es apropiada para el volumen actual, no sustituye transacciones de base de datos en alta concurrencia.
- Document Picture-in-Picture depende del navegador. El fallback con todos los controles vive dentro de la pestaña y no puede mantenerse sobre otras aplicaciones.
- El selector de pantalla completa, ventana o pestaña es nativo del navegador; la aplicación no puede elegir por el usuario.
- El bloqueo de canje se serializa por sala dentro de una instancia. Una topología multinodo necesita un lock o transacción compartida.
- Cámara, micrófono, pantalla, reconexión real y Egress deben validarse en un Preview aislado con LiveKit de prueba.
- La grabación actual usa `RoomComposite`: el audio resultante está mezclado. La identificación exacta por participante requiere Participant/Track Egress o diarización del proveedor y siempre admite corrección manual.
- El proveedor `mock` no inventa texto: solo completa trabajos con fixtures explícitos y está prohibido en Producción.
- Los trabajos Deepgram activos se controlan en memoria. Tras reiniciar el proceso, una consulta los marca fallidos y permite reintentar desde la grabación persistida; una topología multinodo requiere una cola duradera.
- La diarización de Room Composite identifica voces, no identidades LiveKit confiables. Los nombres desconocidos se presentan como “Hablante N” y pueden corregirse de forma auditable.
- La purga automática al llegar `retentionUntil` todavía requiere una tarea operativa programada.
- La integración de Google Calendar queda fuera de esta entrega; el modelo y filtros ya permiten añadir un adaptador.

Antes de publicar, sigue [Checklist de release](docs/RELEASE_CHECKLIST.md).
