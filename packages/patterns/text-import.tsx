/// <cts-enable />
/**
 * Text Import Module - Pattern for importing text files
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Supports uploading text files (.txt, .md, .csv, .json) for
 * use as extraction sources.
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  NAME,
  pattern,
  str,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "text-import",
  label: "Text Import",
  icon: "\u{1F4C4}", // document emoji
  schema: {
    content: { type: "string", description: "Text file content" },
    filename: { type: "string", description: "Original filename" },
  },
  fieldMapping: ["content", "filename"],
  allowMultiple: true,
  hasSettings: false,
};

// ===== Types =====
export interface TextImportModuleInput {
  /** The text content from the uploaded file */
  content: Default<string, "">;
  /** The original filename */
  filename: Default<string, "">;
}

// Output interface with unknown for UI properties to prevent OOM (CT-1148)
interface TextImportModuleOutput {
  [NAME]: unknown;
  [UI]: unknown;
  content: string;
  filename: string;
}

// ===== Helper Functions =====

/**
 * Decode base64 data URL to text string
 * Handles data URLs like "data:text/plain;base64,SGVsbG8gV29ybGQ="
 */
function decodeBase64ToText(dataUrl: string): string {
  // Extract the base64 portion after the comma
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return dataUrl; // Not a data URL, return as-is

  const base64Data = dataUrl.slice(commaIndex + 1);

  try {
    // Decode base64 to binary string, then convert to UTF-8
    // Using TextDecoder properly handles multi-byte UTF-8 sequences
    const binaryString = atob(base64Data);
    const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // If decoding fails, return the raw data
    return base64Data;
  }
}

// ===== Handlers =====

// Define the expected event shape from ct-file-input
interface FileUploadEvent {
  detail: {
    files: Array<{
      name: string;
      type: string;
      size: number;
      data: string; // data URL
      url: string;
    }>;
  };
}

// Handler for file upload
const handleFileUpload = handler<
  FileUploadEvent,
  { content: Writable<string>; filename: Writable<string> }
>(({ detail }, state) => {
  const file = detail?.files?.[0];
  if (!file) return;

  // Decode the base64 data URL to text
  const textContent = decodeBase64ToText(file.data);

  state.content.set(textContent);
  state.filename.set(file.name);
});

// Handler to clear the file
const clearFile = handler<
  unknown,
  { content: Writable<string>; filename: Writable<string> }
>((_event, state) => {
  state.content.set("");
  state.filename.set("");
});

// ===== The Pattern =====
export const TextImportModule = pattern<
  TextImportModuleInput,
  TextImportModuleOutput
>(({ content, filename }) => {
  // Check if we have content
  const hasContent = computed(() => !!content && content.length > 0);

  // Display text for NAME
  const displayText = computed(() => {
    const hasFile = hasContent;
    const fname = filename;
    if (hasFile && fname) return fname;
    if (hasFile) return "Text imported";
    return "No file";
  });

  // Truncated preview of content (first 500 chars)
  const contentPreview = computed(() => {
    const c = content;
    if (!c) return "";
    if (c.length <= 500) return c;
    return c.slice(0, 500) + "...";
  });

  // File size display
  const contentSize = computed(() => {
    const c = content;
    if (!c) return "";
    const bytes = new Blob([c]).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  });

  return {
    [NAME]: str`${MODULE_METADATA.icon} ${displayText}`,
    [UI]: (
      <ct-vstack style={{ gap: "12px" }}>
        {ifElse(
          hasContent,
          // File is uploaded - show preview with clear button
          <ct-vstack style={{ gap: "8px" }}>
            {/* Header with filename and clear button */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  minWidth: "0",
                  flex: "1",
                }}
              >
                <span style={{ fontSize: "16px" }}>
                  {MODULE_METADATA.icon}
                </span>
                <span
                  style={{
                    fontSize: "14px",
                    fontWeight: "500",
                    color: "#374151",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {filename}
                </span>
                <span
                  style={{
                    fontSize: "12px",
                    color: "#9ca3af",
                    flexShrink: "0",
                  }}
                >
                  ({contentSize})
                </span>
              </div>
              <button
                type="button"
                onClick={clearFile({ content, filename })}
                style={{
                  background: "rgba(0, 0, 0, 0.6)",
                  color: "white",
                  border: "none",
                  borderRadius: "50%",
                  width: "24px",
                  height: "24px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "14px",
                  flexShrink: "0",
                }}
                title="Clear file"
              >
                x
              </button>
            </div>
            {/* Content preview in scrollable container */}
            <div
              style={{
                maxHeight: "200px",
                overflow: "auto",
                padding: "12px",
                background: "#f9fafb",
                borderRadius: "8px",
                border: "1px solid #e5e7eb",
              }}
            >
              <pre
                style={{
                  margin: "0",
                  fontSize: "12px",
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "#374151",
                }}
              >
                {contentPreview}
              </pre>
            </div>
          </ct-vstack>,
          // No file yet - show upload input
          <ct-file-input
            accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
            buttonText={`${MODULE_METADATA.icon} Import Text File`}
            showPreview={false}
            onct-change={handleFileUpload({ content, filename })}
            style={{ width: "100%" }}
          />,
        )}
      </ct-vstack>
    ),
    content,
    filename,
  };
});

export default TextImportModule;
