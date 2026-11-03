# Validación real de ZM2 con Compose y systemd

## Objetivo y aprobación

Validar ZM2 6.0.47 desde el código local contra systemd y journald reales en Linux, con una aplicación Express administrada por ZM2. El usuario aprobó Compose sobre un perfil Colima exclusivo y un contenedor privilegiado dentro de esa VM desechable. No se publicará en npm ni se hará push automáticamente.

## Entorno observado

El 2026-11-03 se creó `zm2-systemd-test` con 2 CPU, 4 GiB de RAM, disco de 20 GiB, VZ y arquitectura aarch64. Arrancó con `--activate=false --mount none --ssh-agent=false --ssh-config=false --template=false`. Docker informa Ubuntu 24.04.4 LTS, kernel 6.8.0-117-generic, cgroups v2 y driver cgroupfs. El PID 1 de la VM es systemd. No se observaron mounts virtiofs/9p/sshfs en la VM. El perfil `default` sigue detenido y el contexto Docker activo sigue siendo `colima`.

Esto prueba disponibilidad del backend, no el funcionamiento de ZM2 ni de systemd dentro de un contenedor. Esas comprobaciones están pendientes.

## Arquitectura y límites de confianza

- Un proyecto Compose exclusivo, ejecutado mediante el contexto explícito `colima-zm2-systemd-test`, contiene un servicio Linux desechable con `/sbin/init` como PID 1.
- El contenedor privilegiado tiene acceso al kernel de la VM de pruebas: no es una barrera de seguridad frente a esa VM. Por eso el harness debe rechazar otros contextos antes de crear recursos privilegiados.
- Usar namespace privado de cgroups y comprobar que systemd puede crear y administrar sus cgroups. No montar `/sys/fs/cgroup` del host como solución implícita. Si el backend no funciona así, detenerse y revisar el diseño en lugar de ampliar privilegios/montajes silenciosamente.
- No montar el bus systemd, Docker socket, directorios reales de unidades, HOME ni estado/env del host. El código se copia durante la construcción, no se comparte mediante mounts.
- No publicar puertos por defecto. Las comprobaciones HTTP se hacen dentro del contenedor. La app escucha en loopback; no se instala ni expone la API administrativa propia de ZM2.
- Unidades, env, metadatos, nvm y journal viven dentro del sandbox. `/run` y `/tmp` son temporales. El reinicio de pruebas conserva el mismo contenedor y su filesystem; no utiliza `down` seguido de recreación para demostrar persistencia.

## Componentes

1. **Imagen y Compose de pruebas** en `test/systemd/`: Ubuntu con systemd/journald, herramientas de diagnóstico, Node y nvm. No reutilizar sin cambios el Dockerfile de migración existente ni instalar PM2 para estas pruebas.
2. **Fixture Express** en `test/fixtures/systemd-express/`: paquete y lockfile propios. Endpoint `GET /health` con JSON de estado, PID y versión de Node; marcador de arranque sin secretos en stdout. La fixture admite un fallo deliberado al ejecutar la versión objetivo para comprobar recuperación. Express no se añade a las dependencias productivas de ZM2.
3. **Escenarios internos** en `test/e2e/systemd/`: verificaciones Linux/root/PID 1/systemctl, lifecycle y configuración, fases antes/después del reinicio del contenedor, y `--no-rollback`. Reutilizar `update-node.sh` para los escenarios existentes de actualización y rollback sin duplicar sus aserciones.
4. **Runner del host** en `test/systemd/`: preflight, construcción, arranque, captura de evidencia, coordinación del reinicio y limpieza. Los errores retornan salida distinta de cero y conservan diagnósticos; la limpieza no convierte un fallo en éxito.
5. **Documentación** junto al harness: requisitos, advertencia de privilegios, ejecución, evidencias, límites y limpieza explícita del perfil exclusivo.

## Dependencias y construcción

Fijar versiones exactas y existentes de Node/nvm y Express al implementar, verificando las descargas y registrando las versiones efectivas. Usar dos runtimes Node distintos; el CLI debe mantenerse en una ruta absoluta estable durante las actualizaciones. Requerir Node >=16.

El lockfile raíz contiene metadatos heredados de PM2. No asumir que `npm ci` funciona ni regenerarlo en el repositorio como efecto lateral. Construir con un lockfile derivado del manifiesto actual dentro de la imagen si la instalación con el lockfile raíz resulta incompatible; registrar el método y conservar ese lockfile generado como evidencia de la ejecución. El lockfile propio de Express sí pertenece al harness. No copiar `node_modules`, `.git`, worktrees, credenciales ni archivos locales ajenos al build context.

## Criterios de aceptación

### Backend real

Comprobar PID 1 systemd dentro del contenedor, respuesta de `systemctl`, cgroup de una unidad real y disponibilidad de journald. `systemd-analyze verify` no debe emitir errores atribuibles a las unidades de prueba. Un estado degradado global requiere diagnosticar y documentar su causa, nunca ignorarlo sin inspección.

### Lifecycle y observabilidad

- Crear Express mediante `zm2 start`, comprobar HTTP, MainPID coincidente con `/health`, ejecutable en `/proc/<pid>/exe`, registro StateStore y unidad habilitada.
- `zm2 stop` deja la unidad inactiva/deshabilitada y sin disponibilidad HTTP; `zm2 start` de la app existente recupera HTTP y habilitación.
- `zm2 restart` cambia el proceso, conserva la habilitación previa y recupera HTTP; probar también reinicio de una unidad activa deshabilitada sin que se habilite accidentalmente.
- Consultar marcadores de la fixture mediante journalctl y mediante `zm2 logs` en modo acotado, sin dejar seguidores colgados.
- Comprobar directorio env 0700 y archivos 0600, incluidos permisos permisivos previos corregidos al escribir.
- Lanzar registros independientes concurrentes mediante CLI y comprobar JSON válido, entradas completas e IDs únicos; no borrar locks activos.
- Provocar un fallo real y acotado de control de systemd; el CLI debe devolver error visible. Una eliminación cuyo stop/disable falla debe conservar unidad/env/registro para diagnóstico. Retirar únicamente la condición de fallo introducida por el escenario.
- Eliminar las apps de prueba por nombre y verificar ausencia de unidades, enlaces de habilitación, env y entradas de estado. No usar kill/delete all.

### Arranque tras reinicialización del sandbox

Preparar una app habilitada y otra detenida/deshabilitada. Guardar identidad de la invocación de init, PIDs, huellas de unidades y StateStore. Detener y arrancar completamente el mismo contenedor, preservando archivos persistentes y renovando los temporales. Comprobar una nueva invocación de systemd, Express disponible automáticamente sin ejecutar `zm2 start`, y la otra app detenida/deshabilitada. Verificar configuración persistente y metadatos.

Se describe como reinicialización del systemd del contenedor, no como reboot del kernel Linux ni del host. PID numérico o boot ID del kernel por sí solos no sirven como prueba de una nueva invocación de init.

### Actualización de Node

- Ejecutar el script opt-in existente con nvm confiable, un ZM2_HOME vacío y dos versiones exactas distintas. Capturar su salida: actualización estable, rollback de incompatible, app detenida, instancias mixtas, idempotencia, preservación de permisos/alias y limpieza.
- Añadir un escenario real de `--no-rollback`: app incompatible conserva unidad/PATH/metadatos apuntando al runtime objetivo aunque falle el arranque, salida 1 y reporte sin falsa restauración. Confirmar continuación con una app compatible y conservación del estado de otra detenida.
- Verificar con Express la salud funcional y versión de Node después de una actualización exitosa. La ventana de verificación interna de ZM2 no sustituye este health check.

## Evidencia, fallos y limpieza

Crear un directorio de resultados por ejecución con versiones, commit y estado dirty del código, configuración Compose resuelta, método/lockfiles de instalación, salidas de escenarios, códigos de salida, systemctl/journal y comprobaciones HTTP antes/después del reinicio. No volcar entornos completos, tokens ni credenciales. Las credenciales de prueba, si fueran necesarias, no se registran.

En fallo, recolectar diagnósticos antes de retirar recursos. La limpieza automática elimina solo el proyecto/contenedores/volúmenes identificados del harness; ofrecer retención explícita para depuración. Borrar el perfil Colima es una operación separada, documentada y dirigida únicamente a `zm2-systemd-test`. No hacer prune global ni cambiar el contexto activo.

Separar limitaciones del backend, fallos del harness y bugs de producción. Un bug de producción exige reproducción y corrección acotada con regresión, no relajar aserciones. No declarar verde `npm test` ni las suites legacy a partir de esta validación. Los ocho fallos de expectativas de intérprete ya documentados no se consideran resueltos.

## Fuera de alcance

Publicación/tag, infraestructura productiva o remota, migración global de CI, rediseño de nombres/IDs, escaping general de argumentos, reparación indiscriminada de lockfiles y pruebas de reboot del host. No modificar código productivo salvo una corrección justificada por un fallo reproducido y revisado por separado.
