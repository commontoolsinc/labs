import { CFFileDownload } from "./cf-file-download.ts";

if (!customElements.get("cf-file-download")) {
  customElements.define("cf-file-download", CFFileDownload);
}

export { CFFileDownload };
