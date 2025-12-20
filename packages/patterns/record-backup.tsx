/// <cts-enable />
/**
 * Record Backup Pattern - Import/Export for Records
 *
 * Exports all Records in a space to a single JSON file and imports them back.
 * Designed for data survival after server wipes.
 *
 * Features:
 * - Discovers all Records using wish("/")
 * - Extracts module data using registry's fieldMapping
 * - Preserves wiki-links in notes as-is
 * - Includes trashed modules in export
 * - Per-module error handling on import
 */
import {
  Cell,
  computed,
  type Default,
  handler,
  lift,
  NAME,
  navigateTo,
  pattern,
  UI,
  wish,
} from "commontools";

import { createSubCharm, getDefinition } from "./record/registry.ts";
import type { SubCharmEntry, TrashedSubCharmEntry } from "./record/types.ts";
import Record from "./record.tsx";
import Note from "./note.tsx";

// ===== Export Format Types =====

interface ExportedModule {
  type: string;
  pinned: boolean;
  data: Record<string, unknown>;
}

interface ExportedTrashedModule extends ExportedModule {
  trashedAt: string;
}

interface ExportedRecord {
  localId: string;
  title: string;
  modules: ExportedModule[];
  trashedModules: ExportedTrashedModule[];
}

interface ExportData {
  version: string;
  exportDate: string;
  records: ExportedRecord[];
}

// ===== Import Result Types =====

interface ImportError {
  record: string;
  module: string;
  error: string;
}

interface ImportResult {
  success: boolean;
  imported: number;
  failed: number;
  errors: ImportError[];
}

// ===== Pattern Input/Output =====

interface Input {
  importJson: Default<string, "">;
}

interface Output {
  exportedJson: string;
  importJson: string;
  recordCount: number;
  importResult: ImportResult | null;
}

// ===== Type for Record charm =====

interface RecordCharm {
  "#record"?: boolean;
  title?: string;
  subCharms?: SubCharmEntry[];
  trashedSubCharms?: TrashedSubCharmEntry[];
}

// ===== Data Extraction =====

/**
 * Extract data from a module using the registry's fieldMapping
 */
function extractModuleData(
  charm: unknown,
  type: string,
): Record<string, unknown> {
  const def = getDefinition(type);
  if (!def?.fieldMapping) return {};

  const data: Record<string, unknown> = {};
  for (const field of def.fieldMapping) {
    // deno-lint-ignore no-explicit-any
    const value = (charm as any)?.[field];
    if (value !== undefined) {
      // Unwrap Cell values if needed
      // deno-lint-ignore no-explicit-any
      data[field] = (value as any)?.get ? (value as any).get() : value;
    }
  }
  return data;
}

/**
 * Build export data from all Records in the space
 */
const buildExportData = lift(
  ({ allCharms }: { allCharms: RecordCharm[] }): ExportData => {
    // Filter to only Record patterns
    const records = (allCharms || []).filter(
      (charm) => charm?.["#record"] === true,
    );

    const exportedRecords: ExportedRecord[] = records.map((record, index) => {
      const localId = `record-${String(index + 1).padStart(3, "0")}`;
      const title = record?.title || "(Untitled Record)";

      // Extract active modules
      const subCharms = record?.subCharms || [];
      const modules: ExportedModule[] = subCharms
        .filter((entry: SubCharmEntry) => {
          const def = getDefinition(entry.type);
          // Skip internal modules (like type-picker)
          return def && !def.internal;
        })
        .map((entry: SubCharmEntry) => ({
          type: entry.type,
          pinned: entry.pinned,
          data: extractModuleData(entry.charm, entry.type),
        }));

      // Extract trashed modules
      const trashedSubCharms = record?.trashedSubCharms || [];
      const trashedModules: ExportedTrashedModule[] = trashedSubCharms
        .filter((entry: TrashedSubCharmEntry) => {
          const def = getDefinition(entry.type);
          return def && !def.internal;
        })
        .map((entry: TrashedSubCharmEntry) => ({
          type: entry.type,
          pinned: entry.pinned,
          data: extractModuleData(entry.charm, entry.type),
          trashedAt: entry.trashedAt,
        }));

      return {
        localId,
        title,
        modules,
        trashedModules,
      };
    });

    return {
      version: "1.0",
      exportDate: new Date().toISOString(),
      records: exportedRecords,
    };
  },
);

/**
 * Format export data as pretty-printed JSON
 */
const formatExportJson = lift(
  ({ exportData }: { exportData: ExportData }): string => {
    return JSON.stringify(exportData, null, 2);
  },
);

/**
 * Count records in export
 */
const countRecords = lift(
  ({ exportData }: { exportData: ExportData }): number => {
    return exportData?.records?.length || 0;
  },
);

// ===== Import Logic =====

/**
 * Parse and validate import JSON
 */
function parseImportJson(jsonText: string): {
  valid: boolean;
  data?: ExportData;
  error?: string;
} {
  if (!jsonText || jsonText.trim() === "") {
    return { valid: false, error: "No JSON provided" };
  }

  try {
    const parsed = JSON.parse(jsonText);

    // Validate structure
    if (!parsed || typeof parsed !== "object") {
      return { valid: false, error: "Invalid JSON: expected an object" };
    }

    if (parsed.version !== "1.0") {
      return {
        valid: false,
        error: `Unsupported version: ${parsed.version || "missing"}`,
      };
    }

    if (!Array.isArray(parsed.records)) {
      return { valid: false, error: 'Missing or invalid "records" array' };
    }

    return { valid: true, data: parsed as ExportData };
  } catch (e) {
    return { valid: false, error: `JSON parse error: ${e}` };
  }
}

/**
 * Create a module from imported data
 * Returns the charm instance or null if type is unknown
 */
function createModuleFromData(
  type: string,
  data: Record<string, unknown>,
  recordPatternJson: string,
): unknown | null {
  // Special handling for notes - needs embedded flag and linkPattern
  if (type === "notes") {
    return Note({
      content: (data.content as string) || (data.notes as string) || "",
      embedded: true,
      linkPattern: recordPatternJson,
      // deno-lint-ignore no-explicit-any
    } as any);
  }

  // Check if type is known
  const def = getDefinition(type);
  if (!def) {
    return null; // Unknown type
  }

  // Create module with imported data
  return createSubCharm(type, data);
}

/**
 * Handler to import records from JSON
 */
const importRecords = handler<
  Record<string, never>,
  {
    importJson: Cell<string>;
    allCharms: Cell<RecordCharm[]>;
    importResult: Cell<ImportResult | null>;
  }
>((_, { importJson, allCharms, importResult }) => {
  const jsonText = importJson.get();
  const parseResult = parseImportJson(jsonText);

  if (!parseResult.valid || !parseResult.data) {
    importResult.set({
      success: false,
      imported: 0,
      failed: 0,
      errors: [{
        record: "",
        module: "",
        error: parseResult.error || "Unknown error",
      }],
    });
    return;
  }

  const exportData = parseResult.data;
  const result: ImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: [],
  };

  // Get Record pattern JSON for wiki-links in Notes
  const recordPatternJson = JSON.stringify(Record);

  // Create all records
  const createdRecords: unknown[] = [];

  for (const recordData of exportData.records) {
    try {
      // Create modules for this record
      const subCharms: SubCharmEntry[] = [];

      for (const moduleData of recordData.modules) {
        try {
          const charm = createModuleFromData(
            moduleData.type,
            moduleData.data,
            recordPatternJson,
          );

          if (charm === null) {
            // Unknown module type - skip with warning
            result.errors.push({
              record: recordData.title,
              module: moduleData.type,
              error: `Unknown module type: ${moduleData.type}`,
            });
            result.failed++;
            continue;
          }

          subCharms.push({
            type: moduleData.type,
            pinned: moduleData.pinned,
            charm,
          });
        } catch (e) {
          result.errors.push({
            record: recordData.title,
            module: moduleData.type,
            error: String(e),
          });
          result.failed++;
        }
      }

      // Create trashed modules
      const trashedSubCharms: TrashedSubCharmEntry[] = [];

      for (const moduleData of recordData.trashedModules) {
        try {
          const charm = createModuleFromData(
            moduleData.type,
            moduleData.data,
            recordPatternJson,
          );

          if (charm === null) {
            result.errors.push({
              record: recordData.title,
              module: `${moduleData.type} (trashed)`,
              error: `Unknown module type: ${moduleData.type}`,
            });
            result.failed++;
            continue;
          }

          trashedSubCharms.push({
            type: moduleData.type,
            pinned: moduleData.pinned,
            charm,
            trashedAt: moduleData.trashedAt,
          });
        } catch (e) {
          result.errors.push({
            record: recordData.title,
            module: `${moduleData.type} (trashed)`,
            error: String(e),
          });
          result.failed++;
        }
      }

      // Create the Record with all its modules
      // deno-lint-ignore no-explicit-any
      const record = (Record as any)({
        title: recordData.title,
        subCharms: subCharms,
        trashedSubCharms: trashedSubCharms,
      });

      // Push to allCharms to persist
      allCharms.push(record as RecordCharm);
      createdRecords.push(record);
      result.imported++;
    } catch (e) {
      result.errors.push({
        record: recordData.title,
        module: "",
        error: String(e),
      });
      result.success = false;
    }
  }

  // Update result
  if (result.failed > 0) {
    result.success = result.imported > 0; // Partial success
  }

  importResult.set(result);

  // Clear import field on success
  if (result.imported > 0) {
    importJson.set("");
  }

  // Navigate to first imported record
  if (createdRecords.length > 0) {
    return navigateTo(createdRecords[0]);
  }
});

/**
 * Handler to clear import result
 */
const clearImportResult = handler<
  Record<string, never>,
  { importResult: Cell<ImportResult | null> }
>((_, { importResult }) => {
  importResult.set(null);
});

// ===== The Pattern =====

export default pattern<Input, Output>(({ importJson }) => {
  // Get all charms in the space
  const { allCharms } = wish<{ allCharms: RecordCharm[] }>("/");

  // Build export data
  const exportData = buildExportData({ allCharms });
  const exportedJson = formatExportJson({ exportData });
  const recordCount = countRecords({ exportData });

  // Import result state
  const importResult = Cell.of<ImportResult | null>(null);

  return {
    [NAME]: computed(() => `Record Backup (${recordCount} records)`),
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <div slot="start">
            <span style={{ fontWeight: "bold" }}>Record Backup</span>
          </div>
        </ct-toolbar>

        <ct-vscroll flex showScrollbar>
          <ct-vstack gap="6" padding="6">
            {/* Export Section */}
            <ct-card>
              <ct-vstack gap="4">
                <h2>Export Records</h2>
                <p>
                  Found <strong>{recordCount}</strong>{" "}
                  records in this space. Copy the JSON below to save your data.
                </p>
                <ct-code-editor
                  $value={exportedJson}
                  language="application/json"
                  theme="light"
                  wordWrap
                  lineNumbers
                  style={{
                    minHeight: "200px",
                    maxHeight: "400px",
                    overflow: "auto",
                  }}
                  readonly
                />
              </ct-vstack>
            </ct-card>

            {/* Import Section */}
            <ct-card>
              <ct-vstack gap="4">
                <h2>Import Records</h2>
                <p>
                  Paste previously exported JSON below to restore your records.
                </p>
                <ct-code-editor
                  $value={importJson}
                  language="application/json"
                  theme="light"
                  wordWrap
                  lineNumbers
                  style={{
                    minHeight: "200px",
                    maxHeight: "400px",
                    overflow: "auto",
                  }}
                  placeholder={`{
  "version": "1.0",
  "exportDate": "...",
  "records": [...]
}`}
                />
                <ct-button
                  onClick={importRecords({
                    importJson,
                    allCharms,
                    importResult,
                  })}
                >
                  Import Records
                </ct-button>

                {/* Import Result Display */}
                {importResult && (
                  <div
                    style={{
                      padding: "12px",
                      borderRadius: "8px",
                      background: computed(() =>
                        importResult.get()?.success ? "#f0fdf4" : "#fef2f2"
                      ),
                      border: computed(() =>
                        `1px solid ${
                          importResult.get()?.success ? "#86efac" : "#fca5a5"
                        }`
                      ),
                    }}
                  >
                    <ct-vstack gap="2">
                      <strong>
                        {computed(() =>
                          importResult.get()?.success
                            ? "Import Complete"
                            : "Import Issues"
                        )}
                      </strong>
                      <p>
                        Imported{" "}
                        {computed(() => importResult.get()?.imported || 0)}{" "}
                        record(s)
                        {computed(() => {
                          const r = importResult.get();
                          return r && r.failed > 0
                            ? `, ${r.failed} module(s) failed`
                            : "";
                        })}
                      </p>
                      {computed(() => {
                        const r = importResult.get();
                        if (r && r.errors.length > 0) {
                          return (
                            <details>
                              <summary style={{ cursor: "pointer" }}>
                                Errors ({r.errors.length})
                              </summary>
                              <ul
                                style={{ fontSize: "12px", marginTop: "8px" }}
                              >
                                {r.errors.map((err, i) => (
                                  <li key={i}>
                                    {err.record && (
                                      <strong>{err.record}:</strong>
                                    )}
                                    {err.module && <span>{err.module} -</span>}
                                    {err.error}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          );
                        }
                        return null;
                      })}
                      <ct-button
                        size="sm"
                        variant="ghost"
                        onClick={clearImportResult({ importResult })}
                      >
                        Dismiss
                      </ct-button>
                    </ct-vstack>
                  </div>
                )}
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    exportedJson,
    importJson,
    recordCount,
    importResult,
  };
});
