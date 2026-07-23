# Hallazgos de auditoría (no relacionados con la migración de datos)

Hallazgos encontrados durante el trabajo de migración Firestore → MariaDB, pero que son independientes de esa migración en sí — quedan documentados acá para no perderlos ni mezclarlos con `scripts/MIGRATION_NOTES.md`.

## 1. Tokens de Firebase Storage expuestos en `inventory_documents`

En `inventory_documents.files[].url`, las URLs de Firebase Storage incluyen `?alt=media&token=...` — ese token es un **token de descarga de Firebase Storage** que **bypasea las Storage Security Rules por diseño**: cualquiera con la URL completa puede descargar el archivo real sin autenticarse, sin importar lo que digan `storage.rules`. Si estas URLs llegan a quedar expuestas en algún export/log, hay acceso directo a documentos reales de clientes.

## 2. AAID y ANDS (agentes de GitHub Actions) fallan desde el commit inicial del repo

Ambos workflows (`schedule`/cron, no disparados por push ni PR) fallan de forma idéntica desde el commit inicial (`0be191d`) — **2 días antes de que empezara cualquier trabajo de migración**, y también fallan en el commit actual. No es un efecto de nada tocado durante la migración ni del POC de `feature/mariadb-poc` (esa rama nunca se mergeó a `main`).

**Causa probable (no confirmada por falta de acceso a los logs — requiere permisos de admin/token en el repo):** el secret `FIREBASE_SERVICE_ACCOUNT` de GitHub mal configurado o ausente. Ambos agentes comparten `.github/agents/shared/firebase-client.mjs`, que intenta parsear ese secret y, si falla, cae a Application Default Credentials — inexistentes en un runner de GitHub Actions sin configuración adicional. Ya vimos este mismo error exacto (`"Could not load the default credentials"`) en un reporte real de otro agente (`AREF`, `.github/agents/reports/AREF-2026-05-21.json`).

**Impacto real de cada uno, confirmado leyendo el código:**
- **AAID** (`audit/index.mjs`) es únicamente un auditor de solo lectura (chequea huérfanos e inconsistencias de billing, nunca corrige nada) — que siga fallando no tiene impacto en producción, solo se pierde el reporte diario.
- **ANDS** (`deploy/index.mjs`) **no ejecuta ningún deploy real de código** — solo escribe un valor en el documento `config/feature_flags` de Firestore para avanzar/retroceder un rollout por tiers (`mcl_only` → `agents` → `all_mcl` → `clients` → `complete`). Confirmado en `rollback-manager.mjs` (comentario explícito: *"Does NOT do git revert or firebase hosting:rollback — those require manual trigger"*) y verificado que no hay ningún `exec`/`spawn`/`child_process` en toda la carpeta `deploy/`. Mientras falla, el avance del plan de canary queda congelado (ni promueve ni hace rollback), pero **no hay riesgo de que se rompa nada en producción** — no hay ningún build ni deploy de Hosting/Functions de por medio.

**Brecha de documentación encontrada:** `.github/agents/ARCHITECTURE.md` describe el flujo de ANDS como *"Check flags → Build → Deploy preview → Collect metrics → Claude analysis → Promote/Rollback → Report"* — pero el código real de `deploy/index.mjs` nunca implementó los pasos "Build" ni "Deploy preview". Salta directo de "Check flags" a "Collect metrics". La documentación describe una intención más ambiciosa que lo que el agente hace hoy.

## 3. `deploy.yml` apunta a una rama que ya no existe

`.github/workflows/deploy.yml` dispara `on: push: branches: [master]` — pero el repo renombró su rama principal de `master` a `main` (durante la sesión de migración). Ese workflow **no puede dispararse por push a ningún branch actual del repo**, ya que sigue mirando un nombre de rama inexistente. Hallazgo de la sesión anterior, todavía sin resolver — pendiente de decidir si se corrige (cambiar `master` por `main` en el `on: push:`) o se reemplaza por otro mecanismo de deploy.
