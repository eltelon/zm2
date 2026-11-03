# update-node No Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conservar el runtime nuevo ante fallos de arranque cuando se solicita --no-rollback.

**Architecture:** Opción rollback predeterminada true en el coordinador; en modo false se confirma configuración y metadata antes de reiniciar, se agregan fallos por instancia sin revertir y se reporta un estado específico. CLI/API transmiten la opción conservando las llamadas previas.

**Tech Stack:** CommonJS Node >=16, Commander 2, Mocha, systemd simulado en pruebas.

---

Especificación: `docs/superpowers/specs/2026-10-22-update-node-no-rollback-design.md`.

## Archivos

Modificar `lib/Systemd/NodeRuntimeUpdater.js`, `lib/API/UpdateNode.js`, `lib/binaries/CLI.js`, `types/index.d.ts`, `README.md` y las suites existentes `test/programmatic/systemd_node_update.mocha.js` y `test/programmatic/update_node_cli.mocha.js`. No agregar dependencias ni cambiar nvm, generación de unidades o verificador.

## Task 1: Coordinador y persistencia

- [x] Agregar pruebas de restart/verificación fallidos con rollback false; exigir persistencia anterior al reinicio, ninguna restauración y continuación por instancia/aplicación. Cubrir detenidas, éxito y fallos de escritura/persistencia con protección conservada.
- [x] Ejecutar la suite systemd_node_update sin reintentos y observar RED.
- [x] Agregar opción de construcción `rollback` (default true) y estado `failed_no_rollback`; implementar confirmación previa y agregación de errores de arranque manteniendo el flujo por defecto.
- [x] Verificar GREEN, incluyendo un recorrido con StateStore/RuntimeConfig reales en directorios temporales.

## Task 2: CLI, API, reporte y revisión

- [x] Agregar pruebas de `--no-rollback`, API con opciones y callback legado, advertencia y estado nuevo en el reporte; observar RED.
- [x] Transmitir `options.rollback`, agregar overload y tipo de opciones, documentar uso/riesgos sin afirmar éxito del servicio si falló el arranque.
- [x] Verificar las siete suites focalizadas, sintaxis y whitespace; simplificar código modificado sin cambiar comportamiento.
- [x] Solicitar revisión independiente, corregir defectos comprobados y registrar resultados. Linux/systemd real sigue pendiente.

Comando focalizado: `node node_modules/mocha/bin/mocha.js --no-config --timeout 10000 --retries 0 test/programmatic/systemd_node_update.mocha.js test/programmatic/update_node_cli.mocha.js`.

## Resultado

- RED observado: 90 passing, 12 failing en las dos suites afectadas.
- GREEN: 102 pruebas en esas suites y 301 en las siete suites focalizadas, sin reintentos.
- Sintaxis y whitespace correctos. Reinicio/verificación compartidos en un helper para evitar duplicación de manejo de errores.
- Revisión independiente PASS, sin defectos críticos o importantes. No se afirma éxito de la suite completa ni de Linux/systemd real.
- Trabajo en `feat/update-node-no-rollback`: el PR original #4 ya fue fusionado; este cambio es un seguimiento separado.
