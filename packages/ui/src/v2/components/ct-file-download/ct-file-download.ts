import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { type CellHandle } from "@commontools/runtime-client";
import { createStringCellController } from "../../core/cell-controller.ts";

/**
 * MIME type to file extension mapping
 */
const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/html": "html",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "application/xml": "xml",
  "application/octet-stream": "bin",
};

/**
 * CTFileDownload - File download button with automatic visual feedback
 *
 * Triggers a file download from string data. The component encapsulates
 * the blob/ObjectURL/anchor download pattern, allowing patterns to trigger
 * downloads without directly accessing globalThis or browser DOM APIs.
 *
 * @element ct-file-download
 *
 * @property {string|CellHandle<string>} data - Content to download (required)
 * @property {string|CellHandle<string>} filename - Download filename (auto-generated if not provided)
 * @attr {string} mime-type - MIME type for the file (default: "application/octet-stream")
 * @attr {boolean} base64 - If true, decode data as base64 before downloading (default: false)
 * @attr {string} variant - Button style variant (default: "secondary")
 *   Options: "primary" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "pill"
 * @attr {string} size - Button size (default: "default")
 *   Options: "default" | "sm" | "lg" | "icon" | "md"
 * @attr {boolean} disabled - Disable the button
 * @attr {number} feedback-duration - Success feedback duration in ms (default: 2000)
 * @attr {boolean} icon-only - Only show icon, no text (default: false)
 *
 * @fires ct-download-success - Fired when download succeeds
 *   Detail: { filename: string, size: number, mimeType: string }
 * @fires ct-download-error - Fired when download fails
 *   Detail: { error: Error, filename: string }
 *
 * @slot - Button label text (optional, defaults based on state)
 *
 * @example
 * // Basic usage
 * <ct-file-download data="Hello World" filename="hello.txt">Download</ct-file-download>
 *
 * // With Cell binding (in pattern)
 * <ct-file-download
 *   $data={exportData}
 *   $filename={exportFilename}
 *   mime-type="application/json"
 * >Export</ct-file-download>
 *
 * // Icon only
 * <ct-file-download data="data" filename="file.txt" icon-only></ct-file-download>
 *
 * // Base64 binary data
 * <ct-file-download
 *   data={imageBase64}
 *   filename="image.png"
 *   mime-type="image/png"
 *   base64
 * >Download Image</ct-file-download>
 */
export class CTFileDownload extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      /* Ensure icon-only buttons maintain square aspect ratio */
      :host([icon-only]) ct-button {
        min-width: 2.25rem;
        display: inline-flex;
      }

      /* Adjust for different sizes when icon-only */
      :host([icon-only]) ct-button::part(button) {
        aspect-ratio: 1;
        min-width: fit-content;
      }
    `,
  ];

  static override properties = {
    data: { attribute: false },
    filename: { attribute: false },
    mimeType: { type: String, attribute: "mime-type" },
    base64: { type: Boolean },
    variant: { type: String },
    size: { type: String },
    disabled: { type: Boolean, reflect: true },
    feedbackDuration: { type: Number, attribute: "feedback-duration" },
    iconOnly: { type: Boolean, attribute: "icon-only", reflect: true },
  };

  declare data: CellHandle<string> | string;
  declare filename: CellHandle<string> | string;
  declare mimeType: string;
  declare base64: boolean;
  declare variant?:
    | "primary"
    | "secondary"
    | "destructive"
    | "outline"
    | "ghost"
    | "link"
    | "pill";
  declare size?: "default" | "sm" | "lg" | "icon" | "md";
  declare disabled: boolean;
  declare feedbackDuration: number;
  declare iconOnly: boolean;

  private _downloaded = false;
  private _downloading = false;
  private _resetTimeout?: ReturnType<typeof setTimeout>;

  /** Maximum file size in bytes (100MB) */
  private static readonly MAX_FILE_SIZE = 100 * 1024 * 1024;

  /** Delay before revoking object URL to ensure download starts (ms) */
  private static readonly URL_REVOKE_DELAY = 100;

  /** CellController for data property */
  private _dataController = createStringCellController(this, {
    timing: { strategy: "immediate" },
  });

  /** CellController for filename property */
  private _filenameController = createStringCellController(this, {
    timing: { strategy: "immediate" },
  });

  constructor() {
    super();
    this.data = "";
    this.filename = "";
    this.mimeType = "application/octet-stream";
    this.base64 = false;
    this.variant = "secondary";
    this.size = "default";
    this.disabled = false;
    this.feedbackDuration = 2000;
    this.iconOnly = false;
  }

  /**
   * Get the data value (string content to download)
   */
  private _getDataValue(): string {
    return this._dataController.getValue() ?? "";
  }

  /**
   * Sanitize filename to remove potentially problematic characters
   */
  private _sanitizeFilename(filename: string): string {
    // Remove path traversal attempts and problematic characters
    return filename
      .replace(/\.\./g, "_") // No path traversal
      // deno-lint-ignore no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") // No special chars
      .slice(0, 255); // Max filename length
  }

  /**
   * Get the filename, auto-generating if not provided
   */
  private _getFilename(): string {
    const fn = this._filenameController.getValue();
    if (fn) return this._sanitizeFilename(fn);

    // Auto-generate filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const ext = MIME_EXTENSIONS[this.mimeType] || "bin";
    return `download-${timestamp}.${ext}`;
  }

  /**
   * Create a Blob from the data, optionally decoding base64
   */
  private _createBlob(data: string): Blob {
    if (this.base64) {
      try {
        // Trim whitespace that may be present in base64 data from various sources
        const binaryString = atob(data.trim());
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new Blob([bytes], { type: this.mimeType });
      } catch (e) {
        throw new Error(`Invalid base64 data: ${(e as Error).message}`);
      }
    }
    return new Blob([data], { type: this.mimeType });
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // Bind CellControllers when properties change
    if (changedProperties.has("data")) {
      this._dataController.bind(this.data);
    }
    if (changedProperties.has("filename")) {
      this._filenameController.bind(this.filename);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resetTimeout) {
      clearTimeout(this._resetTimeout);
    }
  }

  private _handleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    // Guard against rapid clicks and disabled state
    if (this.disabled || this._downloading) return;

    const data = this._getDataValue();
    const filename = this._getFilename();

    // Check for empty data
    if (!data) {
      this.emit("ct-download-error", {
        error: new Error("No data to download"),
        filename,
      });
      return;
    }

    // Set downloading state to prevent rapid clicks
    this._downloading = true;
    this.requestUpdate();

    try {
      // Create blob from data
      const blob = this._createBlob(data);

      // Check file size limit
      if (blob.size > CTFileDownload.MAX_FILE_SIZE) {
        throw new Error(
          `File size (${
            Math.round(blob.size / 1024 / 1024)
          }MB) exceeds maximum allowed (${
            Math.round(CTFileDownload.MAX_FILE_SIZE / 1024 / 1024)
          }MB)`,
        );
      }

      const url = URL.createObjectURL(blob);

      // Create and trigger download via anchor element
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Delay URL revocation to ensure download starts in all browsers
      setTimeout(
        () => URL.revokeObjectURL(url),
        CTFileDownload.URL_REVOKE_DELAY,
      );

      // Update state for visual feedback
      this._downloaded = true;
      this._downloading = false;
      this.requestUpdate();

      this.emit("ct-download-success", {
        filename,
        size: blob.size,
        mimeType: this.mimeType,
      });

      // Reset downloaded state after duration
      if (this._resetTimeout) {
        clearTimeout(this._resetTimeout);
      }
      this._resetTimeout = setTimeout(() => {
        this._downloaded = false;
        this.requestUpdate();
      }, this.feedbackDuration);
    } catch (error) {
      this._downloading = false;
      this.requestUpdate();
      this.emit("ct-download-error", {
        error: error as Error,
        filename,
      });
    }
  }

  override render() {
    const title = this._downloading
      ? "Downloading..."
      : this._downloaded
      ? "Downloaded!"
      : "Download file";
    const ariaLabel = this._downloading
      ? "Downloading file"
      : this._downloaded
      ? "File downloaded"
      : "Download file";
    const hasData = !!this._getDataValue();

    return html`
      <ct-button
        variant="${this.variant || "secondary"}"
        size="${this.size || "default"}"
        ?disabled="${this.disabled || !hasData || this._downloading}"
        @click="${this._handleClick}"
        title="${title}"
        aria-label="${ariaLabel}"
      >
        ${this.iconOnly
          ? html`
            ${this._downloading
              ? "\u23F3"
              : this._downloaded
              ? "\u2713"
              : "\u2B07"}
          `
          : html`
            <slot> ${this._downloading
              ? "\u23F3 Downloading..."
              : this._downloaded
              ? "\u2713 Downloaded!"
              : "\u2B07 Download"} </slot>
          `}
      </ct-button>
    `;
  }
}

globalThis.customElements.define("ct-file-download", CTFileDownload);
