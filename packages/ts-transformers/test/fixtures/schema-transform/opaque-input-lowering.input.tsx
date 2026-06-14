/// <cts-enable />
import { toSchema } from "commonfabric";

type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
type OpaqueInput<
  T,
  Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true,
> = Cfc<T, { opaque: Spec }>;

interface SecretPayload {
  token: OpaqueInput<string>;
}

const schema = toSchema<SecretPayload>();

// FIXTURE: opaque-input-lowering
// Verifies: OpaqueInput<T, Spec> lowers to ifc.opaque in emitted schemas
export default schema;
