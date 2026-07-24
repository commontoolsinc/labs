export type NativeErrorBrandCheck = (value: unknown) => boolean;

// Capture the DOMException intrinsic before SES can tame prototypes. Unlike
// Object.prototype.toString, this getter performs an internal-slot brand check
// that a Proxy cannot forge.
const domExceptionNameGetter = typeof DOMException === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
const nativeDOMExceptionName = domExceptionNameGetter === undefined
  ? undefined
  : Function.prototype.call.bind(domExceptionNameGetter) as (
    value: unknown,
  ) => string;

/** Build the realm-independent Error brand check used during module init. */
export function createNativeErrorBrandCheck(
  nativeCheck: NativeErrorBrandCheck | undefined,
): NativeErrorBrandCheck {
  if (nativeCheck !== undefined) return nativeCheck;
  return (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (nativeDOMExceptionName !== undefined) {
      try {
        nativeDOMExceptionName(value);
        return true;
      } catch {
        // Not a DOMException; fall through to the Error object brand.
      }
    }
    // Without Error.isError there is no unspoofable, cross-realm ordinary
    // Error brand check. Object.prototype.toString, instanceof, and prototype
    // inspection are all forgeable by a Proxy, so fail closed.
    return false;
  };
}
