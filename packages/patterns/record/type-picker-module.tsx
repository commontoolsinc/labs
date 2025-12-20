/// <cts-enable />
/**
 * TypePicker Module - Controller sub-charm for selecting record type
 *
 * This is a "controller module" - it doesn't just store data, it ACTS on
 * the parent record's state. It receives the parent's Cells as INPUT,
 * which allows it to modify the parent's subCharms list.
 *
 * Key architecture decisions:
 * - Receives parentSubCharms and parentTrashedSubCharms as INPUT Cells
 * - Cells passed as INPUT survive serialization (SigilLinks with overwrite: redirect)
 * - Can call .get() and .set() on parent Cells from handlers
 * - Trashes itself after applying a template
 *
 * See: community-docs/superstitions/2025-12-19-auto-init-use-two-lift-pattern.md
 */

import { Cell, type Default, handler, NAME, pattern, UI } from "commontools";
import {
  createTemplateModules,
  getTemplateList,
  type TemplateDefinition,
} from "./template-registry.ts";
import type { SubCharmEntry, TrashedSubCharmEntry } from "./types.ts";
// Import Note directly for creating with correct linkPattern
import Note from "../note.tsx";

// ===== Types =====

interface TypePickerInput {
  // Parent's Cells - passed as INPUT so they survive serialization
  parentSubCharms: Cell<SubCharmEntry[]>;
  parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
  // Record pattern JSON for creating Notes with correct wiki-link target
  // deno-lint-ignore no-explicit-any
  recordPatternJson?: any;
  // Internal state
  dismissed?: Default<boolean, false>;
}

interface TypePickerOutput {
  dismissed?: Default<boolean, false>;
}

// ===== Handlers =====

// Apply a template and trash self
// Note: We find self by type "type-picker" since there should only be one
const applyTemplate = handler<
  unknown,
  {
    parentSubCharms: Cell<SubCharmEntry[]>;
    parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    templateId: string;
    // deno-lint-ignore no-explicit-any
    recordPatternJson?: any;
  }
>((
  _event,
  { parentSubCharms, parentTrashedSubCharms, templateId, recordPatternJson },
) => {
  const current = parentSubCharms.get() || [];

  // Find and keep the notes module (should be first)
  const notesEntry = current.find((e) => e?.type === "notes");
  if (!notesEntry) {
    console.warn("TypePicker: No notes module found, cannot apply template");
    return;
  }

  // Find self by type (there should only be one type-picker)
  const selfEntry = current.find((e) => e?.type === "type-picker");

  // Create factory for Notes with correct linkPattern
  // deno-lint-ignore no-explicit-any
  const createNotesCharm = () =>
    Note({
      embedded: true,
      linkPattern: recordPatternJson,
    } as any);

  // Create template modules (skip notes since we keep existing one)
  const templateEntries = createTemplateModules(templateId, createNotesCharm);
  const newModules = templateEntries.filter((e) => e.type !== "notes");

  // Build new list: notes + new template modules (excluding type-picker)
  const updatedList = [
    notesEntry,
    ...newModules,
    ...current.filter((e) => e?.type !== "notes" && e?.type !== "type-picker"),
  ];

  parentSubCharms.set(updatedList);

  // Trash self
  if (selfEntry) {
    const trashedSelf: TrashedSubCharmEntry = {
      ...selfEntry,
      trashedAt: new Date().toISOString(),
    };
    parentTrashedSubCharms.push(trashedSelf);
  }
});

// Dismiss without applying (user can restore from trash)
// Note: We find self by type "type-picker" since there should only be one
const dismiss = handler<
  unknown,
  {
    parentSubCharms: Cell<SubCharmEntry[]>;
    parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
  }
>((_event, { parentSubCharms, parentTrashedSubCharms }) => {
  const current = parentSubCharms.get() || [];

  // Find self by type
  const selfEntry = current.find((e) => e?.type === "type-picker");
  if (!selfEntry) return;

  // Remove from active list
  parentSubCharms.set(current.filter((e) => e?.type !== "type-picker"));

  // Add to trash
  const trashedSelf: TrashedSubCharmEntry = {
    ...selfEntry,
    trashedAt: new Date().toISOString(),
  };
  parentTrashedSubCharms.push(trashedSelf);
});

// ===== The Pattern =====

export const TypePickerModule = pattern<TypePickerInput, TypePickerOutput>(
  (
    { parentSubCharms, parentTrashedSubCharms, recordPatternJson, dismissed },
  ) => {
    // Get templates to display (excluding blank)
    const templates = getTemplateList().filter(
      (t: TemplateDefinition) => t.id !== "blank",
    );

    return {
      [NAME]: "Choose Type",
      [UI]: (
        <div
          style={{
            background: "linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)",
            borderRadius: "8px",
            padding: "16px",
          }}
        >
          <div
            style={{
              marginBottom: "12px",
              color: "#0369a1",
              fontWeight: "500",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>What kind of record is this?</span>
            <button
              type="button"
              onClick={dismiss({ parentSubCharms, parentTrashedSubCharms })}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "#6b7280",
                fontSize: "16px",
                padding: "4px",
              }}
              title="Dismiss (can restore from trash)"
            >
              ✕
            </button>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            {templates.map((template: TemplateDefinition) => (
              <button
                type="button"
                onClick={applyTemplate({
                  parentSubCharms,
                  parentTrashedSubCharms,
                  templateId: template.id,
                  recordPatternJson,
                })}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "70px",
                  height: "70px",
                  background: "white",
                  border: "1px solid #bae6fd",
                  borderRadius: "8px",
                  cursor: "pointer",
                  gap: "4px",
                  transition: "all 0.15s ease",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                }}
                title={template.description}
              >
                <span style={{ fontSize: "24px" }}>{template.icon}</span>
                <span style={{ fontSize: "11px", color: "#0369a1" }}>
                  {template.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      ),
      dismissed,
    };
  },
);

export default TypePickerModule;
