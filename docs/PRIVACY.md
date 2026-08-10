# Privacidad, grabación y transcripción

Todos los accesos creados con la política de roles actual deben aceptar el aviso de privacidad antes de recibir un token de conexión. Cuando una reunión exige consentimiento de grabación o transcripción, esas decisiones también se registran en la sesión firmada y en auditoría con fecha, sala y valores booleanos; nunca se guarda el token de invitación. Solo las sesiones organizadoras históricas ya emitidas conservan su comportamiento previo para evitar una ruptura retroactiva.

La interfaz distingue capacidad de estado real. Habilitar grabación en una reunión no muestra una grabación activa: el indicador aparece únicamente cuando LiveKit Egress confirma el estado `EGRESS_ACTIVE`. La notificación visible es **“Esta sesión está siendo grabada.”**

La transcripción solo puede solicitarse desde una grabación real marcada como lista y con Deepgram configurado. La respuesta inicial significa trabajo pendiente o en procesamiento, no texto terminado; el porcentaje representa una etapa técnica. El resultado automático puede contener errores, admite revisión manual, renombrado auditable de hablantes, historial de revisión y exportación.

El audio viaja desde el bucket R2 privado hacia Deepgram mediante una URL presignada que caduca entre 5 y 15 minutos. La URL no se guarda en la transcripción ni se entrega desde su API. Deepgram procesa audio y devuelve texto, tiempos, confianza y etiquetas numéricas de speaker; una etiqueta no demuestra la identidad civil de la persona. En Room Composite se presenta “Hablante N” hasta que un usuario autorizado lo corrija.

La retención configurada debe acompañarse de una política operativa del proveedor y del bucket. `retentionUntil` registra una fecha objetivo, pero no ejecuta por sí sola una purga: eliminar una transcripción desde la aplicación elimina su registro gestionado, pero no sustituye la política de borrado del audio ni del proveedor externo. Las exportaciones dejan de estar controladas por la aplicación una vez descargadas.

El adaptador Deepgram rechaza redirecciones, exige endpoint HTTPS exacto, allowlist y bloquea destinos locales o direcciones privadas. Las claves del proveedor y del almacenamiento permanecen exclusivamente en el servidor. La clave de Preview debe ser exclusiva, rotarse desde el gestor de secretos y revocarse al cerrar el entorno.
