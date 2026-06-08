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

// CT-1665: A trusted-binding builder (handler/lift/...) returns a FACTORY object
// that the transformer-emitted `__cfBindVerifiedBinding` annotates with the
// verified binding identity (`__cfVerifiedBindingIdentity`). For an EXPORTED
// binding that factory is reachable from the module namespace, so the
// post-evaluation capture walk records its metadata. For a NON-exported
// module-scope binding (the common shape — e.g. system/profile-home.tsx's
// setName/setAvatar/addElement) the factory is reachable only through the
// instantiated node graph, which retains the underlying module (sans metadata),
// so the metadata is never registered and CFC `writeAuthorizedBy` rejects the
// binding's own writes. Builders surface every factory here so the engine can
// record its binding metadata after evaluation regardless of export status.
type VerifiedBindingCandidateRegistrar = (candidate: unknown) => void;

let verifiedBindingCandidateRegistrar:
  | VerifiedBindingCandidateRegistrar
  | undefined;

export function setVerifiedBindingCandidateRegistrar(
  registrar: VerifiedBindingCandidateRegistrar | undefined,
): () => void {
  const previous = verifiedBindingCandidateRegistrar;
  verifiedBindingCandidateRegistrar = registrar;
  return () => {
    verifiedBindingCandidateRegistrar = previous;
  };
}

export function registerVerifiedBindingCandidate(candidate: unknown): void {
  verifiedBindingCandidateRegistrar?.(candidate);
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
