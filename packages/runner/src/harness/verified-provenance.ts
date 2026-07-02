import { VERIFIED_BINDING_METADATA_FIELD } from "@commonfabric/utils/sandbox-contract";

/**
 * Content-addressed provenance for verified implementation functions.
 *
 * An entry exists ONLY for a function object that became verified through one
 * of the runner-owned registration channels:
 *
 *  1. post-evaluation module indexing (`PatternManager.indexArtifact`): the
 *     implementation function of an exported / `__cfReg`-registered builder
 *     artifact, with the module's content identity and the artifact's
 *     export/`__cfReg` symbol;
 *  2. the in-action registrar (`Runner.invokeJavaScriptImplementation`): a
 *     builder artifact created DURING a verified action's execution, with the
 *     identity derived from the new function's canonical source location and
 *     `dynamic: true` (in-session only — such artifacts never resolve across
 *     a reload, unchanged from the legacy behavior).
 *
 * The WeakMap itself is the anti-spoof proof for CFC: an attacker-supplied
 * function — even with byte-identical source text — was never registered
 * during a verified evaluation, so it has no entry. There is no string key to
 * collide and no load scoping required. This replaced the former
 * `implementationRef` × `verifiedLoadId` registry checks (deleted in PR E2);
 * see docs/specs/content-addressed-action-identity.md.
 */
export type VerifiedProvenance = {
  /** Module content identity (prefix-free `cf:module/<hash>` hash). */
  identity: string;
  /** Export / `__cfReg` symbol of the registered factory (absent: dynamic). */
  symbol?: string;
  /** Created during a verified action's execution (in-session only). */
  dynamic?: true;
  /** CT-1665 verified binding identity, when the factory carried one. */
  bindingIdentity?: { sourceFile: string; bindingPath: string[] };
};

const provenanceByFn = new WeakMap<object, VerifiedProvenance>();

/**
 * Record provenance for a verified implementation function. First write wins:
 * the first registration (export or `__cfReg` of the defining module) is
 * canonical; later re-registrations of the same live function under other
 * symbols don't reassign it (mirrors the entry-ref first-write-wins
 * semantics).
 */
export function recordVerifiedProvenance(
  fn: unknown,
  provenance: VerifiedProvenance,
): void {
  if (typeof fn !== "function") return;
  if (!provenanceByFn.has(fn)) provenanceByFn.set(fn, provenance);
}

/**
 * The provenance for a function registered during verified evaluation. Only
 * functions are ever recorded (see `recordVerifiedProvenance`), so any
 * non-function key is a guaranteed miss.
 */
export function getVerifiedProvenance(
  fn: unknown,
): VerifiedProvenance | undefined {
  return typeof fn === "function" ? provenanceByFn.get(fn) : undefined;
}

/**
 * The content identity of the module that DEFINED an implementation function,
 * stamped at that module's evaluation (module-record-compiler `execute`). This
 * is the `.src`-free replacement for the re-exporter provenance guard: a
 * re-exporting module surfaces the SAME function object under its own identity,
 * and `recordModuleProvenance` is first-write-wins, so without a discriminator a
 * re-exporter visited first would stamp its identity onto a function it did not
 * define. Modules evaluate in dependency order (a re-exporter imports — so runs
 * after — its definer), and this WeakMap is first-write-wins, so the defining
 * module's stamp always wins. A WeakMap (not a property) because implementations
 * are hardened/frozen after creation.
 *
 * `.src` USED to serve this role (its canonical `cf:module/<hash>` named the
 * defining module), but `.src` is now lazy/debug-only, so identity — including
 * this guard — must not depend on it.
 */
const definingModuleByFn = new WeakMap<object, string>();

/** First-write-wins: only the defining (dependency-first) module's stamp sticks. */
export function recordDefiningModule(fn: unknown, identity: string): void {
  if (typeof fn !== "function") return;
  if (!definingModuleByFn.has(fn)) definingModuleByFn.set(fn, identity);
}

export function getDefiningModule(fn: unknown): string | undefined {
  return typeof fn === "function" ? definingModuleByFn.get(fn) : undefined;
}

/**
 * Read the CT-1665 verified-binding annotation off a builder factory (the
 * transformer's `__cfBindVerifiedBinding` attaches it to the factory object,
 * which shares its implementation function with the node module).
 */
export function readBindingIdentity(
  value: unknown,
): { sourceFile: string; bindingPath: string[] } | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const metadata =
    (value as Record<string, unknown>)[VERIFIED_BINDING_METADATA_FIELD];
  if (!metadata || typeof metadata !== "object") return undefined;
  const sourceFile = (metadata as Record<string, unknown>).sourceFile;
  const bindingPath = (metadata as Record<string, unknown>).bindingPath;
  if (
    typeof sourceFile !== "string" ||
    !Array.isArray(bindingPath) ||
    !bindingPath.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  return { sourceFile, bindingPath: [...bindingPath] };
}

/**
 * Derive the module content identity from a function's canonical source
 * location (`cf:module/<identity>/<path>:line:col`), or undefined for
 * non-canonical sources (host functions, builtins).
 */
export function identityFromCanonicalSource(
  src: unknown,
): string | undefined {
  if (typeof src !== "string") return undefined;
  const match = /^cf:module\/([^/]+)\//.exec(src);
  return match ? match[1] : undefined;
}
