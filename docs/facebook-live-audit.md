# Auditoría técnica — Facebook Live en R.A. Training Streaming

## Estado implementado

La aplicación usa Node.js/Express con LiveKit para la sala y LiveKit Egress para enviar una salida RTMP/RTMPS externa. El flujo actual de Facebook Live es manual: el organizador abre Facebook Live Producer, copia el servidor RTMPS y la Stream Key, los pega en R.A. Training y la app inicia `startRoomCompositeEgress()` hacia ese destino.

Archivos principales:

- `server/app.js`: endpoints `/api/facebook-live/status`, `/api/facebook-live/start` y `/api/facebook-live/stop`.
- `server/facebook-live.js`: validación de destino RTMP/RTMPS, clasificación de estado Egress y mensajes seguros.
- `server/external-sessions.js`: persistencia durable de sesiones Facebook Live en PostgreSQL.
- `server/db/migrations/003_durable_jobs_and_external_services.sql`: tabla `facebook_live_sessions`.
- `public/presenter.html`, `public/viewer.html` y `public/room-ui.js`: modal de configuración, estado y acciones de inicio/detención.

## Servicios y variables necesarias

Para el flujo manual actual deben existir las credenciales de LiveKit usadas por la sala y por Egress:

```text
LIVEKIT_WS_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

La grabación sigue siendo independiente y utiliza su propia configuración de almacenamiento cuando está habilitada.

## Hallazgos corregidos

- La validación de Stream Key era demasiado estricta: bloqueaba el carácter `?`, aunque Facebook puede entregar claves o URLs opacas con parámetros. Ahora se acepta la Stream Key completa con parámetros seguros (`?`, `&`, `=`, `%`, `-`, `_`, `.`), sin aceptar espacios, rutas, fragmentos ni una URL completa pegada en el campo equivocado.
- El error de arranque era demasiado genérico. Ahora el backend devuelve un mensaje seguro que orienta si el problema está en LiveKit Egress/credenciales o en Server URL/Stream Key, sin exponer la clave de Facebook.
- El modal explica que la clave debe pegarse completa, incluyendo parámetros posteriores a `?` si Facebook los muestra.

## Lo que funciona

- Inicio de una señal externa host-only hacia un destino RTMP/RTMPS.
- Estado separado de Facebook Live y de grabación.
- Persistencia de sesión externa cuando PostgreSQL está activo.
- No se devuelve la Stream Key en respuestas públicas, eventos de sala ni auditoría.
- La UI no afirma que Facebook ya publicó el video; solo confirma que R.A. Training está enviando señal y que el organizador debe publicar desde Facebook Live Producer.

## Lo incompleto para OAuth/Meta API

El flujo OAuth de Meta no existe todavía en el código actual. Para dejar un modo “Conectar Facebook” completamente automático hacen falta, como fase separada:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_REDIRECT_URI`
- `META_GRAPH_API_VERSION`
- una clave de cifrado para tokens, por ejemplo `TOKEN_ENCRYPTION_KEY`
- endpoints OAuth de conexión/callback/desconexión
- almacenamiento cifrado de Page Access Token
- selección de página destino
- creación de `LiveVideo` en Graph API
- lectura de `secure_stream_url`
- estados y errores de Meta separados de los estados de LiveKit Egress
- aprobación/revisión de permisos de Meta según el uso de la app

Según la documentación de Meta Live Video API, el flujo automático crea un objeto `LiveVideo` en una página o usuario y devuelve una `secure_stream_url` para que el encoder envíe la señal. Ese flujo requiere configurar la app de Meta, OAuth y permisos revisables. No debe simularse como “listo” sin credenciales reales y revisión de Meta.

