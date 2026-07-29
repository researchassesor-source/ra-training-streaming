# Arquitectura

## Componentes

`server/index.js` carga configuración y abre el puerto. `server/app.js` construye Express y acepta servicios LiveKit simulados para pruebas. La lógica persistente está separada:

- `auth.js`: usuarios, roles, scrypt, sesiones y revocación por versión.
- `meetings.js`: modelo, validaciones y ciclo de vida de reuniones.
- `invitations.js`: creación, hash, caducidad, usos y revocación.
- `room-session.js`: identidad, rol y sala firmados en cookie HttpOnly.
- `rooms.js`: registro de salas con política fail-closed.
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

### Chat, manos y moderación

Los participantes no reciben permiso `canPublishData`. Mensajes y eventos pasan por Express, que valida sesión de sala, CSRF, estado, flags de reunión, pertenencia LiveKit y frecuencia. El servidor los retransmite con `RoomServiceClient.sendData`. Promoción, degradación y expulsión usan la identidad del actor firmada y nunca `panelistIdentity` del JSON.

## Modelo de reunión

Campos principales: `id`, `title`, `description`, `room`, `trainerName`, `trainerId`, `scheduledAt`, `durationMinutes`, `endsAt`, `type`, `status`, `capacity`, flags de colaboración y grabación, modos de acceso y timestamps de ciclo de vida.

Tipos: `WEBINAR`, `SESSION`, `CLASS`.

Estados: `DRAFT`, `SCHEDULED`, `LIVE`, `COMPLETED`, `CANCELLED`, `ARCHIVED`.

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
