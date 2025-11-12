import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { ifDefined } from "lit/directives/if-defined.js";
import type { ButtonSize, ButtonVariant } from "../ct-button/ct-button.ts";
import { type Cell } from "@commontools/runner";
import { createArrayCellController } from "../../core/cell-controller.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";
import {
  compressImage,
  formatFileSize,
} from "../../utils/image-compression.ts";
import "../ct-button/ct-button.ts";

/**
 * Image data structure
 */
export interface ExifData {
  // Core metadata
  dateTime?: string;
  make?: string;
  model?: string;

  // Orientation
  orientation?: number;

  // Location (if available)
  gpsLatitude?: number;
  gpsLongitude?: number;
  gpsAltitude?: number;

  // Camera settings
  fNumber?: number;
  exposureTime?: string;
  iso?: number;
  focalLength?: number;

  // Dimensions
  pixelXDimension?: number;
  pixelYDimension?: number;

  // Software
  software?: string;

  // Raw EXIF tags for advanced use
  raw?: Record<string, any>;
}

export interface ImageData {
  id: string;
  name: string;
  url: string;
  data: string;
  timestamp: number;
  width?: number;
  height?: number;
  size: number;
  type: string;
  exif?: ExifData;
}

/**
 * CTImageInput - Image capture and upload component with camera support
 *
 * @element ct-image-input
 *
 * @attr {boolean} multiple - Allow multiple images (default: false)
 * @attr {number} maxImages - Max number of images (default: unlimited)
 * @attr {number} maxSizeBytes - Max size in bytes before compression (default: no compression)
 * @attr {string} capture - Capture mode: "user" | "environment" | false
 * @attr {string} buttonText - Custom button text (default: "📷 Add Photo")
 * @attr {string} variant - Button style variant
 * @attr {string} size - Button size
 * @attr {boolean} showPreview - Show image previews (default: true)
 * @attr {string} previewSize - Preview thumbnail size: "sm" | "md" | "lg"
 * @attr {boolean} removable - Allow removing images (default: true)
 * @attr {boolean} disabled - Disable the input
 *
 * @fires ct-change - Fired when image(s) are added. detail: { images: ImageData[] }
 * @fires ct-remove - Fired when an image is removed. detail: { id: string, images: ImageData[] }
 * @fires ct-error - Fired when an error occurs. detail: { error: Error, message: string }
 *
 * @example
 * <ct-image-input capture="environment" buttonText="📸 Scan"></ct-image-input>
 * @example
 * <ct-image-input maxSizeBytes={5000000} buttonText="📸 Upload"></ct-image-input>
 */
export class CTImageInput extends BaseElement {
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

      .preview-item.size-sm img {
        height: 80px;
      }

      .preview-item.size-lg img {
        height: 160px;
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

      .image-info {
        padding: 6px 8px;
        font-size: 0.75rem;
        color: var(--ct-theme-color-text-muted, var(--ct-color-gray-600, #4b5563));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        color: var(--ct-theme-color-text-muted, var(--ct-color-gray-600, #4b5563));
        font-size: 0.875rem;
      }
    `,
  ];

  @property({ type: Boolean })
  multiple = false;

  @property({ type: Number })
  maxImages?: number;

  @property({ type: String })
  capture?: "user" | "environment" | false;

  @property({ type: String })
  buttonText = "📷 Add Photo";

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
  maxSizeBytes?: number = 5 * 1024 * 1024; // Default to 5MB

  @property({ type: Array })
  images: Cell<ImageData[]> | ImageData[] = [];

  @property({ type: Boolean })
  private loading = false;

  // Theme consumption
  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  private _cellController = createArrayCellController<ImageData>(this, {
    onChange: (_newImages: ImageData[], _oldImages: ImageData[]) => {
      // Just request an update to re-render with the new cell value
      // Don't emit ct-change here - that causes infinite loops when using handlers
      this.requestUpdate();
    },
  });

  private _generateId(): string {
    return `img-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private getImages(): ImageData[] {
    return [...this._cellController.getValue()];
  }

  private setImages(newImages: ImageData[]): void {
    this._cellController.setValue(newImages);
  }

  private _handleButtonClick() {
    const input = this.shadowRoot?.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    input?.click();
  }

  private async _handleFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;

    if (!files || files.length === 0) return;

    const currentImages = this.getImages();

    // Check max images limit
    if (
      this.maxImages &&
      currentImages.length + files.length > this.maxImages
    ) {
      this.emit("ct-error", {
        error: new Error("Max images exceeded"),
        message: `Maximum ${this.maxImages} images allowed`,
      });
      return;
    }

    this.loading = true;

    try {
      const newImages: ImageData[] = [];

      for (const file of Array.from(files)) {
        try {
          const imageData = await this._processFile(file);
          newImages.push(imageData);
        } catch (error) {
          this.emit("ct-error", {
            error: error as Error,
            message: `Failed to process ${file.name}`,
          });
        }
      }

      // When multiple is false, replace existing images instead of appending
      const updatedImages = this.multiple
        ? [...currentImages, ...newImages]
        : newImages;
      this.setImages(updatedImages);
      this.emit("ct-change", { images: updatedImages });
    } finally {
      this.loading = false;
      // Reset input so same file can be selected again
      input.value = "";
    }
  }

  /**
   * Compress an image file using the image compression utility
   * @param file - The image file to compress
   * @param maxSizeBytes - Target maximum size in bytes
   * @returns Compressed blob
   */
  private async _compressImage(
    file: File,
    maxSizeBytes: number,
  ): Promise<Blob> {
    const result = await compressImage(file, { maxSizeBytes });

    // Log compression result
    if (result.compressedSize < result.originalSize) {
      console.log(
        `Compressed ${file.name}: ${formatFileSize(result.originalSize)} → ${
          formatFileSize(result.compressedSize)
        } (${result.width}x${result.height}, q${result.quality.toFixed(2)})`,
      );
    }

    if (result.compressedSize > maxSizeBytes) {
      console.warn(
        `Could not compress ${file.name} below ${
          formatFileSize(maxSizeBytes)
        }. Final size: ${formatFileSize(result.compressedSize)}`,
      );
    }

    return result.blob;
  }

  private async _processFile(file: File): Promise<ImageData> {
    const id = this._generateId();

    console.log(
      `Processing file: ${file.name}, size: ${
        formatFileSize(file.size)
      }, maxSizeBytes: ${this.maxSizeBytes}`,
    );

    // Compress if maxSizeBytes is set and file exceeds it
    let fileToProcess: Blob = file;
    if (this.maxSizeBytes && file.size > this.maxSizeBytes) {
      console.log(`File exceeds limit, starting compression...`);
      try {
        fileToProcess = await this._compressImage(file, this.maxSizeBytes);
        console.log(
          `Compression complete: ${formatFileSize(fileToProcess.size)}`,
        );
      } catch (error) {
        console.error("Compression failed, using original file:", error);
        // Continue with original file if compression fails
      }
    } else {
      console.log(`File is small enough, skipping compression`);
    }

    return new Promise((resolve, reject) => {
      console.log(
        `Converting compressed file to data URL (${
          formatFileSize(fileToProcess.size)
        })...`,
      );
      const reader = new FileReader();

      reader.onload = () => {
        const dataUrl = reader.result as string;
        console.log(
          `Data URL ready (${formatFileSize(dataUrl.length)} as string)`,
        );

        // Get image dimensions from the data URL
        const img = new Image();
        img.onload = () => {
          console.log(`Dimensions: ${img.width}x${img.height}`);

          const imageData: ImageData = {
            id,
            name: file.name || `Photo-${Date.now()}.jpg`,
            url: dataUrl,
            data: dataUrl,
            timestamp: Date.now(),
            width: img.width,
            height: img.height,
            size: fileToProcess.size, // Use compressed size
            type: fileToProcess.type || file.type,
          };

          resolve(imageData);
        };

        img.onerror = () => {
          reject(new Error("Failed to load image"));
        };

        img.src = dataUrl;
      };

      reader.onerror = () => {
        reject(new Error("Failed to read file"));
      };

      reader.readAsDataURL(fileToProcess);
    });
  }

  private _handleRemove(id: string) {
    const currentImages = this.getImages();
    const updatedImages = currentImages.filter((img) => img.id !== id);
    this.setImages(updatedImages);
    this.emit("ct-remove", { id, images: updatedImages });
    this.emit("ct-change", { images: updatedImages });
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

    // If the images property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("images")) {
      // Bind the new value (Cell or plain array) to the controller
      this._cellController.bind(this.images);
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
    this._cellController.bind(this.images);

    // Apply theme after first render
    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override render() {
    // Only set capture attribute if explicitly specified (not false)
    const captureAttr = this.capture !== false ? this.capture : undefined;
    const currentImages = this.getImages();

    return html`
      <div class="container">
        <input
          type="file"
          accept="image/*"
          ?multiple="${this.multiple}"
          ?disabled="${this.disabled}"
          capture="${ifDefined(captureAttr)}"
          @change="${this._handleFileChange}"
        />

        <ct-button
          variant="${this.variant}"
          size="${this.size}"
          ?disabled="${this.disabled || this.loading}"
          @click="${this._handleButtonClick}"
        >
          ${this.loading ? "Loading..." : this.buttonText}
        </ct-button>

        ${this.loading
          ? html`
            <div class="loading">Processing images...</div>
          `
          : ""} ${this.showPreview && currentImages.length > 0
          ? html`
            <div class="previews">
              ${currentImages.map(
                (image) =>
                  html`
                    <div class="preview-item size-${this.previewSize}">
                      <img src="${image.url}" alt="${image.name}" />
                      ${this.removable
                        ? html`
                          <button
                            type="button"
                            class="remove-button"
                            @click="${() => this._handleRemove(image.id)}"
                            aria-label="Remove image"
                          >
                            ×
                          </button>
                        `
                        : ""}
                      <div class="image-info" title="${image.name}">
                        ${image.name} (${formatFileSize(image.size)})
                      </div>
                    </div>
                  `,
              )}
            </div>
          `
          : ""}
      </div>
    `;
  }
}

customElements.define("ct-image-input", CTImageInput);
