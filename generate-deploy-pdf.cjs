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

function band(text, color) {
  checkPage(8);
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
  const vl = doc.splitTextToSize(text, CW - 38);
  doc.text(vl, M + 38, y + 3);
  y += Math.max(vl.length * 3.2, 4) + 2;
}

function tbl(headers, rows) {
  checkPage(10 + rows.length * 5);
  doc.autoTable({
    startY: y, margin: { left: M, right: M }, head: [headers], body: rows,
    styles: { fontSize: 6, cellPadding: 1.2, textColor: [50,50,50], overflow: 'linebreak' },
    headStyles: { fillColor: BLUE, textColor: WHITE, fontStyle: 'bold', fontSize: 6 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    theme: 'grid',
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
doc.text('Plan de Despliegue Seguro', W/2, 44, { align: 'center' });
doc.setFontSize(10);
doc.text('Blue/Green & Canary Release Strategy', W/2, 56, { align: 'center' });
doc.setFontSize(8);
doc.setFont('helvetica', 'normal');
doc.text('2026-05-18  |  Arquitecto de Despliegue + SRE Specialist', W/2, 70, { align: 'center' });
doc.text('Alcance: 10 puntos criticos del Performance Audit', W/2, 78, { align: 'center' });

doc.setTextColor(...BLACK);
y = 100;
doc.setFontSize(7.5);
doc.setFont('helvetica', 'normal');
doc.setTextColor(...GRAY);
[
  'Contexto: Firebase Hosting (SPA) + Firestore + Auth. Sin K8s ni load balancer.',
  'Adaptaciones: Firebase Preview Channels (canary), Feature Flags en Firestore,',
  '  firebase hosting:rollback (blue/green), Firebase multiple sites.',
  '',
  '10 puntos criticos identificados:',
  '  6 cambios ALTO riesgo — canary con feature flag o deploy incremental',
  '  2 cambios MUY ALTO riesgo — blue/green con sitio separado',
  '  2 cambios ALTO riesgo — canary por componente/modulo',
  '',
  'Estrategia global:',
  '  - 1 cambio critico por semana maximo',
  '  - Feature flags para cambios que tocan datos',
  '  - Comparacion de montos billing pre/post (< $0.01 tolerancia)',
  '  - Rollback en < 5 minutos para cualquier deploy',
  '  - Monitoreo 2 horas post-deploy obligatorio',
].forEach(l => { doc.text(l, M, y); y += 3.8; });

// ═══ 1. PUNTOS CRITICOS ═══
addPage();
title('1. PUNTOS CRITICOS IDENTIFICADOS');

tbl(
  ['#', 'ID', 'Solucion', 'Riesgo', 'Estrategia', 'Modulos que puede romper'],
  [
    ['1', 'SOL-8', 'Where en AWB search', 'ALTO', 'CANARY + Flag', 'Doc Reception, Flight Assignment'],
    ['2', 'SOL-11', 'Inventory N+1', 'ALTO', 'CANARY + Flag', 'Inventory, Billing, Dispatch (8 mod)'],
    ['3', 'SOL-14', 'Separar nested listeners', 'ALTO', 'CANARY x componente', 'Dashboard, Screening, BookingList'],
    ['4', 'SOL-18', 'Paginacion tablas', 'ALTO', 'CANARY + Flag', 'Inventory, Holds, Billing'],
    ['5', 'SOL-19', 'Cloud Functions billing', 'MUY ALTO', 'BLUE/GREEN', 'Billing, KPI, Invoicing'],
    ['6', 'SOL-28', 'Custom claims Auth', 'MUY ALTO', 'BLUE/GREEN', 'Security Rules, TODOS'],
    ['7', 'SOL-1', 'useMemo AuthContext', 'ALTO*', 'CANARY manual', 'TODOS (71 consumers)'],
    ['8', 'SOL-16', 'writeBatch billing', 'ALTO', 'CANARY x modulo', 'Air/WS Billing, PhysRec'],
    ['9', 'SOL-23', 'Dividir componentes', 'ALTO', 'CANARY x comp.', 'BookingNew, Buildup, WSOrderDetail'],
    ['10', 'SOL-31', 'Archival historicos', 'ALTO', 'BLUE/GREEN', 'Billing, Tracking, Delivery'],
  ]
);

// ═══ 2. ESTRATEGIAS DETALLADAS ═══
title('2. ESTRATEGIAS POR PUNTO CRITICO');

band('PC-1: AWB Search — CANARY con Feature Flag', AMBER);
bullet('Flag:', 'config/feature_flags.awb_search_v2 = false');
bullet('Dia 1:', 'Deploy con flag OFF (ambas paths en codigo)');
bullet('Dia 2:', 'Flag ON solo MCL staff (5-8 usuarios)');
bullet('Dia 3-5:', 'Monitorear busquedas exitosas vs fallidas');
bullet('Dia 6:', 'Flag ON para agentes (10-15 usuarios)');
bullet('Dia 8-10:', 'Flag ON para todos (clientes incluidos)');
bullet('Dia 15:', 'Remover flag y codigo viejo');
bullet('Rollback:', 'Flag OFF en Firestore — efecto inmediato sin deploy');
bullet('Alarma:', 'Tasa "AWB no encontrado" sube > 2% sobre baseline');

band('PC-5: Cloud Functions Billing — BLUE/GREEN', RED);
bullet('Blue:', 'wms-mcl.web.app — version actual, billing client-side');
bullet('Green:', 'wms-mcl-green.web.app — version con CF');
bullet('Semana 1:', 'Green solo para admin billing (1-2 personas)');
bullet('Semana 2:', 'Comparar charges Blue vs Green para mismos vuelos');
bullet('Semana 3:', 'Si montos identicos, migrar billing a Green');
bullet('Proteccion:', 'CF escribe source: "cloud_function" vs "client" para comparar');
bullet('Rollback:', 'Redirect a Blue. Borrar charges con source=cloud_function');
bullet('Criterio exito:', '100% charges CF = client-side (dif < $0.01)');

addPage();
band('PC-6: Custom Claims Auth — BLUE/GREEN Progresivo', [139,0,0]);
bullet('Fase 0 (1 sem):', 'Backend setea claims en cada login SIN cambiar rules');
bullet('Fase 1 (1 sem):', 'Script: asignar claims a todos los usuarios activos');
bullet('Fase 2 (1 dia):', 'Deploy rules HIBRIDAS (aceptan get() Y claims)');
bullet('Fase 3 (1 sem):', 'Monitorear permission-denied errors');
bullet('Fase 4 (1 dia):', 'Deploy rules SOLO claims. Remover get()');
bullet('Rollback:', 'Deploy rules viejas (solo get()) — efecto < 1 minuto');
bullet('ALARMA ROJA:', 'CUALQUIER usuario pierde acceso o ve datos de otro');

band('PC-7: useMemo AuthContext — CANARY Manual', AMBER);
bullet('Pre-req 1:', 'Deploy useCallback en 7 funciones (sin useMemo aun)');
bullet('Pre-req 2:', 'Mover flags derivados DENTRO del useMemo');
bullet('Deploy:', 'useMemo completo — validacion intensiva 2 horas');
bullet('Tests:', 'Login/logout, cambio rol, nav modulos, auto-logout, ModuleSelector redirect');
bullet('Rollback:', 'git revert + deploy (< 5 min)');

band('PC-8: writeBatch Billing — CANARY por Modulo', AMBER);
bullet('Deploy 1:', 'Solo airBilling.ts L280-282 → verificar 3 vuelos');
bullet('Deploy 2:', 'Solo billing.ts L191-203 → verificar 5 WRs');
bullet('Deploy 3:', 'billing.ts L433-457 (dispatch charges)');
bullet('Deploy 4:', 'WSBillingCharges.tsx L304/334');
bullet('Validacion:', 'Comparar montos totales pre/post para mismos registros');
bullet('Rollback:', 'git revert del commit de billing especifico');

// ═══ 3. VALIDACIONES PRE-DEPLOY ═══
addPage();
title('3. VALIDACIONES OBLIGATORIAS PRE-DEPLOY');

tbl(
  ['#', 'Validacion', 'Herramienta', 'Aplica a'],
  [
    ['V1', 'Build exitoso sin warnings', 'npm run build', 'Todos'],
    ['V2', '0 errores TypeScript', 'tsc --noEmit', 'Todos'],
    ['V3', 'Flujo airfreight E2E completo', 'Test manual', 'PC-1,3,7,8,9'],
    ['V4', 'Flujo seafreight E2E completo', 'Test manual', 'PC-2,4,8'],
    ['V5', 'Flujo WS E2E completo', 'Test manual', 'PC-7,8,9'],
    ['V6', 'Login admin + login cliente', 'Test manual', 'PC-6,7'],
    ['V7', 'Billing recalculate + invoice', 'Test manual', 'PC-5,8'],
    ['V8', 'Comparar montos billing (dif < $0.01)', 'Script', 'PC-5,8'],
    ['V9', 'Dashboard real-time update', 'Test manual', 'PC-3,7'],
    ['V10', 'AWB search todos formatos', 'Test manual', 'PC-1'],
    ['V11', 'Firestore reads baseline', 'Firebase Console', 'PC-1,2,3,4'],
    ['V12', 'Memory baseline', 'Chrome Task Manager', 'PC-3,7'],
  ]
);

subtitle('Validaciones especificas por punto');
para('PC-1 (AWB): Buscar AWB simple (045-21859633), AWB ecommerce en awb_lines, AWB 1st leg MAWB, AWB con y sin guion, AWB inexistente.');
para('PC-5 (CF): Generar charges vuelo 1 cliente/5 bookings, vuelo 3 clientes/20 bookings. Invoice: verificar PDF + montos. Recalculate = montos identicos.');
para('PC-6 (Claims): Admin lee/escribe todo. Cliente solo sus datos. Viewer read-only su client_id. Vendor admin solo su vendor_id. Sin claims = rechazado.');

// ═══ 4. CRITERIOS EXITO / ROLLBACK ═══
title('4. CRITERIOS DE EXITO Y ROLLBACK');

subtitle('Metricas globales');
tbl(
  ['Metrica', 'Actual', 'Target', 'Rollback si'],
  [
    ['Page load Inventory', '20-40s', '< 5s', '> 45s'],
    ['AWB search', '3-10s', '< 500ms', '> 15s'],
    ['Billing montos', 'Correctos', 'Identicos', 'Dif > $0.01'],
    ['Firestore reads/dia', '50K-100K', '< 25K', '> 120K'],
    ['Console errors/hora', 'Baseline', '<= Baseline', '> 150% baseline'],
    ['Memory 1hr', 'Crece', 'Estable', 'N/A'],
  ]
);

subtitle('Rollback INMEDIATO si:');
para('1. Cualquier usuario pierde acceso a datos que antes podia ver');
para('2. Cualquier calculo de billing produce monto diferente al esperado');
para('3. Cualquier booking/recepcion/DO no se puede crear o editar');
para('4. Firestore permission-denied error nuevo en console');
para('5. Pantalla blanca (crash de app) en cualquier ruta');
para('6. Dashboard no muestra datos real-time despues de 30 segundos');
para('7. Mas de 2 usuarios reportan problemas en la primera hora');

subtitle('AVANZAR al siguiente % de trafico si:');
para('1. 0 reportes de problemas en 24 horas');
para('2. Metricas de performance iguales o mejores');
para('3. 0 errores nuevos en console');
para('4. Todos los flujos E2E validados');

// ═══ 5. PLAN DE ROLLBACK ═══
addPage();
title('5. PLAN DE ROLLBACK SEGURO');

tbl(
  ['Tipo de cambio', 'Metodo rollback', 'Tiempo', 'Impacto en datos'],
  [
    ['Frontend (React)', 'git revert + deploy O firebase hosting:rollback', '< 5 min', 'Zero — Firestore intacto'],
    ['Feature flags', 'Setear flag=false en Firestore', '< 30 seg', 'Zero — path vieja se ejecuta'],
    ['Firestore indices', 'Borrar indice en Console', '5-30 min', 'Zero — queries sin indice no afectados'],
    ['Security rules', 'firebase deploy --only firestore:rules (rules viejas)', '< 2 min', 'Inmediato en todas las requests'],
    ['Cloud Functions', 'firebase deploy --only functions (codigo viejo)', '< 5 min', 'Requests en vuelo fallan ~30s'],
    ['writeBatch', 'git revert + deploy', '< 5 min', 'Batch fail = 0 escrituras (atomico)'],
  ]
);

subtitle('Operaciones en curso durante rollback');
tbl(
  ['Operacion en curso', 'Seguro?', 'Precaucion'],
  [
    ['Booking siendo creado', 'SI', 'Formulario en memoria, guarda via Firestore API'],
    ['Recepcion fisica activa', 'SI', 'Piezas ya en Firestore no se pierden'],
    ['ULD Build-up en progreso', 'SI', 'Piezas asignadas en Firestore'],
    ['Billing recalculate', 'CUIDADO', 'writeBatch puede fallar atomicamente. Re-ejecutar.'],
    ['Invoice generando', 'CUIDADO', 'Verificar estado invoice post-rollback'],
    ['Driver en ruta', 'SI', 'Tracking data independiente del frontend'],
  ]
);

subtitle('Consistencia de datos post-rollback');
para('Firestore es la fuente de verdad. El frontend es stateless (SPA). Al rollback: browser carga codigo viejo, datos en Firestore NO cambian.');
para('Excepcion: Cloud Functions que escribieron con estructura nueva. Mitigacion: CF escribe en campos ADICIONALES durante canary (no reemplaza). Codigo viejo ignora campos nuevos.');

// ═══ 6. CALENDARIO ═══
addPage();
title('6. CALENDARIO DE DESPLIEGUE');

tbl(
  ['Semana', 'Dia', 'Accion', 'Riesgo'],
  [
    ['1', 'Lun', 'Fix race condition WSOrderDetail L276-294', 'Pre-req'],
    ['1', 'Mar', 'useCallback en 7 funciones AuthContext', 'Pre-req'],
    ['1', 'Mie', 'Crear 11 indices compuestos Firebase Console', 'Seguro'],
    ['1', 'Jue', 'Deploy SOL-1 useMemo AuthContext + validacion', 'ALTO'],
    ['1', 'Vie', 'Deploy seguros: ErrorBoundary, blob URLs, debounce', 'Bajo'],
    ['2', 'Lun', 'writeBatch airBilling + verificar 3 vuelos', 'Medio'],
    ['2', 'Mar', 'writeBatch billing.ts + verificar 5 WRs', 'Medio'],
    ['2', 'Mie', 'Feature flag AWB search v2 ON admins', 'ALTO'],
    ['2', 'Jue', 'Buildup Promise.all + verificar distribucion', 'Medio'],
    ['2', 'Vie', 'Review semanal: metricas, errores, feedback', '—'],
    ['3', 'Lun', 'Separar BookingList listener', 'Alto'],
    ['3', 'Mar', 'client_id filter WSDashboard', 'Medio'],
    ['3', 'Mie', 'AWB search v2 ON agentes (escalar canary)', 'ALTO'],
    ['3', 'Jue', 'Paralelizar Generate Sets', 'Medio'],
    ['3', 'Vie', 'Review semanal', '—'],
    ['4', 'Lun', 'Separar Transportation listener', 'Alto'],
    ['4', 'Mar', 'AWB search v2 ON todos (canary completo)', 'ALTO'],
    ['4', 'Mie', 'Cache layer referencia', 'Medio'],
    ['4', 'Jue', 'Extraer useBookingForm hook', 'Alto'],
    ['4', 'Vie', 'Review mensual + decision CF/Claims', '—'],
    ['5-8', '—', 'Paginacion, Dashboard listener, hooks Buildup/WSOrder', 'Alto'],
    ['9+', '—', 'Cloud Functions (blue/green), Custom Claims, Archival', 'MUY ALTO'],
  ]
);

// ═══ 7. REGLAS DE ORO ═══
title('7. REGLAS DE ORO PARA DESPLIEGUE SEGURO');

para('1. UN CAMBIO CRITICO POR SEMANA. Nunca 2 puntos criticos el mismo dia.');
para('2. FEATURE FLAGS para todo lo que toca datos. Deploy directo solo para UI/render.');
para('3. BILLING ES SAGRADO. Comparar montos pre/post. Dif > $0.01 = rollback.');
para('4. MAWB ES INTOCABLE. No modificar flujo MAWB sin autorizacion explicita.');
para('5. DEPLOY 7-8 AM. Nunca despues de 2 PM. NUNCA viernes.');
para('6. ROLLBACK LISTO ANTES DE DEPLOY. Comando escrito y copiado.');
para('7. MONITOREAR 2 HORAS POST-DEPLOY. No cerrar terminal ni Console.');
para('8. DOCUMENTAR CADA DEPLOY. Fecha, hora, cambio, metricas pre/post.');
para('9. COMUNICAR AL EQUIPO. Avisar warehouse antes/despues del deploy.');
para('10. SI HAY DUDA, NO DESPLEGAR. Mejor un dia mas de testing que un rollback de emergencia.');

// Footer
const totalPages = doc.internal.getNumberOfPages();
for (let i = 1; i <= totalPages; i++) {
  doc.setPage(i);
  doc.setFontSize(5.5);
  doc.setTextColor(150, 150, 150);
  doc.text('MCL WMS — Plan de Despliegue Seguro  |  2026-05-18  |  Confidencial', W/2, 272, { align: 'center' });
  doc.text('Pagina ' + i + ' / ' + totalPages, W - M, 272, { align: 'right' });
}

const fs = require('fs');
const out = 'C:/Users/dgarc/Downloads/MCL_WMS_Deployment_Plan.pdf';
fs.writeFileSync(out, Buffer.from(doc.output('arraybuffer')));
console.log('PDF generated: ' + out);
