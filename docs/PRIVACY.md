# Privacidad, grabación y transcripción

Los asistentes deben aceptar el aviso de privacidad antes de recibir un token de conexión. Cuando una reunión exige consentimiento de grabación o transcripción, esas decisiones también se registran en la sesión firmada y en auditoría con fecha, sala y valores booleanos; nunca se guarda el token de invitación.

La interfaz distingue capacidad de estado real. Habilitar grabación en una reunión no muestra una grabación activa: el indicador aparece únicamente cuando LiveKit Egress confirma el estado `EGRESS_ACTIVE`. La notificación visible es **“Esta sesión está siendo grabada.”**

La transcripción solo puede solicitarse desde una grabación real marcada como lista y con un proveedor HTTP configurado. La respuesta inicial significa trabajo en cola o en procesamiento, no texto terminado. El resultado automático puede contener errores, admite revisión manual, historial de revisión y exportación. La retención configurada debe acompañarse de una política operativa del proveedor y del bucket; eliminar una transcripción desde la aplicación elimina su registro gestionado, pero no sustituye la política de borrado del proveedor externo.

El adaptador HTTP rechaza redirecciones y, en Preview/Producción, exige HTTPS y bloquea destinos locales o direcciones privadas. Las claves del proveedor y del almacenamiento permanecen exclusivamente en el servidor.
