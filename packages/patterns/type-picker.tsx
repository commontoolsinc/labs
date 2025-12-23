/// <cts-enable />
/**
 * TypePicker Module - Controller pattern for selecting record type
 *
 * This is a "controller module" - it doesn't just store data, it ACTS on
 * the parent container's state. It uses the ContainerCoordinationContext
 * protocol to modify the parent's entries list.
 *
 * Key architecture:
 * - Receives ContainerCoordinationContext as INPUT
 * - Context's entries/trashedEntries are Cells that survive serialization
 * - Can call .get() and .set() on context Cells from handlers
 * - Trashes itself after applying a template
 *
 * See: community-docs/superstitions/2025-12-19-auto-init-use-two-lift-pattern.md
 */

import { Cell, type Default, handler, NAME, pattern, UI } from "commontools";
import type {
  ContainerCoordinationContext,
  ModuleMetadata,
} from "./container-protocol.ts";
import {
  createTemplateModules,
  getTemplateList,
  type TemplateDefinition,
} from "./record/template-registry.ts";
import type { SubCharmEntry, TrashedSubCharmEntry } from "./record/types.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "type-picker",
  label: "Type Picker",
  icon: "\u{1F3AF}", // target emoji
  internal: true, // Don't show in Add dropdown
};

// ===== Types =====

interface TypePickerInput {
  // Container coordination context - passed from parent
  context: ContainerCoordinationContext<SubCharmEntry>;
  // Internal state
  dismissed?: Default<boolean, false>;
}

interface TypePickerOutput {
  dismissed?: Default<boolean, false>;
}

// ===== Handlers =====

// Apply a template and trash self
// Note: We find self by type "type-picker" since there should only be one
// Handler receives the context components separately for proper typing
const applyTemplate = handler<
  unknown,
  {
    entries: Cell<SubCharmEntry[]>;
    trashedEntries: Cell<TrashedSubCharmEntry[]>;
    // deno-lint-ignore no-explicit-any
    createModule: any;
    templateId: string;
  }
>((_event, { entries, trashedEntries, createModule, templateId }) => {
  const current = entries.get() || [];

  // Find and keep the notes module (should be first)
  const notesEntry = current.find((e) => e?.type === "notes");
  if (!notesEntry) {
    console.warn("TypePicker: No notes module found, cannot apply template");
    return;
  }

  // Find self by type (there should only be one type-picker)
  const selfEntry = current.find((e) => e?.type === "type-picker");

  // Create factory for Notes using context's createModule
  const createNotesCharm = () => createModule("notes");

  // Create template modules (skip notes since we keep existing one)
  const templateEntries = createTemplateModules(templateId, createNotesCharm);
  const newModules = templateEntries.filter((e) => e.type !== "notes");

  // Build new list: notes + new template modules (excluding type-picker)
  const updatedList = [
    notesEntry,
    ...newModules,
    ...current.filter((e) => e?.type !== "notes" && e?.type !== "type-picker"),
  ];

  entries.set(updatedList);

  // Trash self
  if (selfEntry) {
    const trashedSelf: TrashedSubCharmEntry = {
      ...selfEntry,
      trashedAt: new Date().toISOString(),
    };
    trashedEntries.push(trashedSelf);
  }
});

// Dismiss without applying (user can restore from trash)
// Note: We find self by type "type-picker" since there should only be one
const dismiss = handler<
  unknown,
  {
    entries: Cell<SubCharmEntry[]>;
    trashedEntries: Cell<TrashedSubCharmEntry[]>;
  }
>((_event, { entries, trashedEntries }) => {
  const current = entries.get() || [];

  // Find self by type
  const selfEntry = current.find((e) => e?.type === "type-picker");
  if (!selfEntry) return;

  // Remove from active list
  entries.set(current.filter((e) => e?.type !== "type-picker"));

  // Add to trash
  const trashedSelf: TrashedSubCharmEntry = {
    ...selfEntry,
    trashedAt: new Date().toISOString(),
  };
  trashedEntries.push(trashedSelf);
});

// ===== The Pattern =====

export const TypePickerModule = pattern<TypePickerInput, TypePickerOutput>(
  ({ context, dismissed }) => {
    // Extract context components for handlers
    const { entries, trashedEntries, createModule } = context;

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
              onClick={dismiss({ entries, trashedEntries })}
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
                  entries,
                  trashedEntries,
                  createModule,
                  templateId: template.id,
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
