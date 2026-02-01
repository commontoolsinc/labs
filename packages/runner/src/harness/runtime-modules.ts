import { createBuilder } from "../builder/factory.ts";
import { StaticCache } from "@commontools/static";
import turndown from "turndown";

export type RuntimeModuleIdentifier =
  | "commontools"
  | "commontools/schema"
  | "turndown"
  | "@commontools/html"
  | "@commontools/builder"
  | "@commontools/runner";
export const RuntimeModuleIdentifiers: RuntimeModuleIdentifier[] = [
  "commontools",
  "commontools/schema",
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
  return async (cache: StaticCache) => {
    if (depTypes) {
      return depTypes;
    }
    const builderTypes = await cache.getText("types/commontools.d.ts");
    const schemaTypes = await cache.getText("types/commontools-schema.d.ts");
    depTypes = {
      "commontools": builderTypes,
      "commontools/schema": schemaTypes,
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

// Fallback for when SES is not active (testing/unsafe mode)
// deno-lint-ignore no-explicit-any
const harden = (globalThis as any).harden || ((x: any) => Object.freeze(x));

export function getExports() {
  const { commontools, exportsCallback } = createBuilder();
  return {
    runtimeExports: {
      "commontools": harden(commontools),
      // commontools/schema only exports types, no runtime values needed
      "commontools/schema": {},
      // __esModule lets this load in the AMD loader
      // when finding the "default"
      "turndown": { default: turndown, __esModule: true },
      "@commontools/html": harden(commontools),
      "@commontools/builder": harden(commontools),
      "@commontools/runner": harden(commontools),
    },
    exportsCallback,
  };
}
