import { createBuilder } from "@commontools/builder";
import { cache } from "@commontools/static";
import turndown from "turndown";
import { IRuntime } from "../runtime.ts";

export type RuntimeModuleIdentifier =
  | "commontools"
  | "dom-parser"
  | "turndown"
  | "@commontools/html"
  | "@commontools/builder"
  | "@commontools/runner";
export const RuntimeModuleIdentifiers: RuntimeModuleIdentifier[] = [
  "commontools",
  "dom-parser",
  "turndown",
  // backwards compat
  "@commontools/html",
  // backwards compat
  "@commontools/builder",
  // backwards compat, for supporting { type Cell } from "@commontools/runner"
  // from older recipes
  "@commontools/runner",
];
export function isRuntimeModuleIdentifier(
  value: unknown,
): value is RuntimeModuleIdentifier {
  return typeof value === "string" &&
    RuntimeModuleIdentifiers.includes(value as RuntimeModuleIdentifier);
}

export const getTypes = (() => {
  let depTypes:
    | Record<RuntimeModuleIdentifier, string>
    | undefined;
  return async () => {
    if (depTypes) {
      return depTypes;
    }
    const builderTypes = await cache.getText("types/commontools.d.ts");
    depTypes = {
      "commontools": builderTypes,
      "dom-parser": await cache.getText(
        "types/dom-parser.d.ts",
      ),
      "turndown": await cache.getText(
        "types/turndown.d.ts",
      ),
      "@commontools/html": builderTypes,
      "@commontools/builder": builderTypes,
      "@commontools/runner": builderTypes,
    };
    return depTypes;
  };
})();

export async function getExports(runtime: IRuntime) {
  const builder = createBuilder(runtime);
  const DOMParser = await getDOMParser();
  return {
    "commontools": builder,
    "dom-parser": { DOMParser },
    // __esModule lets this load in the AMD loader
    // when finding the "default"
    "turndown": { default: turndown, __esModule: true },
    "@commontools/html": builder,
    "@commontools/builder": builder,
    "@commontools/runner": builder,
  };
}

const getDOMParser = (() => {
  let domParser: object | undefined;
  return async () => {
    if (domParser) {
      return domParser;
    }
    if (globalThis.DOMParser) {
      domParser = globalThis.DOMParser as object;
    } else {
      const { JSDOM } = await import("jsdom");
      const jsdom = new JSDOM("");
      domParser = jsdom.window.DOMParser as object;
    }
    return domParser;
  };
})();
