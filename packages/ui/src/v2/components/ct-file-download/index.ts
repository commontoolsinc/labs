import { CTFileDownload } from "./ct-file-download.ts";

if (!customElements.get("ct-file-download")) {
  customElements.define("ct-file-download", CTFileDownload);
}

export { CTFileDownload };
