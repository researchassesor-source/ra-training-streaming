# Experiencia profesional de reunión

Esta guía describe la sala de R.A. Training Streaming. Los controles se ejecutan sobre una única sesión LiveKit; abrir paneles o Picture-in-Picture no reconstruye la sala ni duplica tracks.

Cada pestaña conserva un selector opaco de sesión de sala. Por eso un organizador y un asistente pueden permanecer abiertos simultáneamente en el mismo perfil del navegador sin sobrescribir identidad ni CSRF. El selector no autentica por sí solo: el servidor siempre exige la cookie HttpOnly firmada correspondiente.

## Roles y modos

`WEBINAR` usa HOST/COHOST/MODERATOR/PANELIST/ATTENDEE; `SESSION` usa HOST/COHOST/MODERATOR/PARTICIPANT; `CLASS` usa TEACHER/COHOST/MODERATOR/STUDENT. La publicación base y las capacidades están centralizadas en `meeting-permissions.js`, se incluyen por fuente en el JWT y se vuelven a validar en cada acción Express. La UI oculta acciones irrelevantes, pero no se usa como barrera de seguridad.

ATTENDEE empieza sin cámara, micrófono o pantalla y puede recibir micrófono temporal. PANELIST publica cámara/micrófono y pantalla configurable. PARTICIPANT publica cámara/micrófono y pantalla configurable. STUDENT publica cámara/micrófono y solo comparte pantalla tras autorización. HOST/TEACHER controlan grabación; COHOST no. MODERATOR gestiona chat, Q&A y solicitudes sin finalizar ni grabar.

## Controles principales

En escritorio están visibles micrófono, cámara, pantalla, chat, mano cuando corresponde, participantes, Más y Salir. En móvil se priorizan micrófono, cámara, chat, mano, Más y Salir; pantalla y participantes siguen disponibles dentro de Más. Los botones publican `aria-pressed`, `aria-busy`, nombre accesible, tooltip y estado deshabilitado.

**Salir** desconecta solo al usuario. **Finalizar para todos** exige rol y confirmación. La grabación no se infiere de `LIVE`: sin Egress el control dice **Grabación no disponible** y explica qué integración falta.

## Pantalla y cámara local

La pantalla compartida ocupa el spotlight y conserva una única miniatura compacta de hablante activo. Un hablante remoto tiene prioridad; si nadie remoto habla se usa el participante local como fallback estable. El cambio aplica debounce de 450 ms al empezar a hablar y 900 ms al volver al fallback para evitar saltos visuales. Si la cámara seleccionada no tiene un track vivo, la miniatura muestra iniciales, nombre y estado de micrófono en vez de fingir vídeo.

El navegador decide si comparte pestaña, ventana o pantalla completa. La aplicación solicita audio, pero solo muestra **Audio de pantalla incluido** cuando LiveKit publica el track `ScreenShareAudio`. El evento `ended` restaura escenario, botones, aviso y auditoría aunque la captura termine desde el indicador nativo.

El estado visual procede del track publicado y sus eventos, no del clic ni de la mera existencia de una publicación. Cámara activa requiere un track de vídeo vivo y no silenciado; al silenciarse, terminar o despublicarse vuelve el avatar. `ScreenShare` y `ScreenShareAudio` se adjuntan por separado: el vídeo entra al spotlight y el audio remoto se monta como elemento no visual. Nunca se prueba `video.src`, porque LiveKit adjunta streams mediante `srcObject`.

## Controles flotantes

Al iniciar pantalla aparece un toast **Mantén los controles visibles mientras presentas**. La preferencia local **Abrir panel flotante al compartir** permite solicitar apertura automática desde ese gesto.

Cuando `documentPictureInPicture` funciona usa tres tamaños orientativos: Compacto 420×210, Completo 420×430 y Mínimo 300×72. Compacto combina la barra esencial con cámara/avatar, nombre y rol del hablante; Completo añade métricas y acciones; Mínimo deja una cápsula de estado. Automático sigue a LiveKit con debounce, Fijado conserva una persona elegida y Oculto elimina la miniatura. La cámara auxiliar está silenciada para evitar audio duplicado. Incluye micrófono, cámara, detener pantalla, chat, preguntas, participantes, mano/ver manos, Más, Salir y volver.

Chat y Participantes se abren como popovers compactos desde el mismo botón que los cierra. Solo uno puede estar abierto, Escape o un clic exterior lo cierran, y `aria-expanded` refleja el estado. Chat conserva el borrador entre cierres, comparte el historial reciente y el estado enviado/fallido con la sala, usa Enter para enviar y Shift+Enter para nueva línea. Participantes muestra rol y estados reales de micrófono, cámara, pantalla, mano y permiso, con las mismas rutas seguras de moderación de la sala.

Cerrar la ventana no altera reunión ni medios y el botón permite reabrirla. Al cerrar se desmontan listeners, track auxiliar y arrastre. Si la API no existe, falla o cierra inmediatamente, se abre un panel arrastrable dentro de la reunión. Ese fallback conserva los controles, pero no puede permanecer sobre otra aplicación. No se promete “siempre encima” fuera de navegadores compatibles.

## Panel lateral y chat

Chat, Preguntas y Participantes comparten un panel. En móvil empieza cerrado; recibir mensajes solo incrementa el badge y nunca lo abre. Cerrarlo añade `panel-closed` al layout, elimina la columna y entrega todo el ancho al escenario. La preferencia se conserva durante la sesión. En tablet el panel es lateral superpuesto y en móvil se comporta como hoja/pantalla completa sin destruir `Room`.

El compositor conserva borradores por tipo, dos líneas autoexpandibles, Enter para enviar, Shift+Enter para nueva línea, protección IME, límites de 2.000/600 caracteres, adjuntos validados, envío, fallo y reintento. Con el panel cerrado, mensajes incrementan contador y producen sonido/toast agrupado; en segundo plano también se solicita notificación del sistema si el usuario otorgó permiso.

## Q&A

Las preguntas se guardan en `questions/` local o S3, no en el DOM. El asistente puede crear, editar/eliminar una pregunta propia pendiente y votar. Organizador/panelista puede destacar, responder por escrito, marcar respondida en vivo o descartar. Al descartar, la pregunta desaparece del flujo activo y deja de devolverse a asistentes; moderadores pueden consultarla únicamente al expandir el historial secundario **Ver descartadas**. Se ordenan por votos o fecha y el contador muestra solo pendientes activas.

Solo se retransmite `question-changed`/`question-deleted`; cada cliente vuelve a consultar una proyección que no expone identidades internas ni la lista de votantes. Auditoría registra creación y decisiones de moderación, no el texto.

## Participantes, mano y consentimiento

Participantes muestra nombre, rol humano, micrófono, cámara, pantalla, mano, hora de entrada y calidad disponible. Al estar solo, el organizador ve enlaces de invitación de asistente y panelista.

El organizador puede silenciar una pista publicada, pedir activación de micrófono, pedir apagar cámara, dar/quitar palabra, expulsar o bloquear. Las solicitudes aparecen como toast con decisión del participante: la plataforma nunca enciende cámara o micrófono remoto. Bloquear revoca la invitación asociada cuando existe.

Una petición de micrófono tiene identificador, caducidad y deduplicación. El asistente elige **Activar micrófono** o **Ahora no**. Solo después de aceptar, el servidor concede temporalmente publicación y el cliente intenta publicar el track; el organizador recibe estados distintos para aceptación, activación real, rechazo o fallo. La concesión se conserva al reconectar y **Quitar palabra** la revoca explícitamente. La UI no anuncia micrófono activo si el dispositivo o la publicación fallan.

La cola de manos conserva orden y hora. En Webinar organizador/panelista revisa la cola; solo organizador cambia permisos de publicación. Sonido, toast, contador, notificación y modelo flotante comparten el mismo evento.

## Reacciones, alertas y notificaciones

Reacciones disponibles: 👍, 👏, ❤️, 😂, 🎉 y ✅. Se retransmiten con identidad, tienen rate limit y animación breve que respeta `prefers-reduced-motion`.

Los toasts usan `aria-live`, cierre y caducidad; eventos repetidos se agrupan. El botón de notificaciones diferencia solicitando, concedido, rechazado y no compatible. `Notification.requestPermission()` solo se ejecuta desde el clic. El volumen global multiplica todas las pistas remotas actuales/futuras y cada participante tiene un factor individual; audio de pantalla usa el mismo camino y el micrófono local nunca cambia. Sonidos, volumen y categorías se conservan localmente sin datos sensibles.

## Estado, temporizador y red

El temporizador comienza tras conexión LiveKit confirmada y usa `meeting.startedAt`, por lo que no reinicia al reconectar. La calidad procede de `ConnectionQualityChanged`: excelente, buena, inestable o sin medir. Reconnecting/disconnected pertenecen a la máquina de conexión y nunca se mezclan con grabación.

Bloquear sala impide nuevos canjes, no desconecta asistentes existentes ni revoca permanentemente enlaces. Desbloquear restaura invitaciones activas. El check y el consumo se serializan por sala dentro de una instancia.

## Atajos y accesibilidad

- Ctrl/Cmd+Shift+M: micrófono.
- Ctrl/Cmd+Shift+V: cámara.
- Ctrl/Cmd+Shift+S: pantalla.
- Ctrl/Cmd+Shift+C: chat.
- Ctrl/Cmd+Shift+H: mano o cola.
- Ctrl/Cmd+Shift+P: participantes.
- Escape: cerrar panel lateral, Más o el popover del dock flotante.

No se ejecutan con foco en `input`, `textarea`, `select`, `contenteditable` o un diálogo. Hay foco visible, nombres accesibles, estados textuales, contraste y controles táctiles. Los diálogos nativos conservan foco modal; el preflight y confirmaciones restauran una salida clara.

## Compatibilidad y rendimiento

Document PiP funciona principalmente en Chromium compatible y exige contexto seguro (localhost cuenta). Firefox/Safari y políticas corporativas pueden usar solo el fallback interno. Selección de altavoz requiere `setSinkId`; compartir pantalla y audio dependen del dispositivo/navegador. Notificaciones pueden ser bloqueadas globalmente.

La sala limita mensajes montados a 300 y el historial proyectado del dock a 60, agrupa toasts, aplica debounce a recargas de Q&A y cambios de hablante, carga efectos bajo demanda, revoca Object URLs y elimina listeners/timers en retry o `pagehide`. Un único `AbortController` desmonta los listeners DOM del chat para que una reconexión no duplique teclas, emojis ni adjuntos. Los fondos se procesan localmente; no se suben.

## QA local

1. `npm run livekit:up` y `npm start`.
2. Organizador en navegador normal; asistente con invitación en incógnito/otro perfil.
3. Probar chat bidireccional, Q&A, reacción, mano, promoción, moderación y bloqueos.
4. Probar pantalla, evento `ended`, miniatura, audio, Document PiP o fallback y controles de medios.
5. Probar conexión/reconexión, salir y finalizar.
6. Revisar 360×640, 375×667, 390×844, 412×915, 768×1024, 1024×768, 1366×768, 1440×900 y 1920×1080 sin overflow.

Limitaciones: una salida abrupta requiere webhook LiveKit para auditoría autoritativa; locks/rate limits en memoria requieren coordinación compartida con varias instancias; grabación y transcripción reales requieren Egress, almacenamiento y proveedor configurados; una herramienta automatizada no puede elegir de forma fiable el elemento del selector nativo de pantalla.
