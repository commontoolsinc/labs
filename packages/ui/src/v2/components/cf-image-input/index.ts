import { CFImageInput } from "./cf-image-input.ts";

if (!customElements.get("cf-image-input")) {
  customElements.define("cf-image-input", CFImageInput);
}

export { CFImageInput };
export type { ExifData, ImageData } from "./cf-image-input.ts";
