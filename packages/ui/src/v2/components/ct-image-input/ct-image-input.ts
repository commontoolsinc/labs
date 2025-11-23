import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import {
  CTFileInput,
  type FileData,
} from "../ct-file-input/ct-file-input.ts";
import {
  compressImage,
  formatFileSize,
} from "../../utils/image-compression.ts";

/**
 * Image-specific metadata (EXIF data)
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

/**
 * Image data structure (extends FileData with image-specific fields)
 */
export interface ImageData extends FileData {
  width?: number;
  height?: number;
  exif?: ExifData;
}

/**
 * CTImageInput - Image capture and upload component with camera support
 *
 * Extends CTFileInput with image-specific features like compression, EXIF extraction,
 * and camera capture support.
 *
 * @element ct-image-input
 *
 * @attr {boolean} multiple - Allow multiple images (default: false)
 * @attr {number} maxImages - Max number of images (default: unlimited)
 * @attr {number} maxSizeBytes - Max size in bytes before compression (default: 5MB)
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
export class CTImageInput extends CTFileInput {
  // Override default properties with image-specific defaults
  @property({ type: String })
  override buttonText = "📷 Add Photo";

  @property({ type: String })
  override accept = "image/*";

  @property({ type: Number })
  override maxSizeBytes = 5 * 1024 * 1024; // Default to 5MB for images

  // Image-specific properties
  @property({ type: String })
  capture?: "user" | "environment" | false;

  @property({ type: Boolean })
  extractExif = false;

  // Provide backward-compatible property alias
  get images(): ImageData[] | any {
    return this.files;
  }
  set images(value: ImageData[] | any) {
    this.files = value;
  }

  // Alias maxImages to maxFiles for backward compatibility
  get maxImages(): number | undefined {
    return this.maxFiles;
  }
  set maxImages(value: number | undefined) {
    this.maxFiles = value;
  }

  // Override: Images should be compressed if maxSizeBytes is set and exceeded
  protected override shouldCompressFile(file: File): boolean {
    return !!(this.maxSizeBytes && file.size > this.maxSizeBytes);
  }

  // Override: Use image compression utility
  protected override async compressFile(file: File): Promise<Blob> {
    if (!this.maxSizeBytes) return file;

    const result = await compressImage(file, {
      maxSizeBytes: this.maxSizeBytes,
    });

    // Log compression result
    if (result.compressedSize < result.originalSize) {
      console.log(
        `Compressed ${file.name}: ${formatFileSize(result.originalSize)} → ${
          formatFileSize(result.compressedSize)
        } (${result.width}x${result.height}, q${result.quality.toFixed(2)})`,
      );
    }

    if (result.compressedSize > this.maxSizeBytes) {
      console.warn(
        `Could not compress ${file.name} below ${
          formatFileSize(this.maxSizeBytes)
        }. Final size: ${formatFileSize(result.compressedSize)}`,
      );
    }

    return result.blob;
  }

  // Override: Extract image dimensions and EXIF
  protected override async processFile(file: File): Promise<ImageData> {
    // Get base file data
    const baseData = await super.processFile(file);

    // Load image to get dimensions
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        const imageData: ImageData = {
          ...baseData,
          width: img.width,
          height: img.height,
        };

        // TODO: Add EXIF extraction if this.extractExif is true

        resolve(imageData);
      };

      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = baseData.url;
    });
  }

  // Override: Always use <img> for images (we know they're images)
  protected override renderPreview(file: ImageData): TemplateResult {
    return html`<img src="${file.url}" alt="${file.name}" />`;
  }

  // Override: Add capture attribute to file input
  protected override renderFileInput(): TemplateResult {
    const captureAttr = this.capture !== false ? this.capture : undefined;

    return html`
      <input
        type="file"
        accept="${this.accept}"
        ?multiple="${this.multiple}"
        ?disabled="${this.disabled}"
        capture="${ifDefined(captureAttr)}"
        @change="${this._handleFileChangeInternal}"
      />
    `;
  }

  // Override render to keep "Processing images..." text
  override render() {
    return html`
      <div class="container">
        ${this.renderFileInput()} ${this.renderButton()}
        ${this.loading
          ? html`<div class="loading">Processing images...</div>`
          : ""}
        ${this.renderPreviews()}
      </div>
    `;
  }

  // Internal handler that calls parent's protected handler
  private _handleFileChangeInternal = (event: Event) => {
    // Call parent's protected _handleFileChange method
    super._handleFileChange(event);
  };

  // Override emit to add backward-compatible event details
  override emit(eventName: string, detail?: any) {
    if (eventName === "ct-change" && detail?.files) {
      // Add 'images' property for backward compatibility
      super.emit(eventName, {
        ...detail,
        images: detail.files,
      });
    } else if (eventName === "ct-remove" && detail?.files) {
      // Add 'images' property for backward compatibility
      super.emit(eventName, {
        ...detail,
        images: detail.files,
      });
    } else {
      super.emit(eventName, detail);
    }
  }
}

customElements.define("ct-image-input", CTImageInput);
