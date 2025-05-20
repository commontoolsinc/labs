export * from "./components.ts";
import theme from "./theme/light.styles.ts";
import { registerIconLibrary } from "@shoelace-style/shoelace";

/**
 * Adopt the styles for shoelace components.
 * This should typically be called on `document`.
 * Calling with no arguments will perform this on `document`.
 */
export const adoptShoelaceStyles = (
  host: Document | ShadowRoot = globalThis.document,
) => {
  host.adoptedStyleSheets = [theme.styleSheet!];
};

export const registerShoelaceIcons = () => {
  registerIconLibrary("material", {
    resolver: (name: string) => {
      const match = name.match(/^(.*?)(_(round|sharp))?$/);
      return match
        ? new URL(
          `${match[1]}/${match[3] || "outline"}.svg`,
          "https://cdn.jsdelivr.net/npm/@material-icons/svg@1.0.5/svg/",
        ).toString()
        : "about:blank";
    },
    mutator: (svg: SVGElement) => svg.setAttribute("fill", "currentColor"),
  });
};

export const setupShoelace = ({
  host = globalThis.document,
}: {
  host?: Document | ShadowRoot;
} = {}) => {
  registerShoelaceIcons();
  adoptShoelaceStyles(host);
};
