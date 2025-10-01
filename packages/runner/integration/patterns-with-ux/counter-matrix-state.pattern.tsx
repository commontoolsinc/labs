/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type Matrix = number[][];

interface CounterMatrixStateArgs {
  matrix: Default<Matrix, [[0, 0], [0, 0]]>;
}

interface Dimensions {
  rows: number;
  columns: number;
}

interface SetCellEvent {
  row?: number;
  column?: number;
  value?: number;
}

interface SetRowEvent {
  row?: number;
  values?: unknown;
}

interface SetColumnEvent {
  column?: number;
  values?: unknown;
  value?: number;
}

const fallbackMatrix: Matrix = [
  [0, 0],
  [0, 0],
];

const cloneFallback = (): Matrix => fallbackMatrix.map((row) => [...row]);

const sanitizeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const sanitizeMatrix = (raw: Matrix | undefined): Matrix => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return cloneFallback();
  }

  let width = 0;
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length > width) {
      width = entry.length;
    }
  }

  if (width === 0) {
    width = fallbackMatrix[0].length;
  }

  return raw.map((entry) => {
    if (!Array.isArray(entry)) {
      return Array.from({ length: width }, () => 0);
    }

    const sanitized = entry.map(sanitizeNumber);
    if (sanitized.length < width) {
      return [
        ...sanitized,
        ...Array.from({ length: width - sanitized.length }, () => 0),
      ];
    }
    if (sanitized.length > width) {
      return sanitized.slice(0, width);
    }
    return sanitized;
  });
};

const computeRowTotals = (raw: Matrix | undefined): number[] => {
  return sanitizeMatrix(raw).map((row) =>
    row.reduce((sum, value) => sum + value, 0)
  );
};

const computeColumnTotals = (raw: Matrix | undefined): number[] => {
  const matrix = sanitizeMatrix(raw);
  if (matrix.length === 0) {
    return [];
  }
  const width = matrix[0].length;
  return Array.from({ length: width }, (_, column) => {
    return matrix.reduce((sum, row) => sum + row[column], 0);
  });
};

const computeDimensions = (raw: Matrix | undefined): Dimensions => {
  const matrix = sanitizeMatrix(raw);
  const columns = matrix.length > 0 ? matrix[0].length : 0;
  return { rows: matrix.length, columns };
};

const setCellValue = handler(
  (
    event: SetCellEvent | undefined,
    context: { matrix: Cell<Matrix> },
  ) => {
    if (
      typeof event?.row !== "number" ||
      typeof event?.column !== "number" ||
      typeof event?.value !== "number" ||
      !Number.isFinite(event.value)
    ) {
      return;
    }

    const matrixValue = context.matrix.get();
    if (!Array.isArray(matrixValue)) {
      return;
    }

    const { row, column, value } = event;
    if (row < 0 || row >= matrixValue.length) {
      return;
    }

    const rowValue = matrixValue[row];
    if (!Array.isArray(rowValue) || column < 0 || column >= rowValue.length) {
      return;
    }

    const rowCell = context.matrix.key(row) as Cell<number[]>;
    const cell = rowCell.key(column) as Cell<number>;
    cell.set(value);
  },
);

const setRowValues = handler(
  (
    event: SetRowEvent | undefined,
    context: { matrix: Cell<Matrix> },
  ) => {
    if (typeof event?.row !== "number") {
      return;
    }

    const matrixValue = context.matrix.get();
    if (!Array.isArray(matrixValue)) {
      return;
    }

    const rowIndex = event.row;
    if (rowIndex < 0 || rowIndex >= matrixValue.length) {
      return;
    }

    const existingRow = matrixValue[rowIndex];
    const rowCell = context.matrix.key(rowIndex) as Cell<number[]>;
    const targetLength = Array.isArray(existingRow) ? existingRow.length : 0;
    if (targetLength === 0) {
      return;
    }

    const provided = Array.isArray(event.values) ? event.values : [];
    const nextRow = Array.from({ length: targetLength }, (_, column) => {
      const candidate = provided[column];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
      const fallback = Array.isArray(existingRow)
        ? existingRow[column]
        : undefined;
      return sanitizeNumber(fallback);
    });

    rowCell.set(nextRow);
  },
);

const setColumnValues = handler(
  (
    event: SetColumnEvent | undefined,
    context: { matrix: Cell<Matrix> },
  ) => {
    if (typeof event?.column !== "number") {
      return;
    }

    const matrixValue = context.matrix.get();
    if (!Array.isArray(matrixValue)) {
      return;
    }

    const columnIndex = event.column;
    if (columnIndex < 0) {
      return;
    }

    const valuesArray = Array.isArray(event.values) ? event.values : undefined;
    const defaultValue = typeof event.value === "number" &&
        Number.isFinite(event.value)
      ? event.value
      : undefined;

    matrixValue.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || columnIndex >= row.length) {
        return;
      }

      const rowCell = context.matrix.key(rowIndex) as Cell<number[]>;
      const cell = rowCell.key(columnIndex) as Cell<number>;
      const candidate = valuesArray && valuesArray[rowIndex];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        cell.set(candidate);
        return;
      }
      if (defaultValue !== undefined) {
        cell.set(defaultValue);
      }
    });
  },
);

export const counterMatrixStateUx = recipe<CounterMatrixStateArgs>(
  "Counter Matrix State (UX)",
  ({ matrix }) => {
    const matrixView = derive(matrix, sanitizeMatrix);
    const rowTotals = derive(matrix, computeRowTotals);
    const columnTotals = derive(matrix, computeColumnTotals);
    const dimensions = derive(matrix, computeDimensions);
    const total = lift((rows: number[]) =>
      rows.reduce((sum, value) => sum + value, 0)
    )(rowTotals);
    const rowSummary = lift((rows: number[]) =>
      rows.map((value, index) => `r${index}=${value}`).join(" | ")
    )(rowTotals);
    const columnSummary = lift((columns: number[]) =>
      columns.map((value, index) => `c${index}=${value}`).join(" | ")
    )(columnTotals);

    // UI form fields
    const rowField = cell<string>("0");
    const columnField = cell<string>("0");
    const valueField = cell<string>("0");

    // UI handlers
    const uiSetCell = handler<
      unknown,
      {
        rowInput: Cell<string>;
        columnInput: Cell<string>;
        valueInput: Cell<string>;
        matrix: Cell<Matrix>;
      }
    >((_event, { rowInput, columnInput, valueInput, matrix }) => {
      const rowStr = rowInput.get();
      const colStr = columnInput.get();
      const valStr = valueInput.get();

      if (
        typeof rowStr !== "string" || rowStr.trim() === "" ||
        typeof colStr !== "string" || colStr.trim() === "" ||
        typeof valStr !== "string" || valStr.trim() === ""
      ) {
        return;
      }

      const row = Number(rowStr);
      const column = Number(colStr);
      const value = Number(valStr);

      if (
        !Number.isFinite(row) || !Number.isFinite(column) ||
        !Number.isFinite(value)
      ) {
        return;
      }

      const matrixValue = matrix.get();
      if (!Array.isArray(matrixValue)) {
        return;
      }

      const rowIdx = Math.trunc(row);
      const colIdx = Math.trunc(column);

      if (rowIdx < 0 || rowIdx >= matrixValue.length) {
        return;
      }

      const rowValue = matrixValue[rowIdx];
      if (
        !Array.isArray(rowValue) || colIdx < 0 || colIdx >= rowValue.length
      ) {
        return;
      }

      const rowCell = matrix.key(rowIdx) as Cell<number[]>;
      const cellRef = rowCell.key(colIdx) as Cell<number>;
      cellRef.set(value);

      rowInput.set("");
      columnInput.set("");
      valueInput.set("");
    })({
      rowInput: rowField,
      columnInput: columnField,
      valueInput: valueField,
      matrix,
    });

    const incrementCell = handler<
      unknown,
      {
        rowInput: Cell<string>;
        columnInput: Cell<string>;
        matrix: Cell<Matrix>;
      }
    >((_event, { rowInput, columnInput, matrix }) => {
      const rowStr = rowInput.get();
      const colStr = columnInput.get();

      if (
        typeof rowStr !== "string" || rowStr.trim() === "" ||
        typeof colStr !== "string" || colStr.trim() === ""
      ) {
        return;
      }

      const row = Number(rowStr);
      const column = Number(colStr);

      if (!Number.isFinite(row) || !Number.isFinite(column)) {
        return;
      }

      const matrixValue = matrix.get();
      if (!Array.isArray(matrixValue)) {
        return;
      }

      const rowIdx = Math.trunc(row);
      const colIdx = Math.trunc(column);

      if (rowIdx < 0 || rowIdx >= matrixValue.length) {
        return;
      }

      const rowValue = matrixValue[rowIdx];
      if (
        !Array.isArray(rowValue) || colIdx < 0 || colIdx >= rowValue.length
      ) {
        return;
      }

      const rowCell = matrix.key(rowIdx) as Cell<number[]>;
      const cellRef = rowCell.key(colIdx) as Cell<number>;
      const current = sanitizeNumber(cellRef.get());
      cellRef.set(current + 1);
    })({ rowInput: rowField, columnInput: columnField, matrix });

    const decrementCell = handler<
      unknown,
      {
        rowInput: Cell<string>;
        columnInput: Cell<string>;
        matrix: Cell<Matrix>;
      }
    >((_event, { rowInput, columnInput, matrix }) => {
      const rowStr = rowInput.get();
      const colStr = columnInput.get();

      if (
        typeof rowStr !== "string" || rowStr.trim() === "" ||
        typeof colStr !== "string" || colStr.trim() === ""
      ) {
        return;
      }

      const row = Number(rowStr);
      const column = Number(colStr);

      if (!Number.isFinite(row) || !Number.isFinite(column)) {
        return;
      }

      const matrixValue = matrix.get();
      if (!Array.isArray(matrixValue)) {
        return;
      }

      const rowIdx = Math.trunc(row);
      const colIdx = Math.trunc(column);

      if (rowIdx < 0 || rowIdx >= matrixValue.length) {
        return;
      }

      const rowValue = matrixValue[rowIdx];
      if (
        !Array.isArray(rowValue) || colIdx < 0 || colIdx >= rowValue.length
      ) {
        return;
      }

      const rowCell = matrix.key(rowIdx) as Cell<number[]>;
      const cellRef = rowCell.key(colIdx) as Cell<number>;
      const current = sanitizeNumber(cellRef.get());
      cellRef.set(current - 1);
    })({ rowInput: rowField, columnInput: columnField, matrix });

    // Name for the charm
    const name = str`Matrix Grid: ${total} total`;

    // UI rendering
    const matrixGrid = lift((m: Matrix) => {
      const rows = m.length;
      const cols = rows > 0 ? m[0].length : 0;

      const gridStyle = "display: grid; grid-template-columns: repeat(" +
        String(cols + 1) +
        ", 1fr); gap: 4px; background: #f8fafc; padding: 12px; border-radius: 8px;";

      const elements = [];

      // Header row: empty corner + column indices
      elements.push(
        h(
          "div",
          {
            style:
              "background: #475569; color: white; padding: 8px; text-align: center; font-weight: bold; border-radius: 4px; font-size: 0.875rem;",
          },
          "",
        ),
      );

      for (let c = 0; c < cols; c++) {
        elements.push(
          h(
            "div",
            {
              style:
                "background: #475569; color: white; padding: 8px; text-align: center; font-weight: bold; border-radius: 4px; font-size: 0.875rem;",
            },
            "C" + String(c),
          ),
        );
      }

      // Data rows: row index + cells
      for (let r = 0; r < rows; r++) {
        elements.push(
          h(
            "div",
            {
              style:
                "background: #475569; color: white; padding: 8px; text-align: center; font-weight: bold; border-radius: 4px; font-size: 0.875rem;",
            },
            "R" + String(r),
          ),
        );

        for (let c = 0; c < cols; c++) {
          const value = m[r][c];
          const cellStyle = "background: " +
            (value === 0 ? "#e2e8f0" : "#06b6d4") + "; color: " +
            (value === 0 ? "#334155" : "white") +
            "; padding: 12px; text-align: center; font-weight: bold; border-radius: 4px; font-size: 1.125rem; border: 2px solid " +
            (value === 0 ? "#cbd5e1" : "#0891b2") + ";";

          elements.push(
            h(
              "div",
              {
                style: cellStyle,
              },
              String(value),
            ),
          );
        }
      }

      return h(
        "div",
        {
          style: gridStyle,
        },
        ...elements,
      );
    })(matrixView);

    const totalsDisplay = lift(
      ({ rows, cols, t }: {
        rows: number[];
        cols: number[];
        t: number;
      }) => {
        const rowElements = [];
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          rowElements.push(
            h(
              "div",
              {
                style:
                  "background: #dbeafe; border: 2px solid #3b82f6; color: #1e40af; padding: 8px 12px; border-radius: 4px; font-weight: 600; text-align: center;",
              },
              "R" + String(i) + ": " + String(r),
            ),
          );
        }

        const colElements = [];
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          colElements.push(
            h(
              "div",
              {
                style:
                  "background: #fce7f3; border: 2px solid #ec4899; color: #9f1239; padding: 8px 12px; border-radius: 4px; font-weight: 600; text-align: center;",
              },
              "C" + String(i) + ": " + String(c),
            ),
          );
        }

        return h(
          "div",
          {
            style:
              "background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); padding: 20px; border-radius: 8px; border: 2px solid #0ea5e9;",
          },
          h(
            "div",
            {
              style:
                "font-size: 1.5rem; font-weight: bold; color: #0c4a6e; margin-bottom: 16px; text-align: center;",
            },
            "Total: " + String(t),
          ),
          h(
            "div",
            {
              style: "margin-bottom: 12px;",
            },
            h(
              "div",
              {
                style: "font-weight: 600; color: #1e40af; margin-bottom: 8px;",
              },
              "Row Totals",
            ),
            h(
              "div",
              {
                style: "display: flex; gap: 8px; flex-wrap: wrap;",
              },
              ...rowElements,
            ),
          ),
          h(
            "div",
            {},
            h(
              "div",
              {
                style: "font-weight: 600; color: #9f1239; margin-bottom: 8px;",
              },
              "Column Totals",
            ),
            h(
              "div",
              {
                style: "display: flex; gap: 8px; flex-wrap: wrap;",
              },
              ...colElements,
            ),
          ),
        );
      },
    )({ rows: rowTotals, cols: columnTotals, t: total });

    const ui = (
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; font-size: 2rem;">Counter Matrix</h1>
          <p style="margin: 0; opacity: 0.95; font-size: 1rem;">
            Interactive grid with row and column aggregations
          </p>
        </div>

        {totalsDisplay}

        <div style="margin: 24px 0;">
          {matrixGrid}
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px; border: 2px solid #e2e8f0; margin-top: 24px;">
          <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 1.25rem;">
            Cell Controls
          </h2>

          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px;">
            <div>
              <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px; font-size: 0.875rem;">
                Row
              </label>
              <ct-input
                $value={rowField}
                placeholder="0"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px; font-size: 0.875rem;">
                Column
              </label>
              <ct-input
                $value={columnField}
                placeholder="0"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px; font-size: 0.875rem;">
                Value
              </label>
              <ct-input
                $value={valueField}
                placeholder="0"
                style="width: 100%;"
              />
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
            <ct-button onClick={uiSetCell} style="width: 100%;">
              Set Cell
            </ct-button>
            <ct-button onClick={incrementCell} style="width: 100%;">
              Increment (+1)
            </ct-button>
            <ct-button onClick={decrementCell} style="width: 100%;">
              Decrement (-1)
            </ct-button>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      matrix,
      matrixView,
      rowTotals,
      columnTotals,
      dimensions,
      total,
      rowSummary,
      columnSummary,
      setCell: setCellValue({ matrix }),
      setRow: setRowValues({ matrix }),
      setColumn: setColumnValues({ matrix }),
    };
  },
);
