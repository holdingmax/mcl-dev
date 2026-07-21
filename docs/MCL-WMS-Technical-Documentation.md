# MCL WMS - Documentacion Tecnica Completa

**Sistema:** MinCurl Logistics Warehouse Management System (MCL WMS)
**Version:** 1.0.0
**Fecha:** Mayo 2026
**Clasificacion:** Confidencial - Solo para equipo IT autorizado

---

## Tabla de Contenidos

1. [Arquitectura General del Sistema](#1-arquitectura-general-del-sistema)
2. [Lenguajes, Frameworks y Librerias](#2-lenguajes-frameworks-y-librerias)
3. [Infraestructura y Hosting](#3-infraestructura-y-hosting)
4. [Base de Datos](#4-base-de-datos)
5. [Seguridad](#5-seguridad)
6. [Integraciones](#6-integraciones)
7. [Flujo Operativo del WMS](#7-flujo-operativo-del-wms)
8. [Mantenimiento y Soporte](#8-mantenimiento-y-soporte)
9. [Riesgos Tecnicos y Recomendaciones](#9-riesgos-tecnicos-y-recomendaciones)

---

## 1. Arquitectura General del Sistema

### 1.1 Patron Arquitectonico

MCL WMS es una **Single Page Application (SPA) serverless** construida sobre la plataforma Firebase de Google Cloud. No existen servidores propios ni infraestructura que gestionar: el frontend se sirve como archivos estaticos y toda la logica de backend se ejecuta en Cloud Functions bajo demanda.

### 1.2 Diagrama de Arquitectura

```
+---------------------------------------------------------------------+
|                        USUARIOS                                     |
|  [Staff MCL]   [Clientes]   [Viewers]   [Vendors]   [Drivers]      |
+--------+---------------+----------+-----------+-----------+---------+
         |               |          |           |           |
         v               v          v           v           v
+---------------------------------------------------------------------+
|                   FIREBASE HOSTING (CDN)                            |
|                   https://wms-mcl.web.app                          |
|                   SPA React (dist/)                                 |
+---------------------------------------------------------------------+
         |
         v
+---------------------------------------------------------------------+
|                     FRONTEND (React SPA)                            |
|  +------------------+  +------------------+  +------------------+   |
|  |   Sea Freight    |  |   Air Freight    |  | Warehouse Svcs   |   |
|  |   Module         |  |   Module         |  | Module           |   |
|  +------------------+  +------------------+  +------------------+   |
|  +------------------+  +------------------+  +------------------+   |
|  |   Billing        |  |  Admin / Setup   |  | Driver Portal    |   |
|  +------------------+  +------------------+  +------------------+   |
+---------------------------------------------------------------------+
         |                        |                       |
         v                        v                       v
+---------------------+  +-------------------+  +-------------------+
| FIREBASE AUTH       |  | CLOUD FIRESTORE   |  | CLOUD STORAGE     |
| - Google OAuth 2.0  |  | - NoSQL Document  |  | - PDFs, fotos     |
| - Email/Password    |  | - 30+ colecciones |  | - Documentos AWB  |
| - Session-only      |  | - Security Rules  |  | - Screening certs |
+---------------------+  +-------------------+  +-------------------+
                                  ^
                                  |
+---------------------------------------------------------------------+
|                    CLOUD FUNCTIONS (Node 22)                        |
|  +---------------------------+  +-------------------------------+   |
|  | processScreeningEmails    |  | checkScreeningAlerts          |   |
|  | (Scheduled 5x/dia)        |  | (Scheduled 1x/dia)           |   |
|  +---------------------------+  +-------------------------------+   |
|  +---------------------------+  +-------------------------------+   |
|  | triggerScreeningManual    |  | cleanupDriverQueue            |   |
|  | (Callable - on demand)    |  | (Scheduled cada 30 min)      |   |
|  +---------------------------+  +-------------------------------+   |
|  +---------------------------+  +-------------------------------+   |
|  | deleteClientUser          |  | deleteVendorUser              |   |
|  | (Callable)                |  | (Callable)                    |   |
|  +---------------------------+  +-------------------------------+   |
|  +---------------------------+  +-------------------------------+   |
|  | getScreeningPdf           |  | resetScreeningData            |   |
|  | (Callable - proxy)        |  | (Callable - admin)            |   |
|  +---------------------------+  +-------------------------------+   |
+---------------------------------------------------------------------+
         |                        |
         v                        v
+---------------------+  +-------------------+
| GMAIL API           |  | SMTP (Nodemailer) |
| - OAuth2            |  | - Gmail App Pwd   |
| - Leer screening    |  | - Alertas email   |
| - Marcar leidos     |  | - Escalaciones    |
+---------------------+  +-------------------+
```

### 1.3 Flujo de Informacion

1. **Usuario** accede a `https://wms-mcl.web.app` via navegador
2. **Firebase Hosting** sirve el bundle React (HTML/JS/CSS) desde CDN global
3. **React SPA** se carga en el navegador y maneja toda la navegacion client-side
4. **Firebase Auth** autentica al usuario (Google SSO o email/password)
5. **Firestore SDK** (client-side) lee/escribe directamente a la base de datos
6. **Security Rules** validan cada operacion segun rol y pertenencia del dato
7. **Cloud Functions** ejecutan procesos automatizados (screening, alertas, limpieza)
8. **Cloud Storage** almacena archivos binarios (PDFs, fotos, documentos)

### 1.4 Componentes Principales

| Componente | Responsabilidad |
|---|---|
| **React SPA** | Interfaz de usuario, logica de presentacion, generacion de PDFs client-side |
| **Firebase Auth** | Autenticacion, gestion de sesiones, proveedores OAuth |
| **Cloud Firestore** | Persistencia de datos, consultas en tiempo real, reglas de seguridad |
| **Cloud Storage** | Almacenamiento de archivos (PDFs, fotos, documentos escaneados) |
| **Cloud Functions** | Procesos backend: screening automatico, alertas, limpieza de datos |
| **Gmail API** | Lectura automatizada de emails de certificados de screening |
| **SMTP/Nodemailer** | Envio de alertas y notificaciones por email |

---

## 2. Lenguajes, Frameworks y Librerias

### 2.1 Frontend

| Tecnologia | Version | Rol |
|---|---|---|
| **TypeScript** | 5.2 | Lenguaje principal (tipado estatico sobre JavaScript) |
| **React** | 18.2 | Framework UI (componentes, estado, ciclo de vida) |
| **React Router** | 6.22 | Navegacion SPA con lazy loading y route guards |
| **Tailwind CSS** | 3.4 | Framework CSS utility-first para estilos |
| **Vite** | 5.1 | Build tool y dev server (HMR, bundling, code splitting) |

### 2.2 Librerias Criticas del Frontend

| Libreria | Version | Proposito |
|---|---|---|
| **firebase** | 10.8 | SDK cliente para Auth, Firestore, Storage, Functions |
| **pdf-lib** | 1.17 | Generacion y anotacion de PDFs (Delivery Orders, AWB cut) |
| **pdfjs-dist** | 5.6 | Renderizado de PDF a imagen (previews, OCR pipeline) |
| **html2pdf.js** | 0.14 | Conversion HTML a PDF (Warehouse Receipts, labels) |
| **exceljs** | 4.4 | Generacion de archivos Excel (exportaciones de inventario, gate-out) |
| **xlsx** | 0.18 | Lectura de archivos Excel (importacion de datos) |
| **date-fns** | 3.3 | Manipulacion y formateo de fechas |
| **recharts** | 3.8 | Graficos y dashboards (opcional, analytics) |
| **tesseract.js** | 7.0 | OCR en navegador (lectura de etiquetas con camara) |
| **@zxing/browser** | 0.1 | Escaneo de codigos de barras con camara |
| **react-barcode** | 1.6 | Generacion de codigos de barras (Code128) para etiquetas |
| **react-to-print** | 2.15 | Impresion de componentes React (WR, labels, DO) |

### 2.3 Backend (Cloud Functions)

| Tecnologia | Version | Rol |
|---|---|---|
| **Node.js** | 22 | Runtime de Cloud Functions |
| **firebase-functions** | 7.2 | Framework para definir Cloud Functions (v2) |
| **firebase-admin** | 13.7 | SDK administrativo (Firestore, Auth, Storage sin restricciones) |
| **googleapis** | 140.0 | Cliente Google APIs (Gmail API para screening) |
| **@anthropic-ai/sdk** | 0.52 | SDK Claude AI (reservado, usado previamente para vision OCR) |
| **nodemailer** | 6.9 | Envio de emails SMTP (alertas de screening) |
| **@google-cloud/secret-manager** | 6.1 | Gestion de secretos en Cloud Functions |

### 2.4 Justificacion de Decisiones Tecnologicas

- **Firebase completo:** Elimina la necesidad de mantener servidores, bases de datos o infraestructura. Escala automaticamente.
- **Firestore (NoSQL):** Los datos logisticos son jerarquicos y variados. Un esquema flexible permite evolucionar sin migraciones.
- **Vite sobre Webpack:** Build rapido (~3s vs ~30s), HMR instantaneo, code splitting nativo.
- **Tailwind CSS:** Desarrollo UI rapido sin archivos CSS separados. Consistencia de diseno.
- **pdf-lib (client-side):** Genera PDFs sin backend, reduce latencia y costos de Cloud Functions.
- **tesseract.js (client-side):** OCR de etiquetas directamente en el navegador del operario de bodega.

---

## 3. Infraestructura y Hosting

### 3.1 Servicios Firebase en Uso

| Servicio | Plan | Proyecto |
|---|---|---|
| Firebase Hosting | Spark/Blaze | `wms-mcl` |
| Cloud Firestore | Blaze (pay-as-you-go) | `wms-mcl` |
| Firebase Auth | Gratuito (incluido) | `wms-mcl` |
| Cloud Storage | Blaze | `wms-mcl.firebasestorage.app` |
| Cloud Functions | Blaze (Node 22) | `wms-mcl` |
| Secret Manager | Blaze | Secretos de screening |

### 3.2 Entornos

| Entorno | Estado | URL |
|---|---|---|
| **Produccion** | Activo | `https://wms-mcl.web.app` |
| **Desarrollo local** | `vite dev` | `http://localhost:5173` |
| **Emuladores Firebase** | Parcial (solo Storage) | `localhost:9199` (Storage), `localhost:4000` (UI) |

> **Nota:** No existe un entorno de staging ni de QA separado. Todas las pruebas se hacen contra Firestore de produccion o localmente con emuladores parciales.

### 3.3 Proceso de Deploy Actual

```bash
# 1. Build del frontend
npm run build          # Vite genera dist/

# 2. Deploy de hosting + reglas
firebase deploy --only hosting
firebase deploy --only firestore:rules
firebase deploy --only storage

# 3. Deploy de Cloud Functions
cd functions
firebase deploy --only functions
```

**Configuracion de caching (firebase.json):**
- `index.html`: `no-cache, no-store, must-revalidate` (siempre fresco)
- `/assets/**`: `public, max-age=31536000, immutable` (1 ano, versionados por hash)
- SPA rewrite: todas las rutas redirigen a `index.html`

### 3.4 Recomendacion: Deploy Profesional

Para eliminar la dependencia de una laptop personal, se recomienda:

```
+------------------+     +-------------------+     +------------------+
| GitHub repo      | --> | GitHub Actions    | --> | Firebase Hosting |
| (push a main)    |     | CI/CD pipeline    |     | + Functions      |
+------------------+     +-------------------+     +------------------+
```

**Pipeline sugerido (GitHub Actions):**

```yaml
# .github/workflows/deploy.yml
name: Deploy to Firebase
on:
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build
      - uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
          channelId: live
```

---

## 4. Base de Datos

### 4.1 Tipo y Caracteristicas

- **Motor:** Cloud Firestore (Google Cloud)
- **Modelo:** NoSQL orientado a documentos
- **Estructura:** Colecciones > Documentos > Campos (+ subcolecciones)
- **Consultas:** Indices compuestos, filtros por igualdad y rango, array-contains
- **Tiempo real:** Listeners con `onSnapshot()` para actualizaciones instantaneas

### 4.2 Mapa de Colecciones

```
FIRESTORE DATABASE (wms-mcl)
|
+-- config/                          # Configuracion del sistema
|   +-- wr_sequence                  # Secuencia WR: {next: number}
|   +-- ws_wr_sequence               # Secuencia WR Warehouse Services
|   +-- invoice_sequence             # Secuencia facturas sea freight
|   +-- air_invoice_sequence         # Secuencia facturas airfreight
|   +-- do_sequence                  # Secuencia Delivery Orders
|   +-- mcl_roles                    # Config de roles
|   +-- anthropic_key                # API key Claude (legacy)
|
+-- user_roles/{uid}                 # Roles y permisos por usuario
|   +-- role: string                 # admin|accounting|super_agent|agent|
|   |                                # counter|bodega|client|viewer|vendor_admin
|   +-- client_id: string            # (solo clients/viewers) FK a cliente
|   +-- modules: string[]            # ['seafreight','airfreight','warehouse_services']
|   +-- must_change_password: bool   # Forzar cambio en primer login
|   +-- is_ecommerce: bool           # Cliente tipo ecommerce
|   +-- can_view_charges: bool       # Puede ver cargos/billing
|
+=== SEA FREIGHT =====================================================
|
+-- clients/{id}                     # Clientes sea freight
|   +-- name, shippers[], consignees[], email_recipients[]
|
+-- consignees/{id}                  # Consignatarios (legacy)
|
+-- warehouse_receipts/{id}          # Recibos de almacen
|   +-- wr_number: string            # "LI0000000001"
|   +-- client_id, client_name
|   +-- po_number, shipper, consignee
|   +-- driver_name, dl_number, dl_photo_url
|   +-- status: string               # received|dispatched|partial
|   +-- dispatch_status: string       # pending|dispatched|partial
|   +-- total_qty, total_cbm, total_weight_kg
|   +-- created_at, updated_at
|   +-- /lines/{lineId}             # Lineas de carga
|   |   +-- packing_type, qty, length, width, height, weight_kg
|   |   +-- cbm, is_lb, is_dg, location, remarks
|   |   +-- photo_urls[]
|   +-- /sku_lines/{skuId}          # Detalle SKU
|       +-- sku, vin, received_qty, case_pack
|
+-- dispatches/{id}                  # Despachos / consolidaciones
|   +-- container_number, container_size, booking_number
|   +-- seal_number, vendor, destination
|   +-- client_ids[]                 # Array de client_ids incluidos
|   +-- wr_ids[]                     # WRs incluidos
|   +-- status, gate_out_date
|
+-- billing_charges/{id}             # Cargos sea freight
|   +-- client_id, wr_id, dispatch_id
|   +-- charge_type, description, qty, rate, total
|   +-- status: pending|invoiced|void
|
+-- invoices/{id}                    # Facturas sea freight
|   +-- client_id, charges[], total, status
|
+-- rate_schedule/{id}               # Tarifario base sea freight
+-- client_billing_rates/{id}        # Overrides por cliente
+-- client_billing_config/{id}       # Config billing por cliente
+-- billing_profiles/{id}            # Perfiles de facturacion
+-- inventory_documents/{id}         # Docs de inventario y ETD
|
+=== AIR FREIGHT =====================================================
|
+-- airfreight_flights/{id}          # Vuelos
|   +-- flight_number, airline, flight_datetime
|   +-- flight_status: string        # booked|terminado|dispatched
|   +-- origin, destination
|   +-- doc_do_tsa, doc_distribution  # Docs nivel vuelo
|
+-- airfreight_bookings/{id}         # Bookings de carga aerea
|   +-- booking_type: string         # simple|mawb|ecommerce|export
|   +-- client_id, client_name
|   +-- flight_id, flight_number
|   +-- mawb_number                  # (mawb/ecommerce types)
|   +-- awb_lines: AwbLine[]         # Lineas AWB con detalle
|   |   +-- awb_number, awb_2nd_leg, uld_type
|   |   +-- pieces, chargeable_weight
|   |   +-- pickup_from, deliver_to, destination
|   |   +-- ready_pickup, last_day_free, cutoff, etd
|   |   +-- hold_bg, hold_box
|   |   +-- is_battery (Lithium Battery)
|   |   +-- screening_status, screening_pieces_screened
|   |   +-- doc_screening_cert       # Cert con versionado
|   |   +-- dispatch_status, dispatched_at
|   |   +-- move_log[]               # Historial de movimientos
|   +-- screening_status: string     # pending|partial|complete|error
|   +-- screening_pieces_total: number
|   +-- screening_events: string[]   # IDs de screening_events
|   +-- created_at, updated_at
|
+-- airfreight_clients/{id}          # Clientes airfreight
|   +-- name, contact, email
|   +-- billing: AirfreightClientBilling
|   +-- type: string                 # ecommerce|regular
|
+-- airfreight_destinations/{id}     # Destinos configurados
+-- airfreight_holds/{id}            # Holds (CBP, docs, customs)
|   +-- client_id, flight_id, booking_id
|   +-- hold_type, status, items[], photos[]
|
+-- delivery_orders/{id}             # Ordenes de entrega
|   +-- do_number: "DO-0000001"
|   +-- awb_entries: AwbEntry[]      # Multi-AWB
|   +-- driver_name, driver_phone
|   +-- tracking_id                  # FK a delivery_tracking
|
+-- pickup_orders/{id}               # Ordenes de pickup
|   +-- pu_number: "PU-0000001"
|   +-- lines: PickupOrderLine[]
|
+-- screening_events/{id}            # Eventos de screening procesados
|   +-- gmail_message_id, gmail_subject, gmail_date
|   +-- pdf_url, pdf_storage_path
|   +-- extracted: { mawb, awb, date, time, pieces, uld_lines[] }
|   +-- matched_booking_id, matched_flight_id
|   +-- match_method, match_status
|
+-- screening_settings/config        # Config del agente screening
|   +-- enabled, phantom_k9_emails[], mcl_alert_emails[]
|   +-- last_run, last_run_status, last_run_count
|   +-- /escalations/{id}           # Historial de alertas enviadas
|
+=== AIR BILLING =====================================================
|
+-- air_rate_schedule/{id}           # Tarifario base aereo
+-- air_rate_airline_overrides/{id}  # Overrides por aerolinea
+-- air_rate_client_overrides/{id}   # Overrides por cliente
+-- air_billing_profiles/{id}        # Perfiles billing aereo
+-- air_billing_charges/{id}         # Cargos aereos
|   +-- client_id, flight_id, booking_id
|   +-- charge_type: string          # ALL_IN|HANDLING|DROP_OFF|PICK_UP|
|   |                                # BUP_PICK_UP|BREAKDOWN|WOODEN_PALLETS|
|   |                                # BUILD_UP_PALLETS|manual
|   +-- source: 'auto'|'manual'
|   +-- status: pending|invoiced|void
|   +-- qty, rate, unit, total
|
+-- air_invoices/{id}                # Facturas aereas
|   +-- invoice_number, client_id
|   +-- charges[], total
|   +-- status: draft|sealed|void
|
+=== WAREHOUSE SERVICES ==============================================
|
+-- warehouse_service_orders/{id}    # Ordenes de servicio 3PL
|   +-- client_id, status
|   +-- items: WSServiceItem[]
|   +-- cargo_type, cargo_mode
|
+-- warehouse_service_clients/{id}   # Clientes WS
+-- ws_inspection_logs/{id}          # Logs de inspeccion
+-- ws_delivery_orders/{id}          # DOs de warehouse services
+-- ws_billing_charges/{id}          # Cargos WS
+-- ws_invoices/{id}                 # Facturas WS
+-- ws_rate_schedule/{id}            # Tarifario WS
|
+=== TRANSPORTE Y VENDORS ============================================
|
+-- vendors/{id}                     # Proveedores de transporte
|   +-- name, address, city, phone, email
|
+-- vendor_users/{uid}               # Usuarios de vendors
|   +-- vendor_id, role
|
+-- driver_queue/{id}                # Cola de drivers (check-in)
|   +-- driver_name, pin, status, expires_at
|
+-- delivery_tracking/{id}           # Tracking en tiempo real
|   +-- do_id, vendor_id, driver_name
|   +-- milestones: { arrival_mcl, truck_loaded, arrival_airline, ... }
|   +-- gps_coords[], photos[], notes
|
+=== OTROS ===========================================================
|
+-- backup_express_line/{id}         # Backups temporales (admin)
```

### 4.3 Indices Compuestos

Los indices estan definidos en `firestore.indexes.json`:

| Coleccion | Campos | Proposito |
|---|---|---|
| `airfreight_bookings` | `client_id` ASC + `created_at` DESC | Bookings por cliente, ordenados |
| `airfreight_bookings` | `flight_id` + `client_id` + `created_at` | Bookings por vuelo y cliente |
| `airfreight_bookings` | `flight_id` + `created_at` | Bookings por vuelo |
| `airfreight_holds` | `client_id` + `created_at` DESC | Holds por cliente |
| `warehouse_receipts` | `client_id` + `created_at` DESC | WRs por cliente |
| `warehouse_receipts` | `dispatch_status` + `client_id` | WRs por estado de despacho |
| `dispatches` | `client_ids` ARRAY_CONTAINS + `created_at` DESC | Despachos que incluyen cliente |
| `billing_charges` | `client_id` + `created_at` DESC | Cargos por cliente |
| `airfreight_flights` | `flight_status` + `flight_datetime` | Vuelos por estado y fecha |
| `screening_events` | `matched_booking_id` + campos de extraccion | Eventos screening por booking |

### 4.4 Buenas Practicas y Riesgos

**Buenas practicas implementadas:**
- Secuencias atomicas (`config/wr_sequence`) con `runTransaction()` para evitar duplicados
- `client_ids` como array para consultas `array-contains` en dispatches multi-cliente
- Campos desnormalizados (`client_name` en bookings) para evitar JOINs costosos
- Soft deletes en vendors (flag `deleted` en vez de borrar documentos)

**Riesgos a mitigar:**
- **Sin backups automaticos:** Firestore no tiene backups programados por defecto. Se deben configurar exports periodicos a Cloud Storage.
- **Desnormalizacion:** Si cambia el nombre de un cliente, hay que actualizar todos los documentos relacionados.
- **Limites Firestore:** Max 1 escritura/doc/segundo. Operaciones batch max 500 docs.
- **Consultas limitadas:** Firestore no soporta `OR` nativo, `JOIN`, ni full-text search.

---

## 5. Seguridad

### 5.1 Autenticacion

**Proveedores configurados en Firebase Auth:**

| Proveedor | Usuarios | Detalles |
|---|---|---|
| **Google OAuth 2.0** | Staff MCL (`@mincurllogistics.com`) | SSO corporativo |
| **Email/Password** | Clientes, viewers, vendors | Creados por admin con password temporal |

**Gestion de sesiones:**
- Persistencia: `browserSessionPersistence` (se cierra al cerrar pestana)
- Inactividad: Auto-logout a los **30 minutos** sin interaccion
- Primer login: Fuerza cambio de password (`must_change_password` flag)
- Tokens Gmail: Solo en `sessionStorage` (no persisten entre sesiones)

### 5.2 Modelo de Autorizacion (Roles)

```
+------------------------------------------------------------------+
|                     JERARQUIA DE ROLES                           |
+------------------------------------------------------------------+
|                                                                  |
|  admin ──────── Acceso total. CRUD en todo. Deploy, config.      |
|  accounting ─── Billing completo. Rates, invoices, charges.      |
|  super_agent ── Operaciones + edicion de WRs ya creados.         |
|  agent ──────── Operaciones: counter, recepcion, despacho.       |
|  counter ────── Solo recepcion documental (counter).             |
|  bodega ─────── Solo recepcion fisica (warehouse floor).         |
|  client ─────── Ver/editar SOLO sus propios datos.               |
|  viewer ─────── Solo lectura de datos de su cliente.             |
|  vendor_admin ─ Solo portal de tracking de su vendor.            |
|                                                                  |
+------------------------------------------------------------------+
```

**Modulos por usuario** (`user_roles.modules[]`):
- `seafreight` - Acceso al modulo maritimo
- `airfreight` - Acceso al modulo aereo
- `warehouse_services` - Acceso al modulo 3PL

### 5.3 Reglas de Firestore (Resumen)

Las reglas estan en `firebase/firestore.rules` (283 lineas). Patron principal:

```javascript
// Funciones helper reutilizadas en todas las reglas:
function isMCL()           // Email @mincurllogistics.com
function isLoggedIn()      // Cualquier usuario autenticado
function userRole()        // Lee rol desde user_roles/{uid}
function isClient()        // Rol == 'client'
function isViewer()        // Rol == 'viewer'
function clientId()        // Lee client_id desde user_roles/{uid}
function isAdminOrAccounting()  // MCL + (admin || accounting)
function isVendorAdmin()   // Rol == 'vendor_admin'
function vendorId()        // Lee vendor_id desde vendor_users/{uid}
```

**Ejemplos de reglas por coleccion:**

```
warehouse_receipts:
  - MCL: read + write
  - Client: read SOLO si resource.data.client_id == clientId()

airfreight_bookings:
  - MCL: read + write
  - Client: CRUD SOLO si client_id coincide
  - Viewer: read SOLO si client_id coincide

air_rate_schedule:
  - MCL: read
  - Admin/Accounting: write (rates son sensibles)

driver_queue:
  - PUBLICO: create + read (drivers no autenticados)
  - MCL: update + delete

delivery_tracking:
  - PUBLICO: read + update (drivers actualizan milestones)
  - MCL: create + delete
  - Vendor admin: read SOLO su vendor_id

user_roles:
  - MCL: read + write
  - Usuario: read su propio doc
  - Usuario: update SOLO must_change_password a false
```

### 5.4 Reglas de Storage

```
airfreight/tracking-photos/*:
  - PUBLICO: write (drivers suben fotos) con limite 10MB, solo imagenes
  - Logueados: read

airfreight/**:
  - Logueados: read + write (10MB max)

airfreight/screening-certs/**:
  - MCL: read + write

uld_returns/**, uld_return_documents/**:
  - MCL: read + write

ws_screening_reports/**, ws_documents/**:
  - MCL: read + write

seafreight/**:
  - Logueados: read + write (10MB max)
```

### 5.5 Manejo de Secretos

| Secreto | Ubicacion | Uso |
|---|---|---|
| Firebase config (API keys) | `.env` (frontend, VITE_*) | Config publica del SDK (normal en Firebase) |
| Google Vision API Key | `.env` (VITE_GOOGLE_VISION_API_KEY) | OCR de documentos |
| GMAIL_CLIENT_ID | Firebase Secret Manager | OAuth2 para Gmail API |
| GMAIL_CLIENT_SECRET | Firebase Secret Manager | OAuth2 para Gmail API |
| GMAIL_REFRESH_TOKEN | Firebase Secret Manager | Token persistente Gmail |
| GMAIL_USER | Firebase Secret Manager | Cuenta email para SMTP |
| GMAIL_APP_PASSWORD | Firebase Secret Manager | App password Gmail |
| ANTHROPIC_API_KEY | Firebase Secret Manager | Claude API (screening legacy) |

**Nota:** Las API keys de Firebase en el `.env` son **intencionalmente publicas** -- la seguridad de Firebase depende de las Security Rules, no de ocultar las keys. Sin embargo, la Google Vision API Key deberia estar restringida por dominio en Google Cloud Console.

### 5.6 Recomendaciones de Endurecimiento

1. **Restringir API keys** en Google Cloud Console (dominio + IP)
2. **Activar App Check** en Firebase para prevenir acceso desde apps no autorizadas
3. **Auditar reglas de `delivery_tracking`**: actualmente permite `update: if true` (cualquiera puede modificar). Considerar limitar a drivers con PIN valido.
4. **Auditar `driver_queue`**: `create: if true` permite spam. Considerar rate limiting o captcha.
5. **Auditar `vendors`**: `read: if true` expone lista de proveedores. Considerar restringir a usuarios logueados.
6. **Activar Firestore audit logging** en Google Cloud para trazabilidad.
7. **Rotar GMAIL_REFRESH_TOKEN** periodicamente.
8. **Implementar backups automaticos** de Firestore (export a Cloud Storage diario).

---

## 6. Integraciones

### 6.1 Gmail API (Screening Automatico)

```
+-------------------+     +---------------------+     +------------------+
| Phantom K9        | --> | Gmail (screening@   | --> | processScreening |
| (envia cert PDF)  |     | mincurllogistics)   |     | Emails (CF)      |
+-------------------+     +---------------------+     +------------------+
                                                              |
                                      +-----+-----+-----+----+
                                      v     v     v          v
                               [Parse email] [Download PDF] [Match AWB]
                                      |           |          |
                                      v           v          v
                               [screening_events] [Storage] [Update booking]
```

**Detalles:**
- **Autenticacion:** OAuth2 con refresh token
- **Busqueda:** `subject:"screening result" has:attachment after:[timestamp]`
- **Parsing:** Regex para AWB, ULD, piezas, screener, fecha
- **Matching:** AWB directo > MAWB fallback > near-match (1-2 chars)
- **Deduplicacion:** Por ULD key (`bookingId::awb::uld`)
- **Frecuencia:** 5 veces/dia (8am, 1pm, 6pm, 9pm, 11pm PST)

### 6.2 SMTP / Nodemailer (Alertas)

- **Servicio:** Gmail SMTP con App Password
- **Usos:** Alertas de screening incompleto, errores de piezas, escalaciones
- **Escalacion:** Dias 1-3 diario, dia 4+ cada 2 dias
- **Destinatarios:** Phantom K9 + CC MCL alert emails

### 6.3 Gmail API (Frontend - Envio de Emails)

- **Uso:** Confirmacion de despacho maritimo (draft creation)
- **Scopes:** `gmail.send`, `gmail.compose`
- **Autenticacion:** OAuth2 token del usuario logueado
- **Almacenamiento:** Token en `sessionStorage` (no persiste)

### 6.4 Google Vision API (Legacy/Parcial)

- **Uso:** OCR de documentos en el frontend
- **API Key:** En `.env` como `VITE_GOOGLE_VISION_API_KEY`
- **Estado:** Configurado pero el uso principal de OCR es ahora tesseract.js (client-side)

### 6.5 Claude AI / Anthropic (AWB Cut)

- **Uso:** Procesamiento de Distribution Sheets en modulo AWB Cut
- **Funcion:** `callProcessDistribution()` y `callIdentifyAwbs()` en `src/lib/awbCut.ts`
- **Modelo:** Claude Vision para extraer AWB-to-pallet mapping de PDFs escaneados
- **Llamada:** Directa desde frontend via API key almacenada en Firestore (`config/anthropic_key`)

### 6.6 Resumen de Integraciones

| Integracion | Protocolo | Direccion | Modulo |
|---|---|---|---|
| Gmail API (lectura) | REST/OAuth2 | Inbound | Screening Agent (Cloud Function) |
| Gmail API (envio) | REST/OAuth2 | Outbound | Sea Freight (Frontend) |
| SMTP/Nodemailer | SMTP | Outbound | Screening Alerts (Cloud Function) |
| Claude Vision API | REST/API Key | Outbound | AWB Cut (Frontend) |
| Google Vision API | REST/API Key | Outbound | OCR docs (Frontend, legacy) |
| Firebase Auth | SDK | Bidirectional | Todos los modulos |
| Cloud Firestore | SDK | Bidirectional | Todos los modulos |
| Cloud Storage | SDK | Bidirectional | Todos los modulos |

---

## 7. Flujo Operativo del WMS

### 7.1 Modulo Sea Freight

```
RECEPCION DOCUMENTAL (Counter)
================================
[Cliente llega con carga]
        |
        v
[CounterNew] --> Crear Warehouse Receipt
  - Seleccionar cliente
  - Ingresar: PO#, shipper, consignee
  - Registrar: driver name, DL#, foto DL
  - Generar WR# automatico (LI + 10 digitos)
        |
        v
RECEPCION FISICA (Bodega)
================================
[PhysicalReception] --> Registrar carga linea por linea
  - Tipo embalaje (SKID, Bolsa, Crate, etc.)
  - Piezas, peso, dimensiones (L x W x H)
  - CBM calculado automaticamente
  - LB (Lithium Battery), DG (Dangerous Goods)
  - Ubicacion en bodega
  - Fotos por linea
  - Detalle SKU (opcional)
        |
        v
[auto] --> Calcular cargos de recepcion
  - Unloading (por CBM)
  - In/Out (por pallets o CBM)
        |
        v
INVENTARIO Y DOCUMENTACION
================================
[Inventory] --> Ver todo el inventario recibido
[InventoryDocuments] --> Tracking de documentacion y ETD
        |
        v
DESPACHO / CONSOLIDACION
================================
[DispatchNew] --> Crear despacho
  - Seleccionar WRs a incluir
  - Asignar contenedor, booking, seal
  - Seleccionar vendor de transporte
  - Confirmar destino
        |
        v
[auto] --> Calcular cargos de despacho
  - Loading, drayage, hazmat, storage
  - Storage con dias libres por tipo de carga
        |
        v
[Dispatch Confirm] --> Confirmar gate-out
  - Email de confirmacion via Gmail API
  - Actualizar status de WRs
        |
        v
FACTURACION
================================
[BillingCharges] --> Revisar cargos acumulados
[Invoices] --> Generar facturas por cliente
[ExportGateOut] --> Exportar a Excel
```

### 7.2 Modulo Air Freight

```
CREACION DE BOOKING
================================
[AirfreightBookingNew] --> Crear booking
  Tipos:
  (a) Simple: 1 AWB por booking
  (b) MAWB: Master + HAWBs
  (c) Ecommerce: Multi-AWB (paste from Excel)
  (d) Export: Exportaciones
        |
        v
  - Seleccionar vuelo (o crear nuevo)
  - Ingresar AWB lines: flight#, AWB 1st/2nd leg
  - ULD type, piezas, chargeable weight
  - Pickup from, deliver to, destination
  - Fechas: ready pickup, last day free, cutoff, ETD
  - Hold BG#, Hold Box#, Battery flag
        |
        v
GESTION DE VUELO
================================
[AirfreightDashboard] --> Flight Operations Board
  - Vista tipo Kanban por vuelo
  - Estado del vuelo: booked --> terminado --> dispatched
  - Por cada booking: docs, screening, holds
        |
        v
DOCUMENTACION
================================
[AirfreightDocs] --> Subir documentos por booking
  - Cliente sube: 7512, HAWB, MAWB draft/final
  - Si battery: LB checklist, CCSF
  - MCL sube: distribution list, DO/TSA
  - Versionado de documentos con historial
        |
        v
SCREENING
================================
[AirfreightScreening] --> Proceso automatico
  - Cloud Function lee emails de Phantom K9
  - Extrae AWB, ULD, piezas del certificado
  - Matchea con bookings existentes
  - Actualiza status: pending -> partial -> complete
  - Alertas por email si piezas no coinciden
        |
        v
HOLDS
================================
[AirfreightHolds] --> Gestionar holds
  - Hold CBP, documentacion, customs
  - Fotos requeridas como evidencia
  - Cliente da instrucciones (fly / send DO)
        |
        v
ULD CONTROL
================================
[AirfreightUldControl] --> Empacar AWBs en ULDs
  - Asignar AWBs a contenedores aereos
  - Track ULD returns
        |
        v
AWB CUT (Distribution)
================================
[AirfreightAwbCut] --> Procesar distribution sheets
  - OCR via Claude Vision
  - Extraer mapeo AWB -> pallets
  - Anotar PDFs de AWB con codigos de pallet
        |
        v
DESPACHO DE VUELO
================================
[Flight Dispatch] --> Cambiar status a "dispatched"
  - Genera cargos automaticos por cliente:
    ALL-IN, Handling, Drop Off, Pick Up, BUP, Breakdown, Pallets
  - Bloquea edicion de bookings
        |
        v
DELIVERY & PICKUP ORDERS
================================
[AirfreightDeliveryOrder] --> Crear DO (multi-AWB)
  - Genera PDF con detalle de AWBs
  - Asignar driver
  - Tracking con milestones GPS
[AirfreightPickupOrder] --> Crear PU
  - Genera HTML imprimible
        |
        v
FACTURACION AEREA
================================
[AirfreightBillingCharges] --> Revisar cargos
[AirfreightBillingSummary] --> Generar facturas
  - Draft -> Sealed -> Void/Unlock
  - Review automatico si datos cambian post-facturacion
```

### 7.3 Modulo Warehouse Services

```
ORDEN DE SERVICIO
================================
[WSOrderNew] --> Crear orden de servicio
  - Cliente, tipo de servicio (screening, transport, storage, etc.)
  - Items con detalle de carga
  - Status: requested
        |
        v
RECEPCION
================================
[WSReception] --> Recibir carga fisicamente
  - Escaneo de codigos de barra (camara + Tesseract OCR)
  - Captura de peso
  - Status: checked_in -> received
        |
        v
SCREENING / INSPECCION
================================
[WSScreening] --> Realizar inspeccion
  - Formularios de inspeccion (K9, X-Ray, manual)
  - Log de inspeccion con observaciones
  - Upload de reportes
  - Status: in_progress
        |
        v
ENTREGA
================================
[WSDeliveryOrders] --> Crear ordenes de entrega
  - Asignar a vendor/driver
  - Status: completed
        |
        v
FACTURACION
================================
[WSBillingCharges] --> Cargos por servicio
[WSInvoices] --> Facturas
```

### 7.4 Manejo de Errores y Validaciones

| Contexto | Validacion | Accion |
|---|---|---|
| WR duplicado | Secuencia atomica con `runTransaction()` | Retry automatico |
| Booking sin vuelo | Validacion en formulario | Bloquea submit |
| Screening pcs > booking pcs | Status = 'error' | Alerta email automatica |
| AWB no encontrado | Near-match (1-2 chars) | Sugiere correccion manual |
| Vuelo dispatched | UI bloquea edicion | Mensaje al usuario |
| Invoice sealed | Requiere void/unlock | Solo admin/accounting |
| Driver queue expired | `cleanupDriverQueue` (cada 30min) | Auto-expira entradas >3h |
| Password debil | `validatePasswordStrength()` | Min 10 chars, mixto |
| In-app browser | `InAppBrowserBlock` | Bloquea acceso, sugiere navegador real |

---

## 8. Mantenimiento y Soporte

### 8.1 Levantar Entorno Local

**Prerrequisitos:**
- Node.js 22+
- npm (incluido con Node)
- Firebase CLI: `npm install -g firebase-tools`
- Git

**Pasos:**

```bash
# 1. Clonar repositorio
git clone <repo-url> mcl-wms
cd mcl-wms

# 2. Instalar dependencias frontend
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con las credenciales de Firebase
# (solicitar a admin las credenciales del proyecto wms-mcl)

# 4. Iniciar servidor de desarrollo
npm run dev
# Abre http://localhost:5173

# 5. (Opcional) Instalar dependencias de Cloud Functions
cd functions
npm install
cd ..

# 6. (Opcional) Iniciar emuladores Firebase
firebase emulators:start --only storage
# Storage emulator en localhost:9199
# UI en localhost:4000
```

### 8.2 Estructura del Repositorio

```
mcl-wms/
  src/
    App.tsx              # Router principal (67 rutas lazy-loaded)
    main.tsx             # Entry point React
    index.css            # Estilos globales (Tailwind)
    components/          # 6 componentes compartidos
    contexts/            # AuthContext (393 lineas)
    data/                # Seed data (clientes, vendors, emails)
    lib/                 # Logica de negocio (13 archivos, ~1800 lineas)
    pages/               # ~67 paginas organizadas por modulo
    types/               # Definiciones TypeScript (1267 lineas)
  functions/
    index.js             # Cloud Functions (1430 lineas)
  firebase/
    firestore.rules      # Reglas Firestore (283 lineas)
    storage.rules        # Reglas Storage (79 lineas)
  docs/                  # Documentacion y prototipos
  public/                # Assets estaticos
```

### 8.3 Depuracion de Errores Comunes

| Problema | Causa Probable | Solucion |
|---|---|---|
| "Permission denied" en Firestore | Reglas de seguridad rechazan la operacion | Verificar rol del usuario en `user_roles/{uid}`. Verificar `client_id` matches. |
| Login con Google falla | In-app browser (WhatsApp, Instagram) | Abrir en Chrome/Safari externo |
| Screening no procesa emails | Token Gmail expirado o secretos invalidos | Verificar GMAIL_REFRESH_TOKEN en Secret Manager. Regenerar si es necesario. |
| WR con numero duplicado | Race condition en secuencia | `runTransaction()` deberia prevenirlo. Si ocurre, verificar `config/wr_sequence`. |
| PDF no se genera | `html2pdf.js` falla en ciertos navegadores | Usar Chrome. Verificar que no haya AdBlocker interfiriendo. |
| Build falla | Dependencias desactualizadas | `rm -rf node_modules && npm install` |
| Cloud Function timeout | Proceso tarda >540s | Revisar logs en Cloud Console. Optimizar queries o aumentar timeout. |
| Cargos no se generan al dispatch | Rate schedule no configurado para cliente/aerolinea | Verificar `air_rate_schedule`, overrides, y config del cliente. |

### 8.4 Monitoreo y Logs

| Herramienta | URL | Que Monitorear |
|---|---|---|
| **Firebase Console** | console.firebase.google.com/project/wms-mcl | Firestore, Auth, Storage, Functions |
| **Cloud Functions Logs** | Console > Functions > Logs | Errores de screening, timeouts, API failures |
| **Firestore Usage** | Console > Firestore > Usage | Reads/writes/deletes por dia |
| **Auth Users** | Console > Authentication | Usuarios activos, bloqueos |
| **Storage Usage** | Console > Storage | Espacio utilizado, archivos |
| **Google Cloud Logging** | console.cloud.google.com | Logs detallados, metricas |

**Diagnostico del Screening Agent:**
- Coleccion `screening_settings/config` tiene campo `last_run_diag` con detalle por email procesado
- Outcomes posibles: `processed`, `already_processed`, `no_pdf`, `no_awb_lines`, `exception`

### 8.5 Escalabilidad

| Componente | Limite Actual | Como Escalar |
|---|---|---|
| **Firestore** | 10K writes/sec, 1 write/doc/sec | Sharding, batch writes, denormalizacion |
| **Cloud Functions** | 1000 instancias concurrentes | Aumentar cuota en Cloud Console |
| **Storage** | 5TB por bucket (Blaze) | Sin limite practico con Blaze |
| **Hosting** | CDN global, auto-scaling | Sin accion necesaria |
| **Auth** | 10K users (free tier) | Escala automaticamente con Blaze |

**Para escalar significativamente (>100 usuarios concurrentes):**
1. Implementar paginacion server-side en lugar de cargar todos los documentos
2. Agregar cache local con React Query o SWR
3. Mover generacion de PDFs pesados a Cloud Functions
4. Considerar Firestore bundles para datos frecuentemente leidos

---

## 9. Riesgos Tecnicos y Recomendaciones

### 9.1 Riesgos Actuales

| # | Riesgo | Severidad | Impacto |
|---|---|---|---|
| 1 | **Sin backups automaticos de Firestore** | CRITICO | Perdida total de datos ante error o borrado accidental |
| 2 | **Sin entorno de staging** | ALTO | Cambios se prueban directamente en produccion |
| 3 | **Deploy desde laptop personal** | ALTO | Dependencia de un solo equipo; sin trazabilidad de deploys |
| 4 | **Secretos en .env local** (Vision API key) | MEDIO | Exposicion si el .env se comparte o commitea |
| 5 | **delivery_tracking permite update publico** | MEDIO | Cualquiera puede modificar datos de tracking |
| 6 | **driver_queue permite create publico** | MEDIO | Posible spam de entradas falsas |
| 7 | **vendors permite read publico** | BAJO | Lista de proveedores expuesta |
| 8 | **Sin tests automatizados** | ALTO | Riesgo de regresion en cada cambio |
| 9 | **Sin CI/CD pipeline** | ALTO | Deploys manuales propensos a error |
| 10 | **Dependencia de un solo desarrollador** | CRITICO | Conocimiento no documentado (mitigado por este doc) |
| 11 | **Anthropic API key en Firestore** (`config/anthropic_key`) | MEDIO | Deberia estar en Secret Manager, no en la BD |
| 12 | **html2pdf.js cargado desde CDN externo** | BAJO | Dependencia de disponibilidad de CDN |

### 9.2 Dependencias Criticas

| Dependencia | Riesgo si Falla | Mitigacion |
|---|---|---|
| **Firebase (todos los servicios)** | Sistema completamente offline | Google SLA 99.95%. Tener plan de contingencia manual. |
| **Gmail API** | Screening agent deja de funcionar | Monitorear `last_run_status`. Renovar tokens. |
| **Phantom K9 email format** | Parser de screening falla | Validar con regex robustos. Alertar ante formato desconocido. |
| **Claude API (Anthropic)** | AWB Cut deja de funcionar | Proceso manual como fallback. |
| **Dominio @mincurllogistics.com** | Autenticacion MCL falla | Configurado como unico proveedor SSO. Mantener DNS activo. |

### 9.3 Puntos Unicos de Falla (SPOF)

1. **Proyecto Firebase `wms-mcl`**: Todo el sistema depende de este unico proyecto GCP.
2. **Cuenta Gmail de screening**: Si se bloquea, el agente de screening se detiene.
3. **Refresh token de Gmail**: Si expira y no se renueva, screening y alertas fallan.
4. **Equipo de deploy**: Actualmente solo el desarrollador puede hacer deploy.
5. **Dominio MCL**: Si el dominio expira, la autenticacion SSO falla.

### 9.4 Recomendaciones Prioritarias

#### Prioridad CRITICA (implementar inmediatamente)

1. **Backups automaticos de Firestore**
   ```bash
   # Configurar export diario a Cloud Storage
   gcloud firestore export gs://wms-mcl-backups/$(date +%Y-%m-%d) \
     --project=wms-mcl
   # Automatizar con Cloud Scheduler + Cloud Function
   ```
   Retener 30 dias de backups. Probar restauracion mensualmente.

2. **CI/CD con GitHub Actions**
   - Build automatico en cada push a `main`
   - Deploy automatico a Firebase Hosting
   - Deploy de Functions con aprobacion manual
   - Elimina dependencia de laptop personal

3. **Entorno de staging**
   - Crear segundo proyecto Firebase: `wms-mcl-staging`
   - Deploy automatico de branches a Preview Channels de Firebase Hosting
   - Probar cambios antes de produccion

#### Prioridad ALTA (implementar en 30 dias)

4. **Tests automatizados**
   - Unit tests para logica de billing (`billing.ts`, `airBilling.ts`)
   - Integration tests para Cloud Functions (screening parser)
   - E2E tests basicos para flujos criticos (crear WR, crear booking)

5. **Mover Anthropic API key a Secret Manager**
   - Eliminar de `config/anthropic_key` en Firestore
   - Agregar como Firebase Secret o variable de entorno del frontend

6. **Endurecer reglas de seguridad**
   - `delivery_tracking`: Limitar updates a campos especificos y drivers con PIN valido
   - `driver_queue`: Rate limiting o validacion de datos minimos
   - `vendors`: Cambiar de `read: if true` a `read: if isLoggedIn()`

#### Prioridad MEDIA (implementar en 90 dias)

7. **Monitoreo y alertas**
   - Configurar alertas de Cloud Monitoring para errores en Functions
   - Dashboard de metricas operativas (bookings/dia, screening success rate)
   - Alerta si `processScreeningEmails` falla 2+ veces consecutivas

8. **Documentacion de API interna**
   - Documentar todos los campos de cada coleccion Firestore
   - Generar tipos desde Firestore (o mantener `types/index.ts` como source of truth)
   - Documentar formato esperado de emails de Phantom K9

9. **Optimizacion de rendimiento**
   - Implementar paginacion en listas grandes (bookings, WRs)
   - Lazy loading de datos pesados (fotos, PDFs)
   - Memoizacion de consultas frecuentes

10. **Control de versiones de reglas**
    - Las reglas de Firestore y Storage deben versionarse y deployarse via CI/CD
    - Nunca editar reglas directamente en la consola Firebase

### 9.5 Sugerencia de Stack CI/CD

```
GitHub repo
    |
    +-- Push a main ---------> GitHub Actions
    |                           |
    |                           +-- npm ci
    |                           +-- npm run build
    |                           +-- npm test (cuando existan tests)
    |                           +-- firebase deploy --only hosting
    |                           +-- firebase deploy --only firestore:rules
    |                           +-- firebase deploy --only storage
    |
    +-- Push a develop -------> GitHub Actions
                                |
                                +-- Deploy a Preview Channel
                                +-- Notificar en Slack/Teams
```

---

## Apendice A: Variables de Entorno

```env
# Frontend (.env)
VITE_FIREBASE_API_KEY=           # Firebase Web API Key
VITE_FIREBASE_AUTH_DOMAIN=       # {project}.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=        # wms-mcl
VITE_FIREBASE_STORAGE_BUCKET=    # {project}.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=  # Sender ID
VITE_FIREBASE_APP_ID=            # App ID
VITE_GOOGLE_VISION_API_KEY=      # Google Vision API Key
```

```bash
# Cloud Functions (Firebase Secret Manager)
GMAIL_CLIENT_ID          # OAuth2 Client ID
GMAIL_CLIENT_SECRET      # OAuth2 Client Secret
GMAIL_REFRESH_TOKEN      # Persistent refresh token
GMAIL_USER               # Email account for SMTP
GMAIL_APP_PASSWORD       # Gmail App-specific password
ANTHROPIC_API_KEY        # Claude API key
```

## Apendice B: Comandos Utiles

```bash
# Desarrollo
npm run dev                          # Dev server (localhost:5173)
npm run build                        # Build produccion (dist/)
npm run preview                      # Preview del build local

# Firebase
firebase login                       # Autenticar CLI
firebase projects:list               # Listar proyectos
firebase deploy --only hosting       # Deploy solo frontend
firebase deploy --only functions     # Deploy solo Cloud Functions
firebase deploy --only firestore:rules  # Deploy reglas Firestore
firebase deploy --only storage       # Deploy reglas Storage
firebase deploy                      # Deploy todo

# Emuladores
firebase emulators:start --only storage  # Solo Storage emulator
firebase emulators:start             # Todos los emuladores

# Logs
firebase functions:log               # Ver logs de Cloud Functions

# Firestore
firebase firestore:delete --all-collections  # PELIGROSO: borra todo
gcloud firestore export gs://bucket  # Backup
gcloud firestore import gs://bucket/path  # Restaurar
```

## Apendice C: Contactos y Accesos

| Recurso | Acceso |
|---|---|
| Firebase Console | console.firebase.google.com/project/wms-mcl |
| Google Cloud Console | console.cloud.google.com (proyecto wms-mcl) |
| Repositorio Git | (definir ubicacion del repo remoto) |
| Dominio | wms-mcl.web.app (Firebase Hosting) |
| Cuenta screening | Configurada en `screening_settings/config` |

---

*Documento generado el 8 de mayo de 2026. Mantener actualizado ante cambios arquitectonicos significativos.*
