/// <cts-enable />
/**
 * Custom Field Module - Generic property/value pairs for structured data
 *
 * A "catch-all" module for capturing properties that don't fit existing typed modules.
 * Supports multiple value types: text, number, date, boolean, url.
 *
 * Key features:
 * - Multi-instance: Users can add many custom fields
 * - Array extraction: LLM extracts multiple fields at once
 * - Always available: Schema included in extraction even without existing instances
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Types =====

export type CustomFieldValueType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "url";

export const VALUE_TYPE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes/No" },
  { value: "url", label: "URL" },
];

// ===== Self-Describing Metadata =====

export const MODULE_METADATA: ModuleMetadata = {
  type: "custom-field",
  label: "Custom Field",
  icon: "\u{1F4CB}", // clipboard emoji
  allowMultiple: true,
  // Special extraction flags:
  // - alwaysExtract: Include in extraction schema even with no instances
  // - extractionMode: "array" means each array item creates a separate module instance
  alwaysExtract: true,
  extractionMode: "array",
  schema: {
    customFields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fieldName: {
            type: "string",
            description: "The property name (e.g., 'Employee ID', 'SKU')",
          },
          fieldValue: {
            type: "string",
            description: "The property value",
          },
          fieldType: {
            type: "string",
            enum: ["text", "number", "date", "boolean", "url"],
            description:
              "Value type - use 'number' for IDs/quantities, 'date' for dates, 'boolean' for yes/no, 'url' for links, 'text' for everything else",
          },
        },
        required: ["fieldName", "fieldValue"],
      },
      description:
        "Custom properties that don't fit other structured modules. Only extract clearly structured data like IDs, codes, explicit measurements. Do NOT extract vague preferences, opinions, or conversational text.",
    },
  },
  fieldMapping: ["customFields"],
};

// ===== Input/Output Types =====

export interface CustomFieldModuleInput {
  /** Field name (e.g., "Employee ID", "SKU") */
  name: Default<string, "">;
  /** Field value (stored as string, parsed by UI) */
  value: Default<string, "">;
  /** Value type determines input UI */
  valueType: Default<CustomFieldValueType, "text">;
}

// Output interface with unknown for UI properties to prevent OOM (CT-1148)
interface CustomFieldModuleOutput {
  [NAME]: unknown;
  [UI]: unknown;
  name: string;
  value: string;
  valueType: CustomFieldValueType;
}

// ===== Handlers =====

// Handler to toggle boolean value
const toggleBoolean = handler<
  unknown,
  { value: Writable<string> }
>((_event, { value }) => {
  const current = (value.get() || "").toLowerCase();
  const isTrue = current === "true" || current === "yes" || current === "1";
  value.set(isTrue ? "false" : "true");
});

// ===== The Pattern =====

export const CustomFieldModule = pattern<
  CustomFieldModuleInput,
  CustomFieldModuleOutput
>("CustomFieldModule", ({ name, value, valueType }) => {
  // Format display value based on type
  const displayValue = computed(() => {
    const v = String(value || "");
    const t = String(valueType) as CustomFieldValueType;

    if (!v) return "(empty)";

    switch (t) {
      case "boolean": {
        const lower = v.toLowerCase();
        return lower === "true" || lower === "yes" || lower === "1"
          ? "Yes"
          : "No";
      }
      case "url": {
        try {
          const url = new URL(v.startsWith("http") ? v : `https://${v}`);
          return url.hostname;
        } catch {
          return v;
        }
      }
      default:
        return v;
    }
  });

  // Check value type for conditional rendering
  const isText = computed(() => String(valueType) === "text");
  const isNumber = computed(() => String(valueType) === "number");
  const isDate = computed(() => String(valueType) === "date");
  const isBoolean = computed(() => String(valueType) === "boolean");
  const isUrl = computed(() => String(valueType) === "url");
  // Fallback for invalid valueType - treat as text
  const isFallback = computed(() => {
    const t = String(valueType);
    return !["text", "number", "date", "boolean", "url"].includes(t);
  });

  // For boolean type, compute the checked state
  const isChecked = computed(() => {
    const v = String(value || "").toLowerCase();
    return v === "true" || v === "yes" || v === "1";
  });

  // Display name for checkbox label
  const displayName = computed(() => {
    const n = String(name || "");
    return n || "Value";
  });

  // Sanitize URL to only allow http/https protocols (prevent javascript:/data: XSS)
  const safeUrl = computed(() => {
    const v = String(value || "").trim();
    if (!v) return "";
    // Add https if no protocol specified
    const urlWithProtocol = v.startsWith("http://") || v.startsWith("https://")
      ? v
      : `https://${v}`;
    // Only allow http/https protocols
    try {
      const url = new URL(urlWithProtocol);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return urlWithProtocol;
      }
      return ""; // Invalid protocol
    } catch {
      return ""; // Invalid URL
    }
  });

  return {
    [NAME]: computed(() => {
      const n = String(name || "");
      const dv = displayValue;
      if (!n) return `${MODULE_METADATA.icon} Custom Field`;
      return `${MODULE_METADATA.icon} ${n}: ${dv}`;
    }),
    [UI]: (
      <ct-vstack style={{ gap: "12px" }}>
        {/* Field name + type selector row */}
        <ct-hstack style={{ gap: "8px", alignItems: "flex-end" }}>
          <ct-vstack style={{ flex: 1, gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Field Name
            </label>
            <ct-input $value={name} placeholder="e.g., Employee ID..." />
          </ct-vstack>
          <ct-vstack style={{ width: "110px", gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Type</label>
            <ct-select $value={valueType} items={VALUE_TYPE_OPTIONS} />
          </ct-vstack>
        </ct-hstack>

        {/* Value input - type-specific */}
        <ct-vstack style={{ gap: "4px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>Value</label>

          {/* Text input */}
          {ifElse(
            isText,
            <ct-input $value={value} placeholder="Enter text..." />,
            null,
          )}

          {/* Number input */}
          {ifElse(
            isNumber,
            <ct-input
              type="number"
              $value={value}
              placeholder="Enter number..."
            />,
            null,
          )}

          {/* Date input */}
          {ifElse(isDate, <ct-input type="date" $value={value} />, null)}

          {/* Boolean checkbox */}
          {ifElse(
            isBoolean,
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                checked={isChecked}
                onClick={toggleBoolean({
                  value,
                })}
                style={{ width: "18px", height: "18px" }}
              />
              <span style={{ color: "#374151" }}>{displayName}</span>
            </div>,
            null,
          )}

          {/* URL input with preview */}
          {ifElse(
            isUrl,
            <ct-vstack style={{ gap: "8px" }}>
              <ct-input $value={value} placeholder="https://..." />
              {ifElse(
                computed(() => !!safeUrl),
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: "12px",
                    color: "#3b82f6",
                    textDecoration: "underline",
                  }}
                >
                  Open link ↗
                </a>,
                null,
              )}
            </ct-vstack>,
            null,
          )}

          {/* Fallback for invalid valueType */}
          {ifElse(
            isFallback,
            <ct-input $value={value} placeholder="Enter value..." />,
            null,
          )}
        </ct-vstack>
      </ct-vstack>
    ),
    name,
    value,
    valueType,
  };
});

export default CustomFieldModule;
