import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { CFFileInput, type FileData } from "../cf-file-input/cf-file-input.ts";
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
 * CFImageInput - Image capture and upload component with camera support
 *
 * Extends CFFileInput with image-specific features like compression, EXIF extraction,
 * and camera capture support.
 *
 * @element cf-image-input
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
 * @fires cf-change - Fired when image(s) are added. detail: { images: ImageData[] }
 * @fires cf-remove - Fired when an image is removed. detail: { id: string, images: ImageData[] }
 * @fires cf-error - Fired when an error occurs. detail: { error: Error, message: string }
 *
 * @example
 * <cf-image-input capture="environment" buttonText="📸 Scan"></cf-image-input>
 * @example
 * <cf-image-input maxSizeBytes={5000000} buttonText="📸 Upload"></cf-image-input>
 */
export class CFImageInput extends CFFileInput {
  // Override default properties with image-specific defaults
  @property({ type: String })
  override accessor buttonText = "📷 Add Photo";

  @property({ type: String })
  override accessor accept = "image/*";

  @property({ type: Number })
  override accessor maxSizeBytes = 5 * 1024 * 1024; // Default to 5MB for images

  // Image-specific properties
  @property({ type: String })
  accessor capture: "user" | "environment" | false | undefined = undefined;

  @property({ type: Boolean })
  accessor extractExif = false;

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

        // TODO(#exif): Add EXIF extraction if this.extractExif is true

        resolve(imageData);
      };

      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = baseData.url;
    });
  }

  // Override: Always use <img> for images (we know they're images)
  protected override renderPreview(file: ImageData): TemplateResult {
    return html`
      <img src="${file.url}" alt="${file.name}" />
    `;
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
        ${this.renderFileInput()} ${this.renderButton()} ${this.loading
          ? html`
            <div class="loading">Processing images...</div>
          `
          : ""} ${this.renderPreviews()}
      </div>
    `;
  }

  // Internal handler that calls parent's protected handler
  private _handleFileChangeInternal = (event: Event) => {
    // Call parent's protected _handleFileChange method
    super._handleFileChange(event);
  };

  // Override emit to add backward-compatible event details
  protected override emit<T = any>(
    eventName: string,
    detail?: T,
    options?: EventInit,
  ): boolean {
    if (eventName === "cf-change" && (detail as any)?.files) {
      // Add 'images' property for backward compatibility
      return super.emit(eventName, {
        ...detail,
        images: (detail as any).files,
      } as T, options);
    } else if (eventName === "cf-remove" && (detail as any)?.files) {
      // Add 'images' property for backward compatibility
      return super.emit(eventName, {
        ...detail,
        images: (detail as any).files,
      } as T, options);
    } else {
      return super.emit(eventName, detail, options);
    }
  }
}

customElements.define("cf-image-input", CFImageInput);
