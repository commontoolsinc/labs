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
 * replaced with a wrapper that pins the ambient defaults — locale → "en-US",
 * Date timeZone → "UTC" — and delegates to the original, passing explicit
 * arguments through untouched. Lockdown then runs with
 * `localeTaming: "unsafe"` so SES leaves the sanitized methods in place and
 * hardens them like any other intrinsic.
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

// An omitted `locales` — undefined or an empty array, both meaning "host
// default" per ECMA-402 — becomes the pinned default. Explicit values pass
// through, including explicit BCP 47 tags the host may or may not have data
// for (ECMA-402 fallback semantics apply as usual).
const pinLocales = (locales: Locales): string | string[] =>
  locales === undefined || (Array.isArray(locales) && locales.length === 0)
    ? DEFAULT_LOCALE
    : locales;

// An omitted `options.timeZone` becomes UTC — never the host timezone.
const pinDateOptions = (
  options: Intl.DateTimeFormatOptions | undefined,
): Intl.DateTimeFormatOptions => ({
  ...options,
  timeZone: options?.timeZone ?? DEFAULT_TIME_ZONE,
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
