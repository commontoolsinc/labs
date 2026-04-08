import { createBuilder } from "../builder/factory.ts";
import { StaticCache } from "@commonfabric/static";
import turndown from "turndown";
import type { RuntimeModuleIdentifier } from "./runtime-module-policy.ts";
import { freezeSandboxValue } from "./hardening.ts";
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
    const builderTypes = await cache.getText("types/commonfabric.d.ts");
    const schemaTypes = await cache.getText("types/commonfabric-schema.d.ts");
    depTypes = {
      "commonfabric": builderTypes,
      "commonfabric/schema": schemaTypes,
      "turndown": await cache.getText("types/turndown.d.ts"),
    };
    return depTypes;
  };
})();

export function getRuntimeModuleExports() {
  const { commonfabric, exportsCallback } = createBuilder();
  const runtimeExports = freezeSandboxValue({
    "commonfabric": commonfabric,
    // commonfabric/schema only exports types, no runtime values needed
    "commonfabric/schema": {},
    // __esModule lets this load in the AMD loader
    // when finding the "default"
    "turndown": { default: turndown, __esModule: true },
  });

  return {
    runtimeExports,
    exportsCallback,
  };
}
