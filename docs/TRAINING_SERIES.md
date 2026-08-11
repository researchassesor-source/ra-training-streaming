# Capacitaciones de varias sesiones

Una capacitación (`TrainingSeries`) agrupa reuniones existentes sin reemplazarlas. Cada sesión conserva su propio `Meeting`, room LiveKit, estado, chat, Q&A, grabación, transcripción, auditoría y asistencia. Las reuniones históricas sin `seriesId` siguen siendo independientes.

## Modelo y resolución

La serie almacena título, descripción, modalidad, capacitador, zona horaria, ventana de preparación y estado. Sus reuniones incorporan opcionalmente `seriesId` y `sessionNumber`.

`resolveSeriesSession()` es la fuente autoritativa: prioriza una sesión `LIVE`; en su ausencia elige la siguiente `SCHEDULED` por fecha, omite sesiones canceladas, archivadas o eliminadas y declara el ciclo completado cuando no queda una sesión válida. Reprogramar una reunión cambia su fecha, no el acceso de la serie.

La ventana `earlyAccessMinutes` vale 120 por defecto:

- antes de la ventana: se informa la próxima fecha;
- dentro de la ventana: se habilita preparación local de dispositivos sin conexión LiveKit;
- cuando el backend confirma `LIVE`: aparece **Entrar ahora**;
- después de cada sesión: el mismo acceso resuelve la próxima;
- al terminar todas: se muestra capacitación finalizada.

## Acceso estable y seguridad

El dashboard crea accesos individuales `/s/<id>.<firma>` para el rol participante de cada modalidad. El registro persistente conserva únicamente SHA-256 del token; la firma HMAC se valida con comparación segura. El token se retira de la URL tras el canje y se sustituye por una cookie firmada `HttpOnly`, `SameSite=Lax` y `Secure` cuando corresponde.

El servidor decide serie, reunión, room, identidad y rol. La entrada crea una `RoomSession` nueva por sesión, aplica CSRF y emite grants LiveKit server-side. No existen accesos estables privilegiados para HOST, TEACHER, COHOST o MODERATOR. Revocar una persona no modifica los accesos de otras personas.

El enlace se recupera de forma determinista al volver a abrir **Compartir acceso**. Regenerarlo es una acción explícita que revoca el anterior. Las plantillas de invitación y recordatorios de 2 horas y 15 minutos usan exactamente el mismo enlace. WhatsApp abre el compositor del usuario; no afirma ni registra un envío automático.

## Sala de espera

`public/series-access.html` consulta `/api/series-access` cada 15 segundos. No importa el cliente LiveKit ni solicita `/api/token`. Cámara y micrófono solo se solicitan al pulsar la prueba local, y **Entrar ahora** realiza la transición explícita a la sala una vez que la reunión está `LIVE` y el aviso de privacidad fue aceptado.

## Solicitudes de palabra y asistencia

Las solicitudes se almacenan por room con estados `PENDING`, `GRANTED`, `REJECTED` y `REVOKED`. El cliente sincroniza la cola desde servidor al conectar, reconectar o abrir participantes. Dar palabra añade únicamente el grant temporal de micrófono; no enciende el dispositivo ni concede cámara, pantalla o privilegios. Un asistente con grant efectivo puede ser hablante activo o fijado; al revocar vuelve al comportamiento de oyente.

La asistencia solo se actualiza tras una conexión LiveKit confirmada mediante los eventos de sala ya existentes. Por participante y sesión registra primera entrada, última salida, reconexiones y duración acumulada. El dashboard no muestra presencia sin evidencia.

## Persistencia y operación

Los módulos `training-series`, `series-accesses`, `speaker-requests` y `attendance` reutilizan la abstracción local JSON/S3 del proyecto. No hay migración destructiva. En una topología multinodo de alto volumen, los locks en memoria y los archivos JSON deben reemplazarse por transacciones y locking compartido.

Endpoints principales:

- administración: `GET/POST /api/series`, `GET/PATCH /api/series/:id`;
- accesos: `GET/POST /api/series/:id/accesses`, revocación y regeneración explícitas;
- asistencia: `GET /api/series/:id/attendance`;
- participante: `/s/:token`, `GET /api/series-access`, perfil, consentimiento y entrada;
- sala: `GET /api/room/speaker-requests` y eventos/moderación existentes.

La validación automatizada cubre series de tres sesiones, rooms únicos, avance y finalización con el mismo token, reprogramación, ventana de espera, bloqueo antes de `LIVE`, revocación individual, persistencia de manos, asistencia, permisos por modalidad y compatibilidad histórica.
