# Seguridad

## Controles implementados

- Cookies HttpOnly, SameSite=Lax, caducidad controlada y `Secure` obligatorio en Producción.
- Token anti-CSRF para mutaciones administrativas y de sala.
- Contraseñas con `crypto.scrypt`, sal aleatoria y comparación timing-safe.
- Roles `ADMIN`, `ORGANIZER`, `PANELIST`, `VIEWER` evaluados en servidor.
- Sesiones revocables mediante `sessionVersion`; desactivar o cambiar contraseña invalida accesos.
- Protección del bootstrap: no se lista hash, no se edita ni elimina desde la aplicación.
- Invitaciones de 256 bits; almacenamiento solo del hash, expiración, revocación y máximo de usos.
- Redirección después del canje y `Referrer-Policy: no-referrer` para retirar el secreto de URL.
- Identidad, rol y sala LiveKit derivados exclusivamente de sesión firmada.
- Salas fail-closed. `ALLOW_OPEN_DEV_ROOMS` nunca funciona con `NODE_ENV=production`.
- JSON limitado, validación de tipos/longitudes, slugs únicos y errores internos no expuestos.
- Rate limiting para login, reuniones y chat/eventos.
- Mensajes y eventos retransmitidos por servidor; `canPublishData=false` impide saltar el rate limit mediante SDK cliente.
- Archivos ligados a sesión de sala, MIME allowlist, tamaño máximo, nombre de objeto aleatorio y URL firmada.
- Grabación restringida a ADMIN/ORGANIZER presentes en una reunión `LIVE` que permite grabar.
- Auditoría con IP acotada, user-agent limitado y eliminación de claves con apariencia de secreto.
- Reuniones con eliminación lógica; la sala se revoca al cancelar, archivar, completar o eliminar.

## Políticas de roles

ADMIN tiene control global. ORGANIZER solo administra reuniones propias o asignadas y no puede crear ADMIN. PANELIST controla medios y modera manos dentro de su sesión de sala, pero no usuarios ni grabaciones. VIEWER recibe publicación de audio/video solo cuando un moderador concede la palabra.

## Encabezados

Express emite `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` y una política de opener compatible con PiP. No se añadió una CSP estricta en esta fase porque LiveKit WebSocket, medios y las páginas heredadas requieren una migración coordinada; debe incorporarse con nonces y una allowlist del host LiveKit en una entrega posterior.

## Limitaciones y evolución

- Rate limit en memoria: usar Redis cuando existan múltiples procesos o instancias.
- S3 no ofrece las mismas garantías transaccionales que una base de datos. Para concurrencia elevada, migrar usuarios, reuniones, invitaciones y auditoría a PostgreSQL.
- El consumo de invitación se serializa de forma efectiva dentro de una instancia; una topología con varias instancias requiere operación atómica compartida.
- Los links firmados de grabación tienen una hora de vigencia; quien reciba el link puede usarlo durante ese periodo.
- La metadata LiveKit visible al cliente solo contiene el rol y no debe incluir información sensible.

## Respuesta a incidentes

1. Revocar sesiones del usuario afectado o desactivarlo.
2. Revocar invitaciones activas de la reunión.
3. Cancelar/archivar la reunión para revocar la sala.
4. Rotar `SESSION_SECRET` para invalidar globalmente sesiones, incluyendo bootstrap.
5. Rotar credenciales LiveKit/R2 desde sus proveedores si hubo exposición; no registrarlas en Git.
6. Revisar auditoría e logs de Render sin copiar secretos a tickets.

## Reporte

No abras un issue público con credenciales, tokens o datos de participantes. Entrega el reporte por el canal privado definido por R.A. Training.

## Grabaciones y transcripciones

- El indicador de grabación depende del estado Egress confirmado por servidor; fallos, estados desconocidos y desconexiones no se muestran como grabación activa.
- La metadata de grabación admite identidades y pistas, pero excluye secretos y se filtra antes de persistirla.
- Las claves del proveedor de transcripción permanecen exclusivamente en servidor. Ninguna respuesta pública incluye la clave ni el identificador privado del trabajo.
- Crear, regenerar, cancelar, editar y eliminar exige CSRF, rol y propiedad de reunión. La consulta de PANELIST es optativa por reunión; VIEWER queda denegado.
- El texto se sanitiza al guardar y al renderizar. La edición usa revisión optimista para evitar sobreescrituras silenciosas.
- Las URL de audio enviadas al proveedor son firmadas y temporales. La transcripción hereda la sensibilidad de la grabación y no debe copiarse a canales no autorizados.
- `retentionUntil` registra la fecha objetivo de retención. La eliminación automática del objeto y del trabajo remoto requiere una tarea operativa programada; hasta implementarla, el borrado manual autorizado y auditable es obligatorio.

La diarización depende de la fuente. Una grabación compuesta puede mezclar voces; si la metadata no permite identificar una pista, la interfaz muestra “Participante sin identificar N” en vez de atribuirla por conjetura. Para mayor precisión, conviene grabar pistas o participantes por separado y correlacionar sus identidades LiveKit.
