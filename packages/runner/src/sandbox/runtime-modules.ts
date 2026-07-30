import { createBuilder } from "../builder/factory.ts";
import { StaticCache } from "@commonfabric/static";
import turndown from "turndown";
import { freezeSandboxValue } from "./hardening.ts";
import * as cfcModule from "@commonfabric/api/cfc-authoring";
export type { RuntimeModuleIdentifier } from "./runtime-module-policy.ts";
export {
  isRuntimeModuleIdentifier,
  RuntimeModuleIdentifiers,
} from "./runtime-module-policy.ts";

/**
 * Resolver-owned runtime type sources that define Common Fabric APIs.
 *
 * This is intentionally an explicit registry rather than a module-name or
 * filename heuristic. `EngineProgramResolver` converts whichever of these it
 * actually supplies into exact `Source.name` values for the TypeScript
 * compiler's provenance registry.
 */
export const CommonFabricRuntimeTypeIdentifiers = [
  "commonfabric",
  "commonfabric/cfc",
  "commonfabric/schema",
  "commontools",
  "commontools/schema",
  "@commontools/html",
  "@commontools/builder",
  "@commontools/runner",
  "cfc.ts",
] as const;

export const getRuntimeModuleTypes = (() => {
  let depTypes:
    | Record<string, string>
    | undefined;
  return async (cache: StaticCache) => {
    if (depTypes) {
      return depTypes;
    }
    const builderTypes = await cache.getText("types/commonfabric.d.ts");
    const cfcTypes = await cache.getText("types/cfc.ts");
    const schemaTypes = await cache.getText("types/commonfabric-schema.d.ts");
    depTypes = {
      "commonfabric": builderTypes,
      "commonfabric/cfc": cfcTypes,
      "commonfabric/schema": schemaTypes,
      "commontools": builderTypes,
      "commontools/schema": schemaTypes,
      "turndown": await cache.getText("types/turndown.d.ts"),
      "@commontools/html": builderTypes,
      "@commontools/builder": builderTypes,
      "@commontools/runner": builderTypes,
      "cfc.ts": cfcTypes,
    };
    return depTypes;
  };
})();

export function getRuntimeModuleExports() {
  const { commonfabric, exportsCallback } = createBuilder();
  const commontools = commonfabric;
  const runtimeExports = freezeSandboxValue({
    "commonfabric": commonfabric,
    "commonfabric/cfc": { ...cfcModule },
    // commonfabric/schema only exports types, no runtime values needed
    "commonfabric/schema": {},
    "commontools": commontools,
    // commontools/schema only exports types, no runtime values needed
    "commontools/schema": {},
    // __esModule lets this load in the AMD loader
    // when finding the "default"
    "turndown": { default: turndown, __esModule: true },
    "@commontools/html": commontools,
    "@commontools/builder": commontools,
    "@commontools/runner": commontools,
  });

  return {
    runtimeExports,
    exportsCallback,
  };
}
