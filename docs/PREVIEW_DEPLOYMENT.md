# Preview aislado

`render.preview.yaml` describe un servicio independiente para la rama `feature/optimizacion-streaming-webinar`. No modifica `render.yaml`, no comparte nombre con el servicio existente y tiene despliegue automático desactivado.

## Barreras de arranque

El proceso no inicia con `APP_ENV=preview` hasta que se cumplan todas estas condiciones:

- `NODE_ENV=production`, `APP_PUBLIC_URL` HTTPS y cookies `Secure`.
- secretos independientes de al menos 32 caracteres para sesiones e invitaciones;
- LiveKit aislado con URL `wss://` y credenciales de prueba;
- bucket R2/S3 exclusivamente de Preview con credenciales propias;
- proveedor HTTP real de transcripción con HTTPS, clave de prueba y su hostname exacto en `TRANSCRIPTION_ALLOWED_HOSTS`;
- `PREVIEW_ISOLATION_ACK=true`, únicamente después de comprobar que ningún valor apunta a Producción.

No copies secretos, buckets, proyectos LiveKit, webhooks ni bases de datos de Producción. El servicio debe permanecer en una cuenta/proyecto o namespace separado. Si una integración no está disponible, el arranque falla en lugar de sustituirla por simulaciones.

## Creación y validación

1. Crea el servicio desde `render.preview.yaml` o reproduce exactamente sus campos en un servicio nuevo.
2. Define `APP_PUBLIC_URL` con la URL final del servicio, sin barra final ni ruta.
3. Carga exclusivamente credenciales no productivas y confirma `PREVIEW_ISOLATION_ACK=true`.
4. Despliega manualmente el commit aprobado de la rama feature.
5. Verifica `/health`: debe identificar `preview`, mostrar versión y reportar cada integración como disponible sin revelar URLs o secretos.
6. Verifica que toda respuesta incluya `X-Robots-Tag: noindex, nofollow, noarchive`, que `/robots.txt` bloquee el rastreo y que las cookies de sesión tengan `Secure`, `HttpOnly` y `SameSite=Lax`.
7. Ejecuta la matriz de QA de `docs/RELEASE_CHECKLIST.md`, con dos navegadores y dispositivos reales cuando se prueben medios.

Un estado `degraded` no demuestra una Preview operativa. Tampoco se considera validación real una grabación o transcripción simulada.

## Retirada

Al terminar la revisión, elimina solo el servicio Preview y sus recursos no productivos explícitamente identificados. No ejecutes acciones sobre Producción y no reutilices sus secretos.
