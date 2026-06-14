import { CFThemeProvider } from "./cf-theme.ts";

if (!customElements.get("cf-theme")) {
  customElements.define("cf-theme", CFThemeProvider);
}

export type { CFThemeProvider as CFThemeElement } from "./cf-theme.ts";
