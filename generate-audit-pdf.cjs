const { jsPDF } = require('jspdf');
const { applyPlugin } = require('jspdf-autotable');
applyPlugin(jsPDF);

const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
const W = doc.internal.pageSize.getWidth();
const M = 15;
const CW = W - 2*M;
let y = 15;

const BLUE = [30, 58, 95];
const GRAY = [100, 100, 100];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const RED = [200, 50, 50];
const AMBER = [180, 120, 30];

function addPage() { doc.addPage(); y = 15; }
function checkPage(need) { if (y + need > 260) addPage(); }

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

function severity(text) {
  checkPage(8);
  const color = text.includes('CRITICO') ? RED : text.includes('ALTO') ? AMBER : GRAY;
  doc.setFillColor(...color);
  doc.rect(M, y, CW, 6, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(text, M + 3, y + 4.2);
  y += 8;
  doc.setTextColor(...BLACK);
}

function bullet(label, text) {
  checkPage(12);
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...BLUE);
  doc.text('> ' + label, M + 2, y + 3);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  const valLines = doc.splitTextToSize(text, CW - 42);
  doc.text(valLines, M + 42, y + 3);
  y += Math.max(valLines.length * 3.5, 4) + 2;
}

function tbl(headers, rows, colWidths) {
  checkPage(10 + rows.length * 6);
  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [headers],
    body: rows,
    styles: { fontSize: 6.5, cellPadding: 1.5, textColor: [50,50,50] },
    headStyles: { fillColor: BLUE, textColor: WHITE, fontStyle: 'bold', fontSize: 6.5 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    columnStyles: {},
    theme: 'grid',
  });
  y = doc.lastAutoTable.finalY + 5;
}

// ══ COVER ══
doc.setFillColor(...BLUE);
doc.rect(0, 0, W, 90, 'F');
doc.setTextColor(...WHITE);
doc.setFontSize(28);
doc.setFont('helvetica', 'bold');
doc.text('MCL WMS', W/2, 35, { align: 'center' });
doc.setFontSize(14);
doc.text('Performance Audit Report', W/2, 48, { align: 'center' });
doc.setFontSize(9);
doc.setFont('helvetica', 'normal');
doc.text('Fecha: 2026-05-18  |  Senior Performance Engineer Analysis', W/2, 62, { align: 'center' });
doc.text('React 18 + Vite + TypeScript + Tailwind CSS + Firebase Firestore', W/2, 70, { align: 'center' });

doc.setTextColor(...BLACK);
y = 100;
doc.setFontSize(10);
doc.setFont('helvetica', 'bold');
doc.text('Resumen Ejecutivo', M, y); y += 7;

doc.setFontSize(8);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...GRAY);
[
  '38 hallazgos documentados con archivo, linea y solucion propuesta.',
  '12 criticos  |  13 altos  |  13 medios',
  '32 acciones organizadas en un plan de 4 fases.',
  '',
  'Principales hallazgos:',
  '  - Inventory page: 4,100+ Firestore reads por carga (20-40s)',
  '  - AWB search: full scan de todas las bookings en cada busqueda',
  '  - AuthContext sin useMemo: 18 componentes re-renderizan por cualquier cambio',
  '  - Memory leak progresivo en Delivery Orders (blob URLs nunca revocados)',
  '  - Nested onSnapshot listeners: cascadas de reads en 4 paginas principales',
  '  - Generate Sets: 30-60s bloqueando UI en DOs grandes',
  '',
  'Top 5 Quick Wins:',
  '  1. Where clause en DocReceptionNew - elimina 2 full collection scans',
  '  2. useMemo en AuthContext - elimina re-renders en 18 consumers',
  '  3. Revocar blob URLs - previene memory leak progresivo',
  '  4. Debounce en search inputs - es-toolkit ya instalado',
  '  5. Separar nested onSnapshot - elimina cascadas en 4 paginas',
].forEach(l => { doc.text(l, M, y); y += 4; });

// ══ 1. ARQUITECTURA ══
addPage();
title('1. ARQUITECTURA GENERAL');
tbl(
  ['Aspecto', 'Tecnologia', 'Estado'],
  [
    ['Frontend', 'React 18 + Vite + TypeScript + Tailwind CSS', 'OK'],
    ['Base de datos', 'Firebase Firestore', 'Problemas de queries'],
    ['Autenticacion', 'Firebase Auth + AuthContext', 'Necesita optimizacion'],
    ['PDF Generation', 'jsPDF + html2pdf.js + pdf-lib', 'Client-side, bloquea UI'],
    ['State Management', 'Context API (solo AuthContext)', 'Sin memoizacion'],
    ['Cloud Functions', 'No existen', 'Todo client-side'],
    ['Rutas', '71 lazy-loaded routes via React.lazy', 'OK'],
  ],
  [40, 80, 40]
);

// ══ 2. FRONTEND ══
title('2. FRONTEND PERFORMANCE');
severity('CRITICO');
bullet('2.1 AuthContext sin memo', 'AuthContext.tsx L376-389. Value recreado cada render. 23 props, 18 consumers. Fix: useMemo.');
bullet('2.2 Componentes monoliticos', 'BookingNew 3,356 ln/35 useState. Buildup 2,394/25. DeliveryOrder 1,583/20. WSOrderDetail 2,529/30.');
bullet('2.3 Sin virtualizacion', '0 react-window. Tablas 100+ filas completas sin React.memo.');

severity('ALTO');
bullet('2.4 Sin useMemo derivados', 'isAdmin, isClient recalculados cada render. aggregateFlight() 100+ vuelos cada update.');
bullet('2.5 Sin React.memo', '0 de 93 componentes. useMemo ~18 usos. useCallback ~18 usos.');
bullet('2.6 tesseract.js top-level', 'BarcodeScannerModal.tsx L2: ~3MB WASM. Fix: dynamic import().');
bullet('2.7 firebase-admin', 'package.json L34: server SDK en browser. Remover.');
bullet('2.8 @zxing sin usar', '~500KB instalado, no importado. Verificar y remover.');

severity('MEDIO');
bullet('2.9 Stale closure', 'AuthContext L346-373: signOut capturado del primer render.');
bullet('2.10 Chunks incompletos', 'xlsx en 11 chunks. exceljs+xlsx redundantes. 5 PDF libs sin chunk.');
bullet('2.11 Watermark 60 spans', 'Layout.tsx L86-99: sin memo. Fix: useMemo([watermarkEmail]).');
bullet('2.12 getUldPieces render', 'Buildup.tsx L340-357: itera allPieces por ULD card. Fix: pre-compute map.');
bullet('2.13-15 Misc', 'noUnusedLocals false. eslint-disable deps oculta bugs. logo.png 43KB->5KB.');

// ══ 3. FIRESTORE ══
addPage();
title('3. FIRESTORE - DATABASE PERFORMANCE');
severity('CRITICO');
bullet('3.1 N+1 Inventory', 'Inventory.tsx L103-171: 1000 WRs x 2-3 subcollection reads = 4,100+ reads. 20-40s.');
bullet('3.2 N+1 Billing', 'WSBillingCharges.tsx L241-278: O(n2) getDoc loops. 5,000+ ops.');
bullet('3.3 N+1 Buildup', 'Buildup.tsx L299-303: for loop getDocs per reception. Fix: in operator.');
bullet('3.4 Full scan tracking', 'WSDeliveryOrders.tsx L36: sin where/limit. Fix: filtros fecha.');
bullet('3.5 DO 5 queries', 'deliveryOrder.ts L120-150: 5 queries por 1 DO. Fix: redisenar keys.');

severity('ALTO');
bullet('3.6 Full scans (7)', 'DocReceptionNew L236/L219: ALL bookings+receptions por busqueda. BillingCharges L136. DeliveryOrder L822. KpiDashboard L116-118: 3 colecciones.');
bullet('3.7 Limits altos', 'Holds 2000, Inventory 1000, BillingCharges 5 colecciones 1000-2000. Sin paginacion.');
bullet('3.8 Listeners sin filtro', 'BookingList L282: all bookings. WSDashboard L48-58: all orders sin client_id (riesgo seguridad).');
bullet('3.9 N+1 writes', 'airBilling.ts L279: addDoc loop. billing.ts L191: mismo. Fix: writeBatch.');
bullet('3.10 loadClient x150', 'airBilling.ts L514: 150 getDoc mismo cliente por vuelo. Fix: memoizar.');
bullet('3.11 Indices faltantes', '11+ indices compuestos: rate_schedule, bookings, charges, billing, holds.');
bullet('3.12 Rules get()', 'firestore.rules: 4-5 reads extra por write. Fix: custom claims JWT.');

severity('MEDIO');
bullet('3.13 Rate re-fetch', 'airBilling.ts/wsBilling.ts: sin cache. 3x por accion SO.');
bullet('3.14 Feedback loop', 'WSOrderDetail.tsx L242-256: onSnapshot -> updateDoc -> snapshot.');
bullet('3.15-16 Misc', 'Sin archival (colecciones crecen). Datos huerfanos al borrar WR.');

// ══ 4. API/UX ══
title('4. API CALLS & UX PERFORMANCE');
severity('CRITICO');
bullet('4.1 Sin Cloud Functions', 'Todo client-side: agregaciones, billing, PDFs, search.');
bullet('4.2 Print crash', 'Gretel: multiples window.open crashean PC. Fix: singleton pattern.');

severity('ALTO');
bullet('4.3 PDF bloquea UI', 'buildupPdf.ts 400+ lineas sincronas. 2-5s freeze. Fix: Web Worker.');
bullet('4.4 Sin debounce', 'Dashboard, DocReceptionList, DeliveryOrders. es-toolkit instalado no usado.');

severity('MEDIO');
bullet('4.5-4.6', 'Sin skeleton screens. Sin cache de referencia (clientes, destinos, rates).');

// ══ 5. BUGS ADICIONALES ══
addPage();
title('5. BUGS DE PERFORMANCE ADICIONALES');
severity('CRITICO');
bullet('8.1 Memory leak blobs', 'DeliveryOrder.tsx L598: URLs nunca revocados. 15 blobs/click. Crash progresivo.');
bullet('8.2 Nested listener leak', 'Screening.tsx L126-165: inner listener re-created. Leak on unmount.');

severity('ALTO');
bullet('8.3 Add AWB 4 scans', 'DeliveryOrder.tsx L811: 4 getDocs CADA apertura modal. Sin cache.');
bullet('8.4 Generate Sets 60s', 'DeliveryOrder.tsx L600: for...of secuencial. 5 MAWB = 30-60s.');
bullet('8.5 Sin ErrorBoundary', 'App.tsx: render error = pantalla blanca. 0 boundaries.');
bullet('8.6 Barcode sincrono', 'printLabels.ts L43: 100 piezas = 100 SVG main thread.');

severity('MEDIO');
bullet('8.7 window.print bug', 'BookingNew.tsx L2233: listener en parent window. Print no fires.');
bullet('8.8-8.10 Misc', 'CDN JsBarcode ya bundled. PDF upload sin mutex. Supabase sin usar.');

// ══ 6. RESUMEN ══
addPage();
title('6. RESUMEN POR PRIORIDAD');

subtitle('CRITICO (Accion Inmediata) - 12 issues');
tbl(
  ['#', 'Issue', 'Impacto', 'Esfuerzo'],
  [
    ['1', 'N+1 Inventory (4,100+ reads)', '20-40s', 'Alto'],
    ['2', 'N+1 Billing Recalculation (5,000+ ops)', 'UI min', 'Alto'],
    ['3', 'Full scan bookings AWB search', 'Todas/busqueda', 'Bajo'],
    ['4', 'Full scan receptions duplicados', 'Todas/busqueda', 'Bajo'],
    ['5', 'Full scan bookings BillingCharges', 'Miles docs', 'Medio'],
    ['6', '3 full scans WSKpiDashboard', '3 colecciones', 'Medio'],
    ['7', 'AuthContext sin memoizar', 'Re-renders', 'Bajo'],
    ['8', 'Memory leak blob URLs', 'Crash tab', 'Bajo'],
    ['9', 'Nested onSnapshot (4 paginas)', 'Reads+flicker', 'Medio'],
    ['10', 'N+1 Buildup sequential', '6+ calls', 'Medio'],
    ['11', 'Full scan tracking+DOs+queue', 'Col. completas', 'Bajo'],
    ['12', 'Ventanas multiples print', 'Crash PC', 'Medio'],
  ],
  [6, 65, 30, 18]
);

subtitle('ALTO (Programar Pronto) - 13 issues');
tbl(
  ['#', 'Issue', 'Impacto', 'Esfuerzo'],
  [
    ['13', 'Sin debounce search inputs', 'Queries extra', 'Bajo'],
    ['14', 'Generate Sets 30-60s secuencial', 'UI congelada', 'Medio'],
    ['15', 'Add AWB 4 full scans sin cache', 'Delay', 'Bajo'],
    ['16', 'Sin ErrorBoundary', 'Crash app', 'Bajo'],
    ['17', 'tesseract.js 3MB top-level', 'Bundle', 'Bajo'],
    ['18', 'loadClient sin cache 150+ getDoc', 'Reads', 'Bajo'],
    ['19', 'Limits 2000-3000 sin paginacion', 'Carga lenta', 'Medio'],
    ['20', 'Listeners sin filtro client_id', 'Seguridad', 'Medio'],
    ['21', 'PDF bloquea UI thread', 'Freeze 2-5s', 'Alto'],
    ['22', '11+ indices faltantes', 'Queries lentas', 'Bajo'],
    ['23', 'Componentes 3,356 lineas', 'Re-renders', 'Alto'],
    ['24', 'Writes addDoc loops', 'Round-trips', 'Bajo'],
    ['25', 'Barcode SVG sincrono', 'UI freeze', 'Medio'],
  ],
  [6, 65, 30, 18]
);

subtitle('MEDIO (Optimizar) - 13 issues');
tbl(
  ['#', 'Issue', 'Impacto', 'Esfuerzo'],
  [
    ['26', 'Sin virtualizacion listas', 'DOM bloat', 'Medio'],
    ['27', 'Sin React.memo 93 componentes', 'Re-renders', 'Medio'],
    ['28', 'Sin cache referencia', 'Re-fetch', 'Medio'],
    ['29', 'Sin Cloud Functions', 'Client-side', 'Alto'],
    ['30', 'Chunks + xlsx duplicado', 'Bundle', 'Bajo'],
    ['31', 'window.print() bug', 'No fires', 'Bajo'],
    ['32-38', 'CDN barcode, watermark, rates, loop, rules, deps, logo', 'Varios', 'Bajo'],
  ],
  [6, 65, 30, 18]
);

// ══ 7. PLAN ══
addPage();
title('7. PLAN DE ACCION RECOMENDADO');

subtitle('Fase 1: Quick Wins (1-2 dias) - 10 items');
tbl(['#', 'Accion', 'Ref'], [
  ['1', 'useMemo en AuthContext value', '#7'],
  ['2', 'Debounce en search inputs con es-toolkit', '#13'],
  ['3', 'Where/limit en ws_delivery_tracking, driver_queue, delivery_orders', '#11'],
  ['4', 'Singleton window.open para impresion', '#12'],
  ['5', 'Revocar blob URLs en Generate Sets + cleanup on unmount', '#8'],
  ['6', 'ErrorBoundary a nivel de rutas', '#16'],
  ['7', 'Fix window.print() en BookingNew popup', '#31'],
  ['8', 'Where clause en DocReceptionNew AWB search', '#3,4'],
  ['9', 'Cache resultados Add AWB modal entre aperturas', '#15'],
  ['10', 'Memoizar loadClient por clientId en billing loops', '#18'],
], [6, 100, 18]);

subtitle('Fase 2: Query Optimization (3-5 dias) - 8 items');
tbl(['#', 'Accion', 'Ref'], [
  ['11', 'Refactorizar Inventory.tsx: denormalizar, eliminar N+1', '#1'],
  ['12', 'Refactorizar Buildup N+1: Promise.all o operador in', '#10'],
  ['13', 'Where clauses en BillingCharges, KpiDashboard, BillingSummary', '#5,6'],
  ['14', 'Separar nested onSnapshot en listeners independientes', '#9'],
  ['15', 'Agregar 11+ indices compuestos en Firebase Console', '#22'],
  ['16', 'Convertir addDoc loops a writeBatch', '#24'],
  ['17', 'Agregar client_id filter en WSDashboard onSnapshot', '#20'],
  ['18', 'Paginacion real en tablas con 1000+ registros', '#19'],
], [6, 100, 18]);

subtitle('Fase 3: Architecture (1-2 semanas) - 8 items');
tbl(['#', 'Accion', 'Ref'], [
  ['19', 'Cloud Functions para billing recalculation y KPI aggregation', '#29,2'],
  ['20', 'PDF generation en Web Worker o Cloud Function', '#21'],
  ['21', 'Dynamic import tesseract.js', '#17'],
  ['22', 'Cache layer para datos de referencia', '#28,34'],
  ['23', 'Dividir componentes monoliticos', '#23'],
  ['24', 'react-window para virtualizacion de tablas', '#26'],
  ['25', 'Optimizar Vite manualChunks: xlsx, recharts, jspdf, html2pdf', '#30'],
  ['26', 'Paralelizar Generate Sets con Promise.all', '#14'],
], [6, 100, 18]);

subtitle('Fase 4: Polish (continuo) - 6 items');
tbl(['#', 'Accion', 'Ref'], [
  ['27', 'React.memo en componentes hijo y filas de tabla', '#27'],
  ['28', 'Custom claims Firebase Auth para eliminar get() en rules', '#36'],
  ['29', 'Remover firebase-admin, @zxing, exceljs si no se usan', '#37'],
  ['30', 'Skeleton screens', '-'],
  ['31', 'Estrategia de archival para datos historicos', '-'],
  ['32', 'Optimizar logo.png a WebP', '#38'],
], [6, 100, 18]);

// ══ 8. METRICAS ══
checkPage(40);
title('8. METRICAS A MONITOREAR');
tbl(
  ['Metrica', 'Valor Actual', 'Target'],
  [
    ['Firestore reads/dia', '50,000-100,000+', '< 15,000'],
    ['Inventory page load', '20-40s', '< 3s'],
    ['Dashboard initial load', '5-10s', '< 2s'],
    ['AWB search (DocReception)', '3-10s (full scan)', '< 500ms'],
    ['Generate Sets (5 AWB MAWB)', '30-60s', '< 5s'],
    ['PDF generation time', '2-5s (bloquea UI)', '< 1s (async)'],
    ['Auth context re-renders', '18 consumers x N', 'Solo afectados'],
    ['Bundle size (main)', 'Sin medicion', '< 500KB gzip'],
    ['Memory (DO 1hr uso)', 'Crece sin limite', 'Estable'],
  ],
  [45, 50, 40]
);

// Footer
const totalPages = doc.internal.getNumberOfPages();
for (let i = 1; i <= totalPages; i++) {
  doc.setPage(i);
  doc.setFontSize(6);
  doc.setTextColor(150, 150, 150);
  doc.text('MCL WMS Performance Audit  |  2026-05-18  |  Confidencial', W/2, 272, { align: 'center' });
  doc.text('Pagina ' + i + ' / ' + totalPages, W - M, 272, { align: 'right' });
}

const fs = require('fs');
fs.writeFileSync('C:/Users/dgarc/Downloads/MCL_WMS_Performance_Audit.pdf', Buffer.from(doc.output('arraybuffer')));
console.log('PDF generated successfully: C:/Users/dgarc/Downloads/MCL_WMS_Performance_Audit.pdf');
