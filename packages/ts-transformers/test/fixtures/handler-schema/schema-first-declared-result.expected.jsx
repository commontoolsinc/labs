function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, handler, pattern, Stream } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Ping {
    word: string;
}
interface PingResult {
    echoed: string;
}
interface Verbs {
    ping: Stream<Ping, PingResult>;
    poke: Stream<Ping>;
}
// The schema-first authored form: the author supplies the event and state
// schemas, so the transformer must not prepend generated ones — that would
// displace the callback out of the positions the runtime dispatch and the
// sandbox verifier accept (argument 0 or 2). With a declared result, the
// options object still lowers onto the trailing slot.
const ping = handler({
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
}, {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
}, (event, _state) => {
    return { echoed: event.word };
}, { resultSchema: {
        type: "object",
        properties: {
            echoed: {
                type: "string"
            }
        },
        required: ["echoed"]
    } as const satisfies __cfHelpers.JSONSchema });
// The same form without a declared result: passed through untouched — no
// generated schemas, no options object.
const poke = handler({
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
}, {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
}, (_event, _state) => { });
export default pattern(() => {
    const count = cell(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("count", true);
    return { ping: ping({ count }).for({ stream: ["__patternResult", "ping"] }, true), poke: poke({ count }).for({ stream: ["__patternResult", "poke"] }, true) };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        ping: {
            $ref: "#/$defs/Ping",
            asCell: ["stream"]
        },
        poke: {
            $ref: "#/$defs/Ping",
            asCell: ["stream"]
        }
    },
    required: ["ping", "poke"],
    $defs: {
        Ping: {
            type: "object",
            properties: {
                word: {
                    type: "string"
                }
            },
            required: ["word"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: schema-first-declared-result
// Verifies: the schema-first authored form handler<E, T[, R]>(eventSchema,
//   stateSchema, callback) keeps its authored schemas and callback positions
//   — nothing is prepended — while a declared result still lowers into the
//   trailing options as `{ resultSchema: … }`. Without a declared result the
//   call passes through byte-identical.
// Context: before this recognition, the injection unconditionally prepended
//   two generated schemas, producing a call whose callback sat at argument 4
//   — a shape the runtime never reads and the sandbox verifier refuses.
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    ping,
    poke
});
