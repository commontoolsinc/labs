export type NativeErrorBrandCheck = (value: unknown) => boolean;

// Bind the intrinsic before SES can tame Function/Object prototypes. The
// resulting object brand remains useful across realms in browsers that do not
// implement Error.isError.
const nativeObjectTag = Function.prototype.call.bind(
  Object.prototype.toString,
) as (value: unknown) => string;
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
    try {
      return nativeObjectTag(value) === "[object Error]" &&
        !(Symbol.toStringTag in value);
    } catch {
      return false;
    }
  };
}
