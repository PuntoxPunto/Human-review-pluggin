---
id: human-review-current-state
status: canonical
version: 1
updated: 2026-08-15
---

# Human Review — Estado actual

## Canonical baseline

`main` permanece en el bootstrap del repositorio observado en `dcd5eb38d2cddbc4e6c5eac93b3b3723479c8065`.

## Trabajo activo observado

El MVP funcional se desarrolla en Draft PR #1, branch `agent/human-review-mvp`.

Head observado para este registro:

`794fd85f7db2ca166e57d6780d450e5531883bba`

Ese trabajo sigue siendo `change_proposal` mientras no sea mergeado a `main`.

## Alcance del MVP observado

- servidor MCP;
- seis tools de review;
- widget MCP Apps dentro de ChatGPT;
- edición directa de texto;
- comentarios anclados;
- autosave y envío de feedback;
- protección contra revertir silenciosamente cambios humanos;
- Skill companion;
- tests unitarios e integración MCP;
- CI en la branch de implementación;
- documentación de deployment y conexión con ChatGPT.

## Limitaciones observadas

- storage principal del servidor Node todavía es in-memory;
- edición enfocada en HTML/CSS estático;
- no existe todavía pipeline de imágenes pegadas;
- algunas mutaciones estructurales no tienen el mismo nivel de conflict guard que el texto;
- el límite restante de aceptación es la prueba completa en el host real de ChatGPT Developer Mode.

## Próximo gate del proyecto

Validar el bridge real dentro de ChatGPT y, después, decidir hardening/productización sin tratar el MVP propuesto como canonical antes de su merge.
