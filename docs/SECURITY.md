# Seguridad

## Controles implementados

- Cookies HttpOnly, SameSite=Lax, caducidad controlada y `Secure` obligatorio en Producción.
- Token anti-CSRF para mutaciones administrativas y de sala.
- Contraseñas con `crypto.scrypt`, sal aleatoria y comparación timing-safe.
- Roles de cuenta `ADMIN`, `ORGANIZER`, `PANELIST`, `VIEWER` y roles canónicos por modalidad evaluados en servidor.
- Sesiones revocables mediante `sessionVersion`; desactivar o cambiar contraseña invalida accesos.
- Protección del bootstrap: no se lista hash, no se edita ni elimina desde la aplicación.
- Invitaciones de 256 bits; almacenamiento solo del hash, expiración, revocación y máximo de usos.
- Redirección después del canje y `Referrer-Policy: no-referrer` para retirar el secreto de URL.
- Identidad, rol y sala LiveKit derivados exclusivamente de sesión firmada.
- Salas fail-closed. `ALLOW_OPEN_DEV_ROOMS` nunca funciona con `NODE_ENV=production`.
- JSON limitado, validación de tipos/longitudes, slugs únicos y errores internos no expuestos.
- Rate limiting para login, reuniones, chat/preguntas y acciones interactivas de moderación.
- Mensajes y eventos retransmitidos por servidor; `canPublishData=false` impide saltar el rate limit mediante SDK cliente.
- Archivos ligados a sesión de sala, MIME allowlist, tamaño máximo, nombre de objeto aleatorio y URL firmada.
- Grabación restringida a ADMIN/ORGANIZER presentes en una reunión `LIVE` que permite grabar.
- Auditoría con IP acotada, user-agent limitado y eliminación de claves con apariencia de secreto.
- Reuniones con eliminación lógica; la sala se revoca al cancelar, archivar, completar o eliminar.
- Bloqueo reversible validado antes del consumo de invitación; participantes existentes continúan sin convertir el bloqueo en revocación.
- Q&A con autor e identidad derivados de sesión, edición propia solo mientras está pendiente y moderación autorizada en servidor.
- Solicitar micrófono o apagar cámara se comunica al participante; nunca se intenta encender remotamente un dispositivo sin consentimiento.
- Cada acceso a sala emite una cookie HttpOnly firmada con nombre único y un selector opaco por pestaña. `X-Room-Session-ID` solo selecciona la cookie; no reemplaza firma, expiración, rol, sala ni CSRF.
- Los errores de sesión y CSRF distinguen ausencia, expiración e incompatibilidad de token sin incluir cookies, firmas ni valores CSRF en respuestas o logs.
- Conceder palabra persiste una autorización de publicación limitada a esa identidad y sala para que sobreviva a una reconexión; quitar palabra, expulsar o bloquear la revoca.
- Los JWT y actualizaciones LiveKit usan `canPublishSources` mínimas; cambiar rol o conceder/retirar cámara, micrófono o pantalla se revalida, persiste y audita.
- Deepgram usa exclusivamente `https://api.deepgram.com/v1/listen`, hostname/path exactos y `Authorization: Token`; configuración con credenciales en URL, query o fragmento se rechaza.
- La resolución DNS del endpoint se valida en Preview/Producción contra loopback, privadas y link-local; `redirect: error` evita saltos a otro destino.
- La URL R2 para Deepgram caduca entre 300 y 900 segundos, no se persiste ni se devuelve en la API de transcripción.
- Las respuestas Deepgram requieren JSON, tienen límite de 25 MiB y timeout que cubre conexión y body; la cancelación aborta solicitudes y backoff.

## Políticas de roles

ADMIN tiene control global. ORGANIZER solo administra reuniones propias o asignadas y no puede crear ADMIN. En sala, HOST/TEACHER y COHOST poseen capacidades administrativas explícitas; MODERATOR limita su alcance a chat/Q&A/solicitudes; PANELIST, PARTICIPANT y STUDENT no reciben acciones destructivas; ATTENDEE empieza sin fuentes de publicación. Un cambio de parámetros del navegador no puede elevar el rol porque invitación, sesión y acción se validan en el servidor.

## Encabezados

Express emite `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` y una política de opener compatible con PiP. No se añadió una CSP estricta en esta fase porque LiveKit WebSocket, medios y las páginas heredadas requieren una migración coordinada; debe incorporarse con nonces y una allowlist del host LiveKit en una entrega posterior.

## Limitaciones y evolución

- Rate limit en memoria: usar Redis cuando existan múltiples procesos o instancias.
- S3 no ofrece las mismas garantías transaccionales que una base de datos. Para concurrencia elevada, migrar usuarios, reuniones, invitaciones y auditoría a PostgreSQL.
- El consumo de invitación y el cambio de bloqueo se serializan por sala dentro de una instancia; una topología con varias instancias requiere operación atómica compartida.
- Los links firmados de grabación tienen una hora de vigencia; quien reciba el link puede usarlo durante ese periodo.
- La URL firmada interna usada para transcribir tiene una vigencia independiente de 5–15 minutos; el navegador no la recibe desde el detalle de transcripción.
- La metadata LiveKit contiene rol, hora de entrada e identificador interno de invitación para moderación. No contiene el token ni otros secretos.
- Los controladores de trabajos Deepgram activos son memoria local del proceso. Un reinicio fuerza un fallo reintentable; despliegues multinodo requieren cola compartida.

## Auditoría de reunión

Se registran entrada, salida explícita, reconexión, pantalla iniciada/detenida, micrófono silenciado, petición/aceptación/rechazo/fallo de micrófono, concesión/revocación de palabra, cambio de rol, concesión/revocación de fuentes, rechazo de mano, promoción, degradación, expulsión/bloqueo, bloqueo de sala, preguntas creadas/respondidas/descartadas, grabación y finalización. No se guardan textos completos del chat ni de las preguntas en auditoría. Una salida abrupta sin petición HTTP depende de futura integración de webhooks LiveKit para quedar registrada de forma autoritativa.

## Respuesta a incidentes

1. Revocar sesiones del usuario afectado o desactivarlo.
2. Revocar invitaciones activas de la reunión.
3. Cancelar/archivar la reunión para revocar la sala.
4. Rotar `SESSION_SECRET` para invalidar globalmente sesiones, incluyendo bootstrap.
5. Rotar credenciales LiveKit/R2/Deepgram desde sus proveedores si hubo exposición; actualizar primero el gestor seguro, validar y revocar la clave anterior. No registrarlas en Git.
6. Revisar auditoría e logs de Render sin copiar secretos a tickets.

## Reporte

No abras un issue público con credenciales, tokens o datos de participantes. Entrega el reporte por el canal privado definido por R.A. Training.

## Grabaciones y transcripciones

- El indicador de grabación depende del estado Egress confirmado por servidor; fallos, estados desconocidos y desconexiones no se muestran como grabación activa.
- La metadata de grabación admite identidades y pistas, pero excluye secretos y se filtra antes de persistirla.
- Las claves del proveedor de transcripción permanecen exclusivamente en servidor. Ninguna respuesta pública incluye la clave, el identificador privado del trabajo ni la URL presignada usada por Deepgram.
- Crear, regenerar, cancelar, editar y eliminar exige CSRF, rol y propiedad de reunión. La consulta de PANELIST es optativa por reunión; VIEWER queda denegado.
- El texto se sanitiza al guardar y al renderizar. La edición usa revisión optimista para evitar sobreescrituras silenciosas.
- Las URL de audio enviadas al proveedor son firmadas y temporales. La transcripción hereda la sensibilidad de la grabación y no debe copiarse a canales no autorizados.
- `retentionUntil` registra la fecha objetivo de retención. La eliminación automática del objeto y del trabajo remoto requiere una tarea operativa programada; hasta implementarla, el borrado manual autorizado y auditable es obligatorio.

La diarización depende de la fuente. Una grabación compuesta puede mezclar voces; si la metadata no permite identificar una pista, la interfaz muestra “Hablante N” en vez de atribuirla por conjetura. Para mayor precisión, conviene grabar pistas o participantes por separado y correlacionar sus identidades LiveKit.
