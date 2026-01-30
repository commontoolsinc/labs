/// <cts-enable />
/**
 * Record Backup Pattern - Import/Export for Records
 *
 * Exports all Records in a space to a single JSON file and imports them back.
 * Designed for data survival after server wipes.
 *
 * Features:
 * - Discovers all Records using wish("#default")
 * - Extracts module data using registry's fieldMapping
 * - Preserves wiki-links in notes as-is
 * - Includes trashed modules in export
 * - Per-module error handling on import
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

import { createSubPiece, getDefinition } from "./record/registry.ts";
import type { SubPieceEntry, TrashedSubPieceEntry } from "./record/types.ts";
import Record from "./record.tsx";
import Note from "./notes/note.tsx";

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

// ===== Type for Record piece =====

interface RecordPiece {
  "#record"?: boolean;
  title?: string;
  subPieces?: SubPieceEntry[];
  trashedSubPieces?: TrashedSubPieceEntry[];
}

// ===== Data Extraction =====

/**
 * Coerce data types to match schema expectations
 * Handles common type mismatches (e.g., "1986" string → 1986 number)
 * Used by both export (to fix ct-input storing numbers as strings)
 * and import (to handle JSON that may have wrong types)
 */
function coerceDataTypes(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const def = getDefinition(type);
  if (!def?.schema) return data;

  const coerced = { ...data };

  for (const [field, schema] of Object.entries(def.schema)) {
    const value = coerced[field];
    // deno-lint-ignore no-explicit-any
    const fieldSchema = schema as any;

    if (value === undefined || value === null || value === "") continue;

    // Coerce string to number if schema expects number
    if (fieldSchema.type === "number" && typeof value === "string") {
      const parsed = Number(value);
      if (!isNaN(parsed)) {
        coerced[field] = parsed;
      }
    }
  }

  return coerced;
}

/**
 * Extract data from a module using the registry's fieldMapping
 * Also coerces types to match schema (e.g., string "1986" → number 1986)
 */
function extractModuleData(
  piece: unknown,
  type: string,
): Record<string, unknown> {
  const def = getDefinition(type);
  if (!def?.fieldMapping) return {};

  // Validate piece is an object
  if (piece == null || typeof piece !== "object") {
    console.warn(`Invalid piece for type "${type}": expected object`);
    return {};
  }

  const data: Record<string, unknown> = {};
  for (const field of def.fieldMapping) {
    try {
      // deno-lint-ignore no-explicit-any
      const value = (piece as any)?.[field];
      if (value !== undefined) {
        // Unwrap Cell values if needed, with error handling
        // deno-lint-ignore no-explicit-any
        data[field] = (value as any)?.get ? (value as any).get() : value;
      }
    } catch (e) {
      // Cell.get() or other operations may throw
      console.warn(`Failed to extract field "${field}" from ${type}:`, e);
      data[field] = null;
    }
  }

  // Coerce types to match schema (fixes ct-input storing numbers as strings)
  return coerceDataTypes(type, data);
}

/**
 * Build export data from all Records in the space
 */
const buildExportData = lift(
  ({ allPieces }: { allPieces: RecordPiece[] }): ExportData => {
    // Filter to only Record patterns
    const records = (allPieces || []).filter(
      (piece) => piece?.["#record"] === true,
    );

    const exportedRecords: ExportedRecord[] = records.map((record, index) => {
      const localId = `record-${String(index + 1).padStart(3, "0")}`;
      const title = record?.title || "(Untitled Record)";

      // Extract active modules
      const subPieces = record?.subPieces || [];
      const modules: ExportedModule[] = subPieces
        .filter((entry: SubPieceEntry) => {
          // Guard against undefined entries or missing piece
          if (!entry || !entry.type || entry.piece == null) return false;
          const def = getDefinition(entry.type);
          // Skip internal modules (like type-picker)
          return def && !def.internal;
        })
        .map((entry: SubPieceEntry) => ({
          type: entry.type,
          pinned: entry.pinned,
          data: extractModuleData(entry.piece, entry.type),
        }));

      // Extract trashed modules
      const trashedSubPieces = record?.trashedSubPieces || [];
      const trashedModules: ExportedTrashedModule[] = trashedSubPieces
        .filter((entry: TrashedSubPieceEntry) => {
          // Guard against undefined entries or missing piece
          if (!entry || !entry.type || entry.piece == null) return false;
          const def = getDefinition(entry.type);
          return def && !def.internal;
        })
        .map((entry: TrashedSubPieceEntry) => ({
          type: entry.type,
          pinned: entry.pinned,
          data: extractModuleData(entry.piece, entry.type),
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
      exportDate: Temporal.Now.instant().toString(),
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
 * Parse and validate import JSON with comprehensive structure checking
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

    // Validate top-level structure
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

    // Validate each record structure
    for (let i = 0; i < parsed.records.length; i++) {
      const record = parsed.records[i];

      if (!record || typeof record !== "object") {
        return { valid: false, error: `Record ${i}: not an object` };
      }

      if (typeof record.title !== "string") {
        return { valid: false, error: `Record ${i}: missing or invalid title` };
      }

      if (!Array.isArray(record.modules)) {
        return { valid: false, error: `Record ${i}: modules must be an array` };
      }

      if (!Array.isArray(record.trashedModules)) {
        return {
          valid: false,
          error: `Record ${i}: trashedModules must be an array`,
        };
      }

      // Validate module structure
      for (let j = 0; j < record.modules.length; j++) {
        const mod = record.modules[j];
        if (!mod || typeof mod !== "object") {
          return { valid: false, error: `Record ${i}, module ${j}: invalid` };
        }
        if (typeof mod.type !== "string") {
          return {
            valid: false,
            error: `Record ${i}, module ${j}: missing type`,
          };
        }
        if (typeof mod.pinned !== "boolean") {
          return {
            valid: false,
            error: `Record ${i}, module ${j}: pinned must be boolean`,
          };
        }
        if (!mod.data || typeof mod.data !== "object") {
          return {
            valid: false,
            error: `Record ${i}, module ${j}: data must be an object`,
          };
        }
      }

      // Validate trashed module structure
      for (let j = 0; j < record.trashedModules.length; j++) {
        const mod = record.trashedModules[j];
        if (!mod || typeof mod !== "object") {
          return {
            valid: false,
            error: `Record ${i}, trashed ${j}: invalid`,
          };
        }
        if (typeof mod.type !== "string") {
          return {
            valid: false,
            error: `Record ${i}, trashed ${j}: missing type`,
          };
        }
        if (typeof mod.trashedAt !== "string") {
          return {
            valid: false,
            error: `Record ${i}, trashed ${j}: missing trashedAt`,
          };
        }
      }
    }

    return { valid: true, data: parsed as ExportData };
  } catch (e) {
    return { valid: false, error: `JSON parse error: ${e}` };
  }
}

/**
 * Create a module from imported data
 * Returns the piece instance or null if type is unknown
 * Throws if module creation fails
 */
function createModuleFromData(
  type: string,
  data: Record<string, unknown>,
  recordPatternJson: string,
): unknown | null {
  // Special handling for notes - needs embedded flag and linkPattern
  if (type === "notes") {
    // Type-safe content extraction
    let content = "";
    if (typeof data.content === "string") {
      content = data.content;
    } else if (typeof data.notes === "string") {
      // Fallback for legacy field name
      content = data.notes;
    }
    // Silently use empty string for non-string values

    const note = Note({
      content,
      embedded: true,
      linkPattern: recordPatternJson,
      // deno-lint-ignore no-explicit-any
    } as any);

    if (!note) {
      throw new Error("Note constructor returned null/undefined");
    }
    return note;
  }

  // Check if type is known
  const def = getDefinition(type);
  if (!def) {
    return null; // Unknown type - handled by caller
  }

  // Coerce data types to match schema
  const coercedData = coerceDataTypes(type, data);

  // Create module with imported data
  const piece = createSubPiece(type, coercedData);
  if (!piece) {
    throw new Error(`createSubPiece for "${type}" returned null/undefined`);
  }
  return piece;
}

/**
 * Handler to import records from JSON
 */
const importRecords = handler<
  Record<string, never>,
  {
    importJson: Writable<string>;
    allPieces: Writable<RecordPiece[]>;
    importResult: Writable<ImportResult | null>;
  }
>((_, { importJson, allPieces, importResult }) => {
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
      const subPieces: SubPieceEntry[] = [];

      for (const moduleData of recordData.modules) {
        try {
          const piece = createModuleFromData(
            moduleData.type,
            moduleData.data,
            recordPatternJson,
          );

          if (piece === null) {
            // Unknown module type - skip with warning
            result.errors.push({
              record: recordData.title,
              module: moduleData.type,
              error: `Unknown module type: ${moduleData.type}`,
            });
            result.failed++;
            continue;
          }

          subPieces.push({
            type: moduleData.type,
            pinned: moduleData.pinned,
            piece,
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
      const trashedSubPieces: TrashedSubPieceEntry[] = [];

      for (const moduleData of recordData.trashedModules) {
        try {
          const piece = createModuleFromData(
            moduleData.type,
            moduleData.data,
            recordPatternJson,
          );

          if (piece === null) {
            result.errors.push({
              record: recordData.title,
              module: `${moduleData.type} (trashed)`,
              error: `Unknown module type: ${moduleData.type}`,
            });
            result.failed++;
            continue;
          }

          trashedSubPieces.push({
            type: moduleData.type,
            pinned: moduleData.pinned,
            piece,
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
        subPieces: subPieces,
        trashedSubPieces: trashedSubPieces,
      });

      // Push to allPieces to persist
      allPieces.push(record as RecordPiece);
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
  { importResult: Writable<ImportResult | null> }
>((_, { importResult }) => {
  importResult.set(null);
});

/**
 * Handler to process uploaded file
 */
const handleFileUpload = handler<
  { detail: { files: Array<{ data: string; name: string }> } },
  { importJson: Writable<string> }
>(({ detail }, { importJson }) => {
  const files = detail?.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  // data is a data URL, need to extract the JSON content
  const dataUrl = file.data;
  const base64Match = dataUrl.match(/base64,(.+)/);
  if (base64Match) {
    try {
      const jsonContent = atob(base64Match[1]);
      importJson.set(jsonContent);
    } catch (e) {
      console.error("Failed to decode file:", e);
    }
  }
});

// ===== The Pattern =====

export default pattern<Input, Output>(({ importJson }) => {
  // Get all pieces in the space
  const { allPieces } = wish<{ allPieces: RecordPiece[] }>("#default");

  // Build export data
  const exportData = buildExportData({ allPieces });
  const exportedJson = formatExportJson({ exportData });
  const recordCount = countRecords({ exportData });

  // Import result state
  const importResult = Writable.of<ImportResult | null>(null);

  // Computed values for import result display
  const hasImportResult = computed(() => importResult.get() !== null);

  const importResultBg = computed(() =>
    importResult.get()?.success ? "#f0fdf4" : "#fef2f2"
  );

  const importResultBorder = computed(() =>
    `1px solid ${importResult.get()?.success ? "#86efac" : "#fca5a5"}`
  );

  const importResultTitle = computed(() =>
    importResult.get()?.success ? "Import Complete" : "Import Issues"
  );

  const importResultMessage = computed(() => {
    const r = importResult.get();
    if (!r) return "";
    const msg = `Imported ${r.imported || 0} record(s)`;
    if (r.failed > 0) {
      return `${msg}, ${r.failed} module(s) failed`;
    }
    return msg;
  });

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
                <ct-file-download
                  $data={exportedJson}
                  filename={`record-backup-${
                    Temporal.Now.instant().toString().slice(0, 10)
                  }.json`}
                  mimeType="application/json"
                  variant="primary"
                  allowAutosave
                >
                  Download Backup
                </ct-file-download>
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
                  Upload a backup file or paste JSON to restore your records.
                </p>
                <ct-file-input
                  accept=".json,application/json"
                  buttonText="📤 Upload Backup File"
                  showPreview={false}
                  onct-change={handleFileUpload({ importJson })}
                />
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
                    allPieces,
                    importResult,
                  })}
                  variant="primary"
                >
                  Import Records
                </ct-button>

                {/* Import Result Display */}
                {ifElse(
                  hasImportResult,
                  <div
                    style={{
                      padding: "12px",
                      borderRadius: "8px",
                      background: importResultBg,
                      border: importResultBorder,
                    }}
                  >
                    <ct-vstack gap="2">
                      <strong>{importResultTitle}</strong>
                      <p>{importResultMessage}</p>
                      <ct-button
                        size="sm"
                        variant="ghost"
                        onClick={clearImportResult({ importResult })}
                      >
                        Dismiss
                      </ct-button>
                    </ct-vstack>
                  </div>,
                  null,
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
