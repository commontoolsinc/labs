export * from "./components.js";
import theme from "./theme/light.styles.js";
import { registerIconLibrary } from "@shoelace-style/shoelace";

/**
 * Adopt the styles for shoelace components.
 * This should typically be called on `document`.
 * Calling with no arguments will perform this on `document`.
 */
export const adoptShoelaceStyles = (
  host: Document | ShadowRoot = window.document,
) => {
  host.adoptedStyleSheets = [theme.styleSheet];
};

export const registerShoelaceIcons = () => {
  registerIconLibrary("material", {
    resolver: (name) => {
      const match = name.match(/^(.*?)(_(round|sharp))?$/);
      return `https://cdn.jsdelivr.net/npm/@material-icons/svg@1.0.5/svg/${match[1]}/${match[3] || "outline"}.svg`;
    },
    mutator: (svg) => svg.setAttribute("fill", "currentColor"),
  });
};

export const setupShoelace = ({
  host = window.document,
}: {
  host?: Document | ShadowRoot;
} = {}) => {
  registerShoelaceIcons();
  adoptShoelaceStyles(host);
};
