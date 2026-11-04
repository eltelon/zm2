# Una sola instancia por aplicación

## Objetivo y decisión aprobada

Aceptar `-i`, `--instances` y el campo `instances` de ecosystem/API por compatibilidad, pero no crear aplicaciones multiinstancia. El usuario eligió bloquear operaciones de activación sobre aplicaciones multiinstancia existentes, conservando stop/delete, sin conversión ni parada automática.

La política es **un proceso administrado por aplicación registrada**, no un único proceso global ni una restricción sobre procesos hijos que cree la propia aplicación. Aplicaciones diferentes con nombres distintos pueden continuar coexistiendo.

## Configuración nueva

- Mantener los flags y propiedades públicos; normalizar los valores de cantidad aceptados a `1`, incluidos los habituales `4`, `0` y `max`.
- Emitir una advertencia comprensible cuando una solicitud explícita distinta de uno se ignore. No advertir cuando el valor no esté definido o sea uno.
- Normalizar antes de generar mensajes/unidades y reforzar la política en la frontera que crea servicios, para que una llamada programática directa no pueda generar plantillas.
- Crear exclusivamente `zm2-<nombre>.service`, habilitarlo/iniciarlo mediante el flujo existente y registrar `instances: 1` en StateStore. No generar ni arrancar `@.service`/`@N.service` para nuevas aplicaciones.
- Conservar el entorno de la aplicación: `env.INSTANCES` no es un parámetro de ZM2 y no se cambia ni elimina. Un ecosystem que calcula `instances` a partir de `process.env.INSTANCES` sí queda limitado a uno.
- No agregar expansión automática de archivos `.env`. Mantener la validación existente para errores ajenos a la cantidad de instancias.

## Aplicaciones multiinstancia existentes

- Reconocerlas por sus metadatos y por la identidad de plantilla/instancia systemd; no depender solo del número mostrado en listados. La selección por nombre, ID, ecosystem o alias de instancia no debe eludir la política.
- Rechazar start, restart, reload y equivalentes sobre ellas antes de modificar unidad, entorno, metadatos o habilitación. El error explica que se debe detener/eliminar la aplicación y recrearla como servicio único, advirtiendo del downtime.
- `startup` no debe habilitar sus instancias y debe informar la restricción; `unstartup` puede seguir deshabilitándolas. No normalizar retrospectivamente sus metadatos a uno, porque stop/delete necesitan conocer todos los recursos que deben retirar.
- `update-node`, con o sin `--no-rollback`, debe reportarlas como fallidas sin cambios, no instalarlas/reiniciarlas ni intentar rollback de ellas. Si son las únicas aplicaciones elegibles, no instalar un runtime por ellas. Las aplicaciones individuales compatibles pueden seguir procesándose; la presencia de una multiinstancia rechazada produce salida global no cero.
- Mantener consulta, logs, stop y delete para administrar y retirar unidades heredadas. Las operaciones agregadas deben propagar errores y no afirmar éxito total si alguna aplicación fue rechazada.
- No convertir plantillas automáticamente, no elegir arbitrariamente una instancia para conservar y no ocultar ni borrar unidades heredadas al crear una aplicación con nombre coincidente.
- `scale` no debe constituir una vía para crear nuevas instancias; conservar su comportamiento de rechazo si ya está deshabilitado.

## Límite importante: unidades ya habilitadas

Actualizar ZM2 **no detiene ni deshabilita automáticamente** servicios existentes. systemd puede reiniciar por su política de autorestart o al boot las unidades que ya estaban habilitadas. La restricción opera sobre las acciones de ZM2; no revoca el control directo con systemctl ni modifica servicios fuera de una solicitud explícita de stop/delete/unstartup.

Documentar la transición manual por nombre: revisar aplicaciones, detener/eliminar el grupo heredado, y crear un servicio único. La eliminación debe conservar las protecciones ante fallos de stop/disable. No recomendar borrar StateStore ni locks para forzar la transición.

## Arquitectura y compatibilidad

Reutilizar la normalización de configuración y el adaptador systemd existentes. Compartir una política pequeña entre rutas de activación que deban identificar servicios heredados, evitando comprobaciones divergentes. Mantener el soporte de lectura/eliminación de plantillas; no eliminar el generador o el parser si son necesarios para administración/regresiones heredadas.

Actualizar ayuda CLI, README, tipos y descripciones de schema/templates que prometen multiinstancia o balanceo. No eliminar la opción pública ni agregar dependencias. No cambiar el contrato mínimo Node >=16 ni los lockfiles raíz.

## Verificación

1. Regresiones primero: CLI corto/largo, ecosystem y API aceptan cantidades distintas de uno pero generan exactamente un servicio y registran uno; advertencia apropiada; entorno `INSTANCES` intacto.
2. No creación de plantillas ni comandos sobre instancias al preparar una aplicación nueva, incluso invocando directamente el adaptador.
3. Legacy: start/restart/reload fallan sin mutaciones por todas las rutas de selección relevantes; stop/delete siguen recorriendo y eliminando sus instancias, conservando errores de systemd.
4. startup/update-node no habilitan ni reactivan legacy; actualización mixta continúa con servicios únicos y reporta fallo global. Sin runtime instalado cuando solo hay legacy rechazadas.
5. Actualizar los escenarios que antes creaban multiinstancia: simular fixtures heredadas explícitamente, no obtenerlas mediante el nuevo CLI. Conservar la cobertura de parser/limpieza heredada y de runtime de servicio único.
6. Ejecutar el harness Linux en el perfil Colima desechable ya aprobado: Express con `-i 4` y con configuración equivalente debe tener un solo PID/unidad y conservar salud HTTP; una plantilla heredada preparada explícitamente debe rechazarse para activación y poder eliminarse. Mantener pruebas de lifecycle, permisos, concurrencia entre aplicaciones distintas, init restart, update-node, rollback y no-rollback.
7. Capturar resultados y distinguir las pruebas unitarias del systemd real. No afirmar verde el runner legado `npm test` ni resolver incidentalmente los ocho fallos de expectativas de intérprete ya documentados.

## Alcance de entrega

Trabajo aislado en `.worktrees/single-instance-only`, rama `fix/single-instance-only`. Línea base selectiva: 410 pruebas pasando sin reintentos (`/tmp/zm2-single-instance-baseline.log`). No modificar el worktree `update-node`. No merge, push ni publicación npm automáticos.
