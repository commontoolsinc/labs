import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

import {
  AirtableAuthManager,
  type ScopeKey,
} from "./core/util/airtable-auth-manager.tsx";
import { AirtableClient } from "./core/util/airtable-client.ts";
import type { AirtableAuth } from "./core/airtable-auth.tsx";

// ============================================================================
// TYPES
// ============================================================================

/** An Airtable record with its fields */
type AirtableRecordData = {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
};

type BaseInfo = { id: string; name: string };
type TableInfo = { id: string; name: string };

interface Input {
  selectedBaseId: Default<string, "">;
  selectedTableId: Default<string, "">;
}

/** Import records from an Airtable base. #airtableImporter */
interface Output {
  records: readonly AirtableRecordData[];
  bases: readonly BaseInfo[];
  tables: readonly TableInfo[];
  selectedBaseId: string;
  selectedTableId: string;
  selectedBaseName: string;
  selectedTableName: string;
  recordCount: number;
}

// ============================================================================
// REQUIRED SCOPES
// ============================================================================

const REQUIRED_SCOPES: ScopeKey[] = [
  "data.records:read",
  "schema.bases:read",
];

// ============================================================================
// MODULE-SCOPE HANDLERS
// ============================================================================

const fetchBases = handler<
  unknown,
  {
    auth: Writable<AirtableAuth>;
    bases: Writable<BaseInfo[]>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (_event, { auth, bases, loading, error }) => {
  loading.set(true);
  error.set("");
  try {
    const client = new AirtableClient(auth);
    const result = await client.listBases();
    bases.set(result.map((b) => ({ id: b.id, name: b.name })));
  } catch (e) {
    error.set(e instanceof Error ? e.message : String(e));
  } finally {
    loading.set(false);
  }
});

const fetchTables = handler<
  unknown,
  {
    auth: Writable<AirtableAuth>;
    baseId: string;
    tables: Writable<TableInfo[]>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (_event, { auth, baseId, tables, loading, error }) => {
  if (!baseId) return;
  loading.set(true);
  error.set("");
  try {
    const client = new AirtableClient(auth);
    const result = await client.listTables(baseId);
    tables.set(result.map((t) => ({ id: t.id, name: t.name })));
  } catch (e) {
    error.set(e instanceof Error ? e.message : String(e));
  } finally {
    loading.set(false);
  }
});

const fetchRecords = handler<
  unknown,
  {
    auth: Writable<AirtableAuth>;
    baseId: string;
    tableId: string;
    records: Writable<AirtableRecordData[]>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (_event, { auth, baseId, tableId, records, loading, error }) => {
  if (!baseId || !tableId) return;
  loading.set(true);
  error.set("");
  try {
    const client = new AirtableClient(auth);
    const result = await client.listRecords(baseId, tableId, {
      maxRecords: 500,
    });
    records.set(
      result.map((r) => ({
        id: r.id,
        createdTime: r.createdTime,
        fields: r.fields,
      })),
    );
  } catch (e) {
    error.set(e instanceof Error ? e.message : String(e));
  } finally {
    loading.set(false);
  }
});

const onSelectBase = handler<
  unknown,
  {
    baseId: string;
    selectedBaseId: Writable<string>;
    selectedTableId: Writable<string>;
    tables: Writable<TableInfo[]>;
    records: Writable<AirtableRecordData[]>;
  }
>((_event, { baseId, selectedBaseId, selectedTableId, tables, records }) => {
  selectedBaseId.set(baseId);
  selectedTableId.set("");
  tables.set([]);
  records.set([]);
});

const onSelectTable = handler<
  unknown,
  {
    tableId: string;
    selectedTableId: Writable<string>;
    records: Writable<AirtableRecordData[]>;
  }
>((_event, { tableId, selectedTableId, records }) => {
  selectedTableId.set(tableId);
  records.set([]);
});

// ============================================================================
// PATTERN
// ============================================================================

export default pattern<Input, Output>(
  ({ selectedBaseId, selectedTableId }) => {
    // Auth manager
    const {
      auth: authResult,
      isReady,
      fullUI: authUI,
    } = AirtableAuthManager({
      requiredScopes: REQUIRED_SCOPES,
    });

    // deno-lint-ignore no-explicit-any
    const auth = authResult as any;

    // State
    const bases = Writable.of<BaseInfo[]>([]);
    const tables = Writable.of<TableInfo[]>([]);
    const records = Writable.of<AirtableRecordData[]>([]);
    const loading = Writable.of(false);
    const error = Writable.of("");

    const hasBases = computed(() => bases.get().length > 0);
    const hasTables = computed(() => tables.get().length > 0);
    const hasRecords = computed(
      () => records.get().length > 0,
    );
    const recordCount = computed(
      () => records.get().length,
    );

    const selectedBaseName = computed(() => {
      if (!selectedBaseId) return "";
      const base = bases.get().find(
        (b) => b.id === selectedBaseId,
      );
      return base?.name || "";
    });

    const selectedTableName = computed(() => {
      if (!selectedTableId) return "";
      const table = tables.get().find(
        (t) => t.id === selectedTableId,
      );
      return table?.name || "";
    });

    // Bound handlers — pass reactive inputs directly (no double-cast)
    const boundFetchBases = fetchBases({ auth, bases, loading, error });
    const boundFetchTables = fetchTables({
      auth,
      baseId: selectedBaseId,
      tables,
      loading,
      error,
    });
    const boundFetchRecords = fetchRecords({
      auth,
      baseId: selectedBaseId,
      tableId: selectedTableId,
      records,
      loading,
      error,
    });

    // NOTE: onSelectBase/onSelectTable are bound per-item in .map() below
    // (idiomatic CTS: bind the ID into the handler context)

    // Column headers extracted from records
    const columnHeaders = computed(() => {
      const recs = records.get();
      if (recs.length === 0) return [] as string[];
      const allKeys = new Set<string>();
      for (const rec of recs.slice(0, 10)) {
        for (const key of Object.keys(rec.fields)) {
          allKeys.add(key);
        }
      }
      return Array.from(allKeys);
    });

    const hasBaseSelected = computed(() => !!selectedBaseId);
    const hasTableSelected = computed(() => !!selectedTableId);

    // Data-only computed for base/table lists — JSX rendered inline in UI section
    const baseList = computed(() =>
      bases.get().map((base) => ({
        id: base.id,
        name: base.name,
      }))
    );

    const tableList = computed(() =>
      tables.get().map((table) => ({
        id: table.id,
        name: table.name,
      }))
    );

    // Precompute table rows as plain data (avoid nested JSX .map() in computed)
    const tableRows = computed(() => {
      const recs = records.get();
      const hdrs = columnHeaders as string[];
      return recs.map((rec) => ({
        cells: hdrs.map((col) => formatCellValue(rec.fields[col])),
      }));
    });

    const hasError = computed(() => !!error.get());

    return {
      [NAME]: computed(() => {
        if (selectedBaseName && selectedTableName) {
          return `Airtable: ${selectedBaseName} / ${selectedTableName}`;
        }
        return "Airtable Importer";
      }),
      [UI]: (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            padding: "25px",
            maxWidth: "900px",
          }}
        >
          <h2 style={{ fontSize: "24px", fontWeight: "bold", margin: "0" }}>
            Airtable Importer
          </h2>

          {/* Auth section */}
          {authUI}

          {/* Main content - only when authenticated */}
          {ifElse(
            isReady,
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              {/* Base selection */}
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#f8f9fa",
                  borderRadius: "8px",
                  border: "1px solid #e0e0e0",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <h3 style={{ fontSize: "16px", margin: "0" }}>
                    Select a Base
                  </h3>
                  <button
                    type="button"
                    onClick={boundFetchBases}
                    disabled={loading}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: loading ? "#93c5fd" : "#18BFFF",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: loading ? "not-allowed" : "pointer",
                      fontWeight: "500",
                      fontSize: "14px",
                    }}
                  >
                    {ifElse(loading, "Loading...", "Load Bases")}
                  </button>
                </div>

                {ifElse(
                  hasBases,
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    {baseList.map((base) => (
                      <button
                        type="button"
                        onClick={onSelectBase({
                          baseId: base.id,
                          selectedBaseId,
                          selectedTableId,
                          tables,
                          records,
                        })}
                        style={{
                          padding: "10px 14px",
                          backgroundColor: selectedBaseId === base.id
                            ? "#e0f2fe"
                            : "white",
                          border: selectedBaseId === base.id
                            ? "1px solid #18BFFF"
                            : "1px solid #e0e0e0",
                          borderRadius: "6px",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: "14px",
                          fontWeight: selectedBaseId === base.id
                            ? "600"
                            : "normal",
                        }}
                      >
                        {base.name}
                      </button>
                    ))}
                  </div>,
                  <p style={{ color: "#666", fontSize: "14px", margin: "0" }}>
                    Click "Load Bases" to see your Airtable bases.
                  </p>,
                )}
              </div>

              {/* Table selection */}
              {ifElse(
                hasBaseSelected,
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "#f8f9fa",
                    borderRadius: "8px",
                    border: "1px solid #e0e0e0",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "12px",
                    }}
                  >
                    <h3 style={{ fontSize: "16px", margin: "0" }}>
                      Select a Table from {selectedBaseName}
                    </h3>
                    <button
                      type="button"
                      onClick={boundFetchTables}
                      disabled={loading}
                      style={{
                        padding: "8px 16px",
                        backgroundColor: loading ? "#93c5fd" : "#18BFFF",
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        cursor: loading ? "not-allowed" : "pointer",
                        fontWeight: "500",
                        fontSize: "14px",
                      }}
                    >
                      {ifElse(loading, "Loading...", "Load Tables")}
                    </button>
                  </div>

                  {ifElse(
                    hasTables,
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                      }}
                    >
                      {tableList.map((table) => (
                        <button
                          type="button"
                          onClick={onSelectTable({
                            tableId: table.id,
                            selectedTableId,
                            records,
                          })}
                          style={{
                            padding: "10px 14px",
                            backgroundColor: selectedTableId === table.id
                              ? "#e0f2fe"
                              : "white",
                            border: selectedTableId === table.id
                              ? "1px solid #18BFFF"
                              : "1px solid #e0e0e0",
                            borderRadius: "6px",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: "14px",
                            fontWeight: selectedTableId === table.id
                              ? "600"
                              : "normal",
                          }}
                        >
                          {table.name}
                        </button>
                      ))}
                    </div>,
                    <p
                      style={{ color: "#666", fontSize: "14px", margin: "0" }}
                    >
                      Click "Load Tables" to see tables in this base.
                    </p>,
                  )}
                </div>,
                null,
              )}

              {/* Fetch records */}
              {ifElse(
                hasTableSelected,
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "#f8f9fa",
                    borderRadius: "8px",
                    border: "1px solid #e0e0e0",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "12px",
                    }}
                  >
                    <h3 style={{ fontSize: "16px", margin: "0" }}>
                      Records from {selectedTableName}
                    </h3>
                    <button
                      type="button"
                      onClick={boundFetchRecords}
                      disabled={loading}
                      style={{
                        padding: "8px 16px",
                        backgroundColor: loading ? "#93c5fd" : "#18BFFF",
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        cursor: loading ? "not-allowed" : "pointer",
                        fontWeight: "500",
                        fontSize: "14px",
                      }}
                    >
                      {ifElse(loading, "Fetching...", "Fetch Records")}
                    </button>
                  </div>

                  {ifElse(
                    hasRecords,
                    <div>
                      <p
                        style={{
                          fontSize: "14px",
                          color: "#666",
                          margin: "0 0 12px 0",
                        }}
                      >
                        {recordCount} records loaded
                      </p>
                      <div
                        style={{
                          overflow: "auto",
                          maxHeight: "500px",
                          border: "1px solid #e0e0e0",
                          borderRadius: "6px",
                        }}
                      >
                        <table
                          style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: "13px",
                          }}
                        >
                          <thead>
                            <tr
                              style={{
                                backgroundColor: "#f3f4f6",
                                position: "sticky",
                                top: "0",
                              }}
                            >
                              {columnHeaders.map((col) => (
                                <th
                                  style={{
                                    padding: "8px 12px",
                                    textAlign: "left",
                                    borderBottom: "2px solid #e0e0e0",
                                    fontWeight: "600",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tableRows.map(
                              (row) => (
                                <tr>
                                  {row.cells.map((cell) => (
                                    <td
                                      style={{
                                        padding: "8px 12px",
                                        borderBottom: "1px solid #f0f0f0",
                                        maxWidth: "300px",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ),
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>,
                    <p
                      style={{ color: "#666", fontSize: "14px", margin: "0" }}
                    >
                      Click "Fetch Records" to load data from this table.
                    </p>,
                  )}
                </div>,
                null,
              )}

              {/* Error display */}
              {ifElse(
                hasError,
                <div
                  style={{
                    padding: "12px",
                    backgroundColor: "#fee2e2",
                    borderRadius: "8px",
                    border: "1px solid #ef4444",
                    fontSize: "14px",
                    color: "#dc2626",
                  }}
                >
                  <strong>Error:</strong> {error}
                </div>,
                null,
              )}
            </div>,
            null,
          )}
        </div>
      ),
      records: computed(() => records.get()),
      bases: computed(() => bases.get()),
      tables: computed(() => tables.get()),
      selectedBaseId,
      selectedTableId,
      selectedBaseName,
      selectedTableName,
      recordCount,
    };
  },
);

// ============================================================================
// HELPERS
// ============================================================================

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => formatCellValue(v)).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
