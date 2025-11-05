// Test case for CT-1006: Stream type nested in OpaqueRef inside Opaque union
// This mimics the structure of BuiltInLLMState where cancelGeneration: Stream<void>
// becomes Opaque<OpaqueRef<Stream<void>>> when returned inside OpaqueRef<BuiltInLLMState>

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

// Opaque<T> is a union: T | OpaqueRef<T>
type Opaque<T> =
  | OpaqueRef<T>
  | (T extends Array<infer U> ? Array<Opaque<U>>
    : T extends object ? { [K in keyof T]: Opaque<T[K]> }
    : T);

// This mimics BuiltInLLMState structure
interface LLMState {
  pending: boolean;
  result?: string;
  error: unknown;
  cancelGeneration: Stream<void>;  // This becomes problematic when wrapped
}

// When we have OpaqueRef<LLMState>, the cancelGeneration property becomes:
// Opaque<OpaqueRef<Stream<void>>> which is the nested structure that triggered CT-1006
interface SchemaRoot {
  state: OpaqueRef<LLMState>;
}
