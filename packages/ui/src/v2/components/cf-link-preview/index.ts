import { CFLinkPreview } from "./cf-link-preview.ts";

if (!customElements.get("cf-link-preview")) {
  customElements.define("cf-link-preview", CFLinkPreview);
}

export { CFLinkPreview };
export type { CFLinkPreview as CFLinkPreviewElement } from "./cf-link-preview.ts";
