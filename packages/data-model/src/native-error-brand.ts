export type NativeErrorBrandCheck = (value: unknown) => boolean;

// Bind the intrinsic before SES can tame Function/Object prototypes. The
// resulting object brand remains useful across realms in browsers that do not
// implement Error.isError.
const nativeObjectTag = Function.prototype.call.bind(
  Object.prototype.toString,
) as (value: unknown) => string;

/** Build the realm-independent Error brand check used during module init. */
export function createNativeErrorBrandCheck(
  nativeCheck: NativeErrorBrandCheck | undefined,
): NativeErrorBrandCheck {
  if (nativeCheck !== undefined) return nativeCheck;
  return (value: unknown): boolean => {
    const tag = nativeObjectTag(value);
    return tag === "[object Error]" || tag === "[object DOMException]";
  };
}
