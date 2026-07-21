const { jsPDF } = require('jspdf');
const { applyPlugin } = require('jspdf-autotable');
applyPlugin(jsPDF);

const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
const W = doc.internal.pageSize.getWidth();
const M = 14;
const CW = W - 2*M;
let y = 15;

const BLUE = [30, 58, 95];
const GRAY = [100, 100, 100];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const RED = [200, 50, 50];
const AMBER = [180, 120, 30];
const GREEN = [40, 140, 60];
const LIGHT_GREEN = [230, 245, 230];
const LIGHT_RED = [255, 235, 235];
const LIGHT_AMBER = [255, 245, 220];

function addPage() { doc.addPage(); y = 15; }
function checkPage(need) { if (y + need > 262) addPage(); }

function title(text) {
  checkPage(12);
  doc.setFillColor(...BLUE);
  doc.rect(M, y, CW, 9, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(text, M + 3, y + 6.5);
  y += 12;
  doc.setTextColor(...BLACK);
}

function subtitle(text) {
  checkPage(10);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...BLUE);
  doc.text(text, M, y + 4);
  y += 7;
  doc.setTextColor(...BLACK);
}

function riskBand(text, level) {
  checkPage(8);
  const color = level === 'muy_alto' ? [139, 0, 0] : level === 'alto' ? RED : level === 'medio' ? AMBER : GREEN;
  doc.setFillColor(...color);
  doc.rect(M, y, CW, 6, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(text, M + 3, y + 4.2);
  y += 8;
  doc.setTextColor(...BLACK);
}

function para(text) {
  checkPage(8);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  const lines = doc.splitTextToSize(text, CW - 4);
  doc.text(lines, M + 2, y + 3);
  y += lines.length * 3.2 + 2;
  doc.setTextColor(...BLACK);
}

function bullet(label, text) {
  checkPage(12);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...BLUE);
  doc.text(label, M + 2, y + 3);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  const valLines = doc.splitTextToSize(text, CW - 38);
  doc.text(valLines, M + 38, y + 3);
  y += Math.max(valLines.length * 3.2, 4) + 2;
}

function tbl(headers, rows) {
  checkPage(10 + rows.length * 5);
  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [headers],
    body: rows,
    styles: { fontSize: 6, cellPadding: 1.2, textColor: [50,50,50], overflow: 'linebreak' },
    headStyles: { fillColor: BLUE, textColor: WHITE, fontStyle: 'bold', fontSize: 6 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    theme: 'grid',
  });
  y = doc.lastAutoTable.finalY + 5;
}

function riskTbl(headers, rows) {
  checkPage(10 + rows.length * 5);
  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [headers],
    body: rows,
    styles: { fontSize: 6, cellPadding: 1.2, textColor: [50,50,50], overflow: 'linebreak' },
    headStyles: { fillColor: BLUE, textColor: WHITE, fontStyle: 'bold', fontSize: 6 },
    theme: 'grid',
    didParseCell: function(data) {
      if (data.section === 'body' && data.column.index === 1) {
        const val = (data.cell.raw || '').toString().toUpperCase();
        if (val.includes('MUY ALTO')) { data.cell.styles.fillColor = [255, 200, 200]; data.cell.styles.textColor = [139, 0, 0]; data.cell.styles.fontStyle = 'bold'; }
        else if (val.includes('ALTO') && !val.includes('MUY')) { data.cell.styles.fillColor = LIGHT_RED; data.cell.styles.textColor = RED; data.cell.styles.fontStyle = 'bold'; }
        else if (val.includes('MEDIO')) { data.cell.styles.fillColor = LIGHT_AMBER; data.cell.styles.textColor = AMBER; data.cell.styles.fontStyle = 'bold'; }
        else if (val.includes('BAJO')) { data.cell.styles.fillColor = LIGHT_GREEN; data.cell.styles.textColor = GREEN; data.cell.styles.fontStyle = 'bold'; }
      }
    }
  });
  y = doc.lastAutoTable.finalY + 5;
}

// ═══ COVER ═══
doc.setFillColor(...BLUE);
doc.rect(0, 0, W, 90, 'F');
doc.setTextColor(...WHITE);
doc.setFontSize(26);
doc.setFont('helvetica', 'bold');
doc.text('MCL WMS', W/2, 30, { align: 'center' });
doc.setFontSize(14);
doc.text('Validacion de No-Regresion', W/2, 44, { align: 'center' });
doc.setFontSize(10);
doc.text('Performance Audit Impact Analysis', W/2, 56, { align: 'center' });
doc.setFontSize(8);
doc.setFont('helvetica', 'normal');
doc.text('Fecha: 2026-05-18  |  Senior Performance Engineer + QA Architect', W/2, 70, { align: 'center' });
doc.text('Alcance: 38 hallazgos / 32 acciones propuestas', W/2, 78, { align: 'center' });

doc.setTextColor(...BLACK);
y = 100;
doc.setFontSize(10);
doc.setFont('helvetica', 'bold');
doc.text('Resumen Ejecutivo', M, y); y += 7;

doc.setFontSize(7.5);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...GRAY);
[
  '32 soluciones analizadas contra todos los modulos del sistema:',
  '  Airfreight, Seafreight, Warehouse Services, Billing, Bookings,',
  '  Recepcion documental/fisica, Distribucion/ULD Build-up, Dashboards, KPIs',
  '',
  'Clasificacion de riesgo:',
  '  8 cambios SEGUROS — implementar sin precauciones especiales',
  '  7 cambios BAJO riesgo — implementar con tests basicos',
  '  10 cambios MEDIO riesgo — implementar con test plan completo',
  '  6 cambios ALTO riesgo — requieren plan de migracion dedicado',
  '  2 cambios MUY ALTO riesgo — requieren proyecto dedicado',
  '',
  'Hallazgos criticos de la validacion:',
  '  - SOL-8 (Where en AWB search): PELIGROSO — Firestore no soporta where en array fields',
  '  - SOL-11 (Inventory N+1): 8 modulos dependen de lines subcollection',
  '  - SOL-14 (Nested listeners): Race condition de flash de estado incompleto',
  '  - SOL-18 (Paginacion): Rompe filtros client-side existentes',
  '  - SOL-19 (Cloud Functions): Requiere nueva infraestructura completa',
  '  - SOL-28 (Custom claims): Reescribir 50+ security rules',
  '',
  'AuthContext: 71 consumers (no 18 como estimaba el audit) — useMemo critico',
].forEach(l => { doc.text(l, M, y); y += 3.8; });

// ═══ 1. MATRIZ DE IMPACTO ═══
addPage();
title('1. MATRIZ DE IMPACTO — CLASIFICACION POR RIESGO');

riskTbl(
  ['#', 'Riesgo', 'Solucion', 'Modulos Afectados'],
  [
    ['1', 'BAJO', 'useMemo AuthContext', 'TODOS (71 consumers)'],
    ['2', 'BAJO', 'Debounce search inputs', 'Dashboard, DocReception, DeliveryOrders'],
    ['3', 'MEDIO', 'Where/limit tracking/queue/DOs', 'WS Delivery, Driver Queue'],
    ['4', 'BAJO', 'Singleton window.open', 'Buildup labels, DO print'],
    ['5', 'BAJO', 'Revocar blob URLs', 'AirfreightDeliveryOrder'],
    ['6', 'BAJO', 'ErrorBoundary', 'App-level wrapper'],
    ['7', 'BAJO', 'Fix window.print popup', 'AirfreightBookingNew'],
    ['8', 'ALTO', 'Where clause DocReception AWB', 'Recepcion documental, Flight Assignment'],
    ['9', 'BAJO', 'Cache Add AWB modal', 'AirfreightDeliveryOrder'],
    ['10', 'BAJO', 'Memoizar loadClient billing', 'Air Billing, WS Billing'],
    ['11', 'ALTO', 'Refactorizar Inventory N+1', 'Inventory, Seafreight, Billing (8 modulos)'],
    ['12', 'MEDIO', 'Buildup Promise.all', 'Build-up, Distribucion'],
    ['13', 'MEDIO', 'Where en Billing/KPI pages', 'BillingCharges, KpiDashboard, BillingSummary'],
    ['14', 'ALTO', 'Separar nested onSnapshot', 'Dashboard, Screening, BookingList'],
    ['15', 'BAJO', 'Indices compuestos', 'Firebase Console (sin codigo)'],
    ['16', 'MEDIO', 'writeBatch addDoc loops', 'Air Billing, WS Billing, PhysicalReception'],
    ['17', 'MEDIO', 'client_id filter WSDashboard', 'WS Dashboard'],
    ['18', 'ALTO', 'Paginacion tablas', 'Inventory, Holds, Billing, Bookings'],
    ['19', 'MUY ALTO', 'Cloud Functions billing/KPI', 'Billing, KPI, Invoicing (arquitectura)'],
    ['20', 'MEDIO', 'PDF en Web Worker', 'buildupPdf (solo viable)'],
    ['21', 'BAJO', 'Dynamic import tesseract.js', 'BarcodeScannerModal'],
    ['22', 'MEDIO', 'Cache layer datos referencia', 'Rates, Clients, Destinations'],
    ['23', 'ALTO', 'Dividir componentes monoliticos', 'BookingNew, Buildup, DeliveryOrder, WSOrderDetail'],
    ['24', 'MEDIO', 'react-window virtualizacion', 'Todas las tablas'],
    ['25', 'BAJO', 'Optimizar Vite chunks', 'Build output'],
    ['26', 'MEDIO', 'Paralelizar Generate Sets', 'AirfreightDeliveryOrder'],
    ['27', 'BAJO', 'React.memo componentes', 'Componentes de fila/card'],
    ['28', 'MUY ALTO', 'Custom claims Firebase Auth', 'Security Rules, Auth, TODOS'],
    ['29', 'BAJO', 'Remover deps sin usar', 'package.json'],
    ['30', 'BAJO', 'Skeleton screens', 'UI cosmetic'],
    ['31', 'ALTO', 'Archival datos historicos', 'Billing, Tracking, Delivery'],
    ['32', 'BAJO', 'Optimizar logo.png', 'Layout'],
  ]
);

// ═══ 2. ANALISIS DE RIESGOS CRITICOS ═══
addPage();
title('2. ANALISIS DE RIESGOS CRITICOS');

riskBand('SOL-8: Where clause en DocReceptionNew AWB search — ALTO RIESGO', 'alto');
para('ESTE ES EL CAMBIO MAS PELIGROSO DE LA FASE 1. La busqueda actual hace getDocs de TODAS las bookings y filtra client-side por AWB normalizado contra 4 campos diferentes (awb_1st_leg, awb_2nd_leg, awb_lines[].awb_number, awb_lines[].awb_2nd_leg).');
bullet('Problema:', 'Firestore NO soporta where() en campos de array de objetos (awb_lines[].awb_number). La normalizacion (regex replace) es client-side — Firestore no soporta regex en where.');
bullet('Escenarios rotos:', 'AWBs en awb_lines (ecommerce/mawb) no se encuentran. AWBs con formatos diferentes (guion vs sin guion) no matchean.');
bullet('Alternativa segura:', 'Crear campo indexable awb_numbers: [normalized values] en cada booking y usar array-contains. O implementar cache local de bookings en vez de where.');
bullet('Recomendacion:', 'NO implementar where directo. Usar cache en su lugar hasta crear campo de indice.');

riskBand('SOL-11: Refactorizar Inventory N+1 — ALTO RIESGO', 'alto');
para('Denormalizar lines/sku_lines al WR principal afecta 8 modulos: PhysicalReception, DispatchNew, DispatchCorrection, Dashboard, WRPrint, Inventory, InventoryDocuments, billing.ts. Cada edicion de line deberia actualizar el WR — riesgo de inconsistencia si falla parcialmente.');
bullet('Recomendacion:', 'Opcion C: Paginacion + cache (50 WRs por pagina). MAS SEGURO que denormalizar. Reservar denormalizacion para cuando existan Cloud Functions.');

riskBand('SOL-14: Separar nested onSnapshot — ALTO RIESGO', 'alto');
para('El patron actual (flights listener -> bookings listener anidado) garantiza atomicidad: el state se actualiza una sola vez con datos combinados. Separar causa flash de estado incompleto: flights nuevo + bookings viejo = 1 frame inconsistente.');
bullet('Screening especial:', 'El inner listener filtra por flight_id del outer. Si se separa, necesita escuchar TODAS las bookings y filtrar client-side — peor en reads.');
bullet('Recomendacion:', 'Mantener nested en Dashboard/Screening (cleanup actual funciona). Solo separar en BookingList donde inner NO depende de outer.');

riskBand('SOL-18: Paginacion tablas — ALTO RIESGO', 'alto');
para('Los filtros client-side (pais, status, cliente, busqueda) dependen de tener TODOS los items en memoria. Con paginacion, filtros solo funcionan sobre la pagina actual — REGRESION FUNCIONAL. Totales de billing serian parciales.');
bullet('Recomendacion:', 'Implementar react-window (SOL-24) primero — resuelve problema de render sin cambiar datos. Paginacion solo DESPUES de migrar filtros a server-side where clauses.');

riskBand('SOL-19: Cloud Functions — MUY ALTO RIESGO', 'muy_alto');
para('No existen Cloud Functions. Requiere: Firebase Blaze plan, entorno Node.js, deploy pipeline, monitoring. Cambio de UX de sincrono a asincrono. Si CF falla, no hay rollback automatico.');
bullet('Recomendacion:', 'Implementar como proyecto dedicado (Sprint 4). Requiere plan de migracion propio con rollback strategy.');

riskBand('SOL-28: Custom claims Firebase Auth — MUY ALTO RIESGO', 'muy_alto');
para('Requiere reescribir 50+ security rules en firestore.rules. Custom claims solo se setean desde Admin SDK (server-side). Usuarios deben re-login para que JWT se refresque. Migracion parcial = usuarios sin acceso.');
bullet('Recomendacion:', 'Ultima prioridad. Solo implementar si costo de Firestore por reads de rules es significativo.');

// ═══ 3. RIESGOS OCULTOS POR SOLUCION ═══
addPage();
title('3. RIESGOS OCULTOS Y EDGE CASES');

subtitle('SOL-1: useMemo AuthContext');
para('ADVERTENCIA: Las funciones (signOut, signInWithGoogle, etc.) deben envolverse en useCallback PRIMERO. Sin useCallback, el useMemo se invalida en cada render porque las funciones se recrean — CERO EFECTO. Hay 7 funciones que necesitan useCallback. El flag isAdmin y 10 mas deben calcularse DENTRO del useMemo, no fuera. AuthContext tiene 71 consumers, no 18 como el audit estimaba.');

subtitle('SOL-3: Where/limit en tracking/queue');
para('RIESGO: Si se filtra por fecha (created_at >= 30d), DOs activos antiguos y trackings en transito de hace 2 meses desaparecen. Conductores en espera desde hace tiempo quedan invisibles. Solucion: filtrar por status != completed OR created_at >= 30d (union).');

subtitle('SOL-16: writeBatch para addDoc loops');
para('CAMBIO DE COMPORTAMIENTO DE ERROR: addDoc loop = fallo parcial (items 1-2 escritos si falla en 3). writeBatch = todo o nada (atomico). Limite de 500 ops por batch — necesita chunking. airBilling.ts L500-506 YA usa este patron para deletes — consistir para creates.');

subtitle('SOL-20: PDF en Web Worker');
para('Solo buildupPdf.ts es viable para Worker (usa jsPDF puro). deliveryOrder.ts, printLabels.ts, DocReceptionList y html2pdf.js requieren DOM — NO funcionan en Worker. Para estos, usar requestIdleCallback o chunking.');

subtitle('SOL-24: react-window');
para('Ctrl+F del browser NO encuentra texto fuera del viewport virtual. Print del browser solo imprime filas visibles. Tablas con filas expandibles necesitan VariableSizeList. Alternativa: react-virtuoso soporta tablas HTML nativas.');

// ═══ 4. VALIDACION DE COMPATIBILIDAD ═══
addPage();
title('4. VALIDACION DE COMPATIBILIDAD POR MODULO');

subtitle('Flujos de Booking');
tbl(
  ['Flujo', 'Riesgo', 'Cambios que lo afectan', 'Regresion posible'],
  [
    ['Simple booking', 'Bajo', 'SOL-1, SOL-23', 'Solo si split rompe state'],
    ['MAWB booking', 'Bajo', 'SOL-1, SOL-23', 'Solo si split rompe state'],
    ['Ecommerce booking', 'Medio', 'SOL-1, SOL-8, SOL-23', 'AWB search broken'],
    ['Export booking', 'Bajo', 'SOL-1', 'Ninguna'],
    ['Booking con AWB lines', 'Medio', 'SOL-8, SOL-23', 'AWB search broken'],
  ]
);

subtitle('Dashboards');
tbl(
  ['Dashboard', 'Riesgo', 'Cambios', 'Regresion posible'],
  [
    ['Airfreight Dashboard', 'Alto', 'SOL-14', 'Flash estado incompleto'],
    ['WS Dashboard', 'Medio', 'SOL-17', 'clientId null = 0 results'],
    ['WS KPI Dashboard', 'Medio', 'SOL-13', 'KPIs parciales'],
    ['Billing Dashboard', 'Bajo', 'SOL-1', 'Ninguna'],
    ['Seafreight Dashboard', 'Bajo', 'SOL-1', 'Ninguna'],
  ]
);

subtitle('Calculos de Billing');
tbl(
  ['Calculo', 'Riesgo', 'Cambios', 'Regresion posible'],
  [
    ['Auto charges (dispatch)', 'Medio', 'SOL-10, 16, 19', 'Atomicidad cambia con writeBatch'],
    ['Manual charges', 'Bajo', 'SOL-16', 'Solo atomicidad'],
    ['Recalculate charges', 'Medio', 'SOL-10, 16, 19', 'Cache stale + atomicidad'],
    ['Storage charges', 'Bajo', 'SOL-11', 'Solo si denormaliza'],
    ['Invoice totals', 'Medio', 'Transitivo', 'Depende de charges correctos'],
  ]
);

subtitle('Recepcion Documental / Fisica');
tbl(
  ['Operacion', 'Riesgo', 'Cambios', 'Regresion posible'],
  [
    ['Buscar AWB', 'ALTO', 'SOL-8', 'AWBs en awb_lines no encontrados'],
    ['Check duplicados', 'ALTO', 'SOL-8', 'Falsos negativos con where limitado'],
    ['Crear doc reception', 'Bajo', 'SOL-8', 'Depende de busqueda correcta'],
    ['Escanear barcode', 'Bajo', 'SOL-21', 'Solo delay primera vez'],
    ['Print labels', 'Bajo', 'SOL-4', 'Ventana singleton ok'],
  ]
);

subtitle('Build-up / Distribucion');
tbl(
  ['Operacion', 'Riesgo', 'Cambios', 'Regresion posible'],
  [
    ['Cargar piezas', 'Medio', 'SOL-12', 'Promise.all OK, in operator requiere re-agrupacion'],
    ['Distribuir a ULD', 'Bajo', 'SOL-12', 'No afectado directamente'],
    ['PDF de buildup', 'Medio', 'SOL-20', 'Solo si Web Worker implementation falla'],
    ['Close distribution', 'Bajo', 'N/A', 'No afectado'],
  ]
);

subtitle('Integraciones Externas');
tbl(
  ['Integracion', 'Afectada', 'Por'],
  [
    ['Firebase Auth', 'Solo SOL-28', 'Custom claims (MUY ALTO riesgo)'],
    ['Firebase Firestore', 'SOL-15', 'Indices: mejora, no rompe'],
    ['Firebase Storage', 'No', 'Ninguna solucion toca Storage'],
    ['n8n workflow', 'No', 'Independiente del WMS'],
  ]
);

// ═══ 5. PLAN DE PRUEBAS ═══
addPage();
title('5. PLAN DE PRUEBAS OBLIGATORIO');

subtitle('A. Pruebas Funcionales — Flujos Criticos End-to-End');
tbl(
  ['Flujo E2E', 'Pasos', 'SOL# que lo afectan'],
  [
    ['Airfreight completo', 'Booking > Doc Reception > Physical > Buildup > Dispatch > Billing > Invoice', '1, 8, 10, 12, 16, 26'],
    ['Seafreight completo', 'WR > Physical Reception > Dispatch > Billing > Invoice', '1, 11, 16'],
    ['WS completo', 'SO > Reception > DO > Tracking > Billing', '1, 3, 16, 17, 23'],
    ['Auth cross-module', 'Login admin > crear booking > login cliente > ver booking', '1'],
    ['Real-time sync', 'Dashboard abierto > crear booking en otra pestana > dashboard actualiza', '14'],
    ['Billing integrity', 'Recalculate > verificar montos > generar invoice > verificar totales', '10, 16, 19'],
  ]
);

subtitle('B. Pruebas de Regresion por Modulo');
tbl(
  ['Modulo', 'Test', 'Criticidad', 'SOL#'],
  [
    ['Bookings', 'Crear/editar simple, ecommerce, MAWB, export', 'Alta', '1, 23'],
    ['Doc Reception', 'Buscar AWB (todos formatos), check duplicados', 'Critica', '8'],
    ['Physical Reception', 'Agregar piezas, escanear barcode, completar', 'Alta', '1, 21'],
    ['Build-up', 'Ver vuelos, distribuir piezas, PDF, close', 'Alta', '12, 20'],
    ['Delivery Orders', 'Add AWB, Generate Sets, print', 'Critica', '5, 9, 26'],
    ['Air Billing', 'Auto/manual charges, recalculate, invoice', 'Critica', '10, 16'],
    ['WS Dashboard', 'Admin ve todo, cliente ve solo suyo', 'Alta', '17'],
    ['Inventory', 'Carga, filtros, export, detalle, semaforo', 'Critica', '11, 18'],
    ['Sea Billing', 'Charges por WR, invoicing', 'Critica', '13, 16'],
    ['Screening', 'Lista AWBs, real-time updates', 'Alta', '14'],
  ]
);

subtitle('C. Pruebas de Performance (Before/After)');
tbl(
  ['Metrica', 'Herramienta', 'Baseline actual', 'Target'],
  [
    ['Inventory page load', 'DevTools Performance', '20-40s', '< 3s'],
    ['Dashboard initial render', 'Performance.mark', '5-10s', '< 2s'],
    ['AWB search latency', 'Console.time', '3-10s', '< 500ms'],
    ['Generate Sets (5 AWBs)', 'Console.time', '30-60s', '< 5s'],
    ['Auth re-renders', 'React DevTools Profiler', 'Count/nav', 'Reducido 80%+'],
    ['Firestore reads/page', 'Firebase Console', 'Medir antes', 'Reducido 50%+'],
    ['Bundle size', 'vite build output', 'Medir antes', '< 500KB gzip'],
    ['Memory 1hr uso', 'Chrome Task Manager', 'Crece sin limite', 'Estable'],
    ['PDF generation', 'Console.time', '2-5s', '< 1s'],
  ]
);

subtitle('D. Pruebas de Estres');
tbl(
  ['Escenario', 'Condicion', 'Verificar'],
  [
    ['1000 bookings', 'Fixtures', 'BookingList, Dashboard < 3s'],
    ['100 WRs x 50 lines', 'Fixtures', 'Inventory carga < 5s'],
    ['50 charges por vuelo', 'Fixtures', 'Billing recalculate < 10s'],
    ['5 usuarios simultaneos', '5 pestanas', 'Real-time no se bloquea'],
    ['20 recepciones por vuelo', 'Datos reales', 'Buildup carga correcto'],
    ['10 AWBs MAWB en DO', 'Datos reales', 'Generate Sets < 15s'],
    ['Navegacion rapida', '10 paginas en 5s', 'No memory/listener leak'],
  ]
);

// ═══ 6. ORDEN DE IMPLEMENTACION REVISADO ═══
addPage();
title('6. ORDEN DE IMPLEMENTACION REVISADO (POR RIESGO)');

riskBand('Sprint 1: Cambios Seguros + Bajo Riesgo (1-2 dias)', 'bajo');
tbl(
  ['Orden', 'SOL#', 'Cambio', 'Riesgo'],
  [
    ['1', '6', 'ErrorBoundary a nivel de rutas', 'Seguro'],
    ['2', '7', 'Fix window.print en BookingNew popup', 'Seguro'],
    ['3', '15', 'Indices compuestos en Firebase Console', 'Seguro'],
    ['4', '25', 'Vite manualChunks (xlsx, recharts, jspdf)', 'Seguro'],
    ['5', '29', 'Remover firebase-admin, @zxing si no se usan', 'Seguro'],
    ['6', '32', 'Optimizar logo.png a WebP', 'Seguro'],
    ['7', '5', 'Revocar blob URLs en Generate Sets', 'Bajo'],
    ['8', '2', 'Debounce search inputs con es-toolkit', 'Bajo'],
    ['9', '4', 'Singleton window.open para impresion', 'Bajo'],
    ['10', '10', 'Memoizar loadClient en billing loops', 'Bajo'],
    ['11', '1', 'useMemo AuthContext (con useCallback)', 'Bajo'],
    ['12', '21', 'Dynamic import tesseract.js', 'Bajo'],
  ]
);

riskBand('Sprint 2: Riesgo Medio con Test Plan (3-5 dias)', 'medio');
tbl(
  ['Orden', 'SOL#', 'Cambio', 'Precaucion'],
  [
    ['13', '12', 'Buildup Promise.all', 'Verificar resultados identicos'],
    ['14', '16', 'writeBatch addDoc loops', 'Chunking por 500, test atomicidad'],
    ['15', '17', 'client_id filter WSDashboard', 'Guard para clientId null'],
    ['16', '26', 'Paralelizar Generate Sets', 'Benchmark before/after'],
    ['17', '9', 'Cache Add AWB modal', 'TTL 30-60s + invalidacion'],
    ['18', '3', 'Where/limit tracking', 'Toggle "Ver historicos"'],
    ['19', '13', 'Where Billing/KPI', 'Selector de periodo'],
    ['20', '22', 'Cache layer referencia', 'TTL 1 min, invalidar en billing'],
  ]
);

riskBand('Sprint 3: Alto Riesgo con Migracion (1-2 semanas)', 'alto');
tbl(
  ['Orden', 'SOL#', 'Cambio', 'Prerequisito'],
  [
    ['21', '20', 'PDF Web Worker (solo buildupPdf)', 'Test contenido identico'],
    ['22', '24', 'react-window / virtuoso', 'Verificar scroll tactil mobile'],
    ['23', '27', 'React.memo componentes hijo', 'Profiler antes/despues'],
    ['24', '30', 'Skeleton screens', 'Ninguno'],
    ['25', '14', 'Separar nested listeners', 'Solo BookingList, NO Dashboard'],
    ['26', '18', 'Paginacion', 'Migrar filtros a server-side primero'],
    ['27', '8', 'AWB search optim.', 'Crear campo awb_numbers indexable'],
    ['28', '11', 'Inventory optim.', 'Pagination + cache, NO denormalizacion'],
  ]
);

riskBand('Sprint 4: Proyecto Dedicado (MUY ALTO riesgo)', 'muy_alto');
tbl(
  ['Orden', 'SOL#', 'Cambio', 'Requiere'],
  [
    ['29', '23', 'Dividir componentes', 'Custom hooks primero, luego visual'],
    ['30', '31', 'Archival datos historicos', 'Estrategia de migracion completa'],
    ['31', '19', 'Cloud Functions', 'Firebase Blaze, pipeline, monitoring'],
    ['32', '28', 'Custom claims', 'Admin SDK, reescribir 50+ rules'],
  ]
);

// ═══ 7. REGLAS DE IMPLEMENTACION ═══
checkPage(60);
title('7. REGLAS DE IMPLEMENTACION Y MONITOREO');

subtitle('Reglas Obligatorias');
para('1. NUNCA implementar mas de 1 cambio ALTO riesgo en el mismo deploy');
para('2. SIEMPRE build + test manual antes de deploy de cambios MEDIO+');
para('3. SIEMPRE tener rollback plan (git revert) para cambios ALTO+');
para('4. NUNCA modificar flujo MAWB sin autorizacion explicita');
para('5. SIEMPRE verificar billing calculations identicos pre/post cambio');
para('6. SIEMPRE probar con datos reales de produccion');

subtitle('Metricas de Monitoreo Post-Deploy');
tbl(
  ['Metrica', 'Tool', 'Alarma si'],
  [
    ['Firestore reads/dia', 'Firebase Console', '> 110% del baseline'],
    ['Error rate', 'Browser DevTools', 'Nuevos errores aparecen'],
    ['Page load time', 'Chrome Lighthouse', '> 120% del baseline'],
    ['Memory usage', 'Chrome Task Manager', 'Crece sin limite'],
    ['User reports', 'Feedback directo', 'Datos faltantes o incorrectos'],
  ]
);

// ═══ 8. CORRECCIONES POST-ANALISIS ═══
addPage();
title('8. CORRECCIONES POST-ANALISIS PROFUNDO');

subtitle('Datos corregidos vs. Audit original');
tbl(
  ['Dato del Audit', 'Valor Corregido', 'Impacto'],
  [
    ['AuthContext: 18 consumers', '71 consumers', 'useMemo 4x mas critico'],
    ['BookingNew: 35 useState', '68 useState', 'Splitting mas urgente'],
    ['AirfreightBuildup: 15 useState', '43 useState', 'Splitting mas urgente'],
    ['WSOrderDetail: 20 useState', '55+ useState', 'Splitting mas urgente'],
    ['Generate Sets: 30-60s', '2.5-3.5s POR AWB (12-17s para 5)', 'Mas preciso'],
    ['Blob leak: generico', '3-7.5 MB por DO, 15 URLs/gen', 'Cuantificado'],
  ]
);

subtitle('Nuevos riesgos descubiertos');
para('1. WSOrderDetail L276-294: race condition real — unsub2 puede ser undefined si componente se desmonta mientras getDoc Promise esta pendiente. Requiere fix PREVIO a cualquier optimizacion.');
para('2. ModuleSelector.tsx L17-24: auto-redirect depende de moduleAccess flags en useEffect deps. Si useMemo de AuthContext no incluye moduleAccess, usuario queda en pagina equivocada.');
para('3. Dashboard.tsx L21-23: closure capture de isClient/clientId del primer render (empty deps). Bug EXISTENTE — datos stale si auth cambia post-mount.');
para('4. BookingNew: 68 hooks interdependientes — dividir sin custom hooks intermedios causa prop drilling masivo. Extraer useBookingForm ANTES de split visual.');
para('5. wsBilling.ts es el modulo mejor disenado (0 N+1, rates cargados una vez, calculo in-memory). Usar como modelo para refactorizar airBilling.ts.');

subtitle('Pre-requisitos descubiertos');
para('ANTES del Sprint 1:');
para('  FIX-A: Corregir race condition en WSOrderDetail L276-294 (hook useDoTracking)');
para('  FIX-B: Verificar closure capture en Dashboard.tsx L21-23');
para('Para SOL-1 (useMemo): Crear useCallback para 7 funciones del provider ANTES de envolver value');
para('Para SOL-23 (Split): Extraer custom hooks (useBookingForm, useBuildupDistribution) ANTES de dividir visual');

// ═══ Footer ═══
const totalPages = doc.internal.getNumberOfPages();
for (let i = 1; i <= totalPages; i++) {
  doc.setPage(i);
  doc.setFontSize(5.5);
  doc.setTextColor(150, 150, 150);
  doc.text('MCL WMS — Validacion de No-Regresion  |  2026-05-18  |  Confidencial', W/2, 272, { align: 'center' });
  doc.text('Pagina ' + i + ' / ' + totalPages, W - M, 272, { align: 'right' });
}

const fs = require('fs');
const outPath = 'C:/Users/dgarc/Downloads/MCL_WMS_Regression_Validation.pdf';
fs.writeFileSync(outPath, Buffer.from(doc.output('arraybuffer')));
console.log('PDF generated: ' + outPath);
