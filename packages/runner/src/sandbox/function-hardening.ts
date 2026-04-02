type VerifiedFunctionRegistrar = (
  implementationRef: string,
  fn: (...args: any[]) => unknown,
) => void;

let verifiedFunctionRegistrar: VerifiedFunctionRegistrar | undefined;

export function setVerifiedFunctionRegistrar(
  registrar: VerifiedFunctionRegistrar | undefined,
): () => void {
  const previous = verifiedFunctionRegistrar;
  verifiedFunctionRegistrar = registrar;
  return () => {
    verifiedFunctionRegistrar = previous;
  };
}

export function registerVerifiedFunctionImplementation(
  implementationRef: string,
  fn: (...args: any[]) => unknown,
): void {
  verifiedFunctionRegistrar?.(implementationRef, fn);
}

export function hardenVerifiedFunction<T extends (...args: any[]) => unknown>(
  fn: T,
): T {
  Object.freeze(fn);
  const prototype = (fn as { prototype?: unknown }).prototype;
  if (prototype && typeof prototype === "object") {
    Object.freeze(prototype);
  }
  return fn;
}
