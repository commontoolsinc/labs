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
 * Changing this list also affects the `ts-transformers` and `schema-generator`
 * fixture suites, which type-check their fixtures against the type libraries and
 * are checked only in CI; see `packages/static/README.md`.
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

    // Timers and the microtask queue. A pattern reacts through the runtime's
    // scheduler rather than driving its own clock, so a compartment installs
    // none of these. The type libraries declare them, so a pattern that calls
    // one type checks and then throws; withholding turns that into a compile
    // error instead.
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "queueMicrotask",
    // `Intl` reaches the host's default locale and time zone whenever a
    // formatter is constructed without explicit arguments, which is both
    // nondeterministic across runtimes and a fingerprinting channel. The
    // sanitized `toLocale*` methods in `locale-taming.ts` pin those defaults for
    // the surface a pattern actually uses; the `Intl` constructors have no such
    // taming, and no pattern needs them, so they stay out. Stripping removes the
    // namespace's value members (`var Collator`, `var NumberFormat`, ...) while
    // its interfaces remain, so a pattern can still annotate an
    // `Intl.NumberFormatOptions` even though it cannot construct a formatter.
    //
    // If patterns need locale-specific formatting, the intended path is not to
    // endow `Intl` but to add a capability that carries the user's preferred
    // locale(s) — a `wish("#locale")` reading them from the user's profile and
    // falling back to the platform defaults. A pattern passes that locale
    // explicitly to the sanitized `toLocale*` methods, which already honor one,
    // so common number, date, and currency formatting needs no `Intl`.
    "Intl",

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
