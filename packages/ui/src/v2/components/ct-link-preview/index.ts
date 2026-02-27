import { CTLinkPreview } from "./ct-link-preview.ts";

if (!customElements.get("ct-link-preview")) {
  customElements.define("ct-link-preview", CTLinkPreview);
}

export { CTLinkPreview };
export type { CTLinkPreview as CTLinkPreviewElement } from "./ct-link-preview.ts";
