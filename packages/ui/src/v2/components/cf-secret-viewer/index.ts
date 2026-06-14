import { CFSecretViewer } from "./cf-secret-viewer.ts";

if (!customElements.get("cf-secret-viewer")) {
  customElements.define("cf-secret-viewer", CFSecretViewer);
}

export { CFSecretViewer };
