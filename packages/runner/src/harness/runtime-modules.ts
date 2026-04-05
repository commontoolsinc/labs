import { createBuilder } from "../builder/factory.ts";
import { StaticCache } from "@commonfabric/static";
import turndown from "turndown";

export type RuntimeModuleIdentifier =
  | "commontools"
  | "commonfabric"
  | "commonfabric/schema"
  | "turndown"
  | "@commonfabric/html"
  | "@commonfabric/builder"
  | "@commonfabric/runner";
export const RuntimeModuleIdentifiers: RuntimeModuleIdentifier[] = [
  "commontools",
  "commonfabric",
  "commonfabric/schema",
  "turndown",
  // backwards compat
  "@commonfabric/html",
  // backwards compat
  "@commonfabric/builder",
  // backwards compat, for supporting { type Cell } from "@commonfabric/runner"
  // from older patterns
  "@commonfabric/runner",
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
    const builderTypes = await cache.getText("types/commonfabric.d.ts");
    const schemaTypes = await cache.getText("types/commonfabric-schema.d.ts");
    depTypes = {
      "commontools": builderTypes,
      "commonfabric": builderTypes,
      "commonfabric/schema": schemaTypes,
      "turndown": await cache.getText(
        "types/turndown.d.ts",
      ),
      "@commonfabric/html": builderTypes,
      "@commonfabric/builder": builderTypes,
      "@commonfabric/runner": builderTypes,
    };
    return depTypes;
  };
})();

export function getExports() {
  const { commonfabric, exportsCallback } = createBuilder();
  return {
    runtimeExports: {
      "commontools": commonfabric,
      "commonfabric": commonfabric,
      // commonfabric/schema only exports types, no runtime values needed
      "commonfabric/schema": {},
      // __esModule lets this load in the AMD loader
      // when finding the "default"
      "turndown": { default: turndown, __esModule: true },
      "@commonfabric/html": commonfabric,
      "@commonfabric/builder": commonfabric,
      "@commonfabric/runner": commonfabric,
    },
    exportsCallback,
  };
}
