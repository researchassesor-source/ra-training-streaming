# Candidato Streaming UX: roles, móvil, audio y panel del presentador

Este documento describe el contrato implementado en `feature/streaming-ux-roles-mobile`. Es un candidato para Preview aislado; no es evidencia de funcionamiento en Producción ni sustituye la matriz manual con dispositivos y servicios reales.

## Modalidades y roles

| Modalidad | Rol | Publicación base | Administración |
|---|---|---|---|
| Webinar | Anfitrión | cámara, micrófono, pantalla y audio de pantalla | sala, participantes, invitaciones, grabación y finalización |
| Webinar | Coanfitrión | cámara, micrófono y pantalla | sala, participantes, invitaciones y finalización; no grabación |
| Webinar | Moderador | cámara y micrófono | chat, Q&A y solicitudes |
| Webinar | Panelista | cámara, micrófono y pantalla configurable | sin acciones destructivas |
| Webinar | Asistente | ninguna | chat, Q&A, reacciones y solicitud de palabra |
| Sesión | Anfitrión/Coanfitrión | cámara, micrófono y pantalla | según el rol administrativo |
| Sesión | Moderador | cámara, micrófono y pantalla | chat, Q&A y solicitudes |
| Sesión | Participante | cámara, micrófono y pantalla configurable | sin acciones destructivas |
| Clase | Docente/Coanfitrión | cámara, micrófono y pantalla | según el rol administrativo |
| Clase | Moderador | cámara y micrófono | chat, Q&A y solicitudes |
| Clase | Estudiante | cámara y micrófono; pantalla solo con autorización | sin acciones destructivas |

`server/meeting-permissions.js` es la fuente central de capacidades y fuentes publicables. El servidor revalida cada mutación y el JWT LiveKit contiene `canPublishSources` mínimas y `canPublishData=false`. Los cambios de rol y permisos actualizan LiveKit en tiempo real, se guardan por identidad/sala y producen auditoría. La interfaz solo proyecta ese contrato; ocultar un botón no es el control de seguridad.

## Compatibilidad histórica

- Una reunión antigua sin `meetingType`, nuevos flags o `rolePolicyVersion` se normaliza en memoria como Webinar con política histórica; no se reescribe el objeto.
- Invitaciones antiguas SHA-256 y sesiones `PANELIST/VIEWER` siguen siendo válidas. Un cliente antiguo que envía únicamente `role` obtiene el contrato legado; un cliente nuevo envía `meetingRole` y activa la matriz canónica.
- `legacyAccess` mantiene a un `VIEWER` histórico como espectador incluso si una reunión antigua se edita posteriormente como Clase o Sesión.
- Los campos nuevos son aditivos: `meetingType`, `rolePolicyVersion`, `allowPanelistScreenShare`, `allowParticipantScreenShare` y `allowStudentScreenShare`.

## Invitaciones

El panel crea accesos firmados para todos los roles válidos de la modalidad. Cada diálogo ofrece copiar enlace, copiar mensaje, Web Share, abrir en otra pestaña y WhatsApp. Anfitrión, docente y coanfitrión son siempre de un uso. El mensaje incluye título, modalidad, rol, capacidad resumida, fecha, hora/zona, capacitador, duración, enlace independiente y advertencia de privacidad para accesos privilegiados.

## Prejoin, consentimiento y móvil

El prejoin separa rol, modalidad y nombre visible; nunca usa el rol como nombre. La tarjeta usa filas fijas para encabezado/contenido/pie, scroll vertical interno, safe areas y ancho seguro desde 360 px. El pie mantiene Cancelar/Entrar visibles. La vista previa diferencia cámara apagada, permiso rechazado y cámara ausente; permite medir micrófono, probar altavoz y elegir dispositivos cuando el navegador expone esas APIs.

Todos los accesos de la política nueva deben aceptar privacidad. Grabación y transcripción aparecen solo cuando la reunión y su política las requieren. El servidor registra el consentimiento en la sesión firmada y en auditoría antes de emitir el token LiveKit. Las sesiones organizadoras históricas conservan el comportamiento previo para evitar cortar accesos ya emitidos.

En móvil, Chat inicia cerrado y su preferencia se conserva durante la sesión. Un mensaje incrementa el contador y genera una notificación, pero no abre el panel. Cerrar el panel devuelve el espacio al escenario y los listeners de teclado/IME/borrador conservan el contrato del compositor existente.

## Estados multimedia y audio

Micrófono y cámara tienen estados `active`, `off` y `locked`: naranja oficial más texto para activo; azul oscuro más tachado para apagado; gris, tachado, candado y explicación para bloqueado. Pantalla comprueba permiso LiveKit y `getDisplayMedia`; si falta la API se deshabilita y explica que debe usarse un computador o navegador compatible. Los estados se recalculan desde tracks/permisos reales tras cada evento o fallo.

El volumen de reunión multiplica el volumen de todas las pistas remotas actuales y futuras, incluido audio de pantalla. Cada participante remoto tiene un factor individual. Se usa `RemoteAudioTrack.setVolume` cuando está disponible y el elemento HTML como fallback; nunca se cambia el micrófono local. La preferencia global permanece en `localStorage`, mientras los factores individuales viven durante la sesión.

## Presentación y hablante activo

Se reutilizó el sistema existente de Document Picture-in-Picture/fallback. Los modos son:

- Completo: 420×430 orientativo, métricas/acciones y miniatura 16:9.
- Compacto: 420×210 orientativo, barra esencial y hablante activo.
- Mínimo: 300×72 orientativo, cápsula con estado y acciones críticas.

El tamaño real puede quedar limitado por el navegador. La ventana no crea otra `Room`, no reconecta y no reproduce audio: la cámara adicional está silenciada. El hablante se deriva de eventos LiveKit, excluye asistentes no elegibles, aplica 450 ms al hablar y 900 ms al quedar en silencio, y admite Automático, Fijado y Oculto. Todos los listeners, tracks auxiliares y handlers de arrastre se desmontan al cerrar/disponer.

## Temporizador, grabación y transcripción

El temporizador usa el instante más reciente entre `startedAt` y `livekitConfirmedAt`; nunca `createdAt`. Estados programado/finalizado/cancelado devuelven cero transcurrido. La grabación sigue siendo veraz: solo `EGRESS_ACTIVE` produce el aviso visible. R2, Egress y Deepgram no se declaran validados hasta completar el flujo real en Preview. La integración existente mantiene URL R2 temporal, HTTPS/allowlist/SSRF, diarización, revisión y TXT/JSON/VTT/SRT.

## Evidencia local del candidato

El 10 de agosto de 2026 se ejecutó el candidato contra el servidor LiveKit local oficial, sin Egress, almacenamiento externo ni Deepgram:

- Suite final: 127 pruebas aprobadas, 0 fallidas y 0 omitidas.
- Dos conexiones simultáneas reales en Chromium integrado: Anfitrión + Asistente Webinar.
- Verificados en tiempo real: rol visible, JWT/permisos por fuente, chat cerrado con badge sin apertura automática, mano, conceder/retirar palabra, promoción a Panelista, degradación a Asistente y restauración de mínimo privilegio.
- Volumen de reunión comprobado en 0/25/50/100 y volumen individual en 25 %. La suite funcional cubre aplicación a pistas actuales, futuras y audio de pantalla sin modificar el micrófono local.
- Fallback del panel del presentador medido en 420×58 px en modo compacto sin miniatura activa y 420×469 px en modo completo; no creó otra conexión ni audio duplicado.
- Consola del panel, anfitrión y asistente: 0 errores y 0 advertencias durante el flujo.
- Contraste medido en controles representativos: micrófono 11,5:1; salir 9,54:1; conexión 10,29:1.
- `npm audit --omit=dev`: 0 vulnerabilidades. Build de procesadores, 47 archivos con `node --check` y `git diff --check`: aprobados.

La prueba utilizó dispositivos multimedia sintéticos del navegador; no concede evidencia de cámara/micrófono físicos, selección de salida física, iPhone ni Android. La grabación permaneció honestamente deshabilitada porque no se configuraron Egress/R2. La transcripción real no se ejecutó.

## Matriz de compatibilidad

| Capacidad | Chromium automatizado/escritorio | Safari iPhone real | Chrome Android real |
|---|---|---|---|
| Prejoin, chat y layout | validado localmente en nueve resoluciones | pendiente dispositivo | pendiente dispositivo |
| Cámara/micrófono | estados/permisos validados; hardware físico pendiente | pendiente dispositivo | pendiente dispositivo |
| Compartir pantalla | disponible solo si existe `getDisplayMedia` | no declarar sin prueba | no declarar sin prueba |
| Selección de salida | solo con `setSinkId` | depende del navegador | depende del navegador |
| Document PiP | solo navegadores con `documentPictureInPicture` | fallback interno | fallback interno/según navegador |

Resoluciones obligatorias: 360×640, 375×667, 390×844, 412×915, 768×1024, 1024×768, 1366×768, 1440×900 y 1920×1080. La revisión estática/automatizada no equivale a un dispositivo físico.

## Capacidad y costo

`scripts/livekit-load-preview.ps1` envuelve el `lk load-test` oficial con etapas 25/50/100/250/500/750/1000. Por defecto solo calcula participant-minutes. La ejecución exige `APP_ENV=preview`, WSS, host allowlist, credenciales Preview en variables de entorno y confirmación independiente; desde 100 participantes exige además `-ApproveHighCost`. Nunca contiene ni imprime secretos y guarda informes en `.local-runtime/load-tests/`.

La prueba debe usar pocos publicadores y muchos suscriptores para representar Webinar. Cada etapa registra tasa de ingreso, latencia, tracks, bitrate, pérdida, desconexiones, CPU/memoria, señalización y costo. No se ejecutó carga de cientos de conexiones en esta entrega y no existe evidencia para afirmar 1.000 asistentes.

## Rollback

1. Detener únicamente el servicio Preview o volver a desplegar su último SHA aprobado.
2. Revertir commits en orden inverso: documentación/pruebas, panel/audio/UX y finalmente perfiles backend.
3. No migrar ni borrar reuniones, invitaciones, grabaciones, transcripciones o auditoría: los campos son aditivos y los lectores antiguos ignoran extras.
4. Revocar invitaciones creadas para QA y desactivar `TRANSCRIPTION_ENABLED` si debe cortarse consumo.
5. Restaurar variables desde el gestor de secretos, nunca desde Git, y registrar SHA/síntoma/evidencia.
