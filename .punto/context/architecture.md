---
id: human-review-architecture
status: canonical
version: 1
updated: 2026-08-15
---

# Human Review — Arquitectura

## Flujo funcional observado

```text
ChatGPT
  ↓
create_review
  ↓
open_review
  ↓
Human Review widget
  ├─ save_review_draft
  └─ submit_review
        ↓
ChatGPT
  ↓
get_review_feedback
  ↓
apply_review
  ↓
open_review
```

## Componentes

- MCP server como backend de herramientas y sesiones;
- MCP Apps widget como interfaz visual dentro de ChatGPT;
- Skill companion para describir el loop de creación, revisión, feedback y aplicación;
- sanitizer y sandbox para reducir superficie activa del HTML revisado;
- store de sesiones, actualmente efímero en el servidor Node del MVP;
- tests de transporte/handshake y de invariantes de edición humana.

## Invariante central

Una edición humana directa es fuente prioritaria para ese contenido. La aplicación posterior de feedback por el modelo no debe revertirla silenciosamente.

## Seguridad del MVP

El preview usa iframe sandboxed y sanitización conservadora. Esta frontera es suficiente para el MVP y las pruebas actuales, pero no constituye hardening de producción.

## Relación con Punto por Punto

Este repositorio conserva su código y memoria específica. El repositorio madre `PuntoxPunto/Punto-x-Punto` sólo mantiene registro, contratos de interoperabilidad y relaciones entre proyectos.
