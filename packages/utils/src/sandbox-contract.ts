export const SHADOWED_FACTORY_BINDINGS = [
  "define",
  "runtimeDeps",
  "__cfAmdHooks",
] as const;

/**
 * Globals that a sandbox compartment does not provide, and that the type
 * libraries the pattern compiler serves therefore must not declare.
 *
 * A pattern is compiled against `es2023.d.ts` and `dom.d.ts` and then runs
 * inside a compartment. A name declared by those libraries but missing from
 * the compartment type checks, compiles and deploys, then throws a
 * `TypeError` the first time the authored code reaches it. Keeping this list
 * and those declarations in step turns that runtime failure into a compile
 * error.
 *
 * `packages/static/scripts/strip-withheld-globals.ts` removes the matching
 * declaration from the type libraries, and
 * `packages/runner/test/sandbox-global-contract.test.ts` checks each name here
 * against a real compartment. Endowing one of these globals means dropping it
 * from this list and restoring its declaration; the test fails until both
 * happen.
 *
 * This list covers the names already reconciled. The ones still outstanding
 * are in `SANDBOX_UNRESOLVED_GLOBAL_GAPS`.
 */
export const SANDBOX_WITHHELD_GLOBALS = Object.freeze(
  [
    // SES keeps these out of every compartment.
    //
    // `Float32Array` and `Float64Array` carry the NaN side channel. A NaN's
    // unused mantissa bits can hold a payload, and storing one into a float
    // typed array writes those bits through to the underlying buffer, where a
    // second view reads them back. Lockdown repairs `DataView.prototype.setFloat*`
    // to write only canonical NaNs, but a typed-array element store is not a
    // method and nothing can intercept it, so SES withholds the constructors
    // instead.
    "Float32Array",
    "Float64Array",
    // `Atomics` and `SharedArrayBuffer` combine shared memory with a timing
    // source precise enough to read it.
    "Atomics",
    "SharedArrayBuffer",
    // `WeakRef` and `FinalizationRegistry` make garbage collection observable.
    "WeakRef",
    "FinalizationRegistry",

    // The runtime removes this one; see `compartment-globals.ts`.
    "Proxy",

    // Web globals the runtime has never endowed. Unlike the entries above,
    // these are absent because nothing has supplied them, not because they are
    // unsafe.
    "AbortController",
    "AbortSignal",
    "Blob",
    "ByteLengthQueuingStrategy",
    "CountQueuingStrategy",
    "CustomEvent",
    "DOMException",
    "ErrorEvent",
    "Event",
    "EventSource",
    "EventTarget",
    "MessageChannel",
    "MessageEvent",
    "MessagePort",
    "PromiseRejectionEvent",
    "ReadableByteStreamController",
    "ReadableStream",
    "ReadableStreamBYOBReader",
    "ReadableStreamBYOBRequest",
    "ReadableStreamDefaultController",
    "ReadableStreamDefaultReader",
    "TextDecoderStream",
    "TextEncoderStream",
    "TransformStream",
    "TransformStreamDefaultController",
    "WritableStream",
    "WritableStreamDefaultController",
    "WritableStreamDefaultWriter",
    "self",
  ] as const,
);
export type SandboxWithheldGlobalName =
  (typeof SANDBOX_WITHHELD_GLOBALS)[number];

/**
 * Globals the type libraries still declare that a compartment does not
 * install. Every name here is a live instance of the bug
 * `SANDBOX_WITHHELD_GLOBALS` exists to prevent: a pattern that reaches for one
 * compiles, deploys, and then throws.
 *
 * They are listed rather than stripped because stripping them alone does not
 * fix them. `packages/patterns/google/core/util/gmail-send-client.ts` and its
 * siblings build retry backoff out of `setTimeout`, so removing the
 * declaration turns a runtime throw on the retry path into a compile error
 * across several API clients. Resolving each name means either endowing it in
 * `compartment-globals.ts` or removing the code that reaches for it, and
 * `Intl` additionally has to reckon with the locale taming in
 * `locale-taming.ts` rather than forwarding the host's `Intl` as-is.
 *
 * `packages/runner/test/sandbox-global-contract.test.ts` holds this list to
 * exactly the gaps that exist: a new one fails the test, and a name that stops
 * being a gap fails it too. The list only shrinks.
 */
export const SANDBOX_UNRESOLVED_GLOBAL_GAPS = Object.freeze(
  [
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "queueMicrotask",
    "Intl",
  ] as const,
);

export const TRUSTED_BUILDERS = Object.freeze(
  [
    "action",
    "computed",
    "derive",
    "handler",
    "lift",
    // Identity tag for multi-user test descriptors (`cf test`); its
    // arguments are trusted-builder results, never event-carrying closures.
    "multiUserTest",
    "pattern",
  ] as const,
);
export type TrustedBuilderName = (typeof TRUSTED_BUILDERS)[number];
const TRUSTED_BUILDER_SET = new Set<string>(TRUSTED_BUILDERS);

export function isTrustedBuilder(name: string): name is TrustedBuilderName {
  return TRUSTED_BUILDER_SET.has(name);
}

export const TRUSTED_DATA_HELPERS = Object.freeze(
  [
    "schema",
    "__cf_data",
  ] as const,
);
export type TrustedDataHelperName = (typeof TRUSTED_DATA_HELPERS)[number];
const TRUSTED_DATA_HELPER_SET = new Set<string>(TRUSTED_DATA_HELPERS);

export function isTrustedDataHelper(
  name: string,
): name is TrustedDataHelperName {
  return TRUSTED_DATA_HELPER_SET.has(name);
}

export const FUNCTION_HARDENING_HELPER_NAME = "__cfHardenFn";
export const BINDING_IDENTITY_HELPER_NAME = "__cfBindVerifiedBinding";
export const VERIFIED_BINDING_METADATA_FIELD = "__cfVerifiedBindingIdentity";

export const RESERVED_FACTORY_BINDINGS = [
  ...SHADOWED_FACTORY_BINDINGS,
] as const;

export function createFactoryShadowGuardSource(): string[] {
  return SHADOWED_FACTORY_BINDINGS.map((name) => `const ${name} = undefined;`);
}

export function createFunctionHardeningHelperSource(
  helperName = FUNCTION_HARDENING_HELPER_NAME,
  options: { typedParameter?: boolean } = {},
): string {
  const parameter = options.typedParameter ? "fn: Function" : "fn";
  return [
    `function ${helperName}(${parameter}) {`,
    "  Object.freeze(fn);",
    "  const prototype = fn.prototype;",
    '  if (prototype && typeof prototype === "object") {',
    "    Object.freeze(prototype);",
    "  }",
    "  return fn;",
    "}",
  ].join("\n");
}

export function createBindingIdentityHelperSource(
  helperName = BINDING_IDENTITY_HELPER_NAME,
  metadataField = VERIFIED_BINDING_METADATA_FIELD,
  options: { typedParameter?: boolean } = {},
): string {
  const parameter = options.typedParameter ? "value: any" : "value";
  const metadataParameter = options.typedParameter
    ? "metadata: any"
    : "metadata";
  return [
    `function ${helperName}(${parameter}, ${metadataParameter}) {`,
    '  if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {',
    "    Object.defineProperty(value, " +
    JSON.stringify(metadataField) +
    ", {",
    "      value: metadata,",
    "      configurable: true",
    "    });",
    "  }",
    '  if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {',
    "    var implementation = value.implementation;",
    '    if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {',
    "      Object.defineProperty(implementation, " +
    JSON.stringify(metadataField) +
    ", {",
    "        value: metadata,",
    "        configurable: true",
    "      });",
    "    }",
    "  }",
    "  return value;",
    "}",
  ].join("\n");
}
