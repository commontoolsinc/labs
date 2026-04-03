import { CTImageInput } from "./ct-image-input.ts";

if (!customElements.get("ct-image-input")) {
  customElements.define("ct-image-input", CTImageInput);
}

export { CTImageInput };
export type { ExifData, ImageData } from "./ct-image-input.ts";
