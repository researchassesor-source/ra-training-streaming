# Promoción a Producción

Esta guía prepara la configuración; no autoriza merge ni despliegue. Producción debe promover un commit ya validado en Preview, nunca reutilizar el servicio, bucket, proyecto LiveKit, proveedor o bootstrap de la validación.

## Identidad y barreras

- `NODE_ENV=production`
- `APP_ENV=production`
- `APP_DISPLAY_ENV=Producción`
- `APP_NAME=R.A. Training Streaming`
- `APP_PUBLIC_URL=https://<dominio-productivo>`
- `APP_VERSION=<commit-validado>`
- `COOKIE_SECURE=true`
- `ALLOW_OPEN_DEV_ROOMS=false`
- secretos nuevos de 32+ caracteres para `SESSION_SECRET` e `INVITATION_HASH_SECRET`
- LiveKit `wss://` y credenciales server-side
- `TRANSCRIPTION_PROVIDER=deepgram`, endpoint `https://api.deepgram.com/v1/listen`, allowlist `api.deepgram.com` y clave exclusiva de Producción cuando esté habilitado
- modelo/idioma/opciones Deepgram revisados, límites de duración/tamaño, timeout, reintentos y URL firmada entre 300–900 segundos

La aplicación rechaza el arranque si faltan URL HTTPS, cookies seguras, secretos fuertes o LiveKit remoto. Transcripción habilitada en Producción nunca puede usar `mock`.

## Gate de promoción

No promover hasta contar con evidencia de dos dispositivos reales, recepción de cámara/audio/pantalla, Egress con archivo reproducible en bucket privado y transcripción Deepgram real de dos voces. Deben verificarse diarización, palabras/timestamps, edición, renombrado y las cuatro exportaciones. Ejecuta el checklist completo, confirma `/health` operativo y revisa que Producción no herede `X-Robots-Tag` ni el bloqueo de `/robots.txt` de Preview.

Antes de escalar a más de una instancia, sustituye los jobs Deepgram en memoria por una cola duradera. Define también la purga automática de `retentionUntil`, presupuesto/alertas, responsable de consentimiento, rotación/expiración de claves y la política de datos del proveedor. Sin esos controles y sin QA real, el commit no es candidato a Producción.

La persona que aprueba debe comparar el SHA de Preview con `APP_VERSION`, revisar el diff desde `main`, confirmar backups/políticas de retención y programar una ventana de rollback. El merge y el despliegue son acciones separadas y requieren autorización explícita.

## Rollback

1. Conserva datos y auditoría; no borres objetos para revertir código.
2. Vuelve a desplegar el último SHA productivo conocido y verifica `/health`.
3. Restaura variables solo desde el gestor de secretos, nunca desde Git.
4. Revoca invitaciones emitidas durante el incidente cuando corresponda.
5. Documenta síntoma, SHA, hora, impacto y evidencia de recuperación.
6. Si el incidente afecta transcripción, fija `TRANSCRIPTION_ENABLED=false`; rota/revoca la clave Deepgram si existe riesgo de exposición.
