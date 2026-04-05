import { createFactoryShadowGuardSource } from "@commonfabric/utils/sandbox-contract";
import { getAMDLoader } from "../../../js-compiler/typescript/bundler/amd-loader.ts";

const LOADER_SOURCE = getAMDLoader.toString();
const FACTORY_SHADOW_GUARD_SOURCE = createFactoryShadowGuardSource();

export const FACTORY_SHADOW_GUARDS = FACTORY_SHADOW_GUARD_SOURCE.map((
  statement,
) => `    ${statement}`).join("\n");

const FACTORY_GUARD_INSERTION_RE = new RegExp(
  [
    String.raw`(define\([^]*?function\s*\([^)]*\)\s*\{\n\s*"use strict";\n)`,
    String.raw`(?!\s*${escapeRegExp(FACTORY_SHADOW_GUARD_SOURCE[0])})`,
  ].join(""),
  "g",
);

export function withFactoryGuards(bundle: string): string {
  return bundle.replaceAll(
    FACTORY_GUARD_INSERTION_RE,
    `$1${FACTORY_SHADOW_GUARDS}\n`,
  );
}

export function bundleWithGuardedFactory(body: string): string {
  return `
((runtimeDeps = {}) => {
  const __ctAmdHooks = runtimeDeps.__ctAmdHooks ?? {};
  const { define, require } = (${LOADER_SOURCE})(__ctAmdHooks);
  for (const [name, dep] of Object.entries(runtimeDeps)) {
    if (name === "__ctAmdHooks") continue;
    define(name, ["exports"], exports => Object.assign(exports, dep));
  }
  const console = globalThis.console;
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
${FACTORY_SHADOW_GUARDS}
${body}
  });
  const main = require("main");
  const exportMap = Object.create(null);
  return { main, exportMap };
});
`;
}

export function bundleWithCanonicalLoader(body: string): string {
  return `
((runtimeDeps = {}) => {
  const { define, require } = (${LOADER_SOURCE})();
${body}
});
`;
}

export function bundleWithHookedLoader(body: string): string {
  return `
((runtimeDeps = {}) => {
  const __ctAmdHooks = runtimeDeps.__ctAmdHooks ?? {};
  const { define, require } = (${LOADER_SOURCE})(__ctAmdHooks);
  for (const [name, dep] of Object.entries(runtimeDeps)) {
    if (name === "__ctAmdHooks") continue;
    define(name, ["exports"], exports => Object.assign(exports, dep));
  }
${body}
});
`;
}

function escapeRegExp(source: string): string {
  return source.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
