# Auditoría de experiencia de reuniones y compatibilidad

Fecha de corte: 2026-08-10  
Base verificada: `feature/optimizacion-streaming-webinar` en `64df0b2b696f85857fc1f47a5194a5ceabe46ee0`  
Rama de trabajo aislada: `feature/streaming-ux-roles-mobile`

## Línea base verificable

- El árbol base estaba limpio después de preservar fuera de Git los artefactos locales `.ua/` y `CLAUDE.md` mediante `.git/info/exclude`.
- `main` y `origin/main` apuntaban a `f010cd08f5a5fccca8ab46c14c520f8452b74cc7`.
- `npm ci` completó con 127 paquetes y cero vulnerabilidades informadas.
- La suite base ejecutó 113 pruebas: 112 aprobaron y una falló por una diferencia de 1 ms en el cálculo de retención de una transcripción legada (`7776000000` esperado, `7776000001` observado). Es una dependencia inestable del reloj de pared; se corregirá sin eliminar cobertura.

## Arquitectura encontrada

| Área | Estado encontrado | Riesgo o brecha | Estrategia |
| --- | --- | --- | --- |
| Express y seguridad HTTP | Implementada: sesión firmada, CSRF, cookies seguras, CSP/HSTS, rate limiting, logs con request ID y errores saneados | Las autorizaciones de sala dependen de cuatro roles históricos | Añadir capacidades centralizadas sin retirar el contrato histórico |
| Reuniones | Implementadas `WEBINAR`, `SESSION`, `CLASS`, calendario y ciclo de vida persistente | La modalidad no modifica los permisos reales | Derivar un perfil persistente por modalidad con defaults no destructivos |
| Reuniones antiguas | Normalización no destructiva con `WEBINAR` como valor por defecto | No existe rol canónico por modalidad | Mantener `role` histórico y añadir `meetingRole` derivado |
| Invitaciones | Token aleatorio largo, HMAC, hash legado, expiración, usos y revocación | Solo admite `PANELIST` y `VIEWER`; mensajes binarios | Firmar roles canónicos válidos para cada modalidad y conservar alias históricos |
| Sesión de sala | Cookie por pestaña, sesión firmada y CSRF rotatorio | El nombre visible puede caer en el texto del rol; falta modalidad/rol canónico | Persistir `meetingType`, `meetingRole` y nombre vacío/amigable separado |
| Token LiveKit | Token de mínimo acceso para espectadores y actualización en vivo | `canPublish` es booleano; cámara, micrófono y pantalla no se diferencian | Emitir `canPublishSources` y aplicar revocación por fuente |
| Moderación | Mano, permiso temporal, promover/degradar, silenciar, retirar, bloquear y finalizar | Solo `ADMIN/ORGANIZER`; los límites de coanfitrión/moderador no están modelados | Middleware de capacidades y auditoría de cada concesión/revocación |
| Chat/Q&A/archivos | Relay del servidor, límites, MIME/tamaño, borrador, IME, reintento y sanitización | El panel inicia abierto también en móvil | Cerrar por defecto en móvil, conservar elección y badges sin apertura automática |
| Prejoin | Vista previa, dispositivos, medidor y estado de LiveKit | Consentimiento solo para `VIEWER`, mensaje técnico, nombre/rol mezclados y controles ocultos | Unificar el flujo para todos los roles, validar consentimiento en servidor y hacer el layout seguro desde 360 px |
| Controles multimedia | Estado comprobado contra publicaciones reales y timeout de operaciones | Permiso único, estados bloqueados poco claros e iconos no cambian visualmente | Estados activo/apagado/bloqueado por fuente, texto, candado y `aria-*` |
| Audio remoto | Se adjunta una pista por participante/fuente y se limpia al salir | No hay volumen global ni individual real | Controlador único que aplica volumen a pistas actuales/futuras y audio de pantalla |
| Pantalla | Publicación real y detección de `getDisplayMedia` | Compatibilidad se expresa solo como botón deshabilitado | Diagnóstico visible y ocultación por rol; no prometer soporte móvil universal |
| Escenario/hablante | Galería, spotlight de pantalla, miniatura y debounce 450/900 ms | Sin modo fijado/oculto ni rol en la miniatura | Extender el componente existente con modo automático/fijado/oculto e histéresis |
| Panel flotante | Document Picture-in-Picture con fallback interno, limpieza y chat/participantes | Barra inicial de 680 px, sin hablante activo y solo dos modos | Refactorizar el mismo panel a mínimo/compacto/completo, 300–420 px y miniatura opcional |
| Temporizador | Usa `meeting.startedAt` o el instante local de conexión | Una marca histórica errónea puede producir duraciones absurdas | Sincronizar el inicio confirmado por servidor y mostrar estado semántico |
| Grabación | UI derivada de Egress; solo `EGRESS_ACTIVE` enciende el indicador | No hay evidencia de un Egress real en esta auditoría local | Conservar fail-closed y validar solo en Preview aislado si el servicio está disponible |
| R2/S3 | Metadata y URLs firmadas temporales | Credenciales/servicio externo no validados localmente | Verificar disponibilidad agregada sin leer secretos; prueba real solo en Preview |
| Deepgram | Proveedor seguro con HTTPS, allowlist, SSRF, timeout, reintento, cancelación, diarización y exportación | La prueba real depende de grabación y credenciales Preview | No reescribir; mantener pruebas contractuales y ejecutar flujo real solo si está configurado |
| Health/Preview | `/health`, `/api/health`, noindex y Blueprint Preview fail-closed | El despliegue aislado todavía requiere comprobación final | Actualizar únicamente Preview tras gates y confirmar identidad de recursos |

## Matriz de compatibilidad decidida

Se conserva el campo histórico `role` (`ADMIN`, `ORGANIZER`, `PANELIST`, `VIEWER`) para cookies, enlaces y clientes existentes. Se añade `meetingRole`, validado por servidor:

- Webinar: `HOST`, `COHOST`, `MODERATOR`, `PANELIST`, `ATTENDEE`.
- Sesión: `HOST`, `COHOST`, `MODERATOR`, `PARTICIPANT`.
- Clase: `TEACHER`, `COHOST`, `MODERATOR`, `STUDENT`.

Equivalencias legadas: organizadores autenticados se convierten en `HOST` o `TEACHER`; `PANELIST` se convierte en `PANELIST`, `PARTICIPANT` o `STUDENT`; `VIEWER` se convierte en `ATTENDEE`, `PARTICIPANT` o `STUDENT`. El registro almacenado no se reescribe al leerlo y las invitaciones históricas siguen validándose mediante su hash y rol original.

## Límites de validación

- El QA automatizado de Chromium puede validar layout, estados y accesibilidad básica; no equivale a pruebas en iPhone/Android reales.
- No se ejecutará una carga de cientos de conexiones ni Egress/Deepgram de pago sin un entorno aislado confirmado y autorización de costo.
- Ninguna comprobación de Preview autoriza cambios en Producción, `main`, DNS o recursos productivos.

## Rollback

Cada bloque se entregará en un commit local separado. El rollback consiste en revertir, en orden inverso, documentación/QA, panel y audio, UX móvil, y finalmente perfiles de reunión. Los nuevos campos son aditivos y los lectores conservan defaults históricos, por lo que una reversión no necesita migración destructiva.
