import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { classMap } from "lit/directives/class-map.js";
import type { ButtonVariant, ButtonSize } from "../ct-button/ct-button.ts";

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

      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        font-size: 0.875rem;
        font-weight: 500;
        font-family: var(--ct-theme-font-family, inherit);
        line-height: 1.25rem;
        transition: all var(--ct-theme-animation-duration, 0.2s) ease;
        cursor: pointer;
        user-select: none;
        border: 1px solid transparent;
        outline: 2px solid transparent;
        outline-offset: 2px;
        background-color: transparent;
        padding: var(--ct-theme-spacing-normal, 0.5rem)
          var(--ct-theme-spacing-loose, 1rem);
        height: 2.5rem;
      }

      .button:hover:not(:disabled) {
        opacity: 0.9;
      }

      .button:disabled {
        pointer-events: none;
        opacity: 0.5;
        cursor: not-allowed;
      }

      .button.outline {
        background-color: transparent;
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-300, #d1d5db));
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .button.primary {
        background-color: var(
          --ct-theme-color-primary,
          var(--ct-color-primary, #3b82f6)
        );
        color: white;
      }

      .button.secondary {
        background-color: var(
          --ct-theme-color-secondary,
          var(--ct-color-gray-200, #e5e7eb)
        );
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
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

  @property({ type: Array })
  images: ImageData[] = [];

  @property({ type: Boolean })
  private loading = false;

  private _generateId(): string {
    return `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

    // Check max images limit
    if (
      this.maxImages &&
      this.images.length + files.length > this.maxImages
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

      this.images = [...this.images, ...newImages];
      this.emit("ct-change", { images: this.images });
    } finally {
      this.loading = false;
      // Reset input so same file can be selected again
      input.value = "";
    }
  }

  private async _processFile(file: File): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const id = this._generateId();

      reader.onload = async () => {
        try {
          const dataUrl = reader.result as string;

          // Get image dimensions
          const img = new Image();
          img.onload = async () => {
            // Extract EXIF data
            let exif: ExifData | undefined;
            try {
              exif = await this._extractExif(file);
            } catch (error) {
              console.warn("Failed to extract EXIF data:", error);
            }

            const imageData: ImageData = {
              id,
              name: file.name || `Photo-${Date.now()}.jpg`,
              url: dataUrl,
              data: dataUrl,
              timestamp: Date.now(),
              width: img.width,
              height: img.height,
              size: file.size,
              type: file.type,
              exif,
            };

            resolve(imageData);
          };

          img.onerror = () => {
            reject(new Error("Failed to load image"));
          };

          img.src = dataUrl;
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => {
        reject(new Error("Failed to read file"));
      };

      reader.readAsDataURL(file);
    });
  }

  private async _extractExif(file: File): Promise<ExifData | undefined> {
    // TODO: Implement EXIF extraction using a library
    // For now, return undefined - we'll add this in the next step
    return undefined;
  }

  private _handleRemove(id: string) {
    this.images = this.images.filter((img) => img.id !== id);
    this.emit("ct-remove", { id, images: this.images });
    this.emit("ct-change", { images: this.images });
  }

  private _formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  override render() {
    const buttonClasses = {
      button: true,
      [this.variant]: true,
      [this.size]: true,
    };

    const captureAttr = this.capture || undefined;

    return html`
      <div class="container">
        <input
          type="file"
          accept="image/*"
          ?multiple="${this.multiple}"
          ?disabled="${this.disabled}"
          capture="${captureAttr}"
          @change="${this._handleFileChange}"
        />

        <button
          class="${classMap(buttonClasses)}"
          ?disabled="${this.disabled || this.loading}"
          @click="${this._handleButtonClick}"
        >
          ${this.loading ? "Loading..." : this.buttonText}
        </button>

        ${this.loading
          ? html`<div class="loading">Processing images...</div>`
          : ""}
        ${this.showPreview && this.images.length > 0
          ? html`
              <div class="previews">
                ${this.images.map(
                  (image) => html`
                    <div class="preview-item size-${this.previewSize}">
                      <img src="${image.url}" alt="${image.name}" />
                      ${this.removable
                        ? html`
                            <button
                              class="remove-button"
                              @click="${() => this._handleRemove(image.id)}"
                              aria-label="Remove image"
                            >
                              ×
                            </button>
                          `
                        : ""}
                      <div class="image-info" title="${image.name}">
                        ${image.name} (${this._formatFileSize(image.size)})
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
