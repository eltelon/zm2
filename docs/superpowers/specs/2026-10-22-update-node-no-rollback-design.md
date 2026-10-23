# update-node --no-rollback

Semántica aprobada por el usuario en esta conversación.

## Contrato

`zm2 update-node <version> --no-rollback` conserva el nuevo ejecutable, PATH y metadatos aunque un reinicio o la verificación de arranque falle. El comportamiento sin flag no cambia.

- Se aplican los archivos y daemon-reload; se persiste el intérprete nuevo antes de intentar reinicios.
- Se intenta reiniciar y verificar cada instancia originalmente activa, incluso si falla una instancia anterior. Las detenidas siguen detenidas.
- Un fallo de reinicio o verificación no restaura archivos, metadatos ni runtime anterior; se continúa con las demás aplicaciones.
- Se reporta `failed_no_rollback`: configuración actualizada, arranque fallido, sin rollback. Cuenta como fallo y devuelve salida 1, sin afirmar que la aplicación esté ejecutándose con el runtime nuevo.
- La verificación se mantiene: el flag no oculta errores ni transforma un fallo en éxito.
- Fallos de instalación, validación, escritura, daemon-reload o persistencia no son fallos de arranque y mantienen las protecciones existentes. No se intentan reinicios si la configuración y los metadatos nuevos no pudieron guardarse.

## API y compatibilidad

La API conserva `updateNode(version, callback?)` y agrega `updateNode(version, { rollback: false }, callback?)`. El coordinador recibe `rollback: false` como opción de construcción; el valor predeterminado es true. El estado nuevo se agrega al tipo público del reporte sin cambiar sus campos ni totales.

## Verificación

Pruebas de fallos de restart/verificación con configuración nueva persistida, continuación entre instancias/aplicaciones, detenidas intactas, salida 1 y reporte sin falsa restauración. Pruebas de protección ante fallos de escritura/persistencia, API compatible, parseo de Commander y recorrido con RuntimeConfig/StateStore reales y systemd simulado. No se ejecutarán servicios reales en macOS.
