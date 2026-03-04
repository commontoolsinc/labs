/// <cts-enable />
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

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

interface Input {
  selectedBaseId: Default<string, "">;
  selectedTableId: Default<string, "">;
}

/** Import records from an Airtable base. #airtableImporter */
interface Output {
  records: AirtableRecordData[];
  bases: Array<{ id: string; name: string }>;
  tables: Array<{ id: string; name: string }>;
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
    bases: Writable<Array<{ id: string; name: string }>>;
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
  { baseId: string },
  {
    auth: Writable<AirtableAuth>;
    tables: Writable<Array<{ id: string; name: string }>>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (event, { auth, tables, loading, error }) => {
  const baseId = event.baseId;
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
  { baseId: string; tableId: string },
  {
    auth: Writable<AirtableAuth>;
    records: Writable<AirtableRecordData[]>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (event, { auth, records, loading, error }) => {
  const { baseId, tableId } = event;
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

const selectBase = handler<
  { baseId: string },
  {
    selectedBaseId: Writable<string>;
    selectedTableId: Writable<string>;
    tables: Writable<Array<{ id: string; name: string }>>;
    records: Writable<AirtableRecordData[]>;
  }
>((_event, { selectedBaseId, selectedTableId, tables, records }) => {
  selectedBaseId.set(_event.baseId);
  selectedTableId.set("");
  tables.set([]);
  records.set([]);
});

const selectTable = handler<
  { tableId: string },
  {
    selectedTableId: Writable<string>;
    records: Writable<AirtableRecordData[]>;
  }
>((_event, { selectedTableId, records }) => {
  selectedTableId.set(_event.tableId);
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

    const auth = authResult as unknown as Writable<AirtableAuth>;

    // State
    const bases = Writable.of<Array<{ id: string; name: string }>>([]);
    const tables = Writable.of<Array<{ id: string; name: string }>>([]);
    const records = Writable.of<AirtableRecordData[]>([]);
    const loading = Writable.of(false);
    const error = Writable.of("");

    const hasBases = computed(() => (bases.get() as Array<unknown>).length > 0);
    const hasTables = computed(
      () => (tables.get() as Array<unknown>).length > 0,
    );
    const hasRecords = computed(
      () => (records.get() as AirtableRecordData[]).length > 0,
    );
    const recordCount = computed(
      () => (records.get() as AirtableRecordData[]).length,
    );

    const selectedBaseName = computed(() => {
      const id = selectedBaseId as unknown as string;
      if (!id) return "";
      const base = (bases.get() as Array<{ id: string; name: string }>).find(
        (b) => b.id === id,
      );
      return base?.name || id;
    });

    const selectedTableName = computed(() => {
      const id = selectedTableId as unknown as string;
      if (!id) return "";
      const table = (tables.get() as Array<{ id: string; name: string }>).find(
        (t) => t.id === id,
      );
      return table?.name || id;
    });

    // Bound handlers
    const boundFetchBases = fetchBases({ auth, bases, loading, error });
    const boundFetchTables = fetchTables({ auth, tables, loading, error });
    const boundFetchRecords = fetchRecords({
      auth,
      records,
      loading,
      error,
    });

    const boundSelectBase = selectBase({
      selectedBaseId: selectedBaseId as unknown as Writable<string>,
      selectedTableId: selectedTableId as unknown as Writable<string>,
      tables,
      records,
    });
    const boundSelectTable = selectTable({
      selectedTableId: selectedTableId as unknown as Writable<string>,
      records,
    });

    // Column headers extracted from first record
    const columnHeaders = computed(() => {
      const recs = records.get() as AirtableRecordData[];
      if (recs.length === 0) return [] as string[];
      const allKeys = new Set<string>();
      for (const rec of recs.slice(0, 10)) {
        for (const key of Object.keys(rec.fields)) {
          allKeys.add(key);
        }
      }
      return Array.from(allKeys);
    });

    // Has data flags
    const hasBaseSelected = computed(
      () => !!(selectedBaseId as unknown as string),
    );
    const hasTableSelected = computed(
      () => !!(selectedTableId as unknown as string),
    );

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
                    {computed(() =>
                      (bases.get() as Array<{ id: string; name: string }>).map(
                        (base) => (
                          <button
                            type="button"
                            onClick={boundSelectBase}
                            data-base-id={base.id}
                            style={{
                              padding: "10px 14px",
                              backgroundColor:
                                (selectedBaseId as unknown as string) ===
                                    base.id
                                  ? "#e0f2fe"
                                  : "white",
                              border: (selectedBaseId as unknown as string) ===
                                  base.id
                                ? "1px solid #18BFFF"
                                : "1px solid #e0e0e0",
                              borderRadius: "6px",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: "14px",
                              fontWeight:
                                (selectedBaseId as unknown as string) ===
                                    base.id
                                  ? "600"
                                  : "normal",
                            }}
                          >
                            {base.name}
                          </button>
                        ),
                      )
                    )}
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
                      {computed(() =>
                        (
                          tables.get() as Array<{ id: string; name: string }>
                        ).map((table) => (
                          <button
                            type="button"
                            onClick={boundSelectTable}
                            data-table-id={table.id}
                            style={{
                              padding: "10px 14px",
                              backgroundColor:
                                (selectedTableId as unknown as string) ===
                                    table.id
                                  ? "#e0f2fe"
                                  : "white",
                              border: (selectedTableId as unknown as string) ===
                                  table.id
                                ? "1px solid #18BFFF"
                                : "1px solid #e0e0e0",
                              borderRadius: "6px",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: "14px",
                              fontWeight:
                                (selectedTableId as unknown as string) ===
                                    table.id
                                  ? "600"
                                  : "normal",
                            }}
                          >
                            {table.name}
                          </button>
                        ))
                      )}
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
                              {computed(() =>
                                (columnHeaders as unknown as string[]).map(
                                  (h) => (
                                    <th
                                      style={{
                                        padding: "8px 12px",
                                        textAlign: "left",
                                        borderBottom: "2px solid #e0e0e0",
                                        fontWeight: "600",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {h}
                                    </th>
                                  ),
                                )
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {computed(() =>
                              (
                                records.get() as AirtableRecordData[]
                              ).map((rec) => (
                                <tr>
                                  {(columnHeaders as unknown as string[]).map(
                                    (h) => (
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
                                        {formatCellValue(rec.fields[h])}
                                      </td>
                                    ),
                                  )}
                                </tr>
                              ))
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
                computed(() => !!(error.get() as string)),
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
      records: computed(() => records.get() as AirtableRecordData[]),
      bases: computed(
        () => bases.get() as Array<{ id: string; name: string }>,
      ),
      tables: computed(
        () => tables.get() as Array<{ id: string; name: string }>,
      ),
      selectedBaseId: selectedBaseId as unknown as string,
      selectedTableId: selectedTableId as unknown as string,
      selectedBaseName: selectedBaseName as unknown as string,
      selectedTableName: selectedTableName as unknown as string,
      recordCount: recordCount as unknown as number,
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
