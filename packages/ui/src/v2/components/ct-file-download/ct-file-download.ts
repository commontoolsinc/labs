import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { type CellHandle } from "@commontools/runtime-client";
import { createStringCellController } from "../../core/cell-controller.ts";

/**
 * Check if File System Access API is available
 */
const hasFileSystemAccess = (): boolean => {
  return "showDirectoryPicker" in globalThis;
};

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
 * @attr {boolean} allow-autosave - Enable Option+click to activate auto-save mode (default: false)
 *
 * @fires ct-download-success - Fired when download succeeds
 *   Detail: { filename: string, size: number, mimeType: string }
 * @fires ct-download-error - Fired when download fails
 *   Detail: { error: Error, filename: string }
 * @fires ct-autosave-enabled - Fired when auto-save mode is activated
 *   Detail: { directoryName: string }
 * @fires ct-autosave-disabled - Fired when auto-save mode is deactivated
 * @fires ct-autosave-success - Fired when auto-save completes successfully
 *   Detail: { filename: string, size: number }
 * @fires ct-autosave-error - Fired when auto-save fails
 *   Detail: { error: Error }
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
      :host {
        position: relative;
        display: inline-block;
      }

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

      /* Autosave indicator dot */
      .autosave-indicator {
        position: absolute;
        top: -2px;
        right: -2px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        pointer-events: none;
        z-index: 1;
      }

      .autosave-indicator.saved {
        background-color: #22c55e; /* green-500 */
      }

      .autosave-indicator.pending {
        background-color: #f59e0b; /* amber-500 */
        animation: gentle-pulse 2s ease-in-out infinite;
      }

      .autosave-indicator.saving {
        background-color: #3b82f6; /* blue-500 */
      }

      @keyframes gentle-pulse {
        0%, 100% {
          opacity: 1;
        }
        50% {
          opacity: 0.5;
        }
      }

      /* Shake animation for "not available" feedback */
      @keyframes shake {
        0%, 100% {
          transform: translateX(0);
        }
        20%, 60% {
          transform: translateX(-4px);
        }
        40%, 80% {
          transform: translateX(4px);
        }
      }

      :host(.shake) {
        animation: shake 0.4s ease-in-out;
      }

      /* Tooltip for autosave status */
      .autosave-tooltip {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        padding: 4px 8px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        font-size: 12px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.2s;
        margin-bottom: 4px;
        z-index: 10;
      }

      :host(:hover) .autosave-tooltip {
        opacity: 1;
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
    allowAutosave: {
      type: Boolean,
      attribute: "allow-autosave",
      reflect: true,
    },
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
  declare allowAutosave: boolean;

  private _downloaded = false;
  private _downloading = false;
  private _resetTimeout?: ReturnType<typeof setTimeout>;

  // Autosave state
  private _autosaveEnabled = false;
  private _autosaveDirHandle: FileSystemDirectoryHandle | null = null;
  private _autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private _isDirty = false;
  private _lastSavedData: string | null = null;
  private _isSavingAutosave = false;
  private _showNotAvailableTooltip = false;
  private _notAvailableTooltipTimeout?: ReturnType<typeof setTimeout>;

  /** Maximum file size in bytes (100MB) */
  private static readonly MAX_FILE_SIZE = 100 * 1024 * 1024;

  /** Delay before revoking object URL to ensure download starts (ms) */
  private static readonly URL_REVOKE_DELAY = 100;

  /** Auto-save interval in milliseconds (60 seconds) */
  private static readonly AUTOSAVE_INTERVAL = 60_000;

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
    this.allowAutosave = false;
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

    // Track data changes for autosave
    if (this._autosaveEnabled) {
      const currentData = this._getDataValue();
      if (currentData !== this._lastSavedData) {
        this._isDirty = true;
        this._scheduleAutosave();
      }
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    // Add visibility change listener for auto-save on tab switch
    this._boundVisibilityHandler = this._handleVisibilityChange.bind(this);
    this._boundBeforeUnloadHandler = this._handleBeforeUnload.bind(this);
    document.addEventListener("visibilitychange", this._boundVisibilityHandler);
    globalThis.addEventListener("beforeunload", this._boundBeforeUnloadHandler);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resetTimeout) {
      clearTimeout(this._resetTimeout);
    }
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
    }
    if (this._notAvailableTooltipTimeout) {
      clearTimeout(this._notAvailableTooltipTimeout);
    }
    // Remove event listeners
    if (this._boundVisibilityHandler) {
      document.removeEventListener(
        "visibilitychange",
        this._boundVisibilityHandler,
      );
    }
    if (this._boundBeforeUnloadHandler) {
      globalThis.removeEventListener(
        "beforeunload",
        this._boundBeforeUnloadHandler,
      );
    }
  }

  // Event handler references for cleanup
  private _boundVisibilityHandler?: () => void;
  private _boundBeforeUnloadHandler?: (e: BeforeUnloadEvent) => void;

  /**
   * Handle visibility change - save immediately when tab becomes hidden
   */
  private _handleVisibilityChange() {
    if (document.hidden && this._autosaveEnabled && this._isDirty) {
      this._performAutosave();
    }
  }

  /**
   * Handle beforeunload - warn user if there are unsaved changes
   */
  private _handleBeforeUnload(e: BeforeUnloadEvent) {
    if (this._autosaveEnabled && this._isDirty) {
      // Attempt to save (may not complete)
      this._performAutosave();
      // Show browser's default "unsaved changes" dialog
      e.preventDefault();
      e.returnValue = "";
    }
  }

  /**
   * Enable autosave mode by prompting user for folder
   */
  private async _enableAutosave(): Promise<boolean> {
    if (!hasFileSystemAccess()) {
      this._showNotAvailableFeedback("Auto-save requires Chrome or Edge");
      return false;
    }

    try {
      // Prompt user to select a folder
      const dirHandle = await (globalThis as unknown as {
        showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker();

      this._autosaveDirHandle = dirHandle;
      this._autosaveEnabled = true;
      this._lastSavedData = this._getDataValue();
      this._isDirty = false;

      this.emit("ct-autosave-enabled", {
        directoryName: dirHandle.name,
      });

      this.requestUpdate();
      return true;
    } catch (error) {
      // User cancelled or permission denied
      if ((error as Error).name !== "AbortError") {
        this._showNotAvailableFeedback("Could not access folder");
      }
      return false;
    }
  }

  /**
   * Disable autosave mode
   */
  private _disableAutosave() {
    this._autosaveEnabled = false;
    this._autosaveDirHandle = null;
    this._isDirty = false;
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    this.emit("ct-autosave-disabled", {});
    this.requestUpdate();
  }

  /**
   * Perform the actual autosave to the selected folder
   */
  private async _performAutosave(): Promise<void> {
    if (!this._autosaveDirHandle || this._isSavingAutosave) return;

    const data = this._getDataValue();
    if (!data) return;

    this._isSavingAutosave = true;
    this.requestUpdate();

    try {
      const blob = this._createBlob(data);

      // Generate timestamped filename
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const baseName = this._filenameController.getValue() || "backup";
      const ext = MIME_EXTENSIONS[this.mimeType] || "bin";
      const sanitizedBase = this._sanitizeFilename(
        baseName.replace(/\.[^.]+$/, ""),
      );
      const filename = `${sanitizedBase}-${timestamp}.${ext}`;

      // Write to file
      const fileHandle = await this._autosaveDirHandle.getFileHandle(filename, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      // Update state
      this._lastSavedData = data;
      this._isDirty = false;
      this._isSavingAutosave = false;

      // Clear timer since we just saved
      if (this._autosaveTimer) {
        clearTimeout(this._autosaveTimer);
        this._autosaveTimer = null;
      }

      this.emit("ct-autosave-success", {
        filename,
        size: blob.size,
      });

      this.requestUpdate();
    } catch (error) {
      this._isSavingAutosave = false;
      this.requestUpdate();

      // Check if permission was revoked
      if ((error as Error).name === "NotAllowedError") {
        this._disableAutosave();
        this._showNotAvailableFeedback("Folder access revoked");
      }

      this.emit("ct-autosave-error", {
        error: error as Error,
      });
    }
  }

  /**
   * Start or reset the autosave timer
   */
  private _scheduleAutosave() {
    if (!this._autosaveEnabled) return;

    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
    }

    this._autosaveTimer = setTimeout(() => {
      this._performAutosave();
    }, CTFileDownload.AUTOSAVE_INTERVAL);
  }

  /**
   * Show "not available" feedback with shake animation and tooltip
   */
  private _showNotAvailableFeedback(message: string) {
    this._showNotAvailableTooltip = true;
    this.classList.add("shake");
    this.requestUpdate();

    // Store the message for the tooltip
    this._notAvailableMessage = message;

    if (this._notAvailableTooltipTimeout) {
      clearTimeout(this._notAvailableTooltipTimeout);
    }

    this._notAvailableTooltipTimeout = setTimeout(() => {
      this._showNotAvailableTooltip = false;
      this.classList.remove("shake");
      this.requestUpdate();
    }, 2000);
  }

  private _notAvailableMessage = "";

  private _handleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    // Guard against rapid clicks and disabled state
    if (this.disabled || this._downloading) return;

    const mouseEvent = e as MouseEvent;
    const isOptionClick = mouseEvent.altKey;

    // Handle Option+click for autosave toggle
    if (isOptionClick) {
      if (!this.allowAutosave) {
        // Show feedback that autosave is not available for this button
        this._showNotAvailableFeedback(
          "Auto-save not available for this download",
        );
        // Continue with normal download
      } else if (this._autosaveEnabled) {
        // Toggle off
        this._disableAutosave();
        return;
      } else {
        // Toggle on - prompt for folder
        this._enableAutosave();
        return;
      }
    }

    // If autosave is enabled, save to folder instead of browser download
    if (this._autosaveEnabled) {
      this._performAutosave();
      return;
    }

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

  /**
   * Get the autosave indicator state class
   */
  private _getAutosaveIndicatorClass(): string {
    if (!this._autosaveEnabled) return "";
    if (this._isSavingAutosave) return "saving";
    if (this._isDirty) return "pending";
    return "saved";
  }

  /**
   * Get the tooltip text for autosave state
   */
  private _getAutosaveTooltip(): string {
    if (this._showNotAvailableTooltip) {
      return this._notAvailableMessage;
    }
    if (!this._autosaveEnabled) return "";
    if (this._isSavingAutosave) return "Saving...";
    if (this._isDirty) return "Auto-save on · Saving soon...";
    return "Auto-save on · All changes saved";
  }

  override render() {
    const hasData = !!this._getDataValue();

    // Determine title and aria-label based on state
    let title: string;
    let ariaLabel: string;

    if (this._autosaveEnabled) {
      title = this._getAutosaveTooltip();
      ariaLabel = title;
    } else if (this._downloading) {
      title = "Downloading...";
      ariaLabel = "Downloading file";
    } else if (this._downloaded) {
      title = "Downloaded!";
      ariaLabel = "File downloaded";
    } else {
      title = "Download file";
      ariaLabel = "Download file";
    }

    // Determine icon
    const icon = this._autosaveEnabled
      ? "\uD83D\uDD04" // 🔄
      : this._downloading
      ? "\u23F3" // ⏳
      : this._downloaded
      ? "\u2713" // ✓
      : "\u2B07"; // ⬇

    // Determine button text
    const buttonText = this._autosaveEnabled
      ? this._isSavingAutosave
        ? "\uD83D\uDD04 Saving..."
        : "\uD83D\uDD04 Auto-save"
      : this._downloading
      ? "\u23F3 Downloading..."
      : this._downloaded
      ? "\u2713 Downloaded!"
      : "\u2B07 Download";

    const indicatorClass = this._getAutosaveIndicatorClass();
    const tooltipText = this._showNotAvailableTooltip || this._autosaveEnabled
      ? this._getAutosaveTooltip()
      : "";

    return html`
      ${indicatorClass
        ? html`
          <span class="autosave-indicator ${indicatorClass}"></span>
        `
        : null} ${tooltipText
        ? html`
          <span class="autosave-tooltip">${tooltipText}</span>
        `
        : null}
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
            ${icon}
          `
          : html`
            <slot>${buttonText}</slot>
          `}
      </ct-button>
    `;
  }
}

globalThis.customElements.define("ct-file-download", CTFileDownload);
