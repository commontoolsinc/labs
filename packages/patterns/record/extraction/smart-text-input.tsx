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
 * Reads from previewText (for file uploads) or ocrResult (for image OCR)
 */
const handleCommitPreview = handler<
  unknown,
  {
    $value: Cell<string>;
    previewText: Cell<string | null>;
    previewSource: Cell<"file" | "image" | null>;
    previewFileName: Cell<string | null>;
    uploadedImage: Cell<ImageData[]>;
    // deno-lint-ignore no-explicit-any
    ocrResult: any; // The ocr.result reactive value
  }
>(
  (
    _event,
    { $value, previewText, previewSource, previewFileName, uploadedImage, ocrResult },
  ) => {
    const hasImage = uploadedImage.get().length > 0;
    const fileSource = previewSource.get() === "file";
    let preview: string | null = null;

    if (fileSource) {
      preview = previewText.get();
    } else if (hasImage && ocrResult) {
      // ocrResult is already the string value from generateText
      preview = ocrResult as string;
    }

    if (preview) {
      $value.set(preview);
    }
    // Clear preview state
    previewText.set(null);
    previewSource.set(null);
    previewFileName.set(null);
    uploadedImage.set([]); // Also clear image to reset OCR state
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
 * NOTE: The $images binding handles actual data flow to the imageArray Cell.
 * This handler only sets UI state flags for the preview section.
 * The image data arrives via the binding, triggering the computed() for OCR.
 */
const handleImageChange = handler<
  { detail: { images: ImageData[] } },
  {
    previewText: Cell<string | null>;
    fileError: Cell<string | null>;
  }
>(({ detail }, { previewText, fileError }) => {
  // NOTE: The $images binding handles data flow - this handler only clears state
  // The handler fires before file processing completes, so we can't rely on
  // detail.images to detect uploads. derivedPreviewSource handles that reactively.
  const images = detail?.images;
  if (!images || images.length === 0) {
    // Image was removed - clear file errors
    fileError.set(null);
    return;
  }

  // Image added - clear file preview state (image preview is derived from imageArray)
  previewText.set(null);
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

  // ===== OCR Processing =====

  // Build OCR prompt directly using computed() - this ensures reactivity
  // when the $images binding updates the imageArray Cell.
  // Pattern: Match image-analysis.tsx which uses computed() to build content parts
  const ocrPrompt = computed(() => {
    const images = imageArray.get();
    const image = images.length > 0 ? images[0] : null;

    if (!image || !image.data) {
      // Return undefined when no image - generateText will early-exit gracefully
      return undefined;
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

  // ===== Computed State =====
  // Use computed() for reactive transformations (not derive() with side effects)

  // Compute the effective preview text - either from file upload or OCR result
  // IMPORTANT: Don't use .set() inside computed() - that's an anti-pattern!
  // Instead, compute the display value directly from sources
  const effectivePreviewText = computed(() => {
    const images = imageArray.get();
    const hasImages = images.length > 0;
    const manualSource = previewSource.get();
    // Determine effective source: "image" if images present, else manual source
    const source = hasImages ? "image" : manualSource;

    const filePreview = previewText.get();
    const ocrResult = ocr.result;
    const ocrPending = ocr.pending;
    const image = images[0] ?? null;

    // If we have a file upload preview, use it
    if (source === "file" && filePreview) {
      return filePreview;
    }
    // If we have an OCR result and it's done processing, use it
    if (source === "image" && ocrResult && !ocrPending && image) {
      return ocrResult as string;
    }
    return null;
  });

  // hasPreview checks if there's content to show (from file or OCR)
  const hasPreview = computed(() => {
    const images = imageArray.get();
    const hasImages = images.length > 0;
    const manualSource = previewSource.get();
    // Determine effective source: "image" if images present, else manual source
    const source = hasImages ? "image" : manualSource;

    const filePreview = previewText.get();
    const ocrResult = ocr.result;
    const ocrPending = ocr.pending;
    const image = images[0] ?? null;

    if (source === "file" && filePreview) {
      return true;
    }
    if (source === "image" && ocrResult && !ocrPending && image) {
      return true;
    }
    return false;
  });

  const isPending = computed(() => {
    const pending = ocr.pending;
    const image = imageArray.get()[0] ?? null;
    return Boolean(pending && image);
  });

  // Only show error if there's an uploaded image (to avoid showing error for empty prompt)
  const hasError = computed(() => {
    const err = ocr.error;
    const image = imageArray.get()[0] ?? null;
    return Boolean(err && image);
  });

  const errorMessage = computed(() => {
    const err = ocr.error;
    return err ? String(err) : null;
  });

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
  const hasFileError = computed(() => fileError.get() !== null);

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
      {/* Using $images binding like image-analysis.tsx - this handles data flow */}
      {/* Handler only sets preview state flags, doesn't store image */}
      <ct-image-input
        $images={imageArray}
        maxImages={1}
        showPreview={false}
        maxSizeBytes={maxImageSizeBytes}
        buttonText="📷 Add Photo"
        variant="ghost"
        size="sm"
        onct-change={handleImageChange({
          previewText,
          fileError,
        })}
      />
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
                computed(() => previewSource.get() === "file" && imageArray.get().length === 0),
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
            {effectivePreviewText}
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
                uploadedImage: imageArray,
                ocrResult: ocr.result,
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
