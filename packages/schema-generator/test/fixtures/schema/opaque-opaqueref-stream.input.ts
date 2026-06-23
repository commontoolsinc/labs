// Stream type nested in OpaqueRef.
// This mimics the structure of BuiltInLLMState where cancelGeneration:
// Stream<void> is returned inside OpaqueRef<BuiltInLLMState>.

interface OpaqueRefMethods<T> {
  get(): T;
  set(value: T): void;
}

// OpaqueRef<T> is an intersection of OpaqueRefMethods<T> and T
type OpaqueRef<T> =
  & BrandedCell<T, "opaque">
  & OpaqueRefMethods<T>
  & (
  T extends Array<infer U> ? Array<OpaqueRef<U>>
  : T extends object ? { [K in keyof T]: OpaqueRef<T[K]> }
  : T
);

// This mimics BuiltInLLMState structure
interface LLMState {
  pending: boolean;
  result?: string;
  error: unknown;
  cancelGeneration: Stream<void>;
}

interface SchemaRoot {
  state: OpaqueRef<LLMState>;
}
