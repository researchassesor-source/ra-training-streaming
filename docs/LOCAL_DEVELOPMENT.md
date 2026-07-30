# Desarrollo local

## Preparación segura

```powershell
npm ci
Copy-Item .env.example .env
```

Configura credenciales exclusivamente locales. Mantén vacías las variables `RECORDING_S3_*` para deshabilitar R2 y grabación. Usa un `SESSION_SECRET` aleatorio distinto de Producción.

Valores recomendados para una primera ejecución:

```dotenv
NODE_ENV=development
PORT=3000
COOKIE_SECURE=false
ALLOW_OPEN_DEV_ROOMS=false
LIVEKIT_WS_URL=ws://localhost:7880
```

No establezcas `ALLOW_OPEN_DEV_ROOMS=true` salvo una prueba deliberada. La aplicación funciona con reuniones registradas aunque LiveKit no esté iniciado.

## Arranque reproducible

```powershell
npm run livekit:up
npm start
```

Abre `http://localhost:3000` e inicia sesión con el bootstrap local. Los datos quedan en `.local-data/` y sobreviven al reinicio de Node.

## LiveKit local

El proyecto fija LiveKit Server `v1.13.1` y claves exclusivas de desarrollo (`devkey` / `secret`). No las reutilices fuera del equipo local.

### Opción A: Docker

Con Docker Desktop operativo, `npm run livekit:up` usa `docker-compose.livekit.yml`. Expone HTTP/WebSocket `7880`, RTC/TCP `7881` y RTC/UDP `7882`.

### Opción B: binario oficial en Windows

Si Docker no existe:

```powershell
npm run livekit:install
npm run livekit:up
```

El instalador descarga `livekit_1.13.1_windows_amd64.zip` desde la publicación oficial, verifica SHA-256 `57afee4cdb044e5fda04c2cc00ca30f4c783bea1f1ea2f483321ce4b9cff4acf` y lo guarda bajo `.tools/livekit/`, fuera de Git. El proceso y sus registros viven bajo `.local-runtime/livekit/`.

### Secuencia manual de QA

1. Ejecuta `npm run livekit:up` y `npm start` (o `npm run dev`).
2. Abre `http://localhost:3000`, inicia sesión y crea una reunión Programada.
3. Pulsa **Iniciar**: la reunión sigue Programada durante el preflight.
4. Conecta al organizador/panelista; solo la confirmación de LiveKit cambia el estado a En vivo.
5. Crea un enlace de asistente y ábrelo en otro navegador o perfil.
6. Autoriza y prueba cámara, micrófono, participantes, chat, Q&A persistente, reacciones, mano levantada y pantalla.
7. Al compartir, abre el panel flotante, controla medios y detén la captura. Si Document PiP falla, confirma el fallback arrastrable dentro de la pestaña.
8. Cierra el panel lateral y verifica que el escenario use todo el ancho. Prueba bloqueo/desbloqueo e invitaciones internas.
9. Prueba reconexión y **Salir**; luego usa **Finalizar para todos** desde el organizador.
10. Comprueba auditoría: entradas, reconexión, medios relevantes, preguntas respondidas, bloqueo y finalización.
11. Detén Node con `Ctrl+C` y ejecuta `npm run livekit:down`.

Para reproducir el caso que antes mezclaba identidades, también se permite usar dos pestañas del mismo perfil: abre primero al organizador, canjea después la invitación de asistente y confirma que ambos siguen enviando mutaciones. La URL debe limpiarse después del canje; cada pestaña mantiene su selector en `sessionStorage`, mientras la credencial continúa exclusivamente en una cookie HttpOnly firmada.

El dashboard distingue **configurado** de **disponible** mediante una consulta real a la API de LiveKit. Sin servicio, **Iniciar** devuelve un aviso, no crea un falso estado LIVE, no incrementa activas y no registra una reunión iniciada.

## Prueba manual de medios

- Autoriza cámara/micrófono solo en el host local.
- Prueba permiso denegado, dispositivo inexistente y dispositivo ocupado.
- Cambia orientación sin recargar; la instancia `Room` debe permanecer igual.
- Termina la captura de pantalla desde el indicador del navegador y confirma que el botón vuelve a **Compartir pantalla**.
- Confirma con otro participante que una publicación real `ScreenShare` crea un único spotlight con vídeo reproducible, conserva las cámaras y desaparece al despublicarse. Verifica `ScreenShareAudio` por separado cuando la fuente elegida lo ofrezca.
- Prueba Document PiP y, si no está o la ventana se cierra al abrir, comprueba el panel flotante interno y su mensaje de compatibilidad.
- Pon la pestaña en segundo plano después de activar notificaciones mediante el botón; valida mensaje, mano y fallo de conexión.

## Pruebas automatizadas

```powershell
npm test
npm run build:track-processors
git diff --check
```

Las pruebas usan una carpeta temporal mediante `LOCAL_DATA_DIR`, puerto efímero y servicios LiveKit simulados. No apuntan al `.env` productivo.

La matriz automatizada incluye sesiones simultáneas con cookies separadas, CSRF correcto e incorrecto, consentimiento y persistencia de palabra, bloqueo sin consumo de invitación, sesión existente durante bloqueo, creación/voto/respuesta de Q&A, tracks vivos/muteados/terminados, ScreenShare y audio, sincronización del modelo flotante compacto/expandido, fallback, agrupación anti-spam, limpieza de listeners y contratos responsive.

## Limpieza

Detén Node con `Ctrl+C` y LiveKit con `npm run livekit:down`. Si necesitas borrar datos locales de prueba, verifica primero la ruta absoluta de la subcarpeta concreta bajo `.local-data/`; nunca elimines la raíz del repositorio ni uses un destino construido con variables no resueltas.

## Transcripción local

La transcripción está desactivada de forma predeterminada. Para pruebas automatizadas se inyecta un proveedor mock y un fixture explícito; el mock no inventa conversaciones. Para una integración local real usa `TRANSCRIPTION_PROVIDER=http`, una URL HTTPS (o localhost en desarrollo) y una clave de prueba:

```dotenv
TRANSCRIPTION_ENABLED=true
TRANSCRIPTION_PROVIDER=http
TRANSCRIPTION_LANGUAGE=es
TRANSCRIPTION_MAX_DURATION_MINUTES=240
TRANSCRIPTION_RETENTION_DAYS=90
TRANSCRIPTION_API_URL=https://proveedor-de-prueba.example/v1/transcriptions
TRANSCRIPTION_API_KEY=valor-local-no-versionado
```

No copies credenciales reales a capturas, logs, issues o fixtures. Consulta [TRANSCRIPTION.md](TRANSCRIPTION.md) para el contrato del proveedor, permisos, privacidad y limitaciones.

## Comprobación visual local

Además de las pruebas automatizadas, revisa login, calendario, sala previa, grabaciones y transcripción en 360×640, 375×667, 390×844, 412×915, 768×1024, 1024×768, 1366×768 y 1920×1080. En cada tamaño comprueba foco visible, ausencia de scroll horizontal, teclado móvil, diálogos, estados vacíos y que el logo oficial conserve proporción.
