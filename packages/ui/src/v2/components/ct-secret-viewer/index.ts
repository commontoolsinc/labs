import { CTSecretViewer } from "./ct-secret-viewer.ts";

if (!customElements.get("ct-secret-viewer")) {
  customElements.define("ct-secret-viewer", CTSecretViewer);
}

export { CTSecretViewer };
