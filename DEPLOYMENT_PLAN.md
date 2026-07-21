# MCL WMS - Plan de Despliegue Seguro
**Fecha:** 2026-05-18 | **Rol:** Arquitecto de Despliegue + SRE + Canary/Blue-Green Specialist
**Alcance:** Solo puntos criticos y de alto riesgo del Performance Audit

---

## CONTEXTO DE INFRAESTRUCTURA

**Stack actual:**
- Frontend: React SPA desplegada en Firebase Hosting
- Backend: Firebase Firestore (sin Cloud Functions)
- Auth: Firebase Authentication
- Storage: Firebase Storage
- Deploy: `firebase deploy --only hosting`
- Sin load balancer propio, sin Kubernetes, sin infraestructura de microservicios

**Implicacion clave:** Firebase Hosting no soporta blue/green nativo ni canary releases por % de trafico. Las estrategias se adaptan a este contexto usando:
- **Firebase Hosting Preview Channels** (canary: URL temporal para testers)
- **Feature Flags en Firestore** (canary: activar features por usuario/rol)
- **Rollback via `firebase hosting:rollback`** (blue/green: revert a version anterior)
- **Firebase Hosting multiple sites** (blue/green: site-green.web.app + site-blue.web.app)

---

## SECCION 1: PUNTOS CRITICOS EXTRAIDOS

De las 32 soluciones analizadas, los siguientes **10 puntos** son criticos o de alto riesgo porque pueden romper funcionalidades existentes, afectar datos o impactar modulos sensibles:

| # | ID | Solucion | Riesgo | Modulos que puede romper |
|---|-----|---------|--------|-------------------------|
| 1 | SOL-8 | Where clause en AWB search (DocReceptionNew) | **ALTO** | Recepcion documental, Flight Assignment, Bookings |
| 2 | SOL-11 | Refactorizar Inventory N+1 | **ALTO** | Inventory, Billing, Dispatch, WR Print (8 modulos) |
| 3 | SOL-14 | Separar nested onSnapshot | **ALTO** | Dashboard, Screening, BookingList, Transportation |
| 4 | SOL-18 | Paginacion en tablas | **ALTO** | Inventory, Holds, Billing, BookingList |
| 5 | SOL-19 | Cloud Functions para billing | **MUY ALTO** | Billing completo, KPI, Invoicing |
| 6 | SOL-28 | Custom claims Firebase Auth | **MUY ALTO** | Security Rules, Auth, TODOS los modulos |
| 7 | SOL-1 | useMemo AuthContext | **ALTO*** | TODOS (71 consumers) — reclasificado por escala |
| 8 | SOL-16 | writeBatch addDoc loops | **ALTO** | Air Billing, WS Billing, PhysicalReception |
| 9 | SOL-23 | Dividir componentes monoliticos | **ALTO** | BookingNew(68 hooks), Buildup(43), WSOrderDetail(55) |
| 10 | SOL-31 | Archival datos historicos | **ALTO** | Billing, Tracking, Delivery |

*SOL-1 reclasificado de BAJO a ALTO porque afecta 71 consumers (no 18), requiere useCallback previo en 7 funciones, y tiene 3 useEffects con dependencias criticas.*

---

## SECCION 2: ESTRATEGIA POR PUNTO CRITICO

### PC-1: SOL-8 — Where clause en AWB search
**Estrategia: CANARY con Feature Flag**

**Por que canary:** El cambio afecta la busqueda de AWB que es la operacion mas frecuente de warehouse. Un error aqui causa que recepciones documentales no encuentren bookings — datos quedan desvinculados. Necesita validacion gradual con usuarios reales.

**Aislamiento del cambio:**
```typescript
// Feature flag en Firestore: config/feature_flags
{ awb_search_v2: false }

// En DocReceptionNew.tsx:
const useNewSearch = featureFlags.awb_search_v2
if (useNewSearch) {
  // Nueva logica: cache local + campo awb_numbers indexable
} else {
  // Logica actual: full scan + filter client-side
}
```

**Enrutamiento gradual:**
1. **Dia 1:** Flag OFF para todos. Deploy codigo con ambas paths.
2. **Dia 2:** Flag ON solo para MCL staff (admin, super_agent) — 5-8 usuarios
3. **Dia 3-5:** Monitorear: busquedas exitosas vs fallidas, AWBs no encontrados
4. **Dia 6:** Flag ON para agentes (agent role) — 10-15 usuarios
5. **Dia 8-10:** Flag ON para todos (incluyendo clientes)
6. **Dia 15:** Remover feature flag y codigo viejo

**Monitoreo:**
- Log en consola: `console.info('AWB_SEARCH', { version: 'v2', awb, found: !!result, time_ms })`
- Comparar tasa de "AWB no encontrado" entre v1 y v2
- Alarma: si tasa de "no encontrado" sube > 5% respecto a baseline

**Validacion de datos:**
- Ejecutar busqueda paralela (v1 Y v2) durante dias 2-5 y comparar resultados
- Si v2 devuelve menos resultados que v1, hay regresion

**Criterios de exito:**
- Tasa de "AWB encontrado" >= 99% del baseline
- Tiempo de busqueda < 500ms (vs 3-10s actual)
- 0 reportes de "Sin booking" que si tienen booking

**Criterios de rollback INMEDIATO:**
- AWB con booking existente no se encuentra en v2
- Cualquier usuario reporta "Sin booking" para AWB que v1 si encuentra
- Tasa de "no encontrado" > 2% sobre baseline

**Rollback:** Setear `awb_search_v2: false` en Firestore. Efecto inmediato sin deploy.

---

### PC-2: SOL-11 — Refactorizar Inventory N+1
**Estrategia: CANARY con Feature Flag + Paginacion**

**Por que canary:** 8 modulos dependen de la estructura de WR lines. La opcion recomendada (paginacion + cache, NO denormalizacion) es mas segura pero aun cambia como se cargan datos.

**Aislamiento:**
```typescript
// Feature flag
{ inventory_pagination: false, inventory_page_size: 50 }

// En Inventory.tsx:
if (featureFlags.inventory_pagination) {
  // Nueva logica: cargar 50 WRs + cursor pagination
} else {
  // Logica actual: cargar 1000 WRs + N+1 subcollections
}
```

**Enrutamiento gradual:**
1. **Dia 1:** Deploy con flag OFF
2. **Dia 2:** Flag ON solo para admin — verificar que filtros funcionan, datos completos
3. **Dia 5:** Flag ON para MCL staff
4. **Dia 8:** Flag ON para clientes
5. **Dia 12:** Remover flag

**Monitoreo:**
- Comparar: tiempo de carga pagina, numero de WRs visibles, filtros funcionales
- Firestore reads/dia (Firebase Console) — debe bajar > 50%
- Alarma: si algun usuario reporta WRs faltantes

**Validacion de datos:**
- Con flag ON, verificar que TODOS los WRs que aparecian antes siguen accesibles (via paginacion)
- Export a Excel debe generar el mismo dataset que antes
- Filtros por pais/cliente/status deben devolver mismos resultados

**Criterios de exito:**
- Page load < 5s (vs 20-40s actual)
- Todos los WRs accesibles via paginacion
- Export Excel completo
- Filtros devuelven resultados correctos

**Criterios de rollback:**
- WRs no aparecen que deberian aparecer
- Filtros devuelven subsets incorrectos
- Export Excel incompleto
- Firestore reads SUBEN en vez de bajar

**Rollback:** Flag OFF en Firestore.

---

### PC-3: SOL-14 — Separar nested onSnapshot
**Estrategia: CANARY POR COMPONENTE (one page at a time)**

**Por que canary por componente:** Cada pagina tiene un patron de nested listener diferente. Separar todos a la vez es demasiado arriesgado. Empezar por BookingList (menos critico) y dejar Dashboard/Screening para ultimo.

**Aislamiento:**
- Cambio 3A: Solo BookingList (riesgo bajo — inner no depende de outer)
- Cambio 3B: Solo Transportation (similar a BookingList)
- Cambio 3C: Dashboard (riesgo alto — flash de estado incompleto)
- Cambio 3D: Screening (riesgo alto — inner filtra por flight_id del outer)

**NO USAR FEATURE FLAG AQUI** — el cambio es en la estructura de listeners, no en logica de negocio. Feature flag causaria 2 listeners activos simultaneos (doble reads).

**Enrutamiento:**
1. **Deploy 1:** Solo cambio 3A (BookingList) — verificar 3 dias
2. **Deploy 2:** Agregar 3B (Transportation) — verificar 3 dias
3. **Deploy 3:** Agregar 3C (Dashboard) CON flag `bothLoaded` — verificar 5 dias
4. **Deploy 4:** Evaluar si 3D (Screening) es necesario — puede mantenerse nested

**Monitoreo:**
- React DevTools Profiler: contar renders por segundo en Dashboard
- Console.log: `LISTENER_FIRE: flights | bookings | combined`
- Verificar que datos combinados son consistentes (no flash de datos parciales)

**Criterios de exito (por deploy):**
- Datos en Dashboard/BookingList son identicos a version anterior
- No hay flash de tabla vacia o datos parciales
- Real-time updates siguen funcionando (crear booking → aparece en Dashboard)
- Sin listener leak (verificar en DevTools Memory)

**Criterios de rollback:**
- Flash visible de datos incompletos
- Datos real-time no se actualizan
- Memory crece sin limite (listener leak)

**Rollback:** `git revert` del commit especifico + deploy.

---

### PC-4: SOL-18 — Paginacion en tablas
**Estrategia: CANARY con Feature Flag — SOLO DESPUES de migrar filtros**

**PREREQUISITO BLOQUEANTE:** Los filtros client-side (pais, status, cliente, busqueda) DEBEN migrarse a server-side `where()` clauses ANTES de implementar paginacion. Sin esto, la paginacion es una regresion funcional.

**Aislamiento:**
```typescript
{ table_pagination_inventory: false, table_pagination_billing: false }
```

**Orden de implementacion:**
1. **Sprint previo:** Migrar filtros de Inventory a where clauses (sin paginacion)
2. **Deploy 1:** Paginacion en Inventory con flag
3. **Sprint siguiente:** Migrar filtros de BillingCharges
4. **Deploy 2:** Paginacion en BillingCharges con flag
5. **Ultimo:** Holds, BookingList

**NUNCA paginar sin filtros server-side. Es mejor cargar 1000 docs con filtros que paginar 50 sin poder buscar.**

**Criterios de exito:**
- Buscar "ACME" en Inventory devuelve TODOS los WRs de ACME, no solo los de la pagina actual
- Totales de billing reflejan TODOS los charges, no solo la pagina

**Rollback:** Flag OFF.

---

### PC-5: SOL-19 — Cloud Functions para billing
**Estrategia: BLUE/GREEN con Firebase Hosting Multiple Sites**

**Por que blue/green:** Este es un cambio arquitectural. No se puede hacer canary porque billing debe calcular correctamente al 100% o no calcular. No hay "50% de trafico usa CF y 50% usa client-side" para el MISMO calculo.

**Prerequisitos:**
1. Firebase Blaze plan activado
2. Cloud Functions desplegadas y testeadas con datos de staging
3. Site blue (produccion actual) + site green (con CF)

**Aislamiento:**
- **Blue:** `wms-mcl.web.app` — version actual, billing client-side
- **Green:** `wms-mcl-green.web.app` — version nueva, billing via CF
- Ambas apuntan a la MISMA base de datos Firestore

**PELIGRO:** Si ambas versiones escriben charges simultaneamente, hay doble billing.

**Mitigacion:**
```
1. CF billing tiene un campo: { source: 'cloud_function', version: '2.0' }
2. Client-side billing tiene: { source: 'client', version: '1.0' }
3. Antes de calcular, verificar si ya existen charges con version != propia
```

**Enrutamiento:**
1. **Semana 1:** Green disponible solo para admin de billing (1-2 personas)
2. **Semana 2:** Comparar charges calculados por Blue vs Green para mismos vuelos
3. **Semana 3:** Si charges son identicos, migrar todo billing a Green
4. **Semana 4:** Apagar client-side billing en Blue, redirect a Green

**Validacion de datos (CRITICA):**
Para CADA vuelo procesado en Green durante semanas 1-2:
```
SELECT * FROM air_billing_charges WHERE flight_id = X AND source = 'cloud_function'
COMPARE WITH
SELECT * FROM air_billing_charges WHERE flight_id = X AND source = 'client'
```
Los montos deben ser IDENTICOS (diferencia < $0.01).

**Criterios de exito:**
- 100% de charges calculados por CF coinciden con client-side
- Latencia de CF < 5 segundos
- CF no falla en ningun caso de edge (MAWB, ecommerce, export)
- Invoice generation produce PDFs identicos

**Criterios de rollback INMEDIATO:**
- Cualquier diferencia de monto > $0.01 entre CF y client
- CF falla o timeout en > 1% de invocaciones
- Charges duplicados detectados
- Invoice con monto incorrecto

**Rollback:** Revertir DNS/redirect a Blue. Borrar charges con source='cloud_function'. No hay perdida de datos porque Blue sigue funcional.

---

### PC-6: SOL-28 — Custom claims Firebase Auth
**Estrategia: BLUE/GREEN con migracion progresiva de usuarios**

**ESTE ES EL CAMBIO MAS PELIGROSO DEL PLAN COMPLETO.**

**Por que blue/green:** Las security rules son binarias — o usan get() o usan custom claims. No se puede mezclar. El cambio debe ser atomico para las rules.

**Prerequisitos:**
1. Admin SDK backend operativo (Cloud Function o server)
2. Script de migracion que asigna claims a TODOS los usuarios
3. Rules nuevas escritas y testeadas en Firebase Emulator
4. Rollback rules listas

**Fases:**
1. **Fase 0 (1 semana):** Crear backend que setea custom claims en CADA login (sin cambiar rules). Los claims se acumulan silenciosamente.
2. **Fase 1 (1 semana):** Ejecutar script de migracion: asignar claims a todos los usuarios activos. Verificar que todos tienen claims correctos.
3. **Fase 2 (1 dia):** Deploy rules nuevas que ACEPTAN ambos metodos (get() Y custom claims). Esto es el safety net.
4. **Fase 3 (1 semana):** Monitorear que todo funciona con rules hibridas.
5. **Fase 4 (1 dia):** Deploy rules que SOLO usan custom claims. Remover get().

**Validacion:**
- ANTES de Fase 2: verificar que el 100% de usuarios activos tienen claims
- En Fase 2: monitorear Firestore permission-denied errors en Console
- En Fase 3: si hay errores, los rules hibridas caen a get() como fallback

**Criterios de rollback INMEDIATO (en cualquier fase):**
- CUALQUIER usuario pierde acceso (permission-denied)
- CUALQUIER cliente ve datos de otro cliente
- CUALQUIER operacion de escritura falla

**Rollback:**
- Fase 2-3: Deploy rules viejas (solo get()). Efecto en < 1 minuto.
- Fase 4: Deploy rules hibridas (Fase 2). Claims siguen existiendo pero no se usan.

---

### PC-7: SOL-1 — useMemo AuthContext (71 consumers)
**Estrategia: CANARY con validacion manual intensiva**

**Por que canary:** Afecta TODOS los modulos. Un error en memoizacion causa que 71 paginas dejen de reaccionar a cambios de auth.

**PREREQUISITOS (deploy previo):**
1. Agregar useCallback a las 7 funciones del AuthContext
2. Mover flags derivados (isAdmin, isClient, etc.) DENTRO del useMemo
3. Este deploy previo NO cambia comportamiento (preparacion)

**Enrutamiento:**
1. **Deploy preparatorio:** useCallback en funciones (sin useMemo aun)
2. **Dia siguiente:** Deploy useMemo completo
3. **Validacion intensiva:** 2 horas de testing manual:
   - Login/logout flow
   - Cambio de rol via admin
   - Navegacion entre modulos (sea/air/ws)
   - Vista cliente vs admin
   - Auto-logout por inactividad
   - ModuleSelector auto-redirect

**Monitoreo:**
- React DevTools Profiler: verificar que re-renders bajan
- Verificar que ModuleSelector redirige correctamente al login
- Verificar que WSDashboard filtra por clientId correctamente

**Criterios de rollback:**
- Cualquier pagina no reacciona a cambio de auth state
- ModuleSelector no redirige al modulo correcto
- Usuario queda stuck en loading

**Rollback:** `git revert` + deploy. Efecto en < 5 minutos.

---

### PC-8: SOL-16 — writeBatch para addDoc loops
**Estrategia: CANARY por modulo de billing**

**Por que canary:** Cambia la atomicidad de escrituras. Hoy: fallo parcial deja charges parciales. Con batch: todo o nada. Ademas, limite de 500 ops por batch.

**Orden de implementacion:**
1. **Deploy 1:** Solo airBilling.ts L280-282 (charges auto de airfreight)
2. **Verificacion:** Recalcular charges de 3 vuelos → montos identicos
3. **Deploy 2:** Solo billing.ts L191-203 (charges de recepcion warehouse)
4. **Verificacion:** Calcular charges de 5 WRs → montos identicos
5. **Deploy 3:** billing.ts L433-457 (charges de dispatch)
6. **Deploy 4:** WSBillingCharges.tsx L304/334

**Monitoreo:**
- Comparar montos totales de charges pre/post cambio para mismos registros
- Log: `console.info('BILLING_BATCH', { collection, count, success })`
- Verificar que no hay charges huerfanos (creados parcialmente)

**Criterios de exito:**
- Montos de charges identicos (diferencia < $0.01)
- Batch de > 500 charges se divide correctamente
- No hay charges parciales en caso de error

**Criterios de rollback:**
- Diferencia de monto en cualquier charge
- Batch falla completamente (todo-o-nada causa perdida de charges que antes se creaban parcialmente)

**Rollback:** `git revert` del commit de billing especifico.

---

### PC-9: SOL-23 — Dividir componentes monoliticos
**Estrategia: CANARY por componente, extraer hooks primero**

**Orden de implementacion (cada uno es un deploy separado):**

1. **Deploy 1:** Extraer `useBookingForm()` hook de BookingNew (sin cambio visual)
   - Test: crear booking simple, ecommerce, MAWB, export — todo funciona igual

2. **Deploy 2:** Extraer `<ServicesModal>` como lazy component
   - Test: agregar/editar servicios manuales

3. **Deploy 3:** Extraer `useBuildupDistribution()` hook de Buildup
   - Test: flujo completo de distribucion

4. **Deploy 4:** Extraer `useOrderDetail()` hook de WSOrderDetail
   - Test: SO completo con billing

**NO dividir visualmente hasta que hooks esten estables (minimo 1 semana entre hook extraction y visual split).**

**Criterios de rollback:** Cualquier flujo de negocio que deje de funcionar.

---

### PC-10: SOL-31 — Archival datos historicos
**Estrategia: BLUE/GREEN con base de datos de staging**

**Por que blue/green:** Mover datos a otra coleccion es irreversible si se borran los originales.

**Proceso seguro:**
1. **NUNCA borrar datos originales.** Copiar a coleccion de archivo.
2. Agregar campo `archived_at` a documentos archivados.
3. Queries existentes agregan `where('archived_at', '==', null)` para excluir archivados.
4. Admin puede buscar en archivo con toggle "Incluir historicos".

**Fase 1:** Copiar datos > 6 meses a `{collection}_archive` SIN borrar originales.
**Fase 2:** Verificar que queries existentes siguen funcionando.
**Fase 3:** Agregar filtro de exclusion a queries.
**Fase 4 (opcional, semanas despues):** Borrar originales archivados.

**Rollback:** Copiar datos de vuelta de `_archive` a coleccion original.

---

## SECCION 3: VALIDACIONES OBLIGATORIAS ANTES DE MOVER TRAFICO

### Checklist Pre-Deploy (aplica a TODOS los puntos criticos)

| # | Validacion | Herramienta | Obligatoria para |
|---|-----------|-------------|-----------------|
| V1 | Build exitoso sin warnings | `npm run build` | Todos |
| V2 | 0 errores de TypeScript | `tsc --noEmit` | Todos |
| V3 | Flujo airfreight E2E | Test manual | PC-1,3,7,8,9 |
| V4 | Flujo seafreight E2E | Test manual | PC-2,4,8 |
| V5 | Flujo WS E2E | Test manual | PC-7,8,9 |
| V6 | Login admin + login cliente | Test manual | PC-6,7 |
| V7 | Billing recalculate + invoice | Test manual | PC-5,8 |
| V8 | Comparar montos billing | Script | PC-5,8 |
| V9 | Dashboard real-time update | Test manual | PC-3,7 |
| V10 | AWB search (todos formatos) | Test manual | PC-1 |
| V11 | Firestore reads baseline | Firebase Console | PC-1,2,3,4 |
| V12 | Memory baseline | Chrome Task Manager | PC-3,7 |

### Validaciones Especificas por Punto

**PC-1 (AWB search):**
- Buscar AWB simple: `045-21859633` → encontrado
- Buscar AWB ecommerce en awb_lines → encontrado
- Buscar AWB 1st leg MAWB → encontrado
- Buscar AWB con y sin guion → mismo resultado
- Buscar AWB inexistente → "No encontrado" (no error)

**PC-5 (Cloud Functions):**
- Generar charges para vuelo con 1 cliente, 5 bookings
- Generar charges para vuelo con 3 clientes, 20 bookings
- Generar invoice → verificar PDF y montos
- Recalculate → montos identicos a primera generacion

**PC-6 (Custom claims):**
- Admin: puede leer/escribir todo → OK
- Cliente: solo ve sus datos → OK
- Viewer: solo lee datos de su client_id → OK
- Vendor admin: solo ve datos de su vendor_id → OK
- Usuario sin claims: es rechazado por rules → OK (no acceso indebido)

---

## SECCION 4: CRITERIOS DE EXITO Y ROLLBACK

### Metricas Globales

| Metrica | Valor actual | Target post-cambio | Alarma rollback |
|---------|-------------|-------------------|-----------------|
| Page load (Inventory) | 20-40s | < 5s | > 45s (degradacion) |
| AWB search time | 3-10s | < 500ms | > 15s |
| Billing recalculate | Variable | Mismo tiempo o mejor | Montos incorrectos |
| Firestore reads/dia | 50K-100K | < 25K | > 120K |
| Console errors/hora | Baseline | Baseline o menos | > 150% baseline |
| Memory 1hr uso | Crece sin limite | Estable | N/A (mejora, no empeora) |

### Criterios de Rollback Inmediato (aplica a CUALQUIER deploy)

**ROLLBACK SI:**
1. Cualquier usuario pierde acceso a datos que antes podia ver
2. Cualquier calculo de billing produce monto diferente al esperado
3. Cualquier booking/recepcion/DO no se puede crear o editar
4. Firestore permission-denied error en console que no existia antes
5. Pantalla blanca (crash de app) en cualquier ruta
6. Dashboard no muestra datos real-time despues de 30 segundos
7. Mas de 2 usuarios reportan problemas en la primera hora

**AVANZAR SI (al siguiente % de trafico / siguiente deploy):**
1. 0 reportes de problemas en 24 horas
2. Metricas de performance iguales o mejores
3. Firestore reads iguales o menores
4. 0 errores nuevos en console
5. Todos los flujos E2E validados

---

## SECCION 5: PLAN DE ROLLBACK SEGURO

### Rollback por tipo de cambio

#### Frontend (cambios de codigo React)
```bash
# Opcion 1: Revert git + deploy
git revert <commit-hash>
npm run build
firebase deploy --only hosting

# Opcion 2: Rollback a version anterior de hosting
firebase hosting:rollback

# Tiempo: < 5 minutos
```
**Impacto:** Zero. El codigo viejo se sirve inmediatamente. Firestore no se modifica.

#### Feature Flags (cambios controlados por Firestore)
```bash
# Desactivar flag en Firebase Console o via script
# Coleccion: config, documento: feature_flags
# Cambiar campo a false

# Tiempo: < 30 segundos
# Efecto: inmediato (siguiente render del componente)
```
**Impacto:** Zero. El codigo con la path vieja se ejecuta inmediatamente.

#### Firestore Indices
```bash
# Los indices son aditivos — no se pueden romper
# Si un indice causa problemas de costo, borrarlo en Firebase Console
# Tiempo: 5-30 minutos (Firestore procesa la eliminacion)
```
**Impacto:** Zero. Queries que no usan el indice no se afectan.

#### Security Rules
```bash
# Deploy rules anteriores
firebase deploy --only firestore:rules
# Tiempo: < 2 minutos
```
**Impacto:** Inmediato. Todas las requests se evaluan con rules nuevas.

#### Cloud Functions
```bash
# Revert function code + deploy
# O: desactivar function en Firebase Console
firebase deploy --only functions
# Tiempo: < 5 minutos
```
**Impacto:** Requests en vuelo pueden fallar durante el deploy (~30s). Billing client-side debe estar disponible como fallback.

#### writeBatch (cambio de atomicidad en billing)
**CASO ESPECIAL:** Si writeBatch causa que un billing completo falle (todo-o-nada) donde antes con addDoc loop se creaban charges parciales:
1. Los datos NO se corrompieron (batch no escribio nada)
2. Revert codigo + deploy
3. Re-ejecutar billing con codigo viejo (addDoc loop)
4. Verificar que charges se crearon correctamente

**No hay perdida de datos** porque el batch fail = 0 escrituras.

### Rollback sin afectar operaciones en curso

| Operacion en curso | Rollback seguro? | Precaucion |
|--------------------|-----------------|-----------|
| Booking siendo creado | SI | El formulario sigue en memoria del browser. Al guardar, usa la API de Firestore directamente. |
| Recepcion fisica activa | SI | Piezas ya guardadas en Firestore no se pierden. UI se recarga con codigo viejo. |
| ULD Build-up en progreso | SI | Piezas asignadas a ULDs estan en Firestore. UI se recarga. |
| Billing recalculate | PRECAUCION | Si esta a mitad de calculo con writeBatch, el batch puede fallar atomicamente. Verificar y re-ejecutar post-rollback. |
| Invoice en generacion | PRECAUCION | Si el PDF esta generandose en CF, puede quedar a medio generar. Verificar estado del invoice post-rollback. |
| Driver en ruta (tracking) | SI | Tracking data en Firestore no depende del frontend. |

### Consistencia de datos post-rollback

**Firestore es la fuente de verdad.** El frontend es stateless (SPA). Al hacer rollback:
1. El browser carga el codigo viejo
2. Los datos en Firestore NO cambian (son independientes del codigo frontend)
3. Unica excepcion: si Cloud Functions escribieron datos con estructura nueva, esos datos pueden ser incompatibles con codigo viejo

**Mitigacion para CF:**
- Durante fase canary, CF escribe en campos ADICIONALES (no reemplaza campos existentes)
- Codigo viejo ignora campos nuevos (graceful degradation)
- Solo cuando CF esta 100% validada, se migra a campos nuevos como primarios

---

## SECCION 6: CALENDARIO DE DESPLIEGUE

```
SEMANA 1: Pre-requisitos
├─ Lun: Fix race condition WSOrderDetail L276-294
├─ Mar: useCallback en 7 funciones AuthContext (deploy preparatorio)
├─ Mie: Crear indices compuestos en Firebase Console (11 indices)
├─ Jue: Deploy SOL-1 (useMemo AuthContext) + validacion intensiva
└─ Vie: Deploy cambios seguros: ErrorBoundary, blob URLs, debounce, logo

SEMANA 2: Sprint 1 completo
├─ Lun: Deploy SOL-16 airBilling writeBatch + verificar 3 vuelos
├─ Mar: Deploy SOL-16 billing.ts writeBatch + verificar 5 WRs
├─ Mie: Feature flag AWB search v2 ON para admins (PC-1)
├─ Jue: Deploy SOL-12 Buildup Promise.all + verificar distribucion
└─ Vie: Review semanal — metricas, errores, feedback

SEMANA 3: Sprint 2
├─ Lun: Deploy separar BookingList listener (PC-3, cambio 3A)
├─ Mar: Deploy SOL-17 client_id filter WSDashboard
├─ Mie: AWB search v2 ON para agentes (escalar canary PC-1)
├─ Jue: Deploy SOL-26 paralelizar Generate Sets
└─ Vie: Review semanal

SEMANA 4: Sprint 2 continuacion
├─ Lun: Deploy separar Transportation listener (PC-3, cambio 3B)
├─ Mar: AWB search v2 ON para todos (PC-1 completo)
├─ Mie: Deploy SOL-22 cache layer referencia
├─ Jue: Extraer useBookingForm hook (PC-9, paso 1)
└─ Vie: Review mensual + decision sobre PC-5/PC-6

SEMANA 5-8: Sprint 3 (Alto riesgo)
├─ S5: Paginacion Inventory (requiere filtros server-side previos)
├─ S6: Dashboard listener separation (si datos de S3 lo justifican)
├─ S7: Extraer hooks de Buildup y WSOrderDetail
└─ S8: Preparar infraestructura Cloud Functions (staging)

SEMANA 9+: Sprint 4 (Proyectos dedicados)
├─ Cloud Functions billing (PC-5) — blue/green
├─ Custom claims (PC-6) — SOLO si costo Firestore lo justifica
└─ Archival datos historicos (PC-10)
```

---

## SECCION 7: RECOMENDACIONES FINALES

### Reglas de oro para despliegue seguro

1. **UN CAMBIO CRITICO POR SEMANA.** Nunca desplegar 2 puntos criticos en el mismo dia.

2. **FEATURE FLAGS PARA TODO LO QUE TOCA DATOS.** Si el cambio altera como se leen o escriben datos, usar feature flag. Si solo cambia UI/render, deploy directo con git revert como rollback.

3. **BILLING ES SAGRADO.** Cualquier cambio que toque billing (charges, invoices, rates) requiere comparacion de montos pre/post deploy con datos reales. Diferencia > $0.01 = rollback inmediato.

4. **MAWB ES INTOCABLE.** No modificar flujo MAWB a menos que el usuario lo solicite explicitamente. Todos los cambios de AWB search deben probarse con bookings simple, ecommerce, MAWB y export.

5. **DEPLOY EN HORARIO DE BAJA ACTIVIDAD.** Idealmente 7-8 AM antes de que warehouse empiece operaciones. Nunca despues de las 2 PM.

6. **TENER ROLLBACK LISTO ANTES DE DEPLOY.** El comando de rollback debe estar escrito y copiado ANTES de ejecutar el deploy. Si no puedes revertir en < 5 minutos, no despliegues.

7. **MONITOREAR 2 HORAS POST-DEPLOY.** No cerrar terminal ni Firebase Console hasta 2 horas despues del deploy. Verificar reads, errors, user reports.

8. **NUNCA DEPLOY EL VIERNES.** Excepto cambios triviales (logo, skeleton screens). Cualquier problema descubierto el sabado no tiene quien lo atienda.

9. **DOCUMENTAR CADA DEPLOY.** Fecha, hora, cambio, quien lo hizo, estado de metricas pre/post, incidentes.

10. **COMUNICAR AL EQUIPO.** Antes de deploy: avisar a warehouse que puede haber cambios. Despues: confirmar que todo esta normal. Si hay rollback: avisar inmediatamente.

---

*Plan de despliegue generado: 2026-05-18*
*Basado en analisis de regresion de 32 soluciones contra 71 archivos consumer, 200+ queries Firestore, 50+ security rules*
