/**
 * Generador de Simulador de Estiba PAG MD 767F
 * Genera un Excel interactivo para simular carga en posición PAG del main deck de un 767F
 *
 * Ejecutar: npx tsx src/tools/generateStowageSimulator.ts
 */

import ExcelJS from "exceljs";
import path from "path";

// ── Contour definition ──
const CONTOUR_BASE_WIDTH = 88; // inches
const CONTOUR_DEPTH = 125; // inches

// Perfil asimétrico: lado izquierdo (x=0) es pared plana (altura completa),
// lado derecho (x=88) es el borde curvo del fuselaje que baja escalonado.
// Las zonas se miden desde el borde curvo (derecho) hacia adentro.
const CONTOUR_ZONES = [
  { from: 0, to: 5, maxHeight: 43 },     // 0-5" desde borde curvo (x=83-88)
  { from: 5, to: 12.5, maxHeight: 62 },   // 5-12.5" desde borde curvo (x=75.5-83)
  { from: 12.5, to: 21.5, maxHeight: 83 }, // 12.5-21.5" desde borde curvo (x=66.5-75.5)
  { from: 21.5, to: 88, maxHeight: 98 },   // 21.5"+ desde borde curvo (x=0-66.5) — pared plana
];

// Piezas default
const DEFAULT_PIECES = [
  { id: 1, name: "Skid Alto", largo: 48, ancho: 40, alto: 36, peso: 225 },
  { id: 2, name: "Skid Medio", largo: 48, ancho: 40, alto: 24, peso: 160 },
  { id: 3, name: "Skid Bajo", largo: 48, ancho: 18, alto: 18, peso: 115 },
  { id: 4, name: "Caja A", largo: 24, ancho: 20, alto: 18, peso: 23 },
  { id: 5, name: "Caja B", largo: 20, ancho: 16, alto: 14, peso: 16 },
  { id: 6, name: "Caja C", largo: 16, ancho: 12, alto: 12, peso: 9 },
  { id: 7, name: "Bolsa", largo: 36, ancho: 32, alto: 12, peso: 11 },
  { id: 8, name: "(Vacío)", largo: 0, ancho: 0, alto: 0, peso: 0 },
];

// ── Styles ──
const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E79" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 11,
};
const SUBHEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD6E4F0" },
};
const CONTOUR_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE0E0E0" },
};
const OK_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFC6EFCE" },
};
const EXCEED_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFC7CE" },
};
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

// Colores para tipos de pieza en la visualización
const PIECE_COLORS = [
  "FF4472C4", // azul
  "FFED7D31", // naranja
  "FFA5A5A5", // gris
  "FFFFC000", // amarillo
  "FF5B9BD5", // celeste
  "FF70AD47", // verde
  "FF7030A0", // violeta
  "FFFF6699", // rosa
];

// Obtiene la altura máxima en una posición X (0=pared plana izq, 88=borde curvo der)
function getMaxHeightAtX(xPosition: number): number {
  // Distancia desde el borde curvo (derecho)
  const distFromCurvedEdge = CONTOUR_BASE_WIDTH - xPosition;
  for (const zone of CONTOUR_ZONES) {
    if (distFromCurvedEdge >= zone.from && distFromCurvedEdge <= zone.to) {
      return zone.maxHeight;
    }
  }
  return 0;
}

function getMaxHeightForColumn(
  colStart: number,
  colWidth: number,
  _baseWidth: number
): number {
  // La altura máx está limitada por el borde más cercano al lado curvo (derecho)
  const rightEdge = colStart + colWidth;
  return getMaxHeightAtX(rightEdge);
}

// Calcula el volumen total del contour
function computeContourVolume(): number {
  let area = 0;
  for (let x = 0; x < CONTOUR_BASE_WIDTH; x++) {
    const h = getMaxHeightAtX(x + 0.5);
    area += h;
  }
  return area * CONTOUR_DEPTH;
}

async function generate() {
  const wb = new ExcelJS.Workbook();

  // ════════════════════════════════════════════
  // SHEET 1: Piezas
  // ════════════════════════════════════════════
  const wsPiezas = wb.addWorksheet("Piezas", { tabColor: { argb: "FF4472C4" } });

  // Title
  wsPiezas.mergeCells("A1:F1");
  const titleCell = wsPiezas.getCell("A1");
  titleCell.value = "Configuración de Piezas — PAG MD 767F";
  titleCell.font = { bold: true, size: 14, color: { argb: "FF1F4E79" } };
  titleCell.alignment = { horizontal: "center" };

  wsPiezas.mergeCells("A2:F2");
  wsPiezas.getCell("A2").value = "Modifique las dimensiones y pesos según sus empaques reales";
  wsPiezas.getCell("A2").font = { italic: true, size: 10, color: { argb: "FF808080" } };
  wsPiezas.getCell("A2").alignment = { horizontal: "center" };

  // Headers row 4
  const pzHeaders = ["#", "Nombre", "Largo (in)", "Ancho (in)", "Alto (in)", "Peso (kg)"];
  const pzHeaderRow = wsPiezas.getRow(4);
  pzHeaders.forEach((h, i) => {
    const cell = pzHeaderRow.getCell(i + 1);
    cell.value = h;
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: "center" };
    cell.border = THIN_BORDER;
  });

  // Data rows 5-12
  DEFAULT_PIECES.forEach((p, idx) => {
    const row = wsPiezas.getRow(5 + idx);
    [p.id, p.name, p.largo, p.ancho, p.alto, p.peso].forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = v;
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: "center" };
    });
    // Color indicator
    row.getCell(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: PIECE_COLORS[idx] },
    };
    row.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  // Column widths
  wsPiezas.getColumn(1).width = 6;
  wsPiezas.getColumn(2).width = 16;
  wsPiezas.getColumn(3).width = 14;
  wsPiezas.getColumn(4).width = 14;
  wsPiezas.getColumn(5).width = 14;
  wsPiezas.getColumn(6).width = 14;

  // Named range for piece names (for dropdowns)
  // Piece data is in Piezas!B5:B12
  // We'll reference these in data validations

  // ════════════════════════════════════════════
  // SHEET 2: Contour
  // ════════════════════════════════════════════
  const wsContour = wb.addWorksheet("Contour", { tabColor: { argb: "FF808080" } });

  // Title
  wsContour.mergeCells("A1:J1");
  wsContour.getCell("A1").value = "Perfil del Contour — PAG MD 767F";
  wsContour.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF1F4E79" } };

  // Contour table
  wsContour.mergeCells("A3:D3");
  wsContour.getCell("A3").value = "Perfil de Alturas";
  wsContour.getCell("A3").font = { bold: true, size: 12 };

  const contourHeaders = ["Zona", "Desde Borde Curvo (in)", "Hasta (in)", "Altura Máx (in)"];
  const chRow = wsContour.getRow(4);
  contourHeaders.forEach((h, i) => {
    const cell = chRow.getCell(i + 1);
    cell.value = h;
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: "center" };
    cell.border = THIN_BORDER;
  });

  const zoneNames = ["Borde Curvo", "Zona 3", "Zona 2", "Pared Plana"];
  CONTOUR_ZONES.forEach((z, i) => {
    const row = wsContour.getRow(5 + i);
    [zoneNames[i], z.from, z.to, z.maxHeight].forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = v;
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: "center" };
    });
  });

  wsContour.getColumn(1).width = 12;
  wsContour.getColumn(2).width = 18;
  wsContour.getColumn(3).width = 18;
  wsContour.getColumn(4).width = 16;

  // Dimensions info
  wsContour.getCell("A10").value = "Base:";
  wsContour.getCell("A10").font = { bold: true };
  wsContour.getCell("B10").value = `${CONTOUR_BASE_WIDTH}" × ${CONTOUR_DEPTH}" (ancho × profundidad)`;

  wsContour.getCell("A11").value = "Vol. Total:";
  wsContour.getCell("A11").font = { bold: true };
  const vol = computeContourVolume();
  const volM3 = vol * 0.000016387064; // in³ → m³
  wsContour.getCell("B11").value = `${volM3.toFixed(2)} m³`;

  // ── Visual cross-section ──
  // Grid: each cell = 2" × 2"
  // Width: 88" → 44 cols; Height: 98" → 49 rows
  const gridStartCol = 6; // column F
  const gridStartRow = 3;
  const cellSize = 2; // inches per cell
  const gridCols = CONTOUR_BASE_WIDTH / cellSize; // 44
  const gridRows = Math.ceil(98 / cellSize); // 49

  // Label
  wsContour.getCell(gridStartRow - 1, gridStartCol).value = "Cross-Section Frontal (cada celda = 2\" × 2\")";
  wsContour.getCell(gridStartRow - 1, gridStartCol).font = { bold: true, size: 11 };

  // Set narrow columns for grid
  for (let c = 0; c < gridCols; c++) {
    wsContour.getColumn(gridStartCol + c).width = 2.5;
  }

  // Draw contour (rows go from top = max height, bottom = 0)
  // x=0 es pared plana (izq), x=88 es borde curvo (der)
  for (let r = 0; r < gridRows; r++) {
    const heightAtRow = (gridRows - r) * cellSize; // height from floor
    const excelRow = wsContour.getRow(gridStartRow + r);
    excelRow.height = 13;
    for (let c = 0; c < gridCols; c++) {
      const xInches = c * cellSize + cellSize / 2; // center of this cell
      const maxH = getMaxHeightAtX(xInches);
      const cell = excelRow.getCell(gridStartCol + c);
      if (heightAtRow <= maxH) {
        cell.fill = CONTOUR_FILL;
      }
      cell.border = {
        top: { style: "hair", color: { argb: "FFD0D0D0" } },
        left: { style: "hair", color: { argb: "FFD0D0D0" } },
        bottom: { style: "hair", color: { argb: "FFD0D0D0" } },
        right: { style: "hair", color: { argb: "FFD0D0D0" } },
      };
    }
  }

  // Height labels on the left
  for (let r = 0; r < gridRows; r += 5) {
    const h = (gridRows - r) * cellSize;
    wsContour.getCell(gridStartRow + r, gridStartCol - 1).value = `${h}"`;
    wsContour.getCell(gridStartRow + r, gridStartCol - 1).font = { size: 8 };
    wsContour.getCell(gridStartRow + r, gridStartCol - 1).alignment = { horizontal: "right" };
  }

  // Width labels at bottom
  for (let c = 0; c < gridCols; c += 5) {
    const x = c * cellSize;
    wsContour.getCell(gridStartRow + gridRows, gridStartCol + c).value = `${x}"`;
    wsContour.getCell(gridStartRow + gridRows, gridStartCol + c).font = { size: 8 };
  }

  // Labels para identificar lados
  wsContour.getCell(gridStartRow + gridRows + 1, gridStartCol).value = "← PARED PLANA";
  wsContour.getCell(gridStartRow + gridRows + 1, gridStartCol).font = { bold: true, size: 9, color: { argb: "FF1F4E79" } };
  wsContour.getCell(gridStartRow + gridRows + 1, gridStartCol + gridCols - 6).value = "BORDE CURVO →";
  wsContour.getCell(gridStartRow + gridRows + 1, gridStartCol + gridCols - 6).font = { bold: true, size: 9, color: { argb: "FF9C0006" } };

  // ════════════════════════════════════════════
  // SHEETS 3-5: Escenarios
  // ════════════════════════════════════════════

  interface ScenarioColumn {
    name: string;
    width: number; // inches
    rows: { pieceIdx: number; layers: number }[]; // pieceIdx = 0-based index into DEFAULT_PIECES
  }

  interface Scenario {
    name: string;
    description: string;
    columns: ScenarioColumn[];
  }

  // Perfil asimétrico: Izq (x=0) = pared plana 98", Der (x=88) = borde curvo escalonado
  // Columnas se colocan de izquierda a derecha: las más altas cerca de la pared plana
  const scenarios: Scenario[] = [
    {
      name: "Escenario 1",
      description: "Skids altos junto a pared plana + bajos en borde curvo",
      columns: [
        {
          name: "Pared Plana",
          width: 40,
          rows: [
            { pieceIdx: 0, layers: 2 }, // Skid Alto x2 = 72" (max 98")
            { pieceIdx: 0, layers: 2 },
            { pieceIdx: 4, layers: 1 }, // Caja B relleno
          ],
        },
        {
          name: "Zona Media",
          width: 20,
          rows: [
            { pieceIdx: 1, layers: 2 }, // Skid Medio x2 = 48" (max 83" hasta x=60")
            { pieceIdx: 1, layers: 2 },
            { pieceIdx: 5, layers: 1 }, // Caja C
          ],
        },
        {
          name: "Zona Intermedia",
          width: 12,
          rows: [
            { pieceIdx: 2, layers: 2 }, // Skid Bajo x2 = 36" (max 62" hasta x=72")
            { pieceIdx: 2, layers: 2 },
            { pieceIdx: 6, layers: 1 }, // Bolsa
          ],
        },
        {
          name: "Borde Curvo",
          width: 16,
          rows: [
            { pieceIdx: 2, layers: 1 }, // Skid Bajo = 18" (max 43" hasta x=88")
            { pieceIdx: 2, layers: 1 },
            { pieceIdx: 6, layers: 1 }, // Bolsa
          ],
        },
      ],
    },
    {
      name: "Escenario 2",
      description: "Skids iguales + relleno con cajas y bolsas",
      columns: [
        {
          name: "Izquierda (Pared)",
          width: 40,
          rows: [
            { pieceIdx: 1, layers: 1 }, // Skid Medio
            { pieceIdx: 1, layers: 1 },
            { pieceIdx: 3, layers: 1 }, // Caja A encima
          ],
        },
        {
          name: "Centro",
          width: 40,
          rows: [
            { pieceIdx: 1, layers: 1 }, // Skid Medio
            { pieceIdx: 1, layers: 1 },
            { pieceIdx: 4, layers: 1 }, // Caja B encima (más baja, zona limitada)
          ],
        },
        {
          name: "Gap Curvo",
          width: 8,
          rows: [
            { pieceIdx: 6, layers: 1 }, // Bolsa
            { pieceIdx: 6, layers: 1 },
            { pieceIdx: 7, layers: 0 }, // Vacío
          ],
        },
      ],
    },
    {
      name: "Escenario 3",
      description: "Mix escalonado siguiendo perfil del contour",
      columns: [
        {
          name: "Pared Plana",
          width: 40,
          rows: [
            { pieceIdx: 0, layers: 2 }, // Skid Alto x2 = 72" (max 98")
            { pieceIdx: 0, layers: 2 },
            { pieceIdx: 5, layers: 2 }, // Caja C x2 = 24" (72+24=96 < 98) ✓
          ],
        },
        {
          name: "Zona 83\"",
          width: 16,
          rows: [
            { pieceIdx: 1, layers: 2 }, // Skid Medio x2 = 48"
            { pieceIdx: 1, layers: 2 },
            { pieceIdx: 4, layers: 2 }, // Caja B x2 = 28" (48+28=76 < 83) ✓
          ],
        },
        {
          name: "Zona 62\"",
          width: 12,
          rows: [
            { pieceIdx: 1, layers: 1 }, // Skid Medio = 24"
            { pieceIdx: 1, layers: 1 },
            { pieceIdx: 3, layers: 1 }, // Caja A = 18" (24+18=42 < 62) ✓
          ],
        },
        {
          name: "Zona 43\"",
          width: 12,
          rows: [
            { pieceIdx: 2, layers: 1 }, // Skid Bajo = 18"
            { pieceIdx: 2, layers: 1 },
            { pieceIdx: 6, layers: 2 }, // Bolsa x2 = 24" (18+24=42 < 43) ✓
          ],
        },
        {
          name: "Borde Curvo",
          width: 8,
          rows: [
            { pieceIdx: 6, layers: 1 }, // Bolsa = 12"
            { pieceIdx: 6, layers: 1 },
            { pieceIdx: 7, layers: 0 }, // Vacío
          ],
        },
      ],
    },
  ];

  const depthRows = [
    { label: "Fila 1 (0-48\")", depth: 48 },
    { label: "Fila 2 (48-96\")", depth: 48 },
    { label: "Fila 3 (96-125\")", depth: 29 },
  ];

  // ── Helper: build piece placement data for a scenario ──
  interface PlacedPiece {
    colStartInches: number;
    colWidthInches: number;
    heightStartInches: number;
    heightEndInches: number;
    pieceIdx: number;
  }
  interface AerialPiece {
    xStart: number; // width position
    xEnd: number;
    yStart: number; // depth position
    yEnd: number;
    pieceIdx: number;
  }

  const HAIR_BORDER: Partial<ExcelJS.Borders> = {
    top: { style: "hair", color: { argb: "FFD0D0D0" } },
    left: { style: "hair", color: { argb: "FFD0D0D0" } },
    bottom: { style: "hair", color: { argb: "FFD0D0D0" } },
    right: { style: "hair", color: { argb: "FFD0D0D0" } },
  };

  for (const scenario of scenarios) {
    const ws = wb.addWorksheet(scenario.name, {
      tabColor: { argb: "FF70AD47" },
    });

    // ── Data column widths (A-H) ──
    ws.getColumn(1).width = 18;
    ws.getColumn(2).width = 14;
    ws.getColumn(3).width = 14;
    ws.getColumn(4).width = 14;
    ws.getColumn(5).width = 22;
    ws.getColumn(6).width = 18;
    ws.getColumn(7).width = 16;
    ws.getColumn(8).width = 12;
    ws.getColumn(9).width = 3; // spacer

    // Visual grid columns (J onwards = col 10+) — narrow for pixel art
    const vizBaseCol = 11; // col K = label col, L onwards = grid
    ws.getColumn(10).width = 2; // spacer
    ws.getColumn(vizBaseCol).width = 5; // label column
    const vizScale = 4; // inches per cell
    const vizGridCols = CONTOUR_BASE_WIDTH / vizScale; // 88/4 = 22
    const vizGridRowsH = Math.ceil(98 / vizScale); // 98/4 = 25 (cross-section height)
    const vizGridRowsD = Math.ceil(CONTOUR_DEPTH / vizScale); // 125/4 = 32 (aerial depth)
    for (let c = 0; c < vizGridCols; c++) {
      ws.getColumn(vizBaseCol + 1 + c).width = 3;
    }

    let currentRow = 1;

    // ── Title ──
    ws.mergeCells(currentRow, 1, currentRow, 8);
    const sTitle = ws.getCell(currentRow, 1);
    sTitle.value = `${scenario.name}: ${scenario.description}`;
    sTitle.font = { bold: true, size: 14, color: { argb: "FF1F4E79" } };
    currentRow += 2;

    // ══════════════════════════════════
    // LEFT SIDE: Sección A — Columnas
    // ══════════════════════════════════
    ws.getCell(currentRow, 1).value = "SECCIÓN A: Definición de Columnas";
    ws.getCell(currentRow, 1).font = { bold: true, size: 12, color: { argb: "FF1F4E79" } };
    currentRow += 1;

    const colDefHeaders = ["Columna", "Ancho (in)", "Inicio (in)", "Fin (in)", "Altura Máx Contour (in)"];
    const colDefHeaderRow = ws.getRow(currentRow);
    colDefHeaders.forEach((h, i) => {
      const cell = colDefHeaderRow.getCell(i + 1);
      cell.value = h;
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.alignment = { horizontal: "center" };
      cell.border = THIN_BORDER;
    });
    currentRow++;

    const colDefStartRow = currentRow;
    let runningX = 0;
    scenario.columns.forEach((col) => {
      const row = ws.getRow(currentRow);
      const colStart = runningX;
      const colEnd = runningX + col.width;
      const maxH = getMaxHeightForColumn(colStart, col.width, CONTOUR_BASE_WIDTH);
      row.getCell(1).value = col.name;
      row.getCell(1).font = { bold: true };
      row.getCell(2).value = col.width;
      row.getCell(3).value = colStart;
      row.getCell(4).value = colEnd;
      row.getCell(5).value = maxH;
      for (let i = 1; i <= 5; i++) {
        row.getCell(i).border = THIN_BORDER;
        row.getCell(i).alignment = { horizontal: "center" };
      }
      runningX = colEnd;
      currentRow++;
    });

    // Total
    const totalRow = ws.getRow(currentRow);
    totalRow.getCell(1).value = "TOTAL";
    totalRow.getCell(1).font = { bold: true };
    totalRow.getCell(2).value = { formula: `SUM(B${colDefStartRow}:B${currentRow - 1})` };
    totalRow.getCell(2).font = { bold: true };
    for (let i = 1; i <= 5; i++) {
      totalRow.getCell(i).border = THIN_BORDER;
      totalRow.getCell(i).alignment = { horizontal: "center" };
      totalRow.getCell(i).fill = SUBHEADER_FILL;
    }
    currentRow += 2;

    // ══════════════════════════════════
    // LEFT SIDE: Sección B — Stacking
    // ══════════════════════════════════
    ws.getCell(currentRow, 1).value = "SECCIÓN B: Stacking por Columna";
    ws.getCell(currentRow, 1).font = { bold: true, size: 12, color: { argb: "FF1F4E79" } };
    currentRow += 1;

    const stackHeaders = ["Columna", "Fila (prof.)", "Pieza", "Alto (in)", "Capas", "Alt. Total (in)", "Alt. Máx (in)", "Status"];
    const shRow = ws.getRow(currentRow);
    stackHeaders.forEach((h, i) => {
      const cell = shRow.getCell(i + 1);
      cell.value = h;
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.alignment = { horizontal: "center", wrapText: true };
      cell.border = THIN_BORDER;
    });
    currentRow++;

    const pieceValidation: ExcelJS.DataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`Piezas!$B$5:$B$12`],
      showDropDown: false,
    };

    runningX = 0;
    scenario.columns.forEach((col) => {
      const colStart = runningX;
      const maxH = getMaxHeightForColumn(colStart, col.width, CONTOUR_BASE_WIDTH);

      depthRows.forEach((dr, ri) => {
        const row = ws.getRow(currentRow);
        const piece = DEFAULT_PIECES[col.rows[ri].pieceIdx];
        const layers = col.rows[ri].layers;

        if (ri === 0) { row.getCell(1).value = col.name; row.getCell(1).font = { bold: true }; }
        row.getCell(1).border = THIN_BORDER;
        row.getCell(2).value = dr.label;
        row.getCell(2).border = THIN_BORDER;

        const pieceCellRef = `C${currentRow}`;
        row.getCell(3).value = piece.name;
        row.getCell(3).dataValidation = pieceValidation;
        row.getCell(3).border = THIN_BORDER;

        row.getCell(4).value = { formula: `IFERROR(INDEX(Piezas!E$5:E$12,MATCH(${pieceCellRef},Piezas!$B$5:$B$12,0)),0)` };
        row.getCell(4).border = THIN_BORDER;
        row.getCell(4).alignment = { horizontal: "center" };

        row.getCell(5).value = layers;
        row.getCell(5).border = THIN_BORDER;
        row.getCell(5).alignment = { horizontal: "center" };

        row.getCell(6).value = { formula: `D${currentRow}*E${currentRow}` };
        row.getCell(6).border = THIN_BORDER;
        row.getCell(6).alignment = { horizontal: "center" };

        row.getCell(7).value = maxH;
        row.getCell(7).border = THIN_BORDER;
        row.getCell(7).alignment = { horizontal: "center" };

        if (ri === depthRows.length - 1) {
          const firstStackRow = currentRow - (depthRows.length - 1);
          row.getCell(8).value = { formula: `IF(SUM(F${firstStackRow}:F${currentRow})<=G${currentRow},"✓ OK","✗ EXCEDE")` };
        }
        row.getCell(8).border = THIN_BORDER;
        row.getCell(8).alignment = { horizontal: "center" };
        row.getCell(8).font = { bold: true };
        currentRow++;
      });

      // Subtotal
      const subRow = ws.getRow(currentRow);
      subRow.getCell(1).value = `▸ ${col.name} Total`;
      subRow.getCell(1).font = { bold: true, italic: true };
      const colFirstRow = currentRow - depthRows.length;
      subRow.getCell(6).value = { formula: `SUM(F${colFirstRow}:F${currentRow - 1})` };
      subRow.getCell(6).font = { bold: true };
      subRow.getCell(7).value = maxH;
      subRow.getCell(7).font = { bold: true };
      subRow.getCell(8).value = { formula: `IF(F${currentRow}<=G${currentRow},"✓ OK","✗ EXCEDE")` };
      subRow.getCell(8).font = { bold: true };
      for (let i = 1; i <= 8; i++) {
        subRow.getCell(i).fill = SUBHEADER_FILL;
        subRow.getCell(i).border = THIN_BORDER;
        subRow.getCell(i).alignment = { horizontal: "center" };
      }
      ws.addConditionalFormatting({
        ref: `H${currentRow}`,
        rules: [
          { type: "containsText", operator: "containsText", text: "OK", priority: 1, style: { fill: OK_FILL, font: { color: { argb: "FF006100" } } } },
          { type: "containsText", operator: "containsText", text: "EXCEDE", priority: 2, style: { fill: EXCEED_FILL, font: { color: { argb: "FF9C0006" } } } },
        ],
      });
      currentRow++;
      runningX += col.width;
    });

    currentRow += 1;

    // ══════════════════════════════════
    // LEFT SIDE: Resumen
    // ══════════════════════════════════
    ws.getCell(currentRow, 1).value = "RESUMEN";
    ws.getCell(currentRow, 1).font = { bold: true, size: 12, color: { argb: "FF1F4E79" } };
    currentRow++;

    const resHRow = ws.getRow(currentRow);
    ["Métrica", "Valor"].forEach((h, i) => {
      const cell = resHRow.getCell(i + 1);
      cell.value = h;
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: "center" };
    });
    currentRow++;

    let totalPieces = 0;
    let totalVolUsed = 0;
    let totalWeight = 0;
    for (const col of scenario.columns) {
      for (let ri = 0; ri < col.rows.length; ri++) {
        const p = DEFAULT_PIECES[col.rows[ri].pieceIdx];
        const layers = col.rows[ri].layers;
        if (p.largo === 0) continue;
        totalPieces += layers;
        totalVolUsed += p.largo * p.ancho * p.alto * layers;
        totalWeight += p.peso * layers;
      }
    }
    const contourVol = computeContourVolume();
    const in3ToM3 = 0.000016387064;
    const metrics: [string, string | number][] = [
      ["Piezas totales", totalPieces],
      ["Volumen utilizado (m³)", +(totalVolUsed * in3ToM3).toFixed(2)],
      ["Volumen contour (m³)", +(contourVol * in3ToM3).toFixed(2)],
      ["Utilización %", `${((totalVolUsed / contourVol) * 100).toFixed(1)}%`],
      ["Peso total (kg)", totalWeight],
    ];
    metrics.forEach(([label, value]) => {
      const row = ws.getRow(currentRow);
      row.getCell(1).value = label as string;
      row.getCell(1).font = { bold: true };
      row.getCell(1).border = THIN_BORDER;
      row.getCell(2).value = value as string | number;
      row.getCell(2).border = THIN_BORDER;
      row.getCell(2).alignment = { horizontal: "center" };
      if (label === "Utilización %") {
        row.getCell(2).font = { bold: true, size: 13, color: { argb: "FF1F4E79" } };
      }
      currentRow++;
    });

    // Legend (left side, below summary)
    currentRow += 1;
    ws.getCell(currentRow, 1).value = "Leyenda:";
    ws.getCell(currentRow, 1).font = { bold: true };
    currentRow++;
    DEFAULT_PIECES.forEach((p, i) => {
      if (i >= 7) return;
      const lRow = ws.getRow(currentRow);
      lRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: PIECE_COLORS[i] } };
      lRow.getCell(1).border = THIN_BORDER;
      lRow.getCell(2).value = p.name;
      currentRow++;
    });

    // ══════════════════════════════════════════════════════
    // RIGHT SIDE: Visuales (cross-section + vista aérea)
    // ══════════════════════════════════════════════════════

    // Build piece placement data
    const placedPieces: PlacedPiece[] = [];
    const aerialPieces: AerialPiece[] = [];
    let px = 0;
    for (const col of scenario.columns) {
      let hCursor = 0;
      let dCursor = 0;
      for (let ri = 0; ri < col.rows.length; ri++) {
        const piece = DEFAULT_PIECES[col.rows[ri].pieceIdx];
        const layers = col.rows[ri].layers;
        const totalH = piece.alto * layers;
        const depth = depthRows[ri].depth;

        if (totalH > 0) {
          placedPieces.push({
            colStartInches: px,
            colWidthInches: col.width,
            heightStartInches: hCursor,
            heightEndInches: hCursor + totalH,
            pieceIdx: col.rows[ri].pieceIdx,
          });
        }

        // Aerial: pieza ocupa ancho de columna × largo de pieza en profundidad
        // Si la pieza cabe en la columna width-wise
        if (piece.largo > 0 && layers > 0) {
          // Pieza ocupa: x = [px, px + min(col.width, piece.ancho)], y = [dCursor, dCursor + piece.largo]
          aerialPieces.push({
            xStart: px,
            xEnd: px + Math.min(col.width, piece.ancho),
            yStart: dCursor,
            yEnd: Math.min(dCursor + piece.largo, dCursor + depth),
            pieceIdx: col.rows[ri].pieceIdx,
          });
        }

        hCursor += totalH;
        dCursor += depth;
      }
      px += col.width;
    }

    // ── CROSS-SECTION FRONTAL (right side, row 3) ──
    const csStartRow = 3;
    const gridStartCol = vizBaseCol + 1; // first grid column

    ws.getCell(csStartRow - 1, vizBaseCol).value = "CROSS-SECTION FRONTAL";
    ws.getCell(csStartRow - 1, vizBaseCol).font = { bold: true, size: 10, color: { argb: "FF1F4E79" } };

    for (let r = 0; r < vizGridRowsH; r++) {
      const heightAtRow = (vizGridRowsH - r) * vizScale;
      const excelRow = ws.getRow(csStartRow + r);
      excelRow.height = 14;

      // Height label
      if (r % 3 === 0) {
        ws.getCell(csStartRow + r, vizBaseCol).value = `${heightAtRow}"`;
        ws.getCell(csStartRow + r, vizBaseCol).font = { size: 7 };
        ws.getCell(csStartRow + r, vizBaseCol).alignment = { horizontal: "right" };
      }

      for (let c = 0; c < vizGridCols; c++) {
        const xInches = c * vizScale;
        const maxH = getMaxHeightAtX(xInches + vizScale / 2);
        const cell = excelRow.getCell(gridStartCol + c);

        if (heightAtRow <= maxH) {
          // Inside contour — check pieces
          let filled = false;
          for (const pp of placedPieces) {
            if (
              xInches >= pp.colStartInches &&
              xInches + vizScale <= pp.colStartInches + pp.colWidthInches &&
              heightAtRow - vizScale >= pp.heightStartInches &&
              heightAtRow <= pp.heightEndInches
            ) {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PIECE_COLORS[pp.pieceIdx] } };
              filled = true;
              break;
            }
          }
          if (!filled) {
            // Empty space inside contour = light gray outline only (white fill = gap visible)
            cell.fill = CONTOUR_FILL;
          }
        }
        // No fill for outside contour = white = blank
        cell.border = HAIR_BORDER;
      }
    }

    // Side labels
    ws.getCell(csStartRow + vizGridRowsH, gridStartCol).value = "PARED";
    ws.getCell(csStartRow + vizGridRowsH, gridStartCol).font = { bold: true, size: 7, color: { argb: "FF1F4E79" } };
    ws.getCell(csStartRow + vizGridRowsH, gridStartCol + vizGridCols - 3).value = "CURVO";
    ws.getCell(csStartRow + vizGridRowsH, gridStartCol + vizGridCols - 3).font = { bold: true, size: 7, color: { argb: "FF9C0006" } };

    // ── VISTA AÉREA / TOP-DOWN (right side, below cross-section) ──
    const aerialStartRow = csStartRow + vizGridRowsH + 3;

    ws.getCell(aerialStartRow - 1, vizBaseCol).value = "VISTA AÉREA (planta)";
    ws.getCell(aerialStartRow - 1, vizBaseCol).font = { bold: true, size: 10, color: { argb: "FF1F4E79" } };

    // Aerial: X = width (88"), Y = depth (125")
    // Each cell = vizScale × vizScale inches
    for (let r = 0; r < vizGridRowsD; r++) {
      const depthAtRow = r * vizScale; // top of cell = closer to front
      const excelRow = ws.getRow(aerialStartRow + r);
      excelRow.height = 14;

      // Depth label
      if (r % 4 === 0) {
        ws.getCell(aerialStartRow + r, vizBaseCol).value = `${depthAtRow}"`;
        ws.getCell(aerialStartRow + r, vizBaseCol).font = { size: 7 };
        ws.getCell(aerialStartRow + r, vizBaseCol).alignment = { horizontal: "right" };
      }

      for (let c = 0; c < vizGridCols; c++) {
        const xInches = c * vizScale;
        const cell = excelRow.getCell(gridStartCol + c);

        // Check if any aerial piece covers this cell
        let filled = false;
        for (const ap of aerialPieces) {
          if (
            xInches >= ap.xStart &&
            xInches + vizScale <= ap.xEnd &&
            depthAtRow >= ap.yStart &&
            depthAtRow + vizScale <= ap.yEnd
          ) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PIECE_COLORS[ap.pieceIdx] } };
            filled = true;
            break;
          }
        }
        // NOT filled = white = gap/hueco (no fill applied)
        cell.border = HAIR_BORDER;
      }
    }

    // Axis labels for aerial
    ws.getCell(aerialStartRow + vizGridRowsD, gridStartCol).value = "PARED";
    ws.getCell(aerialStartRow + vizGridRowsD, gridStartCol).font = { bold: true, size: 7, color: { argb: "FF1F4E79" } };
    ws.getCell(aerialStartRow + vizGridRowsD, gridStartCol + vizGridCols - 3).value = "CURVO";
    ws.getCell(aerialStartRow + vizGridRowsD, gridStartCol + vizGridCols - 3).font = { bold: true, size: 7, color: { argb: "FF9C0006" } };
    ws.getCell(aerialStartRow - 1, gridStartCol + vizGridCols + 1).value = "← frente";
    ws.getCell(aerialStartRow - 1, gridStartCol + vizGridCols + 1).font = { size: 7, italic: true };
    ws.getCell(aerialStartRow + vizGridRowsD - 1, gridStartCol + vizGridCols + 1).value = "← fondo";
    ws.getCell(aerialStartRow + vizGridRowsD - 1, gridStartCol + vizGridCols + 1).font = { size: 7, italic: true };
  }

  // ── Save ──
  const outputPath = path.join(
    "C:\\Users\\dgarc\\Downloads",
    "Simulador_Estiba_PAG_767F.xlsx"
  );
  await wb.xlsx.writeFile(outputPath);
  console.log(`✅ Excel generado: ${outputPath}`);
}

generate().catch((err) => {
  console.error("Error generando Excel:", err);
  process.exit(1);
});
