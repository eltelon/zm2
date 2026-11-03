# Update Node via nvm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar `zm2 update-node <versión>` para actualizar aplicaciones Node mediante nvm, con rollback por aplicación y reporte final verificable.

**Architecture:** Un adaptador nvm prepara el ejecutable; un actualizador coordina snapshots, cambios de configuración, comprobación de arranque y recuperación secuencial. CLI y API son adaptadores delgados: no regeneran unidades desde StateStore ni incorporan un nuevo gestor de runtimes.

**Tech Stack:** CommonJS, Node.js >=16, Commander 2.15, systemd, nvm para Linux, Mocha, Should.js y módulos estándar de Node. No agregar dependencias.

---

## Especificación y límites

Referencia normativa: `docs/superpowers/specs/2026-10-22-update-node-design.md`, aprobada por el usuario.

Ejecutar cambios de implementación en una rama/worktree dedicada, sin tocar `.claude/` ni otros archivos ajenos. Este documento solo planifica: no modifica runtimes ni servicios.

Mantener el Node predeterminado de nvm, las versiones anteriores y todas las directivas ajenas al runtime. No agregar filtros, dry-run, endpoints HTTP, actualizaciones de ZM2, reconstrucción de dependencias ni rollback manual. No inferir otro usuario bajo sudo; validar explícitamente el contexto nvm/ZM2 y los permisos antes de instalar Node.

## Mapa de archivos

Crear:
- `lib/tools/Nvm.js`: validar versión y localizar/instalar/verificar un runtime nvm.
- `lib/Systemd/RuntimeConfig.js`: inspeccionar y modificar únicamente `ExecStart`/`PATH`; snapshots y restauración de archivos.
- `lib/Systemd/RuntimeVerifier.js`: observar arranque y ejecutable real sin bloquear el event loop.
- `lib/Systemd/NodeRuntimeUpdater.js`: preflight, selección y transacción por aplicación; devuelve resultados estructurados.
- `lib/API/UpdateNode.js`: extensión API, reporte y códigos de salida.
- `test/programmatic/nvm.mocha.js`.
- `test/programmatic/systemd_runtime_config.mocha.js`.
- `test/programmatic/systemd_runtime_verifier.mocha.js`.
- `test/programmatic/systemd_node_update.mocha.js`.
- `test/programmatic/update_node_cli.mocha.js`.
- `test/e2e/systemd/update-node.sh` y fixtures dentro de `test/fixtures/update-node/`.

Modificar:
- `lib/Systemd/StateStore.js`: lectura estricta optativa, guardado atómico y restauración exacta de una entrada.
- `lib/Systemd.js`: auxiliares de consulta de configuración efectiva y ejecutable del PID; reset de fallo limitado al servicio solicitado.
- `lib/API.js`: cargar la extensión `UpdateNode` junto a las demás extensiones.
- `lib/binaries/CLI.js`: registrar `update-node <version>` antes del catch-all.
- `types/index.d.ts`: método API y resultado público.
- `test/programmatic/systemd_state_store.mocha.js`: mantener comportamiento legado y probar las nuevas garantías.
- `test/unit.sh`: registrar explícitamente las suites nuevas.
- `README.md`: uso, requisitos, resultados y advertencias.

## Contratos compartidos

Los siguientes contratos son objetivos de implementación, no código existente. Los módulos reciben dependencias en el constructor para probar procesos, filesystem y temporizadores sin mocks globales persistentes. En producción usan los módulos estándar existentes.

```text
Nvm(options)
  validateVersion(input) -> string normalizada sin prefijo v; lanza ante entrada inválida
  prepare(version) -> Promise<{version, executable, binDir}>

RuntimeConfig(options)
  inspect(entry) -> snapshot inmutable con unidad, entorno, metadatos y ejecutable anterior
  plan(snapshot, runtime) -> {changed, unitContent, envContent}
  apply(snapshot, plan) -> void; lanza si falla cualquier escritura
  restore(snapshot) -> void; intenta restaurar todos los archivos y agrega errores

RuntimeVerifier(options)
  verify(serviceName, expectedExecutable) -> Promise<void>

NodeRuntimeUpdater(options)
  run(version) -> Promise<UpdateNodeReport>

StateStore.load(options?) -> this; options.strict predeterminado false
StateStore.replace(serviceName, metadata) -> this
Systemd.getRuntimeProperties(serviceName) -> objeto de propiedades efectivas de systemctl show
Systemd.getProcessExecutable(pid) -> ruta real desde /proc/<pid>/exe
Systemd.resetFailed(serviceName) -> resultado de systemctl reset-failed de esa unidad

API.prototype.updateNode(version, callback?) -> void
callback(error|null, report) se invoca exactamente una vez y no termina el proceso
```

`NodeRuntimeUpdater.run` convierte errores operativos, incluidos los globales, en reportes; no pierde resultados parciales. `RuntimeConfig` no instala Node ni reinicia servicios. `RuntimeVerifier` no modifica archivos ni StateStore. `StateStore.replace` reemplaza completamente una entrada existente sin actualizar timestamps ni mezclar campos, para permitir restauración exacta; el guardado exitoso es atómico.

```text
UpdateNodeReport = {
  requestedVersion: string,
  runtime: null | {version: string, executable: string, binDir: string},
  globalError: null | string,
  results: Array<{
    serviceName: string,
    name: string,
    previousVersion: string|null,
    status: 'updated'|'skipped'|'failed_unchanged'|'failed_restored'|
            'failed_restore'|'not_updated',
    stopped: boolean,
    startupVerified: boolean,
    reason: string|null,
    errors: string[],
    rollbackErrors: string[]
  }>,
  totals: {updated: number, skipped: number, failed: number, notUpdated: number},
  exitCode: 0|1
}
```

`stopped` indica que ninguna instancia estaba activa; el reporte de aplicaciones mixtas debe aclarar que las instancias previamente detenidas no se verificaron. Las filas fallidas incluyen el identificador de la instancia causante en el detalle. `globalError` cubre versión/contexto/nvm/StateStore; errores por aplicación no se convierten en error global. El callback recibe un error si `exitCode` es `1`, junto con el reporte completo. Sin callback, la extensión imprime el reporte y usa `exitCli` una vez.

## Verificación y baseline

Usar comandos directos de Mocha, con `--retries 0` para que los reintentos no oculten errores. En cada tarea: escribir prueba, observar RED por el comportamiento ausente, implementar, observar GREEN y recién entonces hacer commit.

Baseline comprobado durante la planificación: **59 pruebas pasan** ejecutando:

```bash
node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_state_store.mocha.js test/programmatic/systemd_logs.mocha.js
```

Repetir este baseline al iniciar implementación; la cifra describe la ejecución de planificación, no las pruebas nuevas todavía inexistentes.

El runner legado `test/unit.sh` referencia `bin/pm2` y suites ajenas al modo systemd. No arreglar ese runner de forma general ni presentar su ejecución como prueba de integración real. Registrar las suites nuevas usando su mecanismo actual y correrlas también directamente. Las pruebas reales de systemd/nvm solo se ejecutan en Linux desechable con permisos administrativos.

### Task 1: StateStore estricto y restauración exacta

**Files:** modificar `lib/Systemd/StateStore.js` y `test/programmatic/systemd_state_store.mocha.js`.

**References:** `load`, `save` y `register` actuales; la lectura tolerante de archivos corruptos debe seguir siendo el comportamiento predeterminado para consumidores existentes.

**Acceptance:** el actualizador puede rechazar JSON corrupto o estructuras inválidas, preservar una entrada exactamente y persistir sin truncar un archivo válido si falla la escritura.

- [ ] Escribir pruebas para `load({strict:true})`: JSON corrupto, lectura denegada, `services` inválido, archivo inexistente y estado válido. Archivo inexistente representa lista vacía; corrupción y permisos producen error.
- [ ] Escribir pruebas para `replace`: conserva `pm_id`, timestamps y campos originales, elimina campos nuevos y rechaza una entrada inexistente. Cubrir fallo de persistencia sin dejar un estado en memoria diferente del disco válido anterior.
- [ ] Ejecutar `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_state_store.mocha.js`; confirmar RED en los casos nuevos, no por un error del test.
- [ ] Implementar la lectura estricta optativa y `replace`; hacer atómico `save` mediante archivo temporal en el mismo directorio y rename, conservando propietario/permisos existentes y limpiando temporales al fallar. Mantener el formato JSON y el comportamiento público previo.
- [ ] Repetir el comando y confirmar GREEN, incluidas las pruebas legadas de lectura tolerante y reserva del ID 0.
- [ ] Revisar `git diff --check` y hacer commit `feat: add strict runtime metadata persistence`, agregando únicamente los dos archivos de esta tarea.

### Task 2: Preparación segura del runtime nvm

**Files:** crear `lib/tools/Nvm.js` y `test/programmatic/nvm.mocha.js`.

**References:** `resolveNodeInterpreter` en `lib/Common.js` como antecedente, no como contrato seguro de shell; `semver` ya está disponible en `package.json`.

**Acceptance:** obtener un ejecutable absoluto de la versión exacta usando un solo nvm, sin depender del shell interactivo ni alterar el alias predeterminado.

- [ ] Escribir pruebas de normalización: `26.12.1` y `v26.12.1` válidos; rechazar alias, rangos, prereleases, espacios adicionales, versiones incompletas, ceros iniciales inválidos y metacaracteres shell.
- [ ] Escribir pruebas con procesos simulados: `NVM_DIR` explícito, fallback `$HOME/.nvm`, rutas con espacios, falta de `nvm.sh`, runtime existente, instalación fallida y salida `node --version` discordante. Confirmar que se usa un shell no interactivo y los datos viajan como argumentos.
- [ ] Escribir pruebas de conservación del alias `default`, tanto presente como ausente antes de instalar, y comprobación de ejecutabilidad del binario resultante. No ejecutar nvm real en esta suite.
- [ ] Ejecutar `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/nvm.mocha.js`; confirmar RED por el contrato ausente.
- [ ] Implementar `validateVersion` y `prepare`; cargar explícitamente nvm, instalar solo cuando haga falta y validar la salida del ejecutable final. Verificar la disponibilidad de las opciones nvm utilizadas; no asumir que `nvm install` deja intactos los alias automáticamente. Si no puede preservarse el alias, devolver error antes de modificar servicios.
- [ ] Repetir la suite y confirmar GREEN; verificar que ninguna prueba realizó descargas ni escribió en el nvm del desarrollador.
- [ ] Revisar `git diff --check` y hacer commit `feat: resolve node runtimes through nvm`, agregando únicamente el módulo y su suite.

### Task 3: Inspección y edición limitada de unidades y entorno

**Files:** crear `lib/Systemd/RuntimeConfig.js` y `test/programmatic/systemd_runtime_config.mocha.js`; modificar `lib/Systemd.js` solo para `getRuntimeProperties`.

**References:** `lib/Systemd/UnitGenerator.js` para unidades/plantillas generadas y formato del archivo EnvironmentFile; `systemd.service(5)`, `systemd.exec(5)` y `systemd.syntax(7)` para quoting, specifiers y precedencia del entorno. Consultar los manuales de la máquina Linux de integración antes de aceptar sintaxis no trivial.

**Contract detail:** `Systemd.getRuntimeProperties` consulta al menos `ExecStart`, `FragmentPath`, `DropInPaths`, `Environment`, `EnvironmentFiles`, `User` y `Group` mediante argumentos de `execFileSync`. `inspect` devuelve bytes originales, ruta, existencia, modo/uid/gid de cada archivo, metadatos clonados y ejecutable anterior; `plan` no escribe. En plantillas se consulta la configuración efectiva de cada instancia `@0`, `@1`, etc., y se comprueba que todas usan la misma plantilla/entorno modificables; no se consulta una unidad base sin instanciar como si fuera una aplicación de instancia única.

**Acceptance:** modificar exclusivamente el primer ejecutable de un `ExecStart` Node y el `PATH` de su archivo de entorno conocido, sin perder comentarios, argumentos ni directivas de configuración. Rechazar lo no soportado antes de escribir.

- [ ] Crear pruebas con archivos temporales para unidad normal y plantilla: conservar exactamente argumentos entrecomillados, `User`, límites, timers referenciados, cwd, políticas de reinicio, comentarios y el resto del entorno.
- [ ] Probar nuevo runtime con espacios, `%`, comillas y barras invertidas; los paths deben producir tokens systemd válidos o un rechazo explícito antes de escribir. No usar división por espacios como parser general.
- [ ] Probar `PATH` existente, ausente, definido más de una vez en el mismo env file y directorio nuevo ya presente; anteponer sin duplicar y mantener el resto. Usar la base fija de la especificación si falta; no introducir `$PATH` ni el entorno del CLI.
- [ ] Probar unidades ausentes, symlinks/rutas fuera de directorios administrados, drop-ins que cambian `ExecStart`/entorno, múltiples comandos efectivos y archivos de entorno ajenos: rechazarlos cuando no se pueda demostrar que el cambio es seguro. Aceptar solo unidades ZM2 regulares conocidas; nunca editar la salida textual de `systemctl show ExecStart` como si fuera el archivo fuente.
- [ ] Probar snapshot/apply/restore: bytes, propietario y modo; archivo previamente ausente; fallo en la segunda escritura; restauración que sigue intentando el segundo archivo si falla el primero. Una modificación parcial debe poder recuperarse desde el snapshot original.
- [ ] Ejecutar `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_runtime_config.mocha.js`; confirmar RED.
- [ ] Implementar inspección, plan puro, escritura atómica por archivo y restauración con agregación de errores. Consultar configuración efectiva de systemd sin regenerar la unidad desde StateStore. No ejecutar `daemon-reload` aquí: pertenece a la transacción.
- [ ] Repetir la suite y confirmar GREEN; probar escape con `systemd-analyze verify` posteriormente en Linux como parte de Task 9.
- [ ] Revisar `git diff --check` y hacer commit `feat: safely rewrite node runtime config`, agregando el módulo, su suite y el cambio acotado en `lib/Systemd.js`.

### Task 4: Verificación temporal del arranque

**Files:** crear `lib/Systemd/RuntimeVerifier.js` y `test/programmatic/systemd_runtime_verifier.mocha.js`; modificar `lib/Systemd.js` para `getProcessExecutable`.

**References:** `Systemd.getStatus` ya expone `ActiveState`, `SubState`, `MainPID` y `NRestarts`. Resolver el ejecutable real mediante `/proc/<pid>/exe`, no mediante el nombre de proceso.

**Acceptance:** comprobar `active/running`, PID y ejecutable esperados durante cinco segundos, consultando cada 500 ms; nunca confundir esta verificación con un health check funcional.

- [ ] Escribir pruebas con reloj/delay inyectados para diez intervalos de 500 ms más las consultas de inicio/fin: instancia estable y runtime resuelto por symlink equivalente.
- [ ] Escribir pruebas de fallo por estado failed/inactive/activating, PID cero o inválido, incremento de `NRestarts`, cambio inesperado de PID durante la observación, ejecutable distinto y error de lectura de `/proc` o systemctl. No ignorar un fallo temporal porque luego la instancia se recupere.
- [ ] Probar que se compara el contador con la lectura inicial posterior al reinicio solicitado y que los temporizadores no dejan callbacks pendientes tras éxito o fallo. Las pruebas no esperan cinco segundos reales.
- [ ] Ejecutar `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_runtime_verifier.mocha.js`; confirmar RED.
- [ ] Implementar `verify` con espera asíncrona y los auxiliares de ejecutable de PID; validar PID antes de construir la ruta `/proc`. Mantener los defaults de 500/5000 ms fijos en producción y permitir reloj/delay inyectados para tests.
- [ ] Repetir la suite y confirmar GREEN; verificar que no usa busy-wait ni bloquea el event loop durante la ventana de observación.
- [ ] Revisar `git diff --check` y hacer commit `feat: verify updated node service startup`, agregando los tres archivos involucrados.

### Task 5: Preflight, selección y actualización secuencial

**Files:** crear `lib/Systemd/NodeRuntimeUpdater.js` y `test/programmatic/systemd_node_update.mocha.js`.

**References:** `_prepare` y `_restartProcess` en `lib/SystemdClient.js` para StateStore e instancias; no reutilizar `_prepare` porque arranca instancias detenidas y regenera configuración incompleta.

**Contract detail:** el constructor recibe `stateStore`, `systemd`, `nvm`, `runtimeConfig` y `verifier`, más adaptadores de plataforma/permisos/procesos para preflight y consulta del Node anterior. `run` valida versión y lee el store estrictamente desde disco aunque el cliente lo haya cargado previamente de forma tolerante. No accede a systemd ni nvm al importar el módulo.

**Acceptance:** ejecutar una aplicación a la vez, sin instalar Node ni modificar servicios si falla un requisito global, y mantener detenidas las instancias que estaban detenidas.

- [ ] Escribir pruebas de contexto Linux/systemd, permisos de unidades/entorno/StateStore/nvm y selección explícita de directorios bajo sudo. Si `SUDO_USER` identifica un usuario distinto del efectivo, exigir un `NVM_DIR` y ZM2 home explícitos antes de permitir instalación; no intentar adivinar sus homes. Probar corrupción de StateStore después de la carga inicial del cliente.
- [ ] Probar clasificación de `node`, `node@versión` y rutas Node; omitir Python/Bun/shell/npm/directos e infraestructura HTTP. Identificar la infraestructura por su entrada reservada y script, no excluir indiscriminadamente aplicaciones cuyo nombre contenga `api`.
- [ ] Probar Node sin unidad, metadata versus `ExecStart` discordantes, estados transitorios y errores de permisos por aplicación. Mantener una fila fallida por entrada y continuar con las elegibles restantes.
- [ ] Probar lista vacía o solo omitidas sin instalar Node; si hay filas fallidas, conservar exitCode 1 aunque no quede ninguna elegible. Si falla `nvm.prepare`, las elegibles restantes quedan `not_updated`, sin escrituras ni reinicios.
- [ ] Probar la secuencia exitosa: snapshot, plan, apply, reload, restart de activas, verify, persistencia de `exec_interpreter`. Comprobar consulta de versión anterior desde el ejecutable configurado, sin usar `process.version`.
- [ ] Probar aplicación detenida, template mixto y runtime ya configurado; no llamar start/enable/disable sobre detenidas, verificar solo las reiniciadas y omitir únicamente si ejecutable y `PATH` cumplen el contrato.
- [ ] Ejecutar `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_node_update.mocha.js`; confirmar RED en los comportamientos nuevos.
- [ ] Implementar preflight y camino exitoso sin anticipar concurrencia. Registrar una sola fila por aplicación, preservar orden y metadatos ajenos al intérprete. Asegurar que el bucle no arranca la aplicación siguiente hasta concluir la actual.
- [ ] Repetir la suite y confirmar GREEN para los casos agregados. No conectar aún el comando CLI: el flujo no se publica sin la recuperación de Task 6.
- [ ] Revisar `git diff --check` y hacer commit `feat: coordinate sequential node updates`, agregando solo el actualizador y su suite.

### Task 6: Rollback completo por aplicación y continuidad

**Files:** modificar `lib/Systemd/NodeRuntimeUpdater.js`, `lib/Systemd.js` y `test/programmatic/systemd_node_update.mocha.js`.

**Contract detail:** `Systemd.resetFailed(serviceName)` llama `systemctl reset-failed <service>.service`, nunca un reset global. Los errores originales van en `errors`; los de restauración, en `rollbackErrors`.

**Acceptance:** todo fallo después de comenzar cambios intenta restaurar los archivos y metadatos originales, recuperar todas las instancias previamente activas y continuar con la aplicación siguiente. Un rollback incompleto nunca se reporta como restaurado.

- [ ] Agregar pruebas de fallo en primera y segunda escritura, `daemon-reload`, restart, consulta, verificación y persistencia de StateStore. Para cada fase afirmar bytes/metadata finales y que la aplicación siguiente sí se procesa.
- [ ] Probar rollback de un template: si la segunda instancia falla, restaurar toda la plantilla y recuperar ambas instancias antes activas; las detenidas siguen sin recibir start/restart. No restaurar el StateStore completo sobre el progreso exitoso de otras aplicaciones.
- [ ] Probar límite de arranques alcanzado: resetear únicamente la instancia bloqueada antes de recuperarla. Probar fallo de restore de archivo, reload de recuperación, guardado de metadata y restart de recuperación; intentar las acciones restantes sin perder ninguno de los errores.
- [ ] Probar error antes de escribir como `failed_unchanged`, recuperación completa como `failed_restored` y cualquier recuperación incompleta como `failed_restore`; todos generan exitCode 1. Reportar la versión anterior desconocida sin inventarla.
- [ ] Ejecutar `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_node_update.mocha.js`; confirmar RED de los casos nuevos.
- [ ] Implementar rollback con snapshot anterior a la primera escritura, registro de etapas y agregación de fallos. Solo reiniciar instancias con una configuración restaurada comprobada; si no puede garantizarse, registrar recuperación fallida en vez de iniciar silenciosamente el runtime nuevo. No desinstalar Node ni sus versiones anteriores.
- [ ] Repetir la suite y confirmar GREEN; revisar explícitamente que errores de rollback no corten el bucle secuencial.
- [ ] Revisar `git diff --check` y hacer commit `feat: roll back failed node service updates`, agregando los tres archivos de esta tarea.

### Task 7: API, comando CLI y reporte final

**Files:** crear `lib/API/UpdateNode.js` y `test/programmatic/update_node_cli.mocha.js`; modificar `lib/API.js`, `lib/binaries/CLI.js` y `types/index.d.ts`.

**References:** extensiones al final de `lib/API.js`; `lib/API/LogManagement.js` y `test/programmatic/systemd_logs.mocha.js` para callbacks, salida y pruebas CLI con procesos simulados. Usar las constantes existentes `SUCCESS_EXIT`/`ERROR_EXIT`.

**Acceptance:** `zm2 update-node <version>` accede al mismo ZM2 home de la API y muestra el reporte completo exactamente una vez, con versiones, resultados, detalles de error y totales; no termina antes de los últimos mensajes.

- [ ] Escribir pruebas de método API con callback: éxito, fallo global, fallo parcial y rollback fallido. Confirmar un solo callback, reporte íntegro y ninguna llamada a `exitCli`; `error` no nulo cuando el reporte tiene exitCode 1.
- [ ] Escribir pruebas sin callback: una sola salida final por operación y una llamada final a `exitCli`, código 0 para éxito/solo omitidas y 1 para cualquier fallo. No imprimir variables de entorno ni stderr completo de una app si puede contener secretos.
- [ ] Escribir pruebas de filas actualizadas, omitidas, detenidas y templates mixtos, fallidas sin cambios, restauradas, restauración fallida y no actualizadas por fallo global. Afirmar totales y que el detalle incluye el servicio/instancia y `journalctl -u <unidad>` relevante.
- [ ] Probar Commander con versión presente, argumento faltante e inválido; el comando debe registrarse antes de `command('*')`. No intentar instalar nvm cuando falla el parseo/validación.
- [ ] Ejecutar `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/update_node_cli.mocha.js`; confirmar RED.
- [ ] Implementar la extensión API y la presentación tabular usando utilidades existentes. Emitir antes de cambios la advertencia de módulos nativos y ausencia de health check funcional. Registrar la extensión y el comando; evitar meter coordinación dentro del archivo grande `lib/API.js`.
- [ ] Agregar a `types/index.d.ts` la firma pública `updateNode(version, callback?)` y los tipos del reporte definidos al inicio del plan, conservando las convenciones de callbacks existentes. Documentar que la llamada sin callback tiene semántica CLI.
- [ ] Repetir la suite y confirmar GREEN; verificar que stdout contiene versión solicitada y, para rollback, el runtime anterior efectivo, no una falsa confirmación de actualización.
- [ ] Revisar `git diff --check` y hacer commit `feat: expose update-node command and report`, agregando solo los cinco archivos de esta tarea.

### Task 8: Registrar suites y documentar operación

**Files:** modificar `test/unit.sh` y `README.md`.

**References:** Quick Start y secciones de systemd/nvm de `README.md`; el runner usa una lista explícita de suites y no descubre automáticamente los nuevos archivos.

**Acceptance:** las pruebas nuevas se pueden ejecutar directamente sin systemd y quedan registradas en el runner existente; el operador entiende privilegios, selección de homes, resultados y límites.

- [ ] Agregar al runner las cinco suites nuevas junto a los tests systemd. No renombrar binarios ni reparar suites legadas ajenas como parte de esta funcionalidad.
- [ ] Documentar `zm2 update-node <versión>` y un ejemplo bajo sudo con `NVM_DIR` y `ZM2_HOME` explícitos que apunten al usuario correcto. No recomendar importar o ejecutar un `nvm.sh` ajeno sin verificar confianza: se ejecuta código shell con los privilegios del comando.
- [ ] Documentar actualización secuencial, downtime esperado, preservación de instancias detenidas, exclusión de ZM2/API y wrappers, conservación del default nvm y de runtimes anteriores, y ausencia de cambios en ecosystem files.
- [ ] Incluir ejemplo de reporte con éxito, omitida y fallo restaurado; explicar exitCode 1 incluso si el rollback recuperó el servicio, y cómo usar journalctl para diagnosticar una restauración fallida.
- [ ] Advertir sobre módulos nativos, paquetes globales no migrados, ventana de cinco segundos sin health check funcional y falta de recuperación ante interrupción abrupta/concurrencia administrativa.
- [ ] Ejecutar `bash -n test/unit.sh` y `git diff --check`; confirmar ambas validaciones sin errores. Revisar manualmente que las suites listadas existen y que los ejemplos no cambian alias nvm.
- [ ] Hacer commit `docs: explain node runtime updates`, agregando únicamente README y el registro de suites.

### Comando de regresión focalizado

Ejecutar después de Task 8; todas las suites deben pasar sin Linux/systemd ni nvm real:

```bash
node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_state_store.mocha.js test/programmatic/systemd_logs.mocha.js test/programmatic/nvm.mocha.js test/programmatic/systemd_runtime_config.mocha.js test/programmatic/systemd_runtime_verifier.mocha.js test/programmatic/systemd_node_update.mocha.js test/programmatic/update_node_cli.mocha.js
```

### Task 9: Integración Linux real y revisión de entrega

**Files:** crear `test/e2e/systemd/update-node.sh`, `test/fixtures/update-node/stable.js` y `test/fixtures/update-node/fail-on-target.js`. Añadir a `README.md` el comando de integración y las variables de prueba.

**Contract:** la prueba requiere `ZM2_UPDATE_NODE_E2E=1`, `NVM_DIR`, `ZM2_HOME`, `ZM2_NODE_OLD` y `ZM2_NODE_TARGET` explícitos. Las dos versiones deben ser reales y distintas; no suponer que la versión ilustrativa `26.12.1` existe. Los fixtures permanecen vivos con temporizador; el segundo termina con error solo cuando `process.version` coincide con `ZM2_NODE_TARGET`, normalizando el prefijo `v` para comparar. Nunca ejecutar el script contra aplicaciones de producción.

**Acceptance:** demostrar en un Linux desechable con systemd y nvm reales que éxito, fallo, rollback y conservación de detenidas corresponden al ejecutable de los procesos, no solo al reporte.

- [ ] Escribir primero el script con comprobación de opt-in, Linux/systemd/privilegios, homes de prueba y versiones válidas/distintas. Usar nombres exclusivos `zm2-update-node-e2e-*`, cleanup mediante trap y rechazar un StateStore que contenga aplicaciones ajenas antes de invocar un comando que actualiza todas las registradas.
- [ ] Agregar setup de una app estable, una incompatible con el runtime nuevo, una detenida y una app de varias instancias con estado mixto. Crear todas inicialmente con la versión anterior, sin instalar ni actualizar el propio ZM2 dentro del nvm bajo prueba.
- [ ] Afirmar, tras el comando con fallo parcial, exitCode 1, ejecutable real nuevo de la estable y de las instancias actualizadas, ejecutable anterior de la incompatible restaurada y ausencia de PID en las detenidas. Verificar metadatos y archivos, no solo texto de salida.
- [ ] Agregar una segunda ejecución sin la app incompatible y afirmar exitCode 0/idempotencia, ausencia de reinicios en apps ya actualizadas y conservación del alias default y de la versión anterior instalada.
- [ ] Ejecutar `bash -n test/e2e/systemd/update-node.sh` y pruebas focalizadas del plan. En macOS confirmar que el script rechaza integración real sin modificar ningún servicio.
- [ ] En Linux desechable ejecutar `systemd-analyze verify` sobre las unidades de prueba modificadas y comprobar que los tokens escapados de `ExecStart` son aceptados. Los errores por unidades adicionales de esa máquina deben distinguirse de los archivos de prueba.
- [ ] En ese mismo Linux, con nvm ya instalado y los homes/versiones del entorno desechable configurados, ejecutar:

```bash
sudo env ZM2_UPDATE_NODE_E2E=1 NVM_DIR="$NVM_DIR" ZM2_HOME="$ZM2_HOME" ZM2_NODE_OLD="$ZM2_NODE_OLD" ZM2_NODE_TARGET="$ZM2_NODE_TARGET" bash test/e2e/systemd/update-node.sh
```

- [ ] Confirmar éxito y cleanup en Linux antes de afirmar integración completa. Si no hay Linux disponible, entregar las pruebas simuladas verificadas e indicar expresamente que esta integración sigue sin ejecutar.
- [ ] Ejecutar `npm run test:unit` y `npm run test:e2e` solo en el entorno Linux apropiado; registrar fallos existentes de suites legadas por separado sin ocultarlos ni ampliar el alcance para repararlos. Repetir el comando focalizado sin reintentos y `git diff --check`.
- [ ] Revisar simplificación y claridad de módulos, cobertura de errores y requisitos contra la especificación; solicitar revisión de código antes de integrar. Verificar especialmente que ningún camino informa `updated` antes de persistir metadata, que rollback no borra progreso ajeno y que stdout se completa antes de salir.
- [ ] Hacer commit `test: cover real node runtime migration`, agregando solo script, fixtures y documentación de integración. Entregar resumen de pruebas efectivamente ejecutadas, pendientes y limitaciones; no hacer push ni merge sin instrucción del usuario.

## Checklist de cobertura de especificación

- Contexto Linux, privilegios, nvm único, homes explícitos: Tasks 2 y 5.
- Instalación/versionado exacto, argumentos seguros y conservación de alias: Task 2.
- Selección/exclusiones, ninguna elegible y fallos globales: Task 5.
- Preservación de unidad/entorno/propietario y quoting systemd: Task 3.
- Estado activo/detenido, templates y ejecución secuencial: Tasks 5 y 6.
- Ventana temporal y ejecutable real: Task 4.
- Persistencia estricta/atómica y rollback exacto: Tasks 1 y 6.
- Reporte completo, totales y salida no cero: Tasks 5 a 7.
- Documentación, advertencias y límites: Task 8.
- Verificación simulada multiplataforma e integración Linux: Tasks 1 a 9.

## Estado de ejecución

Worktree: `.worktrees/update-node`, rama `feat/update-node`.

- Task 1: implementación y revisiones de requisitos/calidad completas, 35 pruebas verificadas, commit `ae2ade86`.
- Task 2: adaptador nvm revisado (requisitos/calidad), 30 pruebas verificadas incluido bash real con stub local sin descargas, commit `1ecf4aff`.
- Task 3: edición de configuración revisada (requisitos/calidad), prioridad PATH, roundtrip `%` y variable de instancia personalizados corregidos; 57 pruebas verificadas, commit `a4f742db`. Observación menor no bloqueante: si falla una escritura parcial del temporal antes de retornar, puede quedar un temporal ignorado por systemd; sin garantía de durabilidad ante corte de energía.
- Task 4: verificador revisado (requisitos/calidad), 38 pruebas verificadas, commit `ecc917f9`; helper Systemd incluido y probado en Task 3.
- Task 5: coordinador revisado (requisitos/calidad), 45 pruebas verificadas incluido recorrido con adaptadores reales; procedencia explícita del home bajo sudo corregida y probada, commit `937dc5a3`.
- Task 6: rollback implementado y revisado (requisitos/calidad), 68 pruebas verificadas; snapshots exactos desde store.get y persistencia staged replace, recuperación por instancia con reset-failed acotado y continuación tras fallos; commit `9f62fc3a`. Estado temporal rollbackContexts eliminado por simplificación.
- Task 7: API/CLI revisadas (requisitos y calidad), diagnóstico de plantillas corregido, commit `ea3f4fda`; ampliación de procedencia del home revisada en Task 5, 23 pruebas verificadas.
- Task 8: documentación y runner revisados (requisitos y calidad), commit `0696175d`; las cinco suites existen y `bash -n test/unit.sh` verificado.
- Task 9: script y fixtures revisados (requisitos/calidad estática), sintaxis y rechazo seguro en macOS verificados, instrucciones README incluidas, commit `d81bc040`. Ejecución real Linux pendiente; requiere rollback de Task 6.

Baseline en este worktree: 59 pruebas existentes verificadas. Dependencias instaladas con `npm ci --ignore-scripts --force` por tratarse de macOS; no se ejecutaron servicios reales.

## Verificación de entrega registrada

- [x] Implementación de Tasks 1–8 revisada por requisitos y calidad; cambios guardados en commits separados.
- [x] Script y fixtures de Task 9 preparados y revisados estáticamente; rechazo seguro en macOS y sintaxis comprobados.
- [x] Regresión focalizada: **290 passing, 0 failing**, sin reintentos, ejecutada por el coordinador después de la última simplificación.
- [x] Sintaxis de los JavaScript modificados, `bash -n` de ambos runners y `git diff --check` sin errores.
- [x] `npm pack --dry-run --ignore-scripts --json`: los nueve archivos necesarios de runtime, API, entrada y tipos están incluidos.
- [x] Revisión final independiente del rango `2a3c614d..9f62fc3a`: sin defectos bloqueantes; resultado READY con integración Linux pendiente.
- [ ] Ejecutar `test/e2e/systemd/update-node.sh` en Linux desechable con systemd/nvm reales. No se ejecutó en este Mac.
- [ ] Ejecutar las suites completas Linux/CI (Node 16/24 y Bun) en el entorno apropiado. No se afirma que el runner legado completo haya pasado.

No se hizo merge ni push. La implementación permanece en `feat/update-node`, worktree `.worktrees/update-node`, pendiente de la elección de integración del usuario.

## Condición de entrega

No declarar la funcionalidad terminada solo por compilar o tener mocks verdes. Adjuntar salida de la regresión focalizada, resultado de revisión y evidencia Linux si fue ejecutada. La integración no realizada se informa como pendiente; no se afirma cero downtime ni salud funcional garantizada.
