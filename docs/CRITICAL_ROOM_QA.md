# QA crítico de sala

Esta matriz reproduce las regresiones corregidas sin depender de Producción.

## Preparación

1. Ejecutar `npm ci`, `npm run livekit:up` y `npm start`.
2. Crear o iniciar una reunión local con datos ficticios.
3. Abrir organizador y asistente en dos pestañas del mismo perfil o en perfiles separados.
4. Mantener DevTools abierto para comprobar que no aparecen errores de sesión, CSRF, tracks o listeners.

## Sesión y acciones concurrentes

1. Enviar un chat y una pregunta desde el asistente; confirmar recepción del organizador.
2. Levantar la mano y alternar el foco entre pestañas antes de dar la palabra.
3. Confirmar que la URL no conserva el token de invitación ni `roomSession` y que las mutaciones usan la sesión de su propia pestaña.
4. Provocar en prueba automatizada un CSRF incorrecto: debe devolver 403 específico y diagnósticos booleanos seguros, nunca secretos.

## Consentimiento y moderación

1. Solicitar micrófono. Rechazar una vez con **Ahora no** y comprobar el aviso específico al organizador.
2. Repetir y aceptar. El permiso se concede antes de solicitar el dispositivo; solo una publicación LiveKit real cambia el estado a activo.
3. Simular dispositivo denegado/ocupado y comprobar que ambos lados informan el fallo sin mostrar micrófono activo.
4. Dar palabra, reconectar al asistente y validar que puede publicar; quitar palabra y validar que vuelve a no poder hacerlo.
5. Revisar **Más acciones** y las confirmaciones de expulsión y bloqueo.

## Medios y layout

1. Encender cámara y observar desde la otra pestaña un vídeo real. Silenciar/despublicar y comprobar el avatar.
2. Compartir pantalla, comprobar un único spotlight `ScreenShare`, cámaras conservadas y audio solo si existe `ScreenShareAudio`.
3. Terminar desde el indicador nativo; el spotlight y el estado deben desaparecer.
4. Cerrar Chat/Preguntas/Participantes y medir que layout, escenario y viewport tienen el mismo ancho, sin scroll horizontal.
5. Abrir PiP: empieza compacto; expandir, contraer, cerrar y reabrir sin desconectar ni duplicar listeners.
6. Mientras existe un `ScreenShare`, hacer hablar al asistente: tras 450 ms su cámara/avatar debe ser la única miniatura; al callar, el fallback local debe estabilizarse tras 900 ms.

## Q&A y dock compacto

1. Crear dos preguntas, votar/ordenar/destacar una y responderla por escrito o en vivo; no deben duplicarse al recargar.
2. Descartar una pregunta: debe desaparecer inmediatamente del flujo principal y del asistente. En moderador solo aparece después de expandir **Ver descartadas**.
3. Abrir Chat desde el dock, escribir sin enviar, cerrar con el mismo botón y reabrir: el borrador debe conservarse.
4. Enviar con Enter, insertar una línea con Shift+Enter y comprobar estados enviado/fallido. Reabrir el dock no debe duplicar mensajes ni listeners.
5. Abrir Participantes mientras Chat está abierto: debe quedar un solo popover. Probar solicitar micrófono, dar/quitar palabra y **Más**; Escape y clic exterior deben cerrar.
6. Medir el dock en escritorio y móvil: hasta 650×56, sin scroll horizontal ni solapamiento de controles.

## Responsive

Revisar como mínimo 360×740, 390×844, 768×900, 1366×768 y 1920×1080. Con el panel lateral cerrado, `panel-closed` debe existir y el escenario debe ocupar todo el ancho útil. Abrir Chat debe reservar la columna lateral; cerrarlo debe devolverla inmediatamente sin reconstruir la conexión.

## Limitación de automatización

El selector nativo de pantalla requiere una elección humana y no se controla desde una prueba DOM. Para una comprobación automatizada local de transporte/render se puede publicar temporalmente una pista de vídeo de prueba con fuente LiveKit `ScreenShare`, siempre desde un harness externo que no se versiona. Ese flujo sí valida suscripción remota, `srcObject`, spotlight, hablante activo y limpieza, pero no sustituye la validación manual de release con el selector nativo y su evento `ended`.

## Cierre

Ejecutar `npm test`, `npm run build:track-processors`, `node --check` sobre JavaScript modificado y `git diff --check`. Detener Node y LiveKit. No crear Preview, push, PR, merge ni despliegue durante esta ronda.
