import { CTImageInput } from "./ct-image-input.ts";

if (!customElements.get("ct-image-input")) {
  customElements.define("ct-image-input", CTImageInput);
}

export { CTImageInput };
export type { ImageData, ExifData } from "./ct-image-input.ts";
