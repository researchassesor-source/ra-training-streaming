# Arquitectura

## Componentes

`server/index.js` carga configuración y abre el puerto. `server/app.js` construye Express y acepta servicios LiveKit simulados para pruebas. La lógica persistente está separada:

- `auth.js`: usuarios, roles, scrypt, sesiones y revocación por versión.
- `meetings.js`: modelo, validaciones y ciclo de vida de reuniones.
- `invitations.js`: creación, hash, caducidad, usos y revocación.
- `room-session.js`: identidad, rol y sala firmados en cookie HttpOnly.
- `rooms.js`: registro de salas con política fail-closed.
- `livekit-status.js`: comprobación real y cacheada de disponibilidad, con timeout y respuesta sin secretos.
- `audit.js`: eventos persistentes con metadata filtrada.
- `local-store.js`: JSON local atómico.
- `s3.js`: cliente S3/R2 privado.

El frontend usa `dashboard.js` para administración y `room-ui.js` para las dos superficies de reunión. `app-core.js` contiene lógica pura que también se prueba en Node.

## Flujos de confianza

### Sesión administrativa

1. `POST /api/auth/login` valida credenciales y rate limit.
2. El servidor emite `rat_session` HttpOnly, SameSite=Lax y Secure en Producción.
3. `GET /api/auth/me` devuelve usuario y token anti-CSRF.
4. Cada mutación valida cookie, rol y `X-CSRF-Token`.
5. Desactivar, restablecer contraseña o revocar sesiones incrementa `sessionVersion`; los tokens anteriores dejan de validar.

### Invitación y sala

1. ADMIN/ORGANIZER crea una invitación ligada a `meetingId`, `room`, rol, expiración y límite de usos.
2. Solo se devuelve una vez un secreto aleatorio de 256 bits. Persistencia conserva únicamente SHA-256.
3. `/i/:token` valida y consume el uso.
4. El servidor crea `rat_room_session` con sala, identidad aleatoria y rol firmados.
5. Responde `303` a `presenter.html` o `viewer.html`; el secreto desaparece de URL e historial inmediato.
6. `/api/token` ignora parámetros de cliente y crea el JWT LiveKit desde la sesión de sala.

### Inicio veraz de reunión

1. `POST /api/meetings/:room/launch` registra `ROOM_OPEN_ATTEMPT` y comprueba la API de LiveKit.
2. Si LiveKit no responde, devuelve `LIVEKIT_UNAVAILABLE`, registra el fallo y conserva DRAFT/SCHEDULED.
3. Si responde, crea la sesión de sala y abre el preflight, todavía sin cambiar el estado.
4. El cliente conecta con el JWT y llama `POST /api/room/connection`.
5. El servidor consulta los participantes reales de LiveKit y solo entonces escribe `LIVE`, `startedAt`, `livekitConfirmedAt` y `ROOM_CONNECTED`.
6. Repetir la confirmación es idempotente y no duplica auditoría. Finalizar escribe `ROOM_ENDED`.

### Chat, manos y moderación

Los participantes no reciben permiso `canPublishData`. Mensajes y eventos pasan por Express, que valida sesión de sala, CSRF, estado, flags de reunión, pertenencia LiveKit y frecuencia. El servidor los retransmite con `RoomServiceClient.sendData`. Promoción, degradación y expulsión usan la identidad del actor firmada y nunca `panelistIdentity` del JSON.

## Modelo de reunión

Campos principales: `id`, `title`, `description`, `room`, `trainerName`, `trainerId`, `scheduledAt`, `durationMinutes`, `endsAt`, `type`, `status`, `capacity`, flags de colaboración y grabación, modos de acceso y timestamps de ciclo de vida, incluido `livekitConfirmedAt`.

Tipos: `WEBINAR`, `SESSION`, `CLASS`.

Estados: `DRAFT` (Borrador), `SCHEDULED` (Programada), `LIVE` (En vivo confirmado), `COMPLETED` (Finalizada), `CANCELLED` (Cancelada), `ARCHIVED` (Archivada). Un clic, una fecha pasada o un preflight abierto nunca producen `LIVE`.

`DELETE` es lógico: fija `deletedAt`, conserva historial y revoca la sala. Restaurar elimina `deletedAt` y vuelve a `SCHEDULED` o `DRAFT`.

## Roles

| Capacidad | ADMIN | ORGANIZER | PANELIST | VIEWER |
|---|---:|---:|---:|---:|
| Usuarios y auditoría | Sí | No | No | No |
| Reuniones propias | Todas | Sí | No | No |
| Iniciar/finalizar reunión | Sí | Sí | No | No |
| Grabar | Sí | Sí | No | No |
| Cámara/mic/pantalla | Sí | Sí | Sí | Solo al recibir palabra |
| Moderar mano | Sí | Sí | Sí | No |
| Chat/preguntas/reacciones | Según reunión | Según reunión | Según reunión | Según reunión |

Un ORGANIZER solo administra reuniones creadas por él o donde coincide con `trainerId`. ADMIN puede administrar todas.

## Persistencia

Con R2, cada entidad es un objeto JSON bajo `users/`, `meetings/`, `room-configs/`, `invitations/` o `audit/`. Sin R2, las mismas secciones viven bajo `.local-data/`. Las grabaciones y archivos de chat requieren S3/R2; no se simulan como archivos públicos locales.

Para alto volumen o varias instancias, la evolución recomendada es PostgreSQL para entidades, Redis para rate limits/sesiones y una cola para trabajos de grabación.

## Compatibilidad de datos históricos

Toda lectura de reuniones pasa por `normalizeStoredMeeting` en `meetings.js`, tanto con almacenamiento local como con R2. La normalización es no destructiva: completa en memoria títulos, sala, entrenador, duración, capacidad, tipo, estado, permisos y timestamps ausentes, pero no reescribe el objeto histórico. Una migración persistente futura deberá ser explícita, versionada y respaldada.

Las fechas inválidas se representan como ausencia de fecha y nunca como `Invalid Date`. El calendario agrupa por fecha local para evitar que una reunión cambie de día por conversión UTC; por ejemplo, una reunión local del 30 de julio permanece en el 30 de julio.

## Estado de grabación

El cliente no infiere que una sala está grabando. Consulta `/api/recording/status` al conectar y reconectar, y solo muestra el indicador rojo cuando el servidor devuelve `state=RECORDING`, `active=true` y un `egressId`. Estados de inicio, finalización, fallo, desconocidos o errores de red son no activos. El control usa una máquina de estados para impedir dobles clics y presentar errores sin producir un falso positivo visual.

Al iniciar Egress se guarda, si R2 está disponible, un objeto `.metadata.json` junto al archivo con sala, reunión, participantes e identidades de pista observadas. No contiene tokens ni credenciales. Esta metadata mejora el enlace posterior entre voces y participantes sin prometer diarización perfecta.

## Transcripciones

- `transcription-provider.js` define la interfaz de proveedor y las implementaciones HTTP y mock.
- `transcriptions.js` gestiona estados, persistencia, revisión optimista, identidad de participantes, retención y exportaciones.
- `app.js` aplica autenticación, roles, propiedad de la reunión, CSRF y rate limit antes de delegar al proveedor.
- `transcription.html` y `transcription.js` ofrecen consulta, búsqueda, edición, regeneración, cancelación, eliminación y exportación.

Estados expuestos por la experiencia: `NOT_AVAILABLE`, `READY`, `QUEUED`, `PROCESSING_AUDIO`, `IDENTIFYING_PARTICIPANTS`, `GENERATING_TRANSCRIPT`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, `FAILED` y `CANCELLED`; desde `QUEUED` se persiste el trabajo real. Las respuestas públicas nunca incluyen `providerJobId` ni claves del proveedor. ADMIN y el ORGANIZER autorizado administran; el PANELIST asignado como `trainerId` solo puede consultar y exportar cuando la reunión lo permite; VIEWER no tiene acceso.

El proveedor HTTP recibe una URL firmada de corta duración creada por el servidor. El modo `mock` solo produce contenido si la prueba inyecta un fixture explícito y está prohibido en Producción. La guía operativa completa está en [TRANSCRIPTION.md](TRANSCRIPTION.md).
