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

## Arranque

```powershell
npm start
```

Abre `http://localhost:3000` e inicia sesión con el bootstrap local. Los datos quedan en `.local-data/` y sobreviven al reinicio de Node.

## LiveKit local

Configura una instancia local con API key/secret de desarrollo y usa la URL `ws://localhost:7880`. Verifica:

1. Crear una reunión y marcarla `LIVE` desde el panel.
2. Abrir como organizador mediante **Iniciar**.
3. Crear un enlace de asistente y abrirlo en otra ventana/perfil.
4. Validar cámara, micrófono, pantalla, chat, preguntas y mano levantada.
5. Confirmar que un viewer no puede llamar promoción, expulsión ni grabación.

Sin LiveKit, usa `npm test`: los endpoints sensibles se validan con mocks y no contactan servicios externos.

## Prueba manual de medios

- Autoriza cámara/micrófono solo en el host local.
- Prueba permiso denegado, dispositivo inexistente y dispositivo ocupado.
- Cambia orientación sin recargar; la instancia `Room` debe permanecer igual.
- Termina la captura de pantalla desde el indicador del navegador y confirma que el botón vuelve a **Compartir pantalla**.
- Prueba Document PiP y, si no está, comprueba el mensaje de compatibilidad o video PiP.
- Pon la pestaña en segundo plano después de activar notificaciones mediante el botón; valida mensaje, mano y fallo de conexión.

## Pruebas automatizadas

```powershell
npm test
npm run build:track-processors
git diff --check
```

Las pruebas usan una carpeta temporal mediante `LOCAL_DATA_DIR`, puerto efímero y servicios LiveKit simulados. No apuntan al `.env` productivo.

## Limpieza

Detén Node con `Ctrl+C`. Si necesitas borrar datos locales de prueba, verifica primero la ruta absoluta de la subcarpeta concreta bajo `.local-data/`; nunca elimines la raíz del repositorio ni uses un destino construido con variables no resueltas.

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
