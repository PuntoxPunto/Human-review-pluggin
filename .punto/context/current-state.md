---
id: human-review-current-state
status: canonical
version: 2
updated: 2026-08-15
---

# Human Review — Estado actual

## Canonical baseline

El Project Pack v1 fue incorporado a `main` mediante PR #2. El estado canónico observado para este registro es:

`5401923e196f8eb479c0c3aed986bf8a65e322ce`

Ese baseline contiene exclusivamente la memoria mínima `.punto/` del proyecto; no convierte el MVP funcional en estado canónico.

## Trabajo activo observado

El MVP funcional continúa en Draft PR #1, branch `agent/human-review-mvp`.

Head observado para este registro:

`794fd85f7db2ca166e57d6780d450e5531883bba`

Ese trabajo sigue siendo `change_proposal` mientras no sea mergeado a `main`.

## Integración con Punto por Punto

- Human Review está registrado como `project_id: human-review` en el Project Registry de Punto por Punto.
- Su Project Pack canónico expone identidad, estado y arquitectura sin duplicar memoria en el repositorio madre.
- El primer smoke test federado canónico confirmó que Human Review, su nodo de proyecto y las relaciones `develops` / `described_by` se resuelven con procedencia canónica.
- La federación es read-only y no concede al repositorio madre autoridad de escritura sobre Human Review.

## Alcance del MVP observado en PR #1

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
- el límite restante de aceptación del MVP es la prueba completa en el host real de ChatGPT Developer Mode.

## Próximo gate del proyecto

Validar el bridge real dentro de ChatGPT y, después, decidir hardening/productización del MVP. El Project Pack y la integración federada ya pueden utilizarse para montar contexto del proyecto sin tratar PR #1 como canonical antes de su merge.
