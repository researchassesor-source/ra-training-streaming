# Arquitectura

## Componentes

`server/index.js` carga configuración y abre el puerto. `server/app.js` construye Express y acepta servicios LiveKit simulados para pruebas. La lógica persistente está separada:

- `auth.js`: usuarios, roles, scrypt, sesiones y revocación por versión.
- `meetings.js`: modelo, validaciones y ciclo de vida de reuniones.
- `meeting-permissions.js`: modalidades, roles canónicos, capacidades y fuentes LiveKit mínimas.
- `invitations.js`: creación, hash, caducidad, usos y revocación.
- `room-session.js`: identidad, rol y sala firmados en cookie HttpOnly.
- `rooms.js`: registro de salas con política fail-closed.
- `questions.js`: preguntas persistentes, votos por identidad, estados y respuestas moderadas.
- `livekit-status.js`: comprobación real y cacheada de disponibilidad, con timeout y respuesta sin secretos.
- `audit.js`: eventos persistentes con metadata filtrada.
- `local-store.js`: JSON local atómico.
- `s3.js`: cliente S3/R2 privado.

El frontend usa `dashboard.js` para administración y `room-ui.js` para las dos superficies de reunión. `stage.js`, `questions.js`, `meeting-notifications.js`, `connection.js` y `floating-bar.js` aíslan escenario, Q&A, toasts, calidad y controles complementarios. `app-core.js` contiene lógica pura que también se prueba en Node.

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
3. `/i/:token` valida el estado de la reunión y, bajo un lock de admisión por sala, comprueba que la sala no esté bloqueada antes de consumir el uso.
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

### Chat, Q&A, manos y moderación

Los participantes no reciben permiso `canPublishData`. Mensajes y eventos pasan por Express, que valida sesión de sala, CSRF, estado, flags de reunión, pertenencia LiveKit y frecuencia. El servidor los retransmite con `RoomServiceClient.sendData`. Q&A se persiste bajo `questions/` y solo transmite avisos de invalidación; cada navegador vuelve a leer su proyección autorizada. Promoción, degradación, expulsión, bloqueo y solicitudes de medios verifican la identidad objetivo contra participantes reales de LiveKit.

### Estado compartido de reunión

`rooms.js` guarda `locked`, `lockedAt` y `lockedBy`. El bloqueo impide nuevos canjes sin revocar invitaciones, por lo que desbloquear restaura el acceso. Las sesiones ya emitidas pueden renovar su JWT mientras la sala siga activa. El temporizador usa `meeting.startedAt`, escrito en la primera conexión LiveKit confirmada incluso si el dashboard había preparado el estado `LIVE`.

El modelo flotante del cliente es observable y sincroniza medios, pantalla, panel activo, manos, mensajes, preguntas pendientes, grabación, red, bloqueo y tiempo. Abrir o cerrar Document PiP no crea otra `Room`, no mueve tracks y no registra listeners de LiveKit adicionales.

## Modelo de reunión

Campos principales: `id`, `title`, `description`, `room`, `trainerName`, `trainerId`, `scheduledAt`, `durationMinutes`, `endsAt`, `type`, `status`, `capacity`, flags de colaboración y grabación, modos de acceso y timestamps de ciclo de vida, incluido `livekitConfirmedAt`.

Tipos: `WEBINAR`, `SESSION`, `CLASS`.

Estados: `DRAFT` (Borrador), `SCHEDULED` (Programada), `LIVE` (En vivo confirmado), `COMPLETED` (Finalizada), `CANCELLED` (Cancelada), `ARCHIVED` (Archivada). Un clic, una fecha pasada o un preflight abierto nunca producen `LIVE`.

`DELETE` es lógico: fija `deletedAt`, conserva historial y revoca la sala. Restaurar elimina `deletedAt` y vuelve a `SCHEDULED` o `DRAFT`.

## Roles

`ADMIN`, `ORGANIZER`, `PANELIST` y `VIEWER` se conservan como roles de cuenta/compatibilidad. Dentro de una sala se usa `meetingRole`, validado según la modalidad:

| Modalidad | Roles de sala |
|---|---|
| `WEBINAR` | `HOST`, `COHOST`, `MODERATOR`, `PANELIST`, `ATTENDEE` |
| `SESSION` | `HOST`, `COHOST`, `MODERATOR`, `PARTICIPANT` |
| `CLASS` | `TEACHER`, `COHOST`, `MODERATOR`, `STUDENT` |

HOST/TEACHER controlan sala, participantes, invitaciones, grabación y finalización. COHOST administra sala/participantes/invitaciones/finalización, pero no grabación. MODERATOR gestiona chat, Q&A y solicitudes. PANELIST/PARTICIPANT/STUDENT publican según la modalidad y sus overrides por fuente; ATTENDEE empieza sin publicación y puede recibir micrófono temporal. Un ORGANIZER solo administra reuniones creadas por él o donde coincide con `trainerId`; ADMIN puede administrar todas.

La autorización se repite en tres capas: capacidad de ruta Express, `canPublishSources` del token/actualización LiveKit y proyección visual. `rooms.js` persiste `roleOverrides` y `mediaGrants` por identidad. Los valores `false` son denegaciones explícitas, no ausencia de configuración.

## Persistencia

Con R2, cada entidad es un objeto JSON bajo `users/`, `meetings/`, `room-configs/`, `invitations/`, `questions/` o `audit/`. Sin R2, las mismas secciones viven bajo `.local-data/`. Las grabaciones y archivos de chat requieren S3/R2; no se simulan como archivos públicos locales.

Para alto volumen o varias instancias, la evolución recomendada es PostgreSQL para entidades, Redis para rate limits/sesiones y una cola para trabajos de grabación.

## Compatibilidad de datos históricos

Toda lectura de reuniones pasa por `normalizeStoredMeeting` en `meetings.js`, tanto con almacenamiento local como con R2. La normalización es no destructiva: completa en memoria títulos, sala, entrenador, duración, capacidad, `meetingType`, política de roles, permisos y timestamps ausentes, pero no reescribe el objeto histórico. `rolePolicyVersion=1` identifica el fallback compatible; las reuniones nuevas usan versión 2. Una migración persistente futura deberá ser explícita, versionada y respaldada.

Las invitaciones nuevas con `meetingRole` usan la matriz canónica. Un cliente histórico que solo envía `role=PANELIST|VIEWER` conserva `legacyAccess` y la semántica anterior. Los hashes HMAC nuevos y SHA-256 heredados se resuelven sin almacenar el token en claro.

Las fechas inválidas se representan como ausencia de fecha y nunca como `Invalid Date`. El calendario agrupa por fecha local para evitar que una reunión cambie de día por conversión UTC; por ejemplo, una reunión local del 30 de julio permanece en el 30 de julio.

## Estado de grabación

El cliente no infiere que una sala está grabando. Consulta `/api/recording/status` al conectar y reconectar, y solo muestra el indicador rojo cuando el servidor devuelve `state=RECORDING`, `active=true` y un `egressId`. Estados de inicio, finalización, fallo, desconocidos o errores de red son no activos. El control usa una máquina de estados para impedir dobles clics y presentar errores sin producir un falso positivo visual.

Al iniciar Egress se guarda, si R2 está disponible, un objeto `.metadata.json` junto al archivo con sala, reunión, participantes e identidades de pista observadas. No contiene tokens ni credenciales. Esta metadata mejora el enlace posterior entre voces y participantes sin prometer diarización perfecta.

## Transcripciones

- `transcription-provider.js` define la interfaz común y conserva las implementaciones HTTP heredada y mock.
- `transcription-providers/deepgram.js` implementa el contrato oficial de audio pregrabado, autenticación `Token`, normalización de diarización y cancelación real.
- `transcription-network.js` centraliza URL allowlist, bloqueo de redes privadas y validación DNS en entornos publicados.
- `transcriptions.js` gestiona esquema v2, compatibilidad no destructiva, estados, persistencia, revisión optimista, hablantes, palabras, retención y exportaciones validadas.
- `app.js` aplica autenticación, roles, propiedad de la reunión, CSRF y rate limit antes de delegar al proveedor.
- `transcription.html` y `transcription.js` ofrecen consulta, búsqueda, edición, regeneración, cancelación, eliminación y exportación.

Estados actuales: `PENDING`, `VALIDATING`, `FETCHING_RECORDING`, `SUBMITTING`, `PROCESSING`, `COMPLETED`, `FAILED` y `CANCELLED`; se conservan los estados heredados para datos antiguos. Los porcentajes describen etapas, no reconocimiento parcial. Las respuestas públicas nunca incluyen `providerJobId`, URL firmada ni claves. ADMIN y el ORGANIZER autorizado administran; el PANELIST asignado como `trainerId` solo puede consultar y exportar cuando la reunión lo permite; VIEWER no tiene acceso.

Deepgram recibe por JSON una URL R2 presignada de 5–15 minutos. El bucket permanece privado; esa URL no se persiste ni se expone por la API de transcripción. La respuesta se reduce a un modelo neutral con segmentos, palabras, speaker y metadata allowlist. La creación se serializa por reunión+grabación y el proveedor usa timeout, tamaño máximo, redirecciones bloqueadas y reintentos de 429/5xx. El modo `mock` solo produce contenido si la prueba inyecta un fixture explícito y está prohibido en Producción. La guía operativa completa está en [TRANSCRIPTION.md](TRANSCRIPTION.md).

Los controladores de jobs Deepgram viven en memoria; la transcripción final sí se persiste. Un reinicio convierte un job activo sin controlador en fallo reintentable. El escalado multinodo necesita una cola duradera antes de Producción.
