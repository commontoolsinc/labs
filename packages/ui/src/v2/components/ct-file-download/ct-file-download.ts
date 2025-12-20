import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell, isCell } from "@commontools/runner";

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
 * @attr {string|Cell<string>} data - Content to download (required)
 * @attr {string|Cell<string>} filename - Download filename (auto-generated if not provided)
 * @attr {string} mime-type - MIME type for the file (default: "text/plain")
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

  declare data: Cell<string> | string;
  declare filename: Cell<string> | string;
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
  private _resetTimeout?: number;
  private _dataUnsubscribe: (() => void) | null = null;
  private _filenameUnsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.data = "";
    this.filename = "";
    this.mimeType = "text/plain";
    this.base64 = false;
    this.variant = "secondary";
    this.size = "default";
    this.disabled = false;
    this.feedbackDuration = 2000;
    this.iconOnly = false;
  }

  /**
   * Get the current value from a Cell or plain value
   */
  private _getValue<T>(prop: Cell<T> | T): T | undefined {
    if (isCell(prop)) {
      return prop.get();
    }
    return prop;
  }

  /**
   * Get the data value (string content to download)
   */
  private _getDataValue(): string {
    const value = this._getValue(this.data);
    return value ?? "";
  }

  /**
   * Get the filename, auto-generating if not provided
   */
  private _getFilename(): string {
    const fn = this._getValue(this.filename);
    if (fn) return fn;

    // Auto-generate filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const ext = MIME_EXTENSIONS[this.mimeType] || "txt";
    return `download-${timestamp}.${ext}`;
  }

  /**
   * Create a Blob from the data, optionally decoding base64
   */
  private _createBlob(data: string): Blob {
    if (this.base64) {
      try {
        const binaryString = atob(data);
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

  /**
   * Clean up data Cell subscription
   */
  private _cleanupDataSubscription(): void {
    if (this._dataUnsubscribe) {
      this._dataUnsubscribe();
      this._dataUnsubscribe = null;
    }
  }

  /**
   * Clean up filename Cell subscription
   */
  private _cleanupFilenameSubscription(): void {
    if (this._filenameUnsubscribe) {
      this._filenameUnsubscribe();
      this._filenameUnsubscribe = null;
    }
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // Handle data Cell subscription
    if (changedProperties.has("data")) {
      this._cleanupDataSubscription();
      if (this.data && isCell(this.data)) {
        this._dataUnsubscribe = this.data.sink(() => {
          this.requestUpdate();
        });
      }
    }

    // Handle filename Cell subscription
    if (changedProperties.has("filename")) {
      this._cleanupFilenameSubscription();
      if (this.filename && isCell(this.filename)) {
        this._filenameUnsubscribe = this.filename.sink(() => {
          this.requestUpdate();
        });
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupDataSubscription();
    this._cleanupFilenameSubscription();
    if (this._resetTimeout) {
      clearTimeout(this._resetTimeout);
    }
  }

  private _handleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    const data = this._getDataValue();
    const filename = this._getFilename();

    if (this.disabled) return;

    // Check for empty data
    if (!data) {
      this.emit("ct-download-error", {
        error: new Error("No data to download"),
        filename,
      });
      return;
    }

    try {
      // Create blob from data
      const blob = this._createBlob(data);
      const url = URL.createObjectURL(blob);

      try {
        // Create and trigger download via anchor element
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Update state for visual feedback
        this._downloaded = true;
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
      } finally {
        // Always revoke the object URL to prevent memory leaks
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      this.emit("ct-download-error", {
        error: error as Error,
        filename,
      });
    }
  }

  override render() {
    const title = this._downloaded ? "Downloaded!" : "Download file";
    const ariaLabel = this._downloaded ? "File downloaded" : "Download file";
    const hasData = !!this._getDataValue();

    return html`
      <ct-button
        variant="${this.variant || "secondary"}"
        size="${this.size || "default"}"
        ?disabled="${this.disabled || !hasData}"
        @click="${this._handleClick}"
        title="${title}"
        aria-label="${ariaLabel}"
      >
        ${this.iconOnly
          ? html`
            ${this._downloaded ? "\u2713" : "\u2B07"}
          `
          : html`
            <slot> ${this._downloaded
              ? "\u2713 Downloaded!"
              : "\u2B07 Download"} </slot>
          `}
      </ct-button>
    `;
  }
}

globalThis.customElements.define("ct-file-download", CTFileDownload);
