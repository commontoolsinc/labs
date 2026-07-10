/**
 * Deterministic locale-method sanitization — a vetted pre-lockdown shim.
 *
 * SES `localeTaming: "safe"` amputates the `toLocale*` family: each method is
 * aliased to its non-locale equivalent and its arguments are silently ignored
 * (`toLocaleDateString("en-US", { month: "short" })` returns `toDateString()`
 * output). SES does this because the methods' DEFAULT arguments reach ambient
 * host state — an omitted `locales` resolves to the host locale and an omitted
 * `options.timeZone` to the host timezone — which is nondeterministic across
 * runtimes and a fingerprinting channel. But called with explicit arguments
 * these methods are pure functions of their inputs (modulo the engine's
 * ICU/CLDR tables), so amputation throws away a legitimately useful surface.
 *
 * We sanitize instead: each method that `localeTaming: "safe"` would alias is
 * replaced with a wrapper that pins every ambient default — an omitted locale
 * → "en-US", an omitted Date timeZone → "UTC", and the unsupported-tag
 * FALLBACK locale → "en-US" (see pinLocales) — and delegates to the original,
 * passing explicit arguments through otherwise untouched. Lockdown then runs
 * with `localeTaming: "unsafe"` so SES leaves the sanitized methods in place
 * and hardens them like any other intrinsic.
 *
 * Two consequences to be aware of:
 *
 * - This must run BEFORE `lockdown()` — the prototypes freeze at lockdown.
 *   `ensureSESInitialized` sequences it.
 * - It patches the realm's shared intrinsics, so host (non-pattern) code sees
 *   the sanitized methods too. That is strictly closer to native behavior
 *   than the status quo, where post-lockdown host code got the amputated
 *   aliases.
 *
 * Residual nondeterminism, accepted: ICU/CLDR version skew — identical
 * explicit inputs can format differently across engine versions (e.g. ICU
 * 72's switch to U+202F time separators). This is the same hazard class as
 * the untamed local-timezone Date getters (`getFullYear()` etc.), which
 * remain host-local.
 */

const DEFAULT_LOCALE = "en-US";
const DEFAULT_TIME_ZONE = "UTC";

type Locales = string | string[] | undefined;

// Pin every path that ECMA-402 would resolve to the host's default locale:
// an omitted `locales` (undefined or an empty array) becomes the pinned
// default, and — the subtle one — the pinned default is APPENDED to every
// explicit request, because a well-formed-but-unsupported tag ("xx") would
// otherwise fall back to the host default locale, letting sandboxed code
// read the user's language/region off the formatted output. With the
// fallback appended, resolution picks the caller's tag when the host
// supports it and "en-US" when it doesn't — never the host default.
// Malformed tags still throw RangeError, unchanged.
// Exported for tests: the leak closure itself can't be asserted in-process
// (the realm's default locale is fixed at startup), so the tests pin this
// mechanism and ECMA-402 resolution does the rest.
export const pinLocales = (locales: Locales): unknown[] | string => {
  if (locales === undefined) return DEFAULT_LOCALE;
  if (Array.isArray(locales)) return [...locales, DEFAULT_LOCALE];
  return [locales, DEFAULT_LOCALE];
};

// An omitted `options.timeZone` becomes UTC — never the host timezone. That
// is the ONLY path to the host zone: unlike locale resolution (which silently
// falls back, see pinLocales), ECMA-402 throws RangeError on any invalid
// timeZone value rather than falling back. So explicit values — including
// null, which natively throws — pass through untouched; only `undefined`
// (omitted) is pinned.
const pinDateOptions = (
  options: Intl.DateTimeFormatOptions | undefined,
): Intl.DateTimeFormatOptions => ({
  ...options,
  timeZone: options?.timeZone === undefined
    ? DEFAULT_TIME_ZONE
    : options.timeZone,
});

type AnyLocaleMethod = (
  this: unknown,
  ...args: unknown[]
) => unknown;

function replaceMethod(
  proto: object,
  name: string,
  wrap: (original: AnyLocaleMethod) => AnyLocaleMethod,
): void {
  const original = (proto as Record<string, unknown>)[name];
  if (typeof original !== "function") return; // absent on this host — nothing to sanitize
  Object.defineProperty(proto, name, {
    value: wrap(original as AnyLocaleMethod),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

let applied = false;

/**
 * Replace every locale-sensitive intrinsic method that
 * `localeTaming: "safe"` would alias with its pinned-default sanitized
 * wrapper. Idempotent; must be called before `lockdown()`.
 */
export function sanitizeLocaleMethods(): void {
  if (applied) return;
  applied = true;

  // Date: pin both the locale and the timezone defaults.
  for (
    const name of [
      "toLocaleDateString",
      "toLocaleTimeString",
      "toLocaleString",
    ] as const
  ) {
    replaceMethod(
      Date.prototype,
      name,
      (original) =>
        function (this: unknown, locales?: unknown, options?: unknown) {
          return original.call(
            this,
            pinLocales(locales as Locales),
            pinDateOptions(options as Intl.DateTimeFormatOptions | undefined),
          );
        },
    );
  }

  // Number / BigInt: pin the locale default; options pass through.
  for (const proto of [Number.prototype, BigInt.prototype]) {
    replaceMethod(
      proto,
      "toLocaleString",
      (original) =>
        function (this: unknown, locales?: unknown, options?: unknown) {
          return original.call(this, pinLocales(locales as Locales), options);
        },
    );
  }

  // String: `localeCompare(that, locales, options)` and the locale-sensitive
  // case mappings. Left untouched, `localeTaming: "unsafe"` would reintroduce
  // the ambient host locale for bare calls of all three.
  replaceMethod(
    String.prototype,
    "localeCompare",
    (original) =>
      function (
        this: unknown,
        that?: unknown,
        locales?: unknown,
        options?: unknown,
      ) {
        return original.call(
          this,
          that,
          pinLocales(locales as Locales),
          options,
        );
      },
  );
  for (const name of ["toLocaleLowerCase", "toLocaleUpperCase"] as const) {
    replaceMethod(
      String.prototype,
      name,
      (original) =>
        function (this: unknown, locales?: unknown) {
          return original.call(this, pinLocales(locales as Locales));
        },
    );
  }

  // Deliberately untouched: Object.prototype.toLocaleString is
  // locale-independent (`this.toString()` per ES, not amended by ECMA-402),
  // and Array/%TypedArray%.prototype.toLocaleString delegate to their
  // elements' toLocaleString — which are sanitized above.
}
