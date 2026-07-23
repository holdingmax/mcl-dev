# Notas de migración Firestore → MariaDB (Inmotion)

Resumen de reglas y decisiones clave acordadas durante el piloto de migración. Referencia rápida antes de retomar el trabajo o de explicarle el estado a alguien nuevo.

## Patrón de migración (todos los scripts `scripts/migrate-*.mjs`)

- **Dry-run por default.** Ningún script escribe en la base salvo que se pase `--execute` explícito.
- **`--preview=N`** controla cuántos INSERT completos se imprimen en dry-run (default 10). En colecciones chicas se usó un N que mostrara todos los documentos (ej. `--preview=3` para 3 docs).
- **Transacciones con rollback en `--execute`:** `BEGIN` al principio, `COMMIT` solo si todos los INSERT de la corrida salen bien, `ROLLBACK` automático ante cualquier error — nunca queda un estado parcial en la base.
- **Prepared statements con `?` siempre** (`connection.execute(sql, values)`), nunca concatenación de strings en el camino de ejecución real. El único lugar que arma SQL como texto es la función de *display* del dry-run (para que se vea legible), que nunca se ejecuta contra la base.
- **Regla de NULL:** si una clave no existe en el documento JSON → se inserta `NULL` real. Si existe (aunque sea `""` o un `null` explícito de Firestore) → se preserva tal cual, nunca se inventa string vacío ni el texto `"undefined"`/`"null"`.
- Fechas ISO (`"2026-04-24T20:47:06.876Z"`) se convierten a formato `DATETIME(3)` de MySQL (`'2026-04-24 20:47:06.876'`) preservando milisegundos.
- Campos numéricos con tipo mixto (int/float) se insertan tal cual vienen, sin forzar redondeo ni truncar decimales.

## Foreign keys sacadas intencionalmente

| Tabla.columna | Constraint | Motivo |
|---|---|---|
| `warehouse_receipts.client_id` | `warehouse_receipts_ibfk_1` (eliminada) | 16 de 18 `client_id` únicos usados por WRs reales no existen en `clients` — pertenecen a `warehouse_service_clients`, colección todavía no migrada. Se sacó la FK para no bloquear el piloto; la columna y su índice (`KEY client_id`) siguen intactos. |
| `billing_charges.wr_id` | `billing_charges_ibfk_2` (eliminada) | De 214 `wr_id` únicos, 13 no están en `warehouse_receipts`: 8 pertenecen a `inventory_documents` (no migrada) y 5 son referencias genuinamente huérfanas (documentos borrados de Firestore en su momento, confirmado buscando en las 920 shards del export — no existen en ningún kind). |

`billing_charges.client_id` (FK hacia `clients`) y las FKs de `client_billing_rates`/`billing_profiles`/`client_billing_config` **se mantuvieron intactas** — se verificó 100% de coincidencia en todos esos casos antes de crear las tablas.

`warehouse_receipt_lines.parent_id` **sí mantiene la FK real hacia `warehouse_receipts`** (a diferencia de `client_id`/`wr_id` en otras tablas) — se verificó 100% de coincidencia sin huérfanos antes de crear la tabla.

## Decisión sobre datos sensibles

**Confirmado por Álvaro:** `billing_profiles` se carga con PII real (nombres de contacto, emails, teléfonos, RUT/identificadores tributarios) tal cual viene de Firestore, **sin anonimizar**. Los ejemplos enmascarados que se mostraron en el chat durante el análisis fueron solo para revisión visual — la carga real a MariaDB (`--execute`) usa los datos reales.

## Estado de las 11 tablas del esquema actual

Todas migradas con datos reales, verificado con `COUNT(*)` contra la base después de cada carga:

| Tabla | Filas | Script de migración |
|---|---|---|
| `clients` | 2 | `scripts/migrate-clients.mjs` |
| `client_shippers` | 22 | `scripts/migrate-clients.mjs` |
| `warehouse_receipts` | 243 | `scripts/migrate-warehouse-receipts.mjs` |
| `billing_charges` | 480 | `scripts/migrate-billing-charges.mjs` |
| `rate_schedule` | 24 | `scripts/migrate-rate-schedule.mjs` |
| `billing_profiles` | 8 | `scripts/migrate-billing-profiles.mjs` |
| `billing_profile_destinations` | 8 | `scripts/migrate-billing-profiles.mjs` |
| `billing_profile_contacts` | 26 | `scripts/migrate-billing-profiles.mjs` |
| `client_billing_rates` | 3 | `scripts/migrate-client-billing-rates.mjs` |
| `client_billing_config` | 2 | `scripts/migrate-client-billing-config.mjs` |
| `warehouse_receipt_lines` | 749 | `scripts/migrate-warehouse-receipt-lines.mjs` |

Definiciones SQL en `scripts/schema/01-pilot-tables.sql` (clients, client_shippers, warehouse_receipts, billing_charges + los 2 `ALTER TABLE DROP FOREIGN KEY`), `scripts/schema/02-rate-billing-config.sql` (rate_schedule, billing_profiles + hijas, client_billing_rates, client_billing_config) y `scripts/schema/03-warehouse-receipt-lines.sql` (warehouse_receipt_lines).

## Pendientes de rondas anteriores (no migrado todavía)

- **`warehouse_service_clients`** — colección real (22 documentos), referenciada por 16 de los 18 `client_id` de `warehouse_receipts`. No decodificada ni migrada.
- **`inventory_documents`** — colección real (378 documentos + 213 en `inventory_documents_archive`), referenciada por 8 de los `wr_id` huérfanos de `billing_charges`. No decodificada ni migrada.
- **`warehouse_receipts.consignee`** — campo objeto anidado (18.5% de presencia en los WRs), sin columna ni tabla hija en el esquema actual — se pierde en la migración tal como está.
- **`clients.consignees`** y **`clients.email_recipients`** — arrays embebidos en `clients` (100% de presencia en los 2 documentos), sin tabla hija creada todavía (mismo patrón que `client_shippers`).
- **`warehouse_receipt_sku_lines`** (subcolección `sku_lines`, 454 docs) de `warehouse_receipts` — no tiene tabla SQL todavía. Uso activo confirmado en producción: el módulo Warehouse Services (`WSReception.tsx` y otros) lee y escribe subcolecciones de `warehouse_receipts` directamente.
- **`photo_urls` de `warehouse_receipt_lines`** (20.8% de presencia, array) — no migrado, mismo patrón que otros arrays pendientes.
- **Normalizar `awb_number`** en `warehouse_receipts` — el valor máximo real encontrado (90 caracteres) sugiere que el campo contiene múltiples AWBs concatenados en un solo string en vez de un valor atómico; evaluar si conviene separar antes de seguir construyendo sobre este campo.

## Plazos acordados con Álvaro

- **Escenario A** (deploy tal cual, sin cambiar motor de datos, a `mcldev.sispoapp.com.ar`): 2-4 horas.
- **Escenario B** (migrar módulo de facturación/WR completo a MariaDB — `clients`, `warehouse_receipts`, `billing_charges`, `rate_schedule` y los 27 archivos de frontend que los tocan): **5-8 días hábiles**. La subcolección `lines` (usada activamente por Warehouse Services) fue **CONFIRMADA por Álvaro** como parte del alcance, y ya está migrada (`warehouse_receipt_lines`, 749 filas) — se mantiene dentro del rango de 5-8 días.
- Ambiente de test aislado: se descartó levantar Firebase Emulators en el hosting compartido de Inmotion (arquitectura incompatible con cPanel shared hosting).
- También se evaluó crear un **segundo proyecto de Firebase real** (no emulado) para aislar test de producción — viable técnicamente (~1 día sin Cloud Functions, 2-3 días con ellas), pero **se descartó** porque contradice el mail "Circuito MCL" ya acordado con Federico/Jorge/Álvaro, que define explícitamente que la DB del ambiente de test debe ser `mcldev.sispoapp.com.ar` (Inmotion/MariaDB), no un proyecto Firebase separado.
- Por eso el camino confirmado y en curso es el **Escenario B (5-8 días)**.
