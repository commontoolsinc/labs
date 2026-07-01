import { css, html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFImage - Renders an image from raw bytes.
 *
 * The cell holds the raw response bytes (from `fetchBinary`); this render-layer
 * component mints an object URL from a Blob and revokes it when the bytes
 * change or the element is removed. Patterns pass `bytes` and `mediaType`
 * directly without touching `URL.createObjectURL`.
 *
 * The `bytes` value may arrive as a `FabricBytes` wrapper, a `Uint8Array`, or a
 * plain `number[]`, so coercion is defensive.
 *
 * @element cf-image
 *
 * @property {unknown} bytes - Raw image bytes (FabricBytes, Uint8Array, or number[])
 * @attr {string} media-type - Media type for the Blob, e.g. "image/png"
 * @attr {string} alt - Alternative text for the image
 */
export class CFImage extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
      }

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    `,
  ];

  @property({ attribute: false })
  accessor bytes: unknown = undefined;

  @property({ type: String, attribute: "media-type" })
  accessor mediaType = "";

  @property({ type: String })
  accessor alt = "";

  private _objectUrl: string | null = null;

  private _revokeObjectUrl() {
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
  }

  /**
   * Coerce the various shapes `bytes` may take into a Uint8Array. Returns null
   * when the value can't be read as bytes (the image then stays empty).
   */
  private _coerceBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
    if (value == null) return null;

    // Copy into a fresh ArrayBuffer-backed array so the result is a valid
    // BlobPart regardless of the source's backing buffer.
    if (value instanceof Uint8Array) return new Uint8Array(value);

    const maybe = value as {
      slice?: (start?: number, end?: number) => unknown;
      length?: number;
    };

    if (typeof maybe.slice === "function") {
      try {
        return new Uint8Array(maybe.slice() as ArrayLike<number>);
      } catch {
        // Fall through to the remaining strategies.
      }
    }

    if (Array.isArray(value)) {
      return new Uint8Array(value as number[]);
    }

    if (typeof maybe.length === "number") {
      try {
        return Uint8Array.from(value as ArrayLike<number>);
      } catch {
        return null;
      }
    }

    return null;
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("bytes") || changedProperties.has("mediaType")) {
      this._revokeObjectUrl();

      const u8 = this._coerceBytes(this.bytes);
      if (u8) {
        const blob = new Blob([u8], { type: this.mediaType || undefined });
        this._objectUrl = URL.createObjectURL(blob);
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._revokeObjectUrl();
  }

  override render() {
    if (!this._objectUrl) return null;
    return html`
      <img src="${this._objectUrl}" alt="${this.alt}" />
    `;
  }
}
