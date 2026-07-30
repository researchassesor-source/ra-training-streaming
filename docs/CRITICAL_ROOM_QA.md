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

## Limitación de automatización

El selector nativo de pantalla requiere una elección humana y no se controla desde una prueba DOM. Para una comprobación automatizada local de transporte/render se puede publicar temporalmente una pista de vídeo de prueba con fuente LiveKit `ScreenShare`, siempre desde un harness externo que no se versiona. La validación manual de release debe repetir el flujo con el selector nativo.

## Cierre

Ejecutar `npm test`, `npm run build:track-processors`, `node --check` sobre JavaScript modificado y `git diff --check`. Detener Node y LiveKit. No crear Preview, push, PR, merge ni despliegue durante esta ronda.
