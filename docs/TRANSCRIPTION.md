# Transcripciones

## Alcance

La aplicación puede crear una transcripción a partir de una grabación privada asociada a una reunión completada. El flujo es asíncrono: crea un trabajo, consulta su estado, persiste el resultado revisable y permite exportarlo. No se transcribe audio del micrófono directamente desde el navegador.

## Configuración

| Variable | Propósito |
|---|---|
| `TRANSCRIPTION_ENABLED` | Habilita el subsistema. Valor predeterminado: `false`. |
| `TRANSCRIPTION_PROVIDER` | `http` para integración real o `mock` únicamente en pruebas/desarrollo. |
| `TRANSCRIPTION_API_URL` | Endpoint HTTPS del proveedor. En desarrollo también se admite localhost. |
| `TRANSCRIPTION_API_KEY` | Credencial enviada solo desde el servidor. |
| `TRANSCRIPTION_LANGUAGE` | Idioma predeterminado, por ejemplo `es`. |
| `TRANSCRIPTION_MAX_DURATION_MINUTES` | Límite antes de enviar una grabación. |
| `TRANSCRIPTION_RETENTION_DAYS` | Fecha objetivo registrada en `retentionUntil`. |
| `TRANSCRIPTION_RATE_LIMIT_MAX` | Creaciones o reintentos permitidos por hora y usuario. |

`NODE_ENV=production` rechaza una configuración habilitada con proveedor `mock`. No versionar `.env`, claves, URLs firmadas ni respuestas originales que contengan datos reales.

## Contrato del proveedor HTTP

El servidor envía `POST` al endpoint configurado con `Authorization: Bearer`, JSON y una URL firmada de corta duración. La solicitud incluye `recordingUrl`, `language`, identificadores de reunión/grabación y metadata filtrada de participantes. Se espera una respuesta con identificador de trabajo y estado.

Las consultas posteriores usan `GET {TRANSCRIPTION_API_URL}/jobs/{jobId}`, el resultado usa `GET .../jobs/{jobId}/transcript` y la cancelación usa `POST .../jobs/{jobId}/cancel`. Un resultado completo puede contener `segments` con:

```json
{
  "startMs": 1200,
  "endMs": 4800,
  "text": "Contenido del segmento",
  "speaker": "speaker_0",
  "participantIdentity": "identidad-livekit",
  "trackSid": "TR_...",
  "confidence": 0.94
}
```

Adapta `transcription-provider.js` si el proveedor elegido usa otro contrato. Mantén la normalización de errores: la interfaz muestra mensajes seguros y el detalle del proveedor no se expone al cliente.

## Estados y operaciones

Estados: `NOT_AVAILABLE`, `READY`, `QUEUED`, `PROCESSING_AUDIO`, `IDENTIFYING_PARTICIPANTS`, `GENERATING_TRANSCRIPT`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, `FAILED` y `CANCELLED`.

- Crear exige grabación disponible, reunión completada, permiso de transcripción y duración dentro del límite.
- Consultar actualiza un trabajo no terminal antes de responder.
- Reintentar crea un trabajo nuevo sobre la misma grabación.
- Cancelar solicita cancelación al proveedor y conserva trazabilidad.
- Editar nombres o texto incrementa `revision`; una revisión obsoleta devuelve conflicto.
- Eliminar borra el registro persistido. La eliminación remota depende del contrato del proveedor y de la política administrativa.
- Exportar admite TXT, JSON, WebVTT y SRT con orden y timestamps normalizados.

Todas estas operaciones relevantes producen eventos de auditoría sin secretos.

## Permisos

| Acción | ADMIN | ORGANIZER autorizado | PANELIST permitido | VIEWER |
|---|---:|---:|---:|---:|
| Ver y exportar | Sí | Sí | Sí | No |
| Crear/regenerar/cancelar | Sí | Sí | No | No |
| Editar/eliminar | Sí | Sí | No | No |

“ORGANIZER autorizado” significa creador o entrenador asignado a la reunión. PANELIST requiere ser el `trainerId` asignado y que `allowPanelistTranscriptAccess=true` en la reunión.

## Identidad y diarización

La aplicación intenta asociar cada segmento con `participantIdentity` o `trackSid` guardados en la metadata de grabación. Si no existe una coincidencia fiable, asigna un rótulo estable “Participante sin identificar N”. Nunca infiere un nombre humano a partir de la posición del segmento.

Room Composite Egress produce una salida mezclada. La precisión de diarización y atribución depende del proveedor y del solapamiento de voces. Si la atribución individual es un requisito contractual, usa Egress por participante o pista y conserva el mapa LiveKit correspondiente.

## Privacidad, retención y costes

Una transcripción contiene datos personales y potencialmente sensibles. Informa a los participantes, solicita el consentimiento exigible y limita `allowTranscription` a reuniones apropiadas. Las descargas y copias quedan bajo responsabilidad del usuario autorizado.

`retentionUntil` permite mostrar y auditar la fecha objetivo, pero esta entrega no incorpora un scheduler que purgue automáticamente almacenamiento y proveedor. Producción necesita una tarea operativa idempotente que elimine registros vencidos, objetos derivados y trabajos remotos, y registre el resultado.

Los costes dependen de minutos de audio, almacenamiento, solicitudes y reintentos del proveedor. Configura duración máxima, rate limit y alertas de consumo antes de habilitar el servicio.

## Validación antes de Producción

1. Usar bucket, LiveKit y proveedor aislados de Producción.
2. Verificar que la URL firmada caduca y no aparece en logs o respuestas permanentes.
3. Ejecutar estados correcto, largo, fallido, cancelado y reintento.
4. Probar voces solapadas, silencios, idioma, nombres desconocidos y metadata parcial.
5. Confirmar 403 de VIEWER y acceso condicional de PANELIST.
6. Revisar las cuatro exportaciones, sanitización, conflicto de revisión y borrado.
7. Definir responsable, plazo de retención, proceso de purga, presupuesto y respuesta a incidentes.

La activación final debe hacerse mediante Preview aprobado. Esta implementación no realiza Preview, push, PR, merge ni despliegue.
