# Checklist de release

## Antes de commit

- [ ] Rama actual: `feature/optimizacion-streaming-webinar`.
- [ ] `.env` y `.local-data/` no aparecen en `git status`.
- [ ] `node --check` pasa para todos los módulos de servidor y frontend modificados.
- [ ] `npm test` pasa sin tests omitidos ni falsos positivos.
- [ ] `npm run build:track-processors` termina correctamente.
- [ ] `git diff --check` no reporta errores.
- [ ] `git diff` no contiene claves, secretos, contraseñas o datos reales.
- [ ] `npm run livekit:up` deja puertos 7880/7881 activos y el dashboard muestra LiveKit disponible.
- [ ] Con LiveKit detenido, **Iniciar** no cambia el estado ni el contador de activas.

## Preview aislado

No ejecutar sin aprobación humana.

1. Crear Preview desde `feature/optimizacion-streaming-webinar`, nunca desde `main`.
2. Configurar un `SESSION_SECRET` de Preview y bootstrap exclusivo.
3. Usar LiveKit y bucket R2 de prueba, no Producción.
4. Mantener `NODE_ENV=production`, `COOKIE_SECURE=true` y `ALLOW_OPEN_DEV_ROOMS=false`.
5. Crear datos ficticios y ejecutar la matriz manual.

## Matriz manual

- [ ] Login correcto, incorrecto, rate limit y logout.
- [ ] Crear, editar, reprogramar, duplicar, cancelar, archivar, eliminar lógicamente y restaurar reunión.
- [ ] Crear/revocar invitaciones; probar expiración, uso único y URL limpia.
- [ ] Crear/editar/desactivar usuario, cambiar contraseña y revocar sesiones.
- [ ] Confirmar que ORGANIZER no administra ADMIN y VIEWER no se autopromueve.
- [ ] Abrir panelista y asistente con cámara/micrófono permitidos y denegados.
- [ ] Confirmar que Programada cambia a En vivo solo después de conectar un participante autorizado y que auditoría contiene un único `ROOM_CONNECTED`.
- [ ] Chat, preguntas, archivo permitido/rechazado, rate limit, no leídos y reintento.
- [ ] Mano: levantar, cancelar, rechazar, dar/quitar palabra y expulsar.
- [ ] Compartir pantalla y evento `ended`.
- [ ] Salir no finaliza; **Finalizar para todos** sí desconecta y completa.
- [ ] Grabación: consentimiento, inicio, aviso, stop, listado y enlace firmado.
- [ ] El indicador de grabación permanece apagado ante error, estado desconocido, reconexión y Egress finalizado.
- [ ] Reunión histórica incompleta carga con valores seguros sin reescribir el objeto almacenado.
- [ ] Calendario conserva la fecha local (incluido un caso del 30 de julio) y distingue el mes adyacente.
- [ ] Transcripción: crear, procesar, completar, fallar, reintentar, cancelar, editar con conflicto, eliminar y exportar TXT/JSON/VTT/SRT.
- [ ] PANELIST respeta el permiso de consulta; VIEWER recibe 403; ninguna respuesta o log expone claves ni `providerJobId`.
- [ ] Probar búsqueda, filtro de participante, timestamps, confianza, nombres desconocidos y cambios sin guardar.
- [ ] PiP de documento, fallback de video y mensaje sin soporte.
- [ ] Sonidos, volumen, preferencias y notificaciones con pestaña oculta.
- [ ] Breakpoints: 360×640, 375×667, 390×844, 412×915, 768×1024, 1024×768, 1366×768, 1920×1080.
- [ ] Teclado móvil, safe areas, rotación y ausencia de scroll horizontal.
- [ ] Navegación por teclado, foco visible, Escape y foco atrapado en diálogos.

## Antes de push o PR

Detenerse y presentar para aprobación:

```powershell
git status
git log --oneline
git diff main...HEAD --stat
npm test
```

Solo después de autorización: push a `feature/optimizacion-streaming-webinar`, PR draft y Preview. Nunca hacer push directo, merge o despliegue a `main` desde este flujo.

## Rollback

1. No borrar datos para revertir código.
2. Si Preview falla, detenerlo o volver a desplegar el último commit aprobado.
3. Si una migración de variables fue preparada, restaurar los valores anteriores desde el gestor seguro; no desde Git.
4. Revocar invitaciones creadas durante validación.
5. Conservar auditoría y grabaciones; no eliminar objetos R2 salvo proceso administrativo aprobado.
6. Documentar el commit, síntoma y prueba que motivaron el rollback.
