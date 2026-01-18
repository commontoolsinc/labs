import { css, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import type { ButtonSize, ButtonVariant } from "../ct-button/ct-button.ts";
import { type CellHandle, type JSONSchema } from "@commontools/runtime-client";
import type { Schema } from "@commontools/api/schema";
import { createArrayCellController } from "../../core/cell-controller.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";
import { formatFileSize } from "../../utils/image-compression.ts";
import "../ct-button/ct-button.ts";

// Schema for FileData array
const FileDataArraySchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      data: { type: "string" },
      timestamp: { type: "number" },
      size: { type: "number" },
      type: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
      metadata: { type: "object" },
    },
    required: ["id", "name", "url", "data", "timestamp", "size", "type"],
  },
} as const satisfies JSONSchema;

/**
 * Generic file data structure
 */
export interface FileData {
  id: string;
  name: string;
  url: string; // data URL
  data: string; // data URL (kept for compatibility)
  timestamp: number;
  size: number;
  type: string; // MIME type

  // Optional metadata (can be populated by subclasses)
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

// Type validation: ensure schema matches interface
type _ValidateFileData = Schema<
  typeof FileDataArraySchema
>[number] extends FileData ? true : never;
const _validateFileData: _ValidateFileData = true;

/**
 * CTFileInput - Generic file upload component
 *
 * @element ct-file-input
 *
 * @attr {boolean} multiple - Allow multiple files (default: false)
 * @attr {number} maxFiles - Max number of files (default: unlimited)
 * @attr {string} accept - File types to accept (default: "*\/*")
 * @attr {string} buttonText - Custom button text (default: "📎 Add File")
 * @attr {string} variant - Button style variant
 * @attr {string} size - Button size
 * @attr {boolean} showPreview - Show file previews (default: true)
 * @attr {string} previewSize - Preview thumbnail size: "sm" | "md" | "lg"
 * @attr {boolean} removable - Allow removing files (default: true)
 * @attr {boolean} disabled - Disable the input
 * @attr {number} maxSizeBytes - Max size warning threshold (default: none)
 *
 * @fires ct-change - Fired when file(s) are added. detail: { files: FileData[] }
 * @fires ct-remove - Fired when a file is removed. detail: { id: string, files: FileData[] }
 * @fires ct-error - Fired when an error occurs. detail: { error: Error, message: string }
 *
 * @example
 * <ct-file-input accept=".pdf,.docx" buttonText="📄 Upload Document"></ct-file-input>
 * @example
 * <ct-file-input accept="image/\*,application/pdf" multiple></ct-file-input>
 */
export class CTFileInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .container {
        display: flex;
        flex-direction: column;
        gap: var(--ct-theme-spacing-normal, 0.75rem);
      }

      input[type="file"] {
        display: none;
      }

      .previews {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: var(--ct-theme-spacing-normal, 0.75rem);
      }

      .preview-item {
        position: relative;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        overflow: hidden;
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-200, #e5e7eb));
        background: var(
          --ct-theme-color-background,
          var(--ct-color-gray-50, #f9fafb)
        );
      }

      .preview-item img {
        width: 100%;
        height: 120px;
        object-fit: cover;
        display: block;
      }

      .preview-item.size-sm img,
      .preview-item.size-sm .file-preview {
        height: 80px;
      }

      .preview-item.size-lg img,
      .preview-item.size-lg .file-preview {
        height: 160px;
      }

      .file-preview {
        width: 100%;
        height: 120px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 1rem;
        background: var(
          --ct-theme-color-background,
          var(--ct-color-gray-50, #f9fafb)
        );
      }

      .file-icon {
        font-size: 2rem;
        line-height: 1;
      }

      .file-name {
        font-size: 0.75rem;
        text-align: center;
        word-break: break-word;
        color: var(
          --ct-theme-color-text-muted,
          var(--ct-color-gray-600, #4b5563)
        );
      }

      .remove-button {
        position: absolute;
        top: 4px;
        right: 4px;
        background: rgba(0, 0, 0, 0.6);
        color: white;
        border: none;
        border-radius: 50%;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0;
        transition: background 0.2s ease;
      }

      .remove-button:hover {
        background: rgba(0, 0, 0, 0.8);
      }

      .file-info {
        padding: 6px 8px;
        font-size: 0.75rem;
        color: var(
          --ct-theme-color-text-muted,
          var(--ct-color-gray-600, #4b5563)
        );
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        color: var(
          --ct-theme-color-text-muted,
          var(--ct-color-gray-600, #4b5563)
        );
        font-size: 0.875rem;
      }
    `,
  ];

  @property({ type: Boolean })
  multiple = false;

  @property({ type: Number })
  maxFiles?: number;

  @property({ type: String })
  accept = "*/*";

  @property({ type: String })
  buttonText = "📎 Add File";

  @property({ type: String })
  variant: ButtonVariant = "outline";

  @property({ type: String })
  size: ButtonSize = "default";

  @property({ type: Boolean })
  showPreview = true;

  @property({ type: String })
  previewSize: "sm" | "md" | "lg" = "md";

  @property({ type: Boolean })
  removable = true;

  @property({ type: Boolean })
  disabled = false;

  @property({ type: Number })
  maxSizeBytes?: number;

  @property({ type: Array })
  files: CellHandle<FileData[]> | FileData[] = [];

  @property({ type: Boolean })
  protected loading = false;

  // Theme consumption
  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  protected _cellController = createArrayCellController<FileData>(this, {
    onChange: (_newFiles: FileData[], _oldFiles: FileData[]) => {
      this.requestUpdate();
    },
  });

  protected _generateId(): string {
    return `file-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  protected getFiles(): FileData[] {
    return [...this._cellController.getValue()];
  }

  protected setFiles(newFiles: FileData[]): void {
    this._cellController.setValue(newFiles);
  }

  /**
   * Process a file and return FileData
   * Subclasses can override this to add custom processing
   */
  protected async processFile(file: File): Promise<FileData> {
    const id = this._generateId();
    const dataUrl = await this._readFileAsDataURL(file);

    return {
      id,
      name: file.name,
      url: dataUrl,
      data: dataUrl,
      timestamp: Date.now(),
      size: file.size,
      type: file.type,
    };
  }

  /**
   * Determine if a file should be compressed
   * Base class: never compress (subclasses override)
   */
  protected shouldCompressFile(_file: File): boolean {
    return false;
  }

  /**
   * Compress a file
   * Subclasses override this for specific compression logic
   */
  protected compressFile(file: File): Promise<Blob> {
    return Promise.resolve(file);
  }

  /**
   * Render preview for a file
   * Subclasses can override for custom preview rendering
   */
  protected renderPreview(file: FileData): TemplateResult {
    // Smart default preview based on MIME type
    if (file.type.startsWith("image/")) {
      return html`
        <img src="${file.url}" alt="${file.name}" />
      `;
    }

    // Generic file preview with icon
    const icon = this._getFileIcon(file.type);
    return html`
      <div class="file-preview">
        <div class="file-icon">${icon}</div>
        <div class="file-name">${file.name}</div>
      </div>
    `;
  }

  /**
   * Render the file input element
   * Subclasses can override to add custom attributes (e.g., capture)
   */
  protected renderFileInput(): TemplateResult {
    return html`
      <input
        type="file"
        accept="${this.accept}"
        ?multiple="${this.multiple}"
        ?disabled="${this.disabled}"
        @change="${this._handleFileChange}"
      />
    `;
  }

  protected renderButton(): TemplateResult {
    return html`
      <ct-button
        variant="${this.variant}"
        size="${this.size}"
        ?disabled="${this.disabled || this.loading}"
        @click="${this._handleButtonClick}"
      >
        ${this.loading ? "Loading..." : this.buttonText}
      </ct-button>
    `;
  }

  protected renderPreviews(): TemplateResult {
    const currentFiles = this.getFiles();

    if (!this.showPreview || currentFiles.length === 0) {
      return html`

      `;
    }

    return html`
      <div class="previews">
        ${currentFiles.map(
          (file) =>
            html`
              <div class="preview-item size-${this.previewSize}">
                ${this.renderPreview(file)} ${this.removable
                  ? html`
                    <button
                      type="button"
                      class="remove-button"
                      @click="${() => this._handleRemove(file.id)}"
                      aria-label="Remove file"
                    >
                      ×
                    </button>
                  `
                  : ""}
                <div class="file-info" title="${file.name}">
                  ${file.name} (${formatFileSize(file.size)})
                </div>
              </div>
            `,
        )}
      </div>
    `;
  }

  private _getFileIcon(mimeType: string): string {
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType === "application/pdf") return "📄";
    if (mimeType.startsWith("video/")) return "🎬";
    if (mimeType.startsWith("audio/")) return "🎵";
    if (mimeType.startsWith("text/")) return "📝";
    if (
      mimeType.includes("word") ||
      mimeType.includes("document") ||
      mimeType.includes("openxmlformats")
    ) {
      return "📝";
    }
    if (mimeType.includes("sheet") || mimeType.includes("excel")) return "📊";
    if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) {
      return "📽️";
    }
    return "📎";
  }

  private _readFileAsDataURL(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  private _handleButtonClick() {
    this.emit("ct-click"); // Emit before opening file picker
    const input = this.shadowRoot?.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    input?.click();
  }

  protected async _handleFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;

    if (!files || files.length === 0) return;

    const currentFiles = this.getFiles();

    // Check max files limit (only for multiple mode)
    // Single-file mode replaces existing files, so no max check needed
    if (this.multiple && this.maxFiles) {
      const totalFiles = currentFiles.length + files.length;
      if (totalFiles > this.maxFiles) {
        this.emit("ct-error", {
          error: new Error("Max files exceeded"),
          message: `Maximum ${this.maxFiles} files allowed`,
        });
        return;
      }
    }

    this.loading = true;

    try {
      const newFiles: FileData[] = [];

      for (const file of Array.from(files)) {
        try {
          // Check if should compress (subclass decides)
          let fileToProcess: Blob = file;
          if (this.shouldCompressFile(file)) {
            fileToProcess = await this.compressFile(file);
          }

          // Check file size AFTER compression if maxSizeBytes is set
          if (this.maxSizeBytes && fileToProcess.size > this.maxSizeBytes) {
            console.warn(
              `File ${file.name} (${
                formatFileSize(fileToProcess.size)
              }) exceeds maxSizeBytes (${
                formatFileSize(this.maxSizeBytes)
              }) even after compression`,
            );
          }

          // Process file (subclass can override)
          const fileData = await this.processFile(
            new File([fileToProcess], file.name, { type: file.type }),
          );
          newFiles.push(fileData);
        } catch (error) {
          this.emit("ct-error", {
            error: error as Error,
            message: `Failed to process ${file.name}`,
          });
        }
      }

      // When multiple is false, replace existing files instead of appending
      const updatedFiles = this.multiple
        ? [...currentFiles, ...newFiles]
        : newFiles;
      this.setFiles(updatedFiles);
      this.emit("ct-change", { files: updatedFiles });
    } finally {
      this.loading = false;
      // Reset input so same file can be selected again
      input.value = "";
    }
  }

  private _handleRemove(id: string) {
    const currentFiles = this.getFiles();
    const updatedFiles = currentFiles.filter((file) => file.id !== id);
    this.setFiles(updatedFiles);
    this.emit("ct-remove", { id, files: updatedFiles });
    this.emit("ct-change", { files: updatedFiles });
  }

  override connectedCallback() {
    super.connectedCallback();
    // CellController handles subscription automatically via ReactiveController
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // CellController handles cleanup automatically via ReactiveController
  }

  override willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);

    // If the files property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("files")) {
      // Bind the new value (Cell or plain array) to the controller
      this._cellController.bind(this.files, FileDataArraySchema);
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme ?? defaultTheme);
    }
  }

  override firstUpdated() {
    // Bind the initial value to the cell controller
    this._cellController.bind(this.files, FileDataArraySchema);

    // Apply theme after first render
    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override render() {
    return html`
      <div class="container">
        ${this.renderFileInput()} ${this.renderButton()} ${this.loading
          ? html`
            <div class="loading">Processing files...</div>
          `
          : ""} ${this.renderPreviews()}
      </div>
    `;
  }
}

customElements.define("ct-file-input", CTFileInput);
