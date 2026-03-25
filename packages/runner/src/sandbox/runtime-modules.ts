import { createBuilder } from "../builder/factory.ts";
import { StaticCache } from "@commontools/static";
import turndown from "turndown";
import type { RuntimeModuleIdentifier } from "./runtime-module-policy.ts";
export type { RuntimeModuleIdentifier } from "./runtime-module-policy.ts";
export {
  isRuntimeModuleIdentifier,
  RuntimeModuleIdentifiers,
} from "./runtime-module-policy.ts";

export const getRuntimeModuleTypes = (() => {
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
      "turndown": await cache.getText("types/turndown.d.ts"),
      "@commontools/html": builderTypes,
      "@commontools/builder": builderTypes,
      "@commontools/runner": builderTypes,
    };
    return depTypes;
  };
})();

export function getRuntimeModuleExports() {
  const { commontools, exportsCallback } = createBuilder();
  return {
    runtimeExports: {
      "commontools": commontools,
      // commontools/schema only exports types, no runtime values needed
      "commontools/schema": {},
      // __esModule lets this load in the AMD loader
      // when finding the "default"
      "turndown": { default: turndown, __esModule: true },
      "@commontools/html": commontools,
      "@commontools/builder": commontools,
      "@commontools/runner": commontools,
    },
    exportsCallback,
  };
}
