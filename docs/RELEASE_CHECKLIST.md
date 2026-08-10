# Checklist de release

## Antes de commit

- [ ] Rama actual: `feature/streaming-ux-roles-mobile`.
- [ ] `.env` y `.local-data/` no aparecen en `git status`.
- [ ] `node --check` pasa para todos los módulos de servidor y frontend modificados.
- [ ] `npm test` pasa sin tests omitidos ni falsos positivos.
- [ ] `npm run build:track-processors` termina correctamente.
- [ ] `git diff --check` no reporta errores.
- [ ] `git diff` no contiene claves, secretos, contraseñas o datos reales.
- [ ] `npm run livekit:up` deja puertos 7880/7881 activos y el dashboard muestra LiveKit disponible.
- [ ] Con LiveKit detenido, **Iniciar** no cambia el estado ni el contador de activas.

## Preview aislado

Ejecutar solo cuando el alcance de la entrega lo autorice expresamente. Esta lista nunca autoriza Producción.

1. Crear Preview desde `feature/streaming-ux-roles-mobile` con `render.preview.yaml`, nunca desde `main` ni con `render.yaml`.
2. Configurar `APP_ENV=preview`, URL pública HTTPS, secretos de sesión/invitación y bootstrap exclusivos.
3. Usar LiveKit, bucket R2/S3 y proveedor de transcripción de prueba; nunca credenciales o datos de Producción.
4. Confirmar el aislamiento antes de definir `PREVIEW_ISOLATION_ACK=true`.
5. Mantener `NODE_ENV=production`, `COOKIE_SECURE=true`, `ALLOW_OPEN_DEV_ROOMS=false` y despliegue automático desactivado.
6. Comprobar `/health`, `X-Robots-Tag`, `/robots.txt` y crear únicamente datos ficticios.
7. Ejecutar la matriz manual y registrar qué casos requieren hardware, dos navegadores o servicios externos.
8. Confirmar `TRANSCRIPTION_PROVIDER=deepgram`, endpoint/host oficiales, modelo `nova-3`, idioma `es`, URL firmada de 600 segundos y clave exclusiva presente sin mostrarla.
9. Antes de declarar Deepgram disponible, completar un job real autorizado; `degraded/not-probed` antes de esa prueba es deliberado y no debe maquillarse.

## Matriz manual

- [ ] Login correcto, incorrecto, rate limit y logout.
- [ ] Crear, editar, reprogramar, duplicar, cancelar, archivar, eliminar lógicamente y restaurar reunión.
- [ ] Crear/revocar invitaciones; probar expiración, uso único y URL limpia.
- [ ] Confirmar que los mensajes de panelista/asistente usan la URL canónica de Preview, fecha, hora, zona, capacitador y codificación correcta de WhatsApp.
- [ ] Confirmar que una invitación histórica SHA-256 sigue funcionando y que una nueva se almacena con HMAC sin token en claro.
- [ ] Mantener organizador y asistente en dos pestañas del mismo perfil; cada una conserva identidad y CSRF al alternar chat, Q&A y moderación.
- [ ] Crear/editar/desactivar usuario, cambiar contraseña y revocar sesiones.
- [ ] Confirmar que ORGANIZER no administra ADMIN y VIEWER no se autopromueve.
- [ ] Abrir panelista y asistente con cámara/micrófono permitidos y denegados.
- [ ] Confirmar que Programada cambia a En vivo solo después de conectar un participante autorizado y que auditoría contiene un único `ROOM_CONNECTED`.
- [ ] Chat, preguntas, archivo permitido/rechazado, rate limit, no leídos y reintento.
- [ ] Q&A persistente: editar propia pendiente, votar, ordenar, fijar y responder por escrito/en vivo sin duplicados; al descartar desaparece del flujo principal y del asistente, y solo queda en el historial secundario de moderación.
- [ ] Mano: levantar, cancelar, rechazar, dar/quitar palabra y expulsar.
- [ ] Solicitud de micrófono: aceptar y publicar, rechazar con “Ahora no”, fallar por dispositivo y recibir cada estado específico en organizador.
- [ ] Conceder palabra, recargar/reconectar asistente, comprobar que el permiso continúa y luego revocarlo.
- [ ] Compartir pantalla y evento `ended`.
- [ ] Salir no finaliza; **Finalizar para todos** sí desconecta y completa.
- [ ] Grabación: consentimiento, inicio, aviso, stop, listado y enlace firmado.
- [ ] El asistente no recibe token LiveKit antes de aceptar privacidad y consentimientos exigidos; el evento queda auditado sin secretos.
- [ ] El indicador de grabación permanece apagado ante error, estado desconocido, reconexión y Egress finalizado.
- [ ] Reunión histórica incompleta carga con valores seguros sin reescribir el objeto almacenado.
- [ ] Calendario conserva la fecha local (incluido un caso del 30 de julio) y distingue el mes adyacente.
- [ ] Transcripción real: Egress Preview → objeto R2 privado → URL temporal → Deepgram; crear, procesar, completar, fallar, reintentar, cancelar, editar con conflicto, renombrar hablante, eliminar y exportar TXT/JSON/VTT/SRT.
- [ ] Audio autorizado de 30–90 s con dos voces: registrar duración, bytes, tiempo de proceso, segmentos, speakers y confianza sin copiar texto sensible ni URL firmada.
- [ ] Probar 401/403 con clave controlada no productiva, 429/5xx si puede simularse sin gasto, formato inválido, timeout, reinicio durante trabajo y caída temporal de R2.
- [ ] PANELIST respeta el permiso de consulta; VIEWER recibe 403; ninguna respuesta o log expone claves ni `providerJobId`.
- [ ] El detalle de transcripción no expone URL R2; bucket permanece privado y la URL enviada al proveedor caduca en 5–15 minutos.
- [ ] Probar búsqueda, filtro de participante, timestamps, confianza, nombres desconocidos y cambios sin guardar.
- [ ] Document PiP abre en modo compacto 420×210, completo 420×430 y mínimo 300×72 (tamaños orientativos); controla medios/paneles/salida, cierra sin desconectar y conserva un fallback interno honesto.
- [ ] Hablante activo cambia con estabilidad, se puede fijar u ocultar y la miniatura adicional permanece silenciada para no duplicar audio.
- [ ] Volumen global afecta pistas actuales/futuras y audio de pantalla; volumen individual solo modifica a la persona elegida.
- [ ] Popovers del dock: Chat y Participantes alternan con su mismo botón, son mutuamente excluyentes, cierran con Escape/clic exterior y conservan borrador e historial sin duplicar listeners.
- [ ] Cerrar Chat/Preguntas/Participantes elimina la columna y expande inmediatamente el escenario.
- [ ] Pantalla real en spotlight, vídeo con `srcObject`, una miniatura de hablante activo con prioridad remota/debounce/fallback local/avatar, audio veraz y recuperación al silenciar, despublicar o terminar desde el navegador.
- [ ] Bloquear/desbloquear: una invitación no se consume al rechazar; la sesión existente continúa.
- [ ] Invitaciones de asistente/panelista desde sala muestran confirmación sin exponer el token en UI persistente.
- [ ] Calidad, temporizador y estado de grabación real coinciden en header y panel flotante.
- [ ] Atajos Ctrl/Cmd+Shift no se ejecutan durante escritura; Escape cierra paneles.
- [ ] Sonidos, volumen, preferencias y notificaciones con pestaña oculta.
- [ ] Breakpoints: 360×640, 375×667, 390×844, 412×915, 768×1024, 1024×768, 1366×768, 1920×1080.
- [ ] Teclado móvil, safe areas, rotación y ausencia de scroll horizontal.
- [ ] Navegación por teclado, foco visible, Escape y foco atrapado en diálogos.

## Antes de push, PR o Preview

Registrar siempre:

```powershell
git status
git log --oneline
git diff main...HEAD --stat
npm test
```

Actuar estrictamente según la autorización vigente. Nunca hacer push directo a `main`, merge, cambio de DNS ni despliegue a Producción desde este flujo.

## Rollback

1. No borrar datos para revertir código.
2. Si Preview falla, detenerlo o volver a desplegar el último commit aprobado.
3. Si una migración de variables fue preparada, restaurar los valores anteriores desde el gestor seguro; no desde Git.
4. Revocar invitaciones creadas durante validación.
5. Conservar auditoría y grabaciones; no eliminar objetos R2 salvo proceso administrativo aprobado.
6. Documentar el commit, síntoma y prueba que motivaron el rollback.
7. Para cortar consumo de Deepgram, fijar `TRANSCRIPTION_ENABLED=false`; si una clave pudo exponerse, rotarla y revocar la anterior desde Deepgram.
