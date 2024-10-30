export * from "./components.js";
import theme from "./theme/light.styles.js";

export const adoptStyles = () => {
  window.document.adoptedStyleSheets = [theme.styleSheet];
};
