import { CTThemeProvider } from "./ct-theme.ts";

if (!customElements.get("ct-theme")) {
  customElements.define("ct-theme", CTThemeProvider);
}

export type { CTThemeProvider as CTThemeElement } from "./ct-theme.ts";
