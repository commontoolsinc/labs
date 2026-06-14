function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/// <cts-enable />
import { toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type Cfc<T, Meta> = T & {
    readonly __ct_cfc__?: Meta;
};
type OpaqueInput<T, Spec extends true | {
    schema?: unknown;
    allowPassThrough?: boolean;
} = true> = Cfc<T, {
    opaque: Spec;
}>;
interface SecretPayload {
    token: OpaqueInput<string>;
}
const schema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        token: {
            type: "string",
            ifc: {
                opaque: true
            }
        }
    },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: opaque-input-lowering
// Verifies: OpaqueInput<T, Spec> lowers to ifc.opaque in emitted schemas
export default schema;
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
