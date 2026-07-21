# Modulo de Visibilidad Operacional por Vuelo

## 1. Objetivo

Vista read-only que muestra, para cada vuelo, el estado de avance de todos sus AWBs a traves de 8 hitos operacionales. Accesible desde Flight Ops Board via boton "Tracking". Permite a MCL tener visibilidad completa del ciclo de vida de cada embarque y a clientes ver los hitos publicos de sus AWBs.

**Principio arquitectonico**: Este modulo es 100% read-only. No escribe datos nuevos ni crea colecciones. Todos los hitos se derivan de datos que ya existen en las colecciones fuente. Los timestamps necesarios para KPIs futuros ya existen dispersos en esas colecciones y seran consolidados en una seccion independiente cuando se diseñe el panel de KPIs (semanal/mensual, no real-time).

---

## 2. Hitos Operacionales

| # | Hito | Coleccion Fuente | Campo(s) Clave | Granularidad | Visible Cliente | Responsable | Frecuencia de Cambio | Riesgo Desync | Observaciones |
|---|------|------------------|----------------|-------------|-----------------|-------------|---------------------|---------------|---------------|
| 1 | **Recepcion Fisica** | `airfreight_physical_pieces` (via `doc_receptions`) | Existencia de piezas con `awb_number == X` vinculadas a doc_receptions del vuelo | Per-AWB | Si | Warehouse staff | Al recibir piezas fisicas | Bajo — dato inmutable una vez creado | Binario: si existe al menos 1 pieza fisica = recibido. No evalua completitud de piezas (eso no es scope de este modulo). Physical pieces no tienen `flight_id` directo; se vinculan via `doc_reception_id` |
| 2 | **IE Status (7512)** | `airfreight_bookings` → `awb_lines[].documents.doc_7512` | `doc_7512.url` (archivo subido) | Per-AWB line | Si (solo si aplica bonded) | Ops / Broker | Esporadico, al subir documento | Bajo | Solo aplica a `cargo_sub_type: 'bonded' \| 'bonded_local'`. Completado = `doc_7512.url` existe. Ya existe semaforo en el sistema para este estado |
| 3 | **Inicio Build-Up** | `airfreight_physical_pieces` (via `doc_receptions`) | `uld_id != null` para al menos 1 pieza de la AWB | Per-AWB | **No** (MCL only) | Buildup operator | Progresivo, pieza por pieza | Bajo | Completado cuando al menos 1 pieza de la AWB tiene `uld_id` asignado. Se deriva de la misma query de piezas fisicas |
| 4 | **Fin Build-Up** | `airfreight_physical_pieces` (via `doc_receptions`) | 100% de piezas de la AWB tienen `uld_id != null` | Per-AWB | **No** (MCL only) | Buildup operator | Progresivo | Bajo | Completado cuando TODAS las piezas de la AWB tienen `uld_id`. Logica: `piezas_con_uld == total_piezas AND total_piezas > 0`. Independiente del boton "Close DIST" que es per-flight |
| 5 | **Generacion DO** | `delivery_orders` | `do_number`, `awb_entries[].awb_number`, `awb_entries[].frozen_pc` | Per-AWB (via DO) | **No** (MCL only) | Ops | Al crear DO | Bajo | Usa logica P/C existente: `frozen_pc = 'P'` (parcial, amarillo) o `frozen_pc = 'C'` (completa, verde). Un AWB puede aparecer en multiples DOs parciales |
| 6 | **Truck Loaded** | `delivery_tracking` | `milestones.truck_loaded.timestamp` | Per-DO | Si | Driver (mobile app) | Una vez | Medio — depende del driver | `delivery_tracking.do_id` vincula al DO. Driver registra via app movil |
| 7 | **Arrival Airline** | `delivery_tracking` | `milestones.arrival_airline.timestamp` | Per-DO | Si | Driver (mobile app) | Una vez | Medio — depende del driver | Mismo tracking doc que Truck Loaded |
| 8 | **Unload End** | `delivery_tracking` | `milestones.unload_end.timestamp` | Per-DO | Si | Driver (mobile app) | Una vez | Medio — depende del driver | Marca el fin del ciclo operacional para ese envio |

### Nota sobre hitos 6-8 (Driver milestones)

Estos hitos dependen de que el chofer registre los eventos en la app movil. Si el driver no los reporta, los campos quedan vacios. Cuando el vuelo se marca como `dispatched` en el Dashboard, los AWBs sin milestones del driver se muestran con badge especial "Dispatched (sin tracking)" en gris, **no se inventan timestamps falsos**.

### Nota sobre hito 5 (DO) y logica P/C

El sistema ya maneja DOs parciales y completas. Cada `awb_entry` en un DO tiene `frozen_pc`:
- `'C'` (Completa): todas las piezas de la AWB estan cubiertas por este DO + DOs anteriores
- `'P'` (Parcial): este DO cubre solo parte de las piezas de la AWB

Un AWB puede aparecer en multiples DOs parciales. El hito se considera:
- **Verde** cuando la AWB tiene al menos un DO con `frozen_pc = 'C'`
- **Amarillo** cuando solo tiene DOs con `frozen_pc = 'P'`
- **Dash** cuando no tiene DO

### Nota sobre hitos 6-8 y multiples DOs

Los milestones del driver son per-DO, pero la tabla muestra per-AWB. Si una AWB aparece en multiples DOs (parciales), puede tener multiples conjuntos de milestones. Regla de display:
- Mostrar los milestones del DO mas reciente que tenga tracking
- Si la AWB tiene DO completa ('C'), usar los milestones de ese DO

---

## 3. Arquitectura: Read-Only Aggregation

### Decision: No crear coleccion de eventos

Vista **100% read-only** que lee directamente de las colecciones fuente. Razones:

1. **Sin duplicacion de datos** — cada hito ya existe en su coleccion natural
2. **Sin riesgo de desync** — la vista siempre muestra datos actuales
3. **Sin writes adicionales** — no hay triggers ni Cloud Functions que mantener
4. **Complejidad minima** — el modulo solo agrega queries de lectura

### Queries necesarias (todas getDocs, one-shot)

Para un vuelo con N AWBs, se necesitan 5 queries (+ flight data ya disponible):

| # | Query | Que obtiene | Docs esperados |
|---|-------|------------|----------------|
| 1 | `airfreight_bookings WHERE flight_id == X` | AWBs, clientes, pesos, cargo_sub_type, doc_7512 | 5-30 |
| 2 | `airfreight_doc_receptions WHERE flight_id == X` | IDs de recepciones del vuelo | 5-30 |
| 3 | `airfreight_physical_pieces WHERE doc_reception_id IN [recIds]` | Recepcion fisica + estado build-up per AWB (uld_id) | 10-200 |
| 4 | `delivery_orders WHERE awb_keys array-contains-any [keys]` | DOs generados, mapping AWB→DO, frozen_pc | 1-10 |
| 5 | `delivery_tracking WHERE do_id IN [doIds]` | Milestones del driver (truck/arrival/unload) | 1-5 |

Flight data (flight_status, built_at, dispatched_at) ya esta disponible desde el Dashboard — se pasa como prop o se lee por ID.

**Total: 5 queries Firestore por apertura de vista.**

### Nota sobre Query #2 y #3 (physical pieces)

`airfreight_physical_pieces` **no tiene `flight_id` como campo directo**. Cada pieza se vincula al vuelo indirectamente via `doc_reception_id` → `airfreight_doc_receptions.flight_id`. Por eso se necesitan 2 queries:
- Query #2: obtener doc_receptions del vuelo (por `flight_id`)
- Query #3: obtener physical_pieces por `doc_reception_id IN [batch]` (max 30 por batch Firestore)

Este patron ya se usa en `AirfreightDocReceptionList.tsx` y `AirfreightBuildup.tsx`.

### Nota sobre Query #4 (delivery_orders)

`delivery_orders` **no tiene `flight_id` como campo top-level**. El flight se identifica dentro de `awb_entries[].flight_id` (array de objetos), que Firestore no puede filtrar directamente.

**Estrategia**: Usar el campo `awb_keys` (array de strings `"{booking_id}::{awb_index}"`) que ya existe en cada DO. De la query #1 (bookings) extraemos los `booking_id` + indices de AWB, y buscamos DOs con `array-contains-any` sobre `awb_keys`. Firestore permite hasta 30 valores por `array-contains-any`, suficiente para la mayoria de vuelos.

Para vuelos con mas de 30 AWBs, se hacen batches de 30.

```typescript
// Construir awb_keys desde bookings del vuelo
const awbKeys: string[] = []
for (const booking of bookings) {
  booking.awb_lines.forEach((line, idx) => {
    awbKeys.push(`${booking.id}::${idx}`)
  })
}

// Batches de 30 (limite Firestore para array-contains-any)
const doBatches = chunk(awbKeys, 30)
const allDOs = (await Promise.all(
  doBatches.map(batch =>
    getDocs(query(
      collection(db, 'delivery_orders'),
      where('awb_keys', 'array-contains-any', batch)
    ))
  )
)).flatMap(snap => snap.docs.map(d => ({ ...d.data(), id: d.id })))
```

### KPIs futuros

Los timestamps para construir KPIs ya existen en las colecciones fuente:
- `physical_pieces.created_at` → hora de recepcion fisica
- `delivery_orders.created_at` → hora de generacion de DO
- `delivery_tracking.milestones.*.timestamp` → horas del driver
- `flights.built_at`, `flights.dispatched_at` → hitos de vuelo

El unico timestamp no registrado explicitamente hoy es **build-up start per AWB** (cuando la primera pieza se asigna a un ULD, se escribe `uld_id` pero no `assigned_at`). Esto se evaluara al diseñar el panel de KPIs; si se necesita, se agrega el campo en ese momento.

El panel de KPIs sera una seccion arquitectonicamente independiente, con frecuencia semanal/mensual, no real-time.

---

## 4. Modelo de Datos en Vista (in-memory)

```typescript
// Estructura computada en el componente, NO almacenada en Firestore
interface FlightTrackingView {
  flight_id: string
  flight_number: string
  etd: string
  airline: string
  flight_status: 'booked' | 'in_progress' | 'built' | 'dispatched' | 'terminado'
  built_at?: string
  dispatched_at?: string
  awbs: AwbTrackingRow[]
}

interface AwbTrackingRow {
  awb_number: string
  client_name: string
  client_id: string
  booking_id: string
  awb_index: number
  pieces: number              // piezas del booking
  weight_kg: number

  // Hito 1: Recepcion Fisica (binario)
  physical_received: boolean         // al menos 1 physical_piece existe para esta AWB

  // Hito 2: IE Status (7512)
  is_bonded: boolean                 // cargo_sub_type == 'bonded' | 'bonded_local'
  ie_doc_uploaded: boolean           // doc_7512.url exists

  // Hito 3: Inicio Build-Up (per-AWB)
  pieces_in_uld: number             // count de physical_pieces con uld_id != null
  pieces_received: number           // count total de physical_pieces
  buildup_started: boolean           // pieces_in_uld > 0

  // Hito 4: Fin Build-Up (per-AWB)
  buildup_completed: boolean         // pieces_in_uld == pieces_received AND pieces_received > 0

  // Hito 5: DO con logica P/C
  do_status: 'none' | 'partial' | 'complete'
  do_entries: { do_id: string; do_number: string; frozen_pc: 'P' | 'C' | null }[]

  // Hitos 6-8: Driver milestones (del DO principal)
  truck_loaded_at?: string
  arrival_airline_at?: string
  unload_end_at?: string

  // Estado especial: dispatched sin tracking del driver
  flight_dispatched: boolean         // flight_status == 'dispatched' | 'terminado'
  has_driver_tracking: boolean       // al menos 1 milestone del driver existe
}
```

### Logica de build-up per AWB

```typescript
// De la query de physical_pieces, agrupar por awb_number
const piecesByAwb = new Map<string, { total: number; inUld: number }>()

for (const piece of physicalPieces) {
  const entry = piecesByAwb.get(piece.awb_number) || { total: 0, inUld: 0 }
  entry.total++
  if (piece.uld_id) entry.inUld++
  piecesByAwb.set(piece.awb_number, entry)
}

// Para cada AWB:
// buildup_started = inUld > 0
// buildup_completed = inUld === total && total > 0
```

### Logica de DO P/C per AWB

```typescript
// De la query de delivery_orders, mapear AWBs a sus DOs
const doByAwb = new Map<string, { do_id: string; do_number: string; frozen_pc: string }[]>()

for (const doDoc of deliveryOrders) {
  for (const entry of doDoc.awb_entries) {
    const key = entry.awb_number
    const list = doByAwb.get(key) || []
    list.push({
      do_id: doDoc.id,
      do_number: doDoc.do_number,
      frozen_pc: entry.frozen_pc
    })
    doByAwb.set(key, list)
  }
}

// Para cada AWB:
// do_status = 'none'     si no aparece en ningun DO
// do_status = 'complete' si algun DO tiene frozen_pc == 'C'
// do_status = 'partial'  si solo tiene DOs con frozen_pc == 'P'
```

### Logica de milestones del driver per AWB

```typescript
// De la query de delivery_tracking, mapear do_id a milestones
const trackByDoId = new Map<string, DeliveryTracking>()
for (const track of trackings) {
  trackByDoId.set(track.do_id, track)
}

// Para cada AWB, buscar milestones del DO principal:
// - Si tiene DO completa ('C'), usar ese DO
// - Si solo tiene parciales, usar el DO mas reciente con tracking
function getDriverMilestones(awbRow: AwbTrackingRow) {
  const completeDo = awbRow.do_entries.find(e => e.frozen_pc === 'C')
  if (completeDo) {
    return trackByDoId.get(completeDo.do_id)
  }
  // Fallback: DO mas reciente con tracking
  for (const entry of awbRow.do_entries) {
    const track = trackByDoId.get(entry.do_id)
    if (track) return track
  }
  return null
}
```

---

## 5. Flujo de Datos

```
Flight Ops Board (Dashboard)
    |
    v  click "Tracking" en fila de vuelo
    |
[FlightOperationalTracking]  (nuevo componente/pagina)
    |
    +--- Flight data (pasado como param, ya disponible)
    |    -> flight_status, built_at, dispatched_at
    |
    +--- Query 1: airfreight_bookings WHERE flight_id == X
    |    -> Extrae awb_lines: awb_number, client_name, client_id,
    |       booking_id, awb_index, pieces, weight, cargo_sub_type,
    |       documents.doc_7512
    |    -> Construye awb_keys: ["{booking_id}::{awb_index}", ...]
    |
    +--- Query 2: airfreight_doc_receptions WHERE flight_id == X
    |    -> Obtiene IDs de recepciones del vuelo
    |
    +--- Query 3: airfreight_physical_pieces WHERE doc_reception_id IN [recIds]
    |    -> Para cada pieza: awb_number, uld_id
    |    -> Agrupa por AWB: { total, inUld }
    |    -> Hito 1 (recepcion): total > 0
    |    -> Hito 3 (buildup start): inUld > 0
    |    -> Hito 4 (buildup end): inUld == total && total > 0
    |
    +--- Query 4: delivery_orders WHERE awb_keys array-contains-any [keys]
    |    -> Map: awb_number -> [{ do_id, do_number, frozen_pc }]
    |    -> Hito 5: do_status = 'complete' | 'partial' | 'none'
    |
    +--- Query 5: delivery_tracking WHERE do_id IN [do_ids]
    |    -> Map: do_id -> milestones { truck_loaded, arrival_airline, unload_end }
    |    -> Hitos 6-8: timestamp de cada milestone (vinculado via DO)
    |
    +--- Merge all into AwbTrackingRow[] para renderizar
```

---

## 6. Visualizacion

### Layout: Tabla con AWB rows y columnas de hitos

Header del vuelo arriba, tabla debajo. Inspirada en la referencia proporcionada.

```
+------------------------------------------------------------------------------------+
| Flight: AA1234  |  ETD: 2026-06-05  |  Airline: American  |  Status: Built         |
+------------------------------------------------------------------------------------+
| Recibidos: 8/10  |  IE: 3/4 bonded  |  Build-Up: 7/10  |  DOs: 2  |  Entrega: 5/10|
+------------------------------------------------------------------------------------+
| AWB          | Client | Pcs | Kg   | Fisico | IE   | B.Start | B.End | DO      | Truck | Arr   | Unload |
|--------------|--------|-----|------|--------|------|---------|-------|---------|-------|-------|--------|
| 023-12345678 | ACME   |  10 |  450 |   V    |  V   |   V     |  V    | 001 [C] | 14:30 | 15:10 | 15:45  |
| 023-87654321 | BetaCo |   5 |  200 |   V    | n/a  |  3/5    |  --   | 001 [P] | 14:30 | 15:10 |  --    |
| 180-11112222 | ACME   |   3 |  120 |   --   | n/a  |   --    |  --   |   --    |  --   |  --   |  --    |
+------------------------------------------------------------------------------------+
```

### Columnas y badges

| Columna | Icono/Badge | Color | Logica |
|---------|------------|-------|--------|
| **Fisico** (Recepcion Fisica) | Checkmark / dash | Verde si existe al menos 1 pieza fisica, gris si no | Binario: piezas fisicas existen para esta AWB |
| **IE** (7512) | Checkmark / "n/a" / dash | Verde si `ie_doc_uploaded`, "n/a" gris si no es bonded, dash si bonded pero sin doc | Solo aplica a bonded/bonded_local. Usa semaforo existente |
| **B.Start** (Build-Up Start) | Checkmark / "X/Y" / dash | Verde si al menos 1 pieza en ULD, gris si 0. Opcion: mostrar "3/5" como progreso parcial | `pieces_in_uld > 0` |
| **B.End** (Build-Up End) | Checkmark / dash | Verde si 100% piezas en ULD, gris si no | `pieces_in_uld == pieces_received AND pieces_received > 0` |
| **DO** | DO number + badge P/C / dash | **Verde** si `frozen_pc = 'C'` (completa), **Amarillo** si `frozen_pc = 'P'` (parcial), gris dash si sin DO | Misma logica P/C que ya usa el sistema en la pantalla de DO |
| **Truck** | Hora / dash | Verde con HH:MM si milestone existe, gris si no | `milestones.truck_loaded.timestamp` |
| **Arr** (Arrival) | Hora / dash | Verde con HH:MM | `milestones.arrival_airline.timestamp` |
| **Unload** | Hora / dash | Verde con HH:MM | `milestones.unload_end.timestamp` |

### Badge especial: Dispatched sin tracking

Cuando `flight_status` es `dispatched` o `terminado` pero los milestones del driver (6-8) no existen:
- Mostrar badge **"Dispatched"** en gris claro en las columnas Truck/Arr/Unload
- Diferenciado del verde (que indica milestone real del driver)
- Tooltip: "Vuelo despachado — sin tracking del conductor"

### KPI Summary (header de vuelo)

Arriba de la tabla, indicadores resumidos:

- **Recibidos Fisicamente**: X / Total AWBs (barra de progreso)
- **IE Completos**: X / Total bonded (solo si hay AWBs bonded)
- **Build-Up Completo**: X / Total AWBs con 100% piezas en ULD
- **DOs Completas**: X AWBs con DO completa / Total AWBs
- **Entregados**: X / Total AWBs con `unload_end`

### Tooltip en timestamps

Al hacer hover sobre milestones del driver (Truck/Arr/Unload):
- Timestamp completo (fecha + hora)
- Nombre del driver
- Nombre del vendor/transportista

### Tooltip en columna DO

Al hacer hover sobre el badge P/C:
- Numero(s) de DO
- Estado P/C de cada uno
- Si tiene multiples DOs parciales, listarlas

---

## 7. Visibilidad por Rol

### MCL Staff
- Ven los 8 hitos completos
- Ven todos los AWBs del vuelo
- Acceso desde Flight Ops Board

### Client
- Ven solo hitos **publicos**: Recepcion Fisica, IE Status, Truck Loaded, Arrival Airline, Unload End (5 de 8)
- **NO ven**: Build-Up Start, Build-Up End, Generacion DO (3 hitos internos MCL)
- Solo ven **sus propios AWBs** (filtro por `client_id`)
- Acceso: desde su vista de bookings, no desde Flight Ops Board

### Viewer
- Igual que Client (ya son read-only)

### Implementacion del filtro

```typescript
const COLUMNS_MCL = ['physical', 'ie', 'buildup_start', 'buildup_end', 'do', 'truck', 'arrival', 'unload']
const COLUMNS_CLIENT = ['physical', 'ie', 'truck', 'arrival', 'unload']

const visibleColumns = isMCL ? COLUMNS_MCL : COLUMNS_CLIENT

const visibleAwbs = isMCL
  ? allAwbs
  : allAwbs.filter(a => a.client_id === currentUserClientId)
```

---

## 8. Acceso y Navegacion

### Desde Flight Ops Board (MCL)

Boton con icono SVG en la columna de acciones de cada fila de vuelo (junto a "Docs" y el icono delete). Aparece en hover igual que los demas botones de accion.

**Icono**: Avion con paquete (inspirado en referencia), avion en verde `#16a34a`, circulo del paquete con borde mcl-blue `#1e3a5f`, texto "MCL" en micro dentro del circulo en mcl-red `#c8102e`. Tamaño: `w-5 h-5` (20x20px). Tooltip: "Seguimiento operacional".

**Ubicacion en el DOM**: Dentro del `<td>` de acciones, entre el boton "Docs" y el icono delete:

```tsx
{/* Tracking icon — between Docs and Delete */}
<button
  onClick={() => navigate(`/airfreight/flight-tracking/${flight.id}`)}
  title="Seguimiento operacional"
  className="hover:opacity-80 transition-opacity px-1 py-1"
>
  <svg viewBox="0 0 32 32" className="w-5 h-5" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Avion en verde */}
    <path d="M6 18l8-4 6-10 2 0-2 12 6 3 2-3 2 0-3 6-3 6-2 0-2-3-6 3-2-12-2 0 6-10z"
          fill="#16a34a" stroke="#15803d" strokeWidth="0.5"/>
    {/* Ala */}
    <path d="M14 14l-8 4" stroke="#15803d" strokeWidth="1" strokeLinecap="round"/>
    {/* Circulo con MCL */}
    <circle cx="22" cy="23" r="7" fill="white" stroke="#1e3a5f" strokeWidth="1.5"/>
    <text x="22" y="24.5" textAnchor="middle" fill="#c8102e"
          fontSize="5" fontWeight="bold" fontFamily="Arial,sans-serif">MCL</text>
    {/* Paquete simplificado dentro del circulo */}
    <rect x="19" y="19.5" width="6" height="4.5" rx="0.5"
          fill="none" stroke="#1e3a5f" strokeWidth="0.8"/>
    <line x1="22" y1="19.5" x2="22" y2="24" stroke="#1e3a5f" strokeWidth="0.5"/>
    <line x1="19" y1="21.5" x2="25" y2="21.5" stroke="#1e3a5f" strokeWidth="0.5"/>
  </svg>
</button>
```

**Nota**: El SVG anterior es una aproximacion. Se refinara en implementacion para que el avion, paquete y "MCL" se vean nitidos a 20x20px. Si "MCL" resulta ilegible a ese tamaño, se usara solo como tooltip y el circulo tendra las iniciales "M" en mcl-red.

### Ventana de vuelos disponibles

No hay ventana de tiempo adicional. El boton de tracking aparece en **cualquier vuelo visible en el Dashboard**. El filtro temporal lo controla el Dashboard (default: ultimos 10 dias, extensible por el usuario).

La pagina de tracking recibe un `flightId` y carga datos on-demand. No hay costo de storage ni performance por tener el boton disponible en vuelos antiguos — las queries solo se ejecutan al hacer click.

### Desde Client Bookings (Fase 2)
- Columna o icono "Status" en la lista de bookings del cliente
- Abre vista reducida con solo sus AWBs y hitos publicos

### Ruta
```
/airfreight/flight-tracking/:flightId
```

### Security: Firestore Rules

No se necesitan reglas nuevas para MVP (vista MCL). Todas las colecciones consultadas ya tienen `allow read: if isMCL()` o acceso mas amplio:

| Coleccion | Regla actual | Suficiente para MVP? |
|-----------|-------------|---------------------|
| `airfreight_flights` | `read: if isLoggedIn()` | Si |
| `airfreight_bookings` | `read: if isMCL()` + client own | Si |
| `airfreight_doc_receptions` | `read: if isMCL()` | Si |
| `airfreight_physical_pieces` | `read: if isMCL()` | Si |
| `delivery_orders` | `read: if isMCL()` | Si |
| `delivery_tracking` | `read: if true` | Si |

**Para vista cliente (Fase 2)**: Los clientes no tienen acceso a `airfreight_doc_receptions`, `airfreight_physical_pieces` ni `delivery_orders`. Opciones:
1. Abrir read filtrado por `client_id` en rules
2. Cloud Function que retorna datos pre-filtrados
3. Derivar lo posible desde colecciones accesibles (bookings + delivery_tracking)

Se evaluara al implementar Fase 2.

---

## 9. Performance

### Optimizaciones

1. **Lazy loading**: Datos se cargan solo al abrir tracking de un vuelo especifico (click)
2. **getDocs one-shot**: Sin listeners en tiempo real. El usuario puede refrescar manualmente
3. **Piezas via doc_receptions**: Query #2 (doc_receptions por flight_id) + Query #3 (physical_pieces por doc_reception_id IN batch) resuelven 3 hitos (recepcion fisica, buildup start, buildup end). Patron ya usado en Buildup y DocReceptionList
4. **Cache en sesion**: Si el usuario vuelve al mismo vuelo sin navegar fuera, reusar datos con boton "Refresh" visible
5. **Batch queries**: `awb_keys array-contains-any` soporta max 30 valores por batch; para vuelos grandes se hacen batches paralelos

### Indices Firestore a verificar/crear

| Coleccion | Indice | Probablemente ya existe? |
|-----------|--------|-------------------------|
| `airfreight_doc_receptions` | `flight_id ASC` | Si — usado en Buildup y DocReceptionList |
| `airfreight_physical_pieces` | `doc_reception_id ASC` | Si — usado en Buildup y DocReceptionList |
| `delivery_orders` | `awb_keys` (array index) | Si — ya se usa `array-contains` en DO creation flow |

### Estimacion de reads

| Escenario | Queries | Docs leidos |
|-----------|---------|-------------|
| Vuelo tipico (15 AWBs, 2 DOs) | 5 | ~80-100 |
| Vuelo grande (30 AWBs, 5 DOs) | 6-7 (extra batches) | ~150-250 |
| Costo Firestore | Despreciable | <$0.001 por apertura |

---

## 10. Consideraciones Adicionales

### AWBs sin piezas fisicas
Si un AWB tiene bookings pero aun no se recibieron piezas fisicas, los hitos 1, 3 y 4 muestran dash. La fila existe porque viene del booking.

### AWBs sin DO
Si un AWB no tiene DO asignado, las columnas DO/Truck/Arr/Unload muestran "--".

### Multiples DOs parciales por AWB
Una AWB puede aparecer en multiples DOs parciales ('P'). La columna DO muestra el estado consolidado:
- Si alguna tiene `frozen_pc = 'C'` → verde con numero de DO
- Si todas son `frozen_pc = 'P'` → amarillo con numero(s) de DO
- Para milestones del driver, se priorizan los del DO completo; si no hay, los del DO mas reciente con tracking

### Build-Up parcial
Cuando `pieces_in_uld > 0` pero `< pieces_received`, la columna B.Start muestra checkmark verde y la columna B.End muestra progreso "3/5" en amarillo.

### Vuelos con status 'terminado'
Todos los hitos deberian estar completos. Util para revision historica.

### Hito IE (7512) no aplica a todos
Solo relevante para `cargo_sub_type: 'bonded' | 'bonded_local'`. Para otros tipos, mostrar "n/a" en gris.

### Refresh manual
Boton "Actualizar" visible que re-ejecuta las 5 queries. No auto-refresh para evitar reads innecesarios.

---

## 11. Scope de Implementacion

### Fase 1 (MVP) — Vista MCL
- Pagina `/airfreight/flight-tracking/:flightId`
- Tabla con 8 columnas de hitos per-AWB
- Build-up start/end calculado per-AWB desde piezas fisicas
- DO con logica P/C (amarillo parcial, verde completa)
- KPIs resumidos en header del vuelo
- Boton "Tracking" en Flight Ops Board
- 5 queries one-shot con getDocs
- Solo usuarios MCL

### Fase 2 — Vista Cliente
- Acceso desde bookings del cliente
- Solo hitos publicos (5 de 8)
- Solo AWBs propios
- Evaluar rules o Cloud Function para datos restringidos

### Fase 3 — Futuro
- Panel de KPIs independiente (semanal/mensual, seccion separada)
- Export a Excel/PDF del tracking de un vuelo
- Notificaciones a clientes por hito completado

---

## 12. Resumen de Decisiones

| Decision | Eleccion | Motivo |
|----------|----------|--------|
| Arquitectura | Read-only puro, sin coleccion nueva, sin writes | Datos ya existen en colecciones fuente; timestamps para KPIs se consolidan en seccion futura independiente |
| Queries | 5 getDocs one-shot por vuelo | Bajo volumen, lazy loading, sin necesidad de real-time |
| Query physical pieces | doc_receptions por flight_id → physical_pieces por doc_reception_id IN batch | Physical pieces no tienen `flight_id` directo; patron ya usado en Buildup |
| Query DOs | `awb_keys array-contains-any` en batches de 30 | `delivery_orders` no tiene `flight_id` top-level; `awb_keys` ya existe y tiene indice |
| Build-Up | Per-AWB basado en conteo de piezas con uld_id | Mas granular que per-flight; refleja progreso real por guia |
| DO Status | Logica P/C existente: verde completa, amarillo parcial | Consistente con la pantalla de DO; reutiliza `frozen_pc` ya guardado |
| Hitos 6-8 sin driver | Badge "Dispatched (sin tracking)" gris | No inventar timestamps falsos; diferencia datos reales de inferidos |
| Hitos 6-8 con multiples DOs | Priorizar DO completa; fallback a DO mas reciente con tracking | Evita ambiguedad cuando AWB tiene DOs parciales |
| Recepcion Fisica | Binario (existe pieza = recibido) | Simplicidad; problemas de piezas faltantes no son scope de este modulo |
| Vista cliente | Fase 2, no en MVP | Requiere evaluar acceso a physical_pieces y delivery_orders |
| IE Status | doc_7512.url existe = completado | Alineado con semaforo existente en el sistema |
| KPIs | Seccion futura independiente, no parte de este modulo | Frecuencia semanal/mensual, arquitectura separada |
