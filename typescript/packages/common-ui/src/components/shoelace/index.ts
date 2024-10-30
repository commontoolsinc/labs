export * from "./components.js";
import theme from "./theme/light.styles.js";

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
