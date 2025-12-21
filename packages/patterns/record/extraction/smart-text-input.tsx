/// <cts-enable />
/**
 * Smart Text Input - Multi-modal text input pattern
 *
 * Provides three input modes:
 * 1. Direct text input (textarea)
 * 2. Text file upload (.txt, .md, .csv, etc.)
 * 3. Image upload with OCR (Claude vision API)
 *
 * Design decisions:
 * - Unified UI: textarea with file/image buttons below (not tabs)
 * - Manual commit: preview before replacing text
 * - Single image: simpler flow, avoids concatenation ambiguity
 * - Minimal API: expose only value Cell, manage internal state internally
 * - LLM-based OCR: uses Claude vision, already integrated
 *
 * Usage:
 *   const smartInput = SmartTextInput({ $value: inputText });
 *   // Use smartInput.ui in your pattern's UI
 *
 * Or compose individual parts:
 *   {smartInput.ui.textArea}
 *   {smartInput.ui.buttons}
 *   {smartInput.ui.preview}
 */

import {
  Cell,
  computed,
  derive,
  generateText,
  handler,
  ifElse,
  type ImageData,
} from "commontools";

// ===== Types =====

// FileData matches ct-file-input's event shape (not exported from commontools)
interface FileData {
  id: string;
  name: string;
  url: string;
  data: string;
  timestamp: number;
  size: number;
  type: string;
}

// Constants for file handling
const DEFAULT_MAX_TEXT_FILE_SIZE = 1 * 1024 * 1024; // 1MB limit for text files

export interface SmartTextInputInput {
  // Required: Target text cell (bidirectional binding)
  // Accepts both Cell<string> and pattern input types (OpaqueCell)
  // deno-lint-ignore no-explicit-any
  $value: any; // Cell<string> | OpaqueCell - framework handles type coercion

  // Optional configuration
  placeholder?: string;
  rows?: number;
  maxImageSizeBytes?: number; // Default: 3.75MB (75% of 5MB API limit)
  maxTextFileSizeBytes?: number; // Default: 1MB
}

export interface SmartTextInputOutput {
  // State
  value: Cell<string>;
  pending: boolean;
  error: string | null;

  // Pre-composed UI components
  ui: {
    complete: JSX.Element;
    textArea: JSX.Element;
    buttons: JSX.Element;
    preview: JSX.Element;
  };
}

// ===== Constants =====

const DEFAULT_PLACEHOLDER =
  "Paste text, upload a file, or snap a photo of a business card...";
const DEFAULT_MAX_IMAGE_SIZE = 3.75 * 1024 * 1024; // 3.75MB (75% of 5MB limit)

const OCR_SYSTEM_PROMPT =
  `You are an OCR system. Extract all text from the provided image.
Return ONLY the extracted text, preserving formatting and line breaks.
Do not add any commentary, explanation, or formatting like markdown.
If no text is visible, return an empty string.`;

// ===== Handlers (defined OUTSIDE pattern function) =====

/**
 * Decode base64 data URL to UTF-8 text
 * Uses TextDecoder for proper multi-byte character handling
 */
function decodeBase64ToText(dataUrl: string): string {
  const base64Match = dataUrl.match(/base64,(.+)/);
  if (!base64Match) {
    throw new Error("Invalid data URL format");
  }

  // Use TextDecoder for proper UTF-8 handling (same as uri-utils.ts)
  const binaryString = atob(base64Match[1]);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

/**
 * Handle text file upload - reads file content and sets as preview
 */
const handleFileUpload = handler<
  { detail: { files: FileData[] } },
  {
    previewText: Cell<string | null>;
    previewSource: Cell<"file" | "image" | null>;
    previewFileName: Cell<string | null>;
    fileError: Cell<string | null>;
    maxTextFileSizeBytes: number;
  }
>(
  (
    { detail },
    {
      previewText,
      previewSource,
      previewFileName,
      fileError,
      maxTextFileSizeBytes,
    },
  ) => {
    // Clear any previous error
    fileError.set(null);

    const files = detail?.files;
    if (!files || files.length === 0) return;

    const file = files[0];

    // Validate file size
    if (file.size > maxTextFileSizeBytes) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      const limitMB = (maxTextFileSizeBytes / (1024 * 1024)).toFixed(1);
      fileError.set(`File too large: ${sizeMB}MB (limit: ${limitMB}MB)`);
      return;
    }

    // Validate file type (case-insensitive extension, allow empty MIME)
    const isTextFile = file.type.startsWith("text/") ||
      file.type === "application/json" ||
      file.type === "" || // Allow empty MIME if extension matches
      /\.(txt|md|csv|json)$/i.test(file.name);

    if (!isTextFile) {
      fileError.set(`Unsupported file type: ${file.name}`);
      return;
    }

    // Decode base64 data URL to text (UTF-8 safe)
    try {
      const textContent = decodeBase64ToText(file.data);
      previewText.set(textContent);
      previewSource.set("file");
      previewFileName.set(file.name);
    } catch (e) {
      console.error("Failed to decode text file:", e);
      fileError.set(
        `Failed to read file: ${
          e instanceof Error ? e.message : "Unknown error"
        }`,
      );
    }
  },
);

/**
 * Commit preview text to the main value
 */
const handleCommitPreview = handler<
  unknown,
  {
    $value: Cell<string>;
    previewText: Cell<string | null>;
    previewSource: Cell<"file" | "image" | null>;
    previewFileName: Cell<string | null>;
  }
>(
  (
    _event,
    { $value, previewText, previewSource, previewFileName },
  ) => {
    const preview = previewText.get();
    if (preview) {
      $value.set(preview);
    }
    // Clear preview state
    previewText.set(null);
    previewSource.set(null);
    previewFileName.set(null);
  },
);

/**
 * Cancel/dismiss preview and clear errors
 */
const handleCancelPreview = handler<
  unknown,
  {
    previewText: Cell<string | null>;
    previewSource: Cell<"file" | "image" | null>;
    previewFileName: Cell<string | null>;
    uploadedImage: Cell<ImageData[]>; // Image array to clear
    fileError: Cell<string | null>;
  }
>(
  (
    _event,
    { previewText, previewSource, previewFileName, uploadedImage, fileError },
  ) => {
    previewText.set(null);
    previewSource.set(null);
    previewFileName.set(null);
    uploadedImage.set([]); // Clear the image array
    fileError.set(null);
  },
);

/**
 * Handle image change from ct-image-input
 * Note: The actual image comes from the $images binding (imageArray),
 * we just use this handler to set up the preview state
 */
const handleImageChange = handler<
  { detail: { images: ImageData[] } },
  {
    previewText: Cell<string | null>;
    previewSource: Cell<"file" | "image" | null>;
    fileError: Cell<string | null>;
  }
>(({ detail }, { previewText, previewSource, fileError }) => {
  const images = detail?.images;
  if (!images || images.length === 0) {
    // Image was removed - clear preview if it was from image
    previewSource.set(null);
    return;
  }

  // Clear any existing preview and errors - OCR will populate it
  previewText.set(null);
  previewSource.set("image");
  fileError.set(null);
});

// ===== The Pattern =====

export function SmartTextInput(
  input: SmartTextInputInput,
): SmartTextInputOutput {
  const {
    $value,
    placeholder = DEFAULT_PLACEHOLDER,
    rows = 4,
    maxImageSizeBytes = DEFAULT_MAX_IMAGE_SIZE,
    maxTextFileSizeBytes = DEFAULT_MAX_TEXT_FILE_SIZE,
  } = input;

  // ===== Internal State =====

  // Preview state (for file upload or OCR result)
  const previewText = Cell.of<string | null>(null);
  const previewSource = Cell.of<"file" | "image" | null>(null);
  const previewFileName = Cell.of<string | null>(null);

  // File error state (for user feedback)
  const fileError = Cell.of<string | null>(null);

  // Image array for ct-image-input binding
  const imageArray = Cell.of<ImageData[]>([]);

  // Derive single image from array - this fixes the disconnection issue
  const uploadedImage = derive(
    imageArray,
    (images: ImageData[]) => (images.length > 0 ? images[0] : null),
  );

  // ===== OCR Processing =====

  // Build OCR prompt only when we have an image
  // Return undefined (not []) to prevent API call when no image
  const ocrPrompt = computed(() => {
    const image = uploadedImage.get();
    if (!image || !image.data) {
      return undefined; // No prompt = no OCR call
    }

    return [
      { type: "image" as const, image: image.data },
      {
        type: "text" as const,
        text: "Extract all text from this image exactly as written.",
      },
    ];
  });

  // OCR using generateText with vision model
  const ocr = generateText({
    system: OCR_SYSTEM_PROMPT,
    prompt: ocrPrompt,
    model: "anthropic:claude-sonnet-4-5",
  });

  // When OCR completes, set the preview text
  // Use requestHash to prevent race conditions - only accept results for current image
  const _ocrWatcher = derive(
    [ocr.result, ocr.pending, ocr.requestHash, uploadedImage] as const,
    ([result, pending, _requestHash, image]) => {
      // Only set preview if:
      // 1. We have a result
      // 2. Not pending (OCR finished)
      // 3. We still have the image that triggered this OCR
      // 4. Preview source is "image" (not overwritten by file upload)
      if (result && !pending && image && previewSource.get() === "image") {
        previewText.set(result);
      }
      return null;
    },
  );

  // ===== Computed State =====

  const hasPreview = derive(
    previewText,
    (text: string | null) => text !== null && text !== "",
  );

  const isPending = derive(
    [ocr.pending, uploadedImage] as const,
    ([pending, image]) => Boolean(pending && image),
  );

  // Only show error if there's an uploaded image (to avoid showing error for empty prompt)
  const hasError = derive(
    [ocr.error, uploadedImage] as const,
    ([err, image]) => Boolean(err && image),
  );

  const errorMessage = derive(ocr.error, (err) => err ? String(err) : null);

  // ===== UI Components =====

  const textArea = (
    <ct-textarea
      $value={$value}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: "100%",
        minHeight: "80px",
      }}
    />
  );

  // File error display
  const hasFileError = derive(
    fileError,
    (err: string | null) => err !== null,
  );

  const buttons = (
    <div
      style={{
        display: "flex",
        gap: "8px",
        marginTop: "8px",
        flexWrap: "wrap",
      }}
    >
      {/* File Upload Button */}
      <ct-file-input
        accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
        buttonText="📄 Upload Text File"
        showPreview={false}
        variant="ghost"
        size="sm"
        onct-change={handleFileUpload({
          previewText,
          previewSource,
          previewFileName,
          fileError,
          maxTextFileSizeBytes,
        })}
      />

      {/* Image Upload Button */}
      <ct-image-input
        $images={imageArray}
        maxImages={1}
        showPreview={false}
        maxSizeBytes={maxImageSizeBytes}
        onct-change={handleImageChange({
          previewText,
          previewSource,
          fileError,
        })}
      >
        <button
          type="button"
          style={{
            padding: "4px 12px",
            background: "transparent",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "13px",
            color: "#374151",
          }}
        >
          📷 Scan Image
        </button>
      </ct-image-input>
    </div>
  );

  const preview = (
    <div>
      {/* Loading state */}
      {ifElse(
        isPending,
        <div
          style={{
            marginTop: "12px",
            padding: "12px",
            background: "#f3f4f6",
            borderRadius: "6px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <ct-loader size="sm" />
          <span style={{ color: "#6b7280", fontSize: "13px" }}>
            Extracting text from image...
          </span>
        </div>,
        null,
      )}

      {/* File error state */}
      {ifElse(
        hasFileError,
        <div
          style={{
            marginTop: "12px",
            padding: "12px",
            background: "#fef3c7",
            borderRadius: "6px",
            color: "#92400e",
            fontSize: "13px",
          }}
        >
          {fileError}
          <button
            type="button"
            onClick={handleCancelPreview({
              previewText,
              previewSource,
              previewFileName,
              uploadedImage: imageArray, // Clear the image array
              fileError,
            })}
            style={{
              marginLeft: "8px",
              padding: "2px 8px",
              background: "white",
              border: "1px solid #fcd34d",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            Dismiss
          </button>
        </div>,
        null,
      )}

      {/* OCR error state */}
      {ifElse(
        hasError,
        <div
          style={{
            marginTop: "12px",
            padding: "12px",
            background: "#fee2e2",
            borderRadius: "6px",
            color: "#991b1b",
            fontSize: "13px",
          }}
        >
          OCR failed: {errorMessage}
          <button
            type="button"
            onClick={handleCancelPreview({
              previewText,
              previewSource,
              previewFileName,
              uploadedImage: imageArray, // Clear the image array
              fileError,
            })}
            style={{
              marginLeft: "8px",
              padding: "2px 8px",
              background: "white",
              border: "1px solid #fca5a5",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            Dismiss
          </button>
        </div>,
        null,
      )}

      {/* Preview with commit/cancel buttons */}
      {ifElse(
        hasPreview,
        <div
          style={{
            marginTop: "12px",
            padding: "12px",
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            borderRadius: "6px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "8px",
            }}
          >
            <span style={{ fontSize: "12px", color: "#047857" }}>
              {ifElse(
                derive(previewSource, (s: "file" | "image" | null) =>
                  s === "file"),
                <span>📄 From file: {previewFileName}</span>,
                <span>📷 Extracted from image</span>,
              )}
            </span>
          </div>

          <div
            style={{
              padding: "8px",
              background: "white",
              border: "1px solid #d1fae5",
              borderRadius: "4px",
              fontSize: "13px",
              whiteSpace: "pre-wrap",
              maxHeight: "150px",
              overflow: "auto",
            }}
          >
            {previewText}
          </div>

          <div
            style={{
              display: "flex",
              gap: "8px",
              marginTop: "8px",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={handleCancelPreview({
                previewText,
                previewSource,
                previewFileName,
                uploadedImage: imageArray, // Clear the image array
                fileError,
              })}
              style={{
                padding: "6px 12px",
                background: "white",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCommitPreview({
                $value,
                previewText,
                previewSource,
                previewFileName,
              })}
              style={{
                padding: "6px 12px",
                background: "#059669",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: "500",
              }}
            >
              ✓ Use This Text
            </button>
          </div>
        </div>,
        null,
      )}
    </div>
  );

  const complete = (
    <div style={{ width: "100%" }}>
      {textArea}
      {buttons}
      {preview}
    </div>
  );

  // ===== Return =====

  return {
    value: $value,
    pending: isPending as unknown as boolean,
    error: errorMessage as unknown as string | null,
    ui: {
      complete,
      textArea,
      buttons,
      preview,
    },
  };
}

export default SmartTextInput;
