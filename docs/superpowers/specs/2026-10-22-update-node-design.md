# Actualización de runtimes Node mediante nvm

## Objetivo y decisiones aprobadas

Agregar `zm2 update-node <versión>` para actualizar las aplicaciones Node registradas en ZM2 utilizando la instalación de nvm de un único usuario.

- Instalar la versión solicitada si falta.
- Cambiar el ejecutable de Node y el `PATH` de las aplicaciones elegibles.
- Procesar aplicaciones secuencialmente y conservar su estado activo/detenido.
- Ante un fallo, revertir únicamente la aplicación afectada y continuar.
- Reportar resultados individuales y devolver un código distinto de cero si hubo fallos.
- No actualizar el propio ZM2 ni cambiar el Node predeterminado de nvm.

## Contexto del código actual

- `lib/binaries/CLI.js` registra comandos mediante Commander.
- `lib/Common.js` ya reconoce intérpretes `node@<versión>` y puede instalar versiones usando `NVM_DIR`. No proporciona una operación de actualización con rollback.
- `lib/Systemd/UnitGenerator.js` genera `ExecStart` usando el intérprete, los argumentos de Node, el script y sus argumentos. Las unidades incluyen un archivo de entorno por aplicación.
- `lib/SystemdClient.js` registra aplicaciones y sus intérpretes en StateStore. El reinicio actual no cambia el ejecutable de la unidad.
- `lib/Systemd.js` encapsula escritura de unidades, `daemon-reload`, control y consulta de servicios.
- `lib/Systemd/StateStore.js` conserva metadatos, pero no toda la configuración necesaria para regenerar fielmente una unidad existente.

Por lo tanto, no se regenerarán unidades completas a partir de StateStore: se modificarán únicamente el ejecutable de `ExecStart` y el `PATH`, preservando las demás directivas.

## Contrato CLI

```bash
zm2 update-node 26.12.1
```

Se acepta una versión exacta `major.minor.patch`, opcionalmente precedida de `v`. Se normaliza antes de invocar nvm. No se aceptan alias como `lts`, `node` ni rangos semver en esta primera versión.

El comando opera sobre todas las aplicaciones registradas en el ZM2 home seleccionado por los mecanismos existentes. No agrega filtros ni opciones nuevas.

### Contexto de usuario y privilegios

Se usa un solo nvm: `NVM_DIR` si está definido; de lo contrario, `$HOME/.nvm`. Debe existir un `nvm.sh` legible. No se instala nvm automáticamente.

La ejecución necesita los privilegios existentes para modificar unidades en `/etc/systemd/system`, archivos en `/etc/zm2/env` y controlar systemd. También necesita acceso al StateStore y al directorio nvm seleccionado. Se validan estos requisitos antes de instalar Node o modificar servicios.

No se adivina otro usuario a partir de `SUDO_USER`, no se cambia de usuario y no se ejecuta `sudo` internamente. Si se invoca mediante sudo, el operador debe seleccionar explícitamente el nvm y ZM2 home correctos; no se debe terminar actualizando accidentalmente el nvm o StateStore de root.

## Selección de aplicaciones

- Se enumeran las entradas de StateStore, no todos los servicios de la máquina.
- Son elegibles las aplicaciones cuyo intérprete es Node: `node`, una referencia `node@<versión>` o una ruta al ejecutable Node. Se contrasta con el ejecutable real de `ExecStart` antes de modificarlo.
- Se omiten otros intérpretes y aplicaciones ejecutadas mediante wrappers como shell, npm o un ejecutable directo: no se intenta reinterpretar sus comandos.
- Se excluye el servicio interno HTTP API de ZM2, reservado como infraestructura. No se reinicia ni modifica el propio ZM2.
- Una entrada Node con unidad ausente o un `ExecStart` que no puede modificarse de forma segura se reporta como fallo, no como actualización exitosa.
- Las versiones anteriores se obtienen del ejecutable configurado, no de la versión de Node del proceso CLI. Si no puede consultarse la versión anterior, se muestra como desconocida; si tampoco puede garantizarse una restauración segura, no se modifica la aplicación.
- Si no hay aplicaciones elegibles para modificar, no se instala Node. Se finaliza correctamente solo si tampoco hubo fallos de selección o preflight; las entradas Node inválidas siguen produciendo código de salida `1`.

## Preparación del runtime

1. Validar versión, Linux/systemd, nvm, permisos y acceso válido al StateStore. Un StateStore ilegible o corrupto es un error, no una lista vacía.
2. Enumerar aplicaciones y preparar el resumen de omitidas y fallidas.
3. Cargar explícitamente `nvm.sh` en un shell no interactivo, sin depender de `.bashrc`.
4. Usar la versión ya instalada o instalarla mediante nvm.
5. Resolver su ruta absoluta y comprobar con `node --version` que coincide con la versión solicitada.
6. Mantener el alias predeterminado existente de nvm sin cambios; la selección del shell hijo no cambia el shell del operador.

La versión y las rutas se pasan como argumentos/datos, no se concatenan como instrucciones shell. Si falla esta preparación, no se modifica ninguna aplicación y el reporte identifica las aplicaciones pendientes como no actualizadas por el fallo global.

No se eliminan versiones anteriores de nvm, ni después de un éxito ni después de un fallo. Una instalación incompleta o una versión nueva instalada no implica rollback del directorio nvm.

## Actualización por aplicación

### Snapshot

Antes de modificar una aplicación se capturan:

- El contenido, permisos y propietario de su unidad, o de su unidad plantilla.
- El contenido, permisos, propietario y existencia previa del archivo de entorno afectado.
- Los metadatos originales de StateStore.
- El estado de cada instancia y cuáles estaban ejecutándose.

Se rechazan estados transitorios como arranque o parada en curso: no se adivina si corresponde reiniciar. El snapshot debe permitir restaurar la aplicación sin reconstruir su configuración a partir de metadatos incompletos.

### Aplicación de cambios

1. Reemplazar únicamente el ejecutable inicial de `ExecStart` por la ruta absoluta del nuevo Node, conservando argumentos, script y demás directivas. Usar el escape de systemd adecuado; rechazar formatos no soportados antes de escribir.
2. Anteponer el directorio `bin` del runtime al `PATH` efectivo mediante el archivo de entorno de la aplicación, conservando el resto del entorno y el resto del `PATH`. Si no había un `PATH` explícito, usar `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` como base; no copiar el `PATH` del shell privilegiado ni escribir `$PATH` esperando expansión de systemd. Si hay overrides de entorno que impidan determinar/controlar el valor efectivo, fallar sin modificar la aplicación.
3. Escribir los archivos conservando sus permisos y propietario; evitar dejar archivos parcialmente escritos.
4. Ejecutar `systemctl daemon-reload`.
5. Reiniciar únicamente las instancias que estaban ejecutándose. No modificar su habilitación de arranque automático.
6. Verificar el arranque de las instancias reiniciadas.
7. Persistir el nuevo `exec_interpreter` en StateStore. La persistencia forma parte del éxito; su fallo inicia rollback.

Las aplicaciones detenidas reciben la nueva configuración sin arrancar. Su resultado indica expresamente que no se verificó el arranque.

Si la configuración ya apunta al mismo runtime, se informa como omitida por estar actualizada solo si también cumple el `PATH` requerido; de lo contrario se corrige la configuración mediante el flujo normal.

### Verificación de arranque

Para cada instancia reiniciada se consulta systemd cada 500 ms durante una ventana de 5 segundos posterior al reinicio. Se requiere que permanezca `active/running`, con PID principal válido, sin incremento de `NRestarts` durante la ventana. La línea base se obtiene después del reinicio solicitado, para distinguirlo de reinicios automáticos.

También se comprueba que el ejecutable del proceso principal corresponda al Node seleccionado. Un fallo de consulta o una discrepancia impiden declarar éxito.

Esta comprobación detecta fallos tempranos de arranque; no verifica disponibilidad HTTP, conexión a bases de datos ni salud funcional. Una aplicación puede fallar después de la ventana. Los procesos de ejecución breve que terminan dentro de la ventana no se consideran servicios actualizados correctamente.

### Varias instancias

Una aplicación con `instances > 1` constituye una unidad de actualización: se modifica su plantilla y se conserva el estado previo de cada instancia. Si falla cualquier instancia activa, se revierte toda esa aplicación, no solo la instancia fallida. Los resultados incluyen el nombre de la instancia causante cuando corresponde.

No se promete cero downtime. Las aplicaciones se procesan una por una y las instancias de una aplicación también se reinician secuencialmente.

## Rollback y continuidad

Ante cualquier error después de iniciar cambios:

1. Restaurar los archivos originales, incluida la ausencia previa de un archivo si fue creado.
2. Ejecutar `daemon-reload` sobre la configuración restaurada.
3. Restaurar los metadatos originales sin cambiar los identificadores de procesos.
4. Intentar recuperar las instancias que estaban ejecutándose y conservar detenidas las demás. Si se alcanzó un límite de arranques de systemd, limpiar el estado fallido únicamente de esas instancias antes de recuperarlas.
5. Verificar la recuperación con la misma ventana de observación, usando el ejecutable anterior.

Se intentan todas las acciones de restauración aplicables aunque falle alguna, conservando el error original y los errores de recuperación. Un rollback solo se reporta como correcto si se restauraron configuración, metadatos y estado esperado.

El fallo de una aplicación, incluso de su rollback, no impide intentar actualizar las siguientes. Un fallo global de preparación sí impide comenzar actualizaciones.

Los snapshots se mantienen durante la operación para rollback automático. No se incorpora un comando de rollback manual ni recuperación transaccional frente a SIGKILL, corte de energía o cambios concurrentes por otros administradores. La operación requiere que no se modifiquen simultáneamente las aplicaciones afectadas.

## Reporte final

Se muestra una fila por aplicación registrada, identificando su servicio systemd:

| Servicio | Versión anterior | Versión solicitada | Resultado |
|---|---|---|---|
| zm2-api-app | 24.8.0 | 26.12.1 | actualizado |
| zm2-worker | 24.8.0 | 26.12.1 | fallido, restaurado a 24.8.0 |
| zm2-scheduler | 24.8.0 | 26.12.1 | actualizado, permanece detenido; arranque no verificado |
| zm2-python | — | — | omitido: intérprete no Node |

Resultados posibles:

- **Actualizado**.
- **Actualizado, permanece detenido**: configuración aplicada sin arrancarlo.
- **Omitido**, con motivo, incluido servicio interno o runtime ya actualizado.
- **Fallido sin cambios**, con motivo.
- **Fallido, restaurado**, indicando versión efectiva anterior.
- **Fallido, restauración fallida**, con los errores de actualización y rollback; no afirmar una versión efectiva sin poder verificarla.
- **No actualizado por fallo global de preparación**, con motivo.

El reporte incluye totales de actualizados, omitidos, fallidos y no actualizados por un error global. Se conserva el detalle de errores por servicio y se indica cómo consultar su journal, sin volcar variables de entorno ni secretos.

Código de salida `0` si todas las aplicaciones elegibles se actualizaron o ya estaban actualizadas y no hubo errores. Código `1` ante errores globales o cualquier fallo de aplicación, aunque su rollback haya sido correcto.

## Límites del alcance

- No actualizar el propio ZM2 ni su servicio HTTP API.
- No instalar nvm, gestionar varios usuarios ni modificar alias predeterminados.
- No actualizar dependencias, paquetes globales, lockfiles ni ejecutar `npm rebuild`.
- No borrar versiones anteriores de Node.
- No modificar ecosystem files: un inicio posterior desde una configuración que fija otro intérprete puede volver a seleccionar ese runtime.
- No agregar endpoint HTTP, modo dry-run, filtros ni health checks configurables en esta versión.
- No garantizar compatibilidad de módulos nativos entre versiones mayores de Node; advertirlo antes de aplicar cambios.

## Componentes propuestos

- **CLI/API**: registro de `update-node`, validación de entrada, coordinación y presentación del reporte. La lógica de operación devuelve resultados estructurados para poder probarse sin leer stdout.
- **Adaptador nvm**: detección, instalación y resolución/verificación del ejecutable, aislado de systemd.
- **Actualizador de runtime**: selección, snapshots, ejecución secuencial, verificación, persistencia y rollback por aplicación.
- **Systemd/StateStore existentes**: reutilizar sus operaciones de control y persistencia; agregar únicamente auxiliares enfocados de lectura/escritura/consulta cuando hagan falta.

No se duplica el flujo completo de creación de aplicaciones ni se refactoriza código ajeno a esta funcionalidad.

## Verificación prevista

Pruebas unitarias con nvm, filesystem, temporizadores y systemd simulados:

- Versiones válidas/invalidas, rutas con espacios y rechazo de inyección shell.
- Runtime instalado, instalación exitosa, versión inexistente, nvm ausente y fallo global sin cambios de servicios.
- Conservación de alias predeterminado y resolución del contexto correcto de nvm/StateStore.
- Aplicaciones Node elegibles; wrappers, otros intérpretes e infraestructura omitidos; metadatos/unidades inconsistentes reportados.
- Preservación de directivas, argumentos, permisos y entorno; nuevo `PATH` sin expansión shell ni filtración del entorno privilegiado.
- Actualización y persistencia exitosas, aplicación detenida y operación repetida sobre el mismo runtime.
- Verificación temporal: proceso estable, caída temprana, reinicio automático y ejecutable inesperado.
- Fallos en escritura, reload, restart, consulta y persistencia: restauración exacta y continuación con la siguiente aplicación.
- Rollback fallido identificado sin ocultar el error original.
- Plantillas con varias instancias y estados activos/detenidos mezclados.
- Reporte final, totales y códigos de salida, incluido cero aplicaciones elegibles.

Pruebas de integración en Linux con systemd y nvm, fuera de producción: actualizar una aplicación estable, otra que falla con el runtime nuevo y una detenida; comprobar el ejecutable real, estado final, rollback y reporte. En macOS solo se validan las pruebas con dependencias simuladas, no la integración real con systemd.
