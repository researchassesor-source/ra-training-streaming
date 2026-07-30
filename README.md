# R.A. Training Streaming

Plataforma web para webinars, clases y sesiones en vivo de Research Assessor & Training. Combina un panel organizador, calendario, administración de credenciales, invitaciones seguras y salas LiveKit con chat, preguntas, mano levantada, grabación, transcripciones revisables y una ventana complementaria Picture-in-Picture.

## Arquitectura

- **Node.js + Express:** APIs, cookies de sesión, roles, validaciones, rate limiting y archivos estáticos.
- **LiveKit:** señalización WebRTC, audio, video, pantalla, permisos de participantes y Egress.
- **Cloudflare R2 / S3 compatible:** usuarios, reuniones, invitaciones, auditoría, archivos de chat y grabaciones.
- **Persistencia local:** JSON atómico bajo `.local-data/` cuando S3 no está configurado.
- **Transcripción desacoplada:** interfaz `TranscriptionProvider`, proveedor mock seguro para pruebas y adaptador HTTP configurable.
- **Frontend vanilla:** HTML, CSS y JavaScript sin framework; vistas específicas para administración, escritorio, tablet y móvil.

Los secretos de invitación se guardan como SHA-256. Al abrir `/i/<token>`, el servidor valida expiración, revocación y usos, crea una cookie HttpOnly de sala y redirige a una URL sin token. El navegador nunca decide su rol, sala ni identidad LiveKit.

Consulta [Arquitectura](docs/ARCHITECTURE.md), [Transcripción](docs/TRANSCRIPTION.md) y [Seguridad](docs/SECURITY.md) para el diseño completo.

## Requisitos

- Node.js 20 o superior.
- npm.
- LiveKit local o remoto para pruebas de medios.
- R2/S3 y LiveKit Egress solo si se van a probar archivos o grabaciones.

## Instalación

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

Abre `http://localhost:3000`. No reutilices credenciales productivas en `.env` local.

## Variables

| Variable | Propósito |
|---|---|
| `NODE_ENV` | `development`, `test` o `production`. |
| `PORT` | Puerto HTTP. |
| `SESSION_SECRET` | Firma de sesiones; obligatorio y aleatorio en Producción. |
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
| `TRANSCRIPTION_PROVIDER` | `mock` en pruebas o `http` para un adaptador externo. |
| `TRANSCRIPTION_LANGUAGE` | Idioma esperado predeterminado. |
| `TRANSCRIPTION_MAX_DURATION_MINUTES` | Duración máxima aceptada por trabajo. |
| `TRANSCRIPTION_RETENTION_DAYS` | Retención predeterminada del texto. |
| `TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY` | Endpoint y secreto del proveedor HTTP; nunca llegan al cliente. |
| `LOCAL_DATA_DIR` | Sobrescribe la carpeta local; útil para pruebas aisladas. |

Los valores seguros de ejemplo están en [.env.example](.env.example). No configures todavía estas variables en Render sin completar el checklist de release.

## Desarrollo local

Sin S3, usuarios, salas, reuniones, invitaciones y auditoría persisten en `.local-data/`. Esta carpeta y `.env` están ignoradas por Git. Sin LiveKit local, el panel y el canje de invitaciones funcionan; la conexión de medios mostrará el error esperado.

Más detalles: [Desarrollo local](docs/LOCAL_DEVELOPMENT.md).

## Pruebas y build

```powershell
npm test
npm run build:track-processors
node --check server\index.js
git diff --check
```

`npm test` usa `node:test`, servidores HTTP efímeros, almacenamiento temporal y servicios LiveKit/transcripción simulados. Cubre compatibilidad legada, grabación, permisos, exportaciones y sanitización sin tocar Producción.

## Flujo Git

1. Trabaja únicamente en una rama `feature/*`.
2. Confirma `git branch --show-current` y `git status` antes de editar.
3. Ejecuta pruebas y build antes de commit.
4. Revisa `git diff main...HEAD --stat`.
5. Solicita aprobación humana antes de push, Pull Request, Preview, merge o despliegue.

## Render, LiveKit y R2

- Render ejecuta `npm start`; no necesita un paso de compilación para servir la aplicación.
- `npm run build:track-processors` regenera el bundle local de efectos LiveKit antes de release.
- LiveKit debe usar una URL `wss://` en entornos publicados.
- R2 se consume mediante su API S3 compatible; el bucket permanece privado y los archivos se entregan con URL firmada corta.
- LiveKit Egress usa las variables `RECORDING_S3_*` sin exponerlas al frontend.

## Limitaciones conocidas

- Los rate limits son en memoria por proceso. Una instalación con varias instancias debe migrarlos a un almacén compartido.
- La persistencia JSON/S3 es apropiada para el volumen actual, no sustituye transacciones de base de datos en alta concurrencia.
- Document Picture-in-Picture depende del navegador; video PiP es el fallback y no ofrece los mismos controles.
- Cámara, micrófono, pantalla, reconexión real y Egress deben validarse en un Preview aislado con LiveKit de prueba.
- La grabación actual usa `RoomComposite`: el audio resultante está mezclado. La identificación exacta por participante requiere Participant/Track Egress o diarización del proveedor y siempre admite corrección manual.
- El proveedor `mock` no inventa texto: solo completa trabajos con fixtures explícitos y está prohibido en Producción.
- La integración de Google Calendar queda fuera de esta entrega; el modelo y filtros ya permiten añadir un adaptador.

Antes de publicar, sigue [Checklist de release](docs/RELEASE_CHECKLIST.md).
