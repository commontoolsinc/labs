function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action, cell, pattern, Stream } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface AddTopic {
    title: string;
}
interface AddTopicResult {
    topic: {
        fid: string;
    };
}
interface Verbs {
    addTopic: Stream<AddTopic, AddTopicResult>;
    touch: Stream<AddTopic>;
}
const __cfHandler_1 = __cfHelpers.handler({
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    },
    required: ["title"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (event, { count }) => {
    count.set(count.get() + 1);
    return { topic: { fid: event.title } };
});
const __cfHandler_2 = __cfHelpers.handler({
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    },
    required: ["title"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (_event, { count }) => {
    count.set(count.get() + 1);
});
export default pattern(() => {
    const count = cell(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("count", true);
    // A verb that declares what it produces (verb contract rule 3). The result
    // rides `Stream`'s second type parameter and is opt-in by naming both type
    // arguments — it is never inferred from the body.
    const addTopic = __cfHandler_1({
        count: count
    }).for({ stream: "addTopic" }, true);
    // The value-less shape, unchanged, for contrast.
    const touch = __cfHandler_2({
        count: count
    }).for({ stream: "touch" }, true);
    // Returned against the `Verbs` annotation on `pattern<>` above, so the
    // declared result is LOAD-BEARING here rather than decorative: fixture
    // inputs are type-checked (only `*.expected.*` is excluded from the check
    // task), so if a returning verb ever stops satisfying `Stream<E, R>` this
    // file fails to compile. An earlier revision declared `Verbs` and never
    // returned against it, which asserted nothing.
    return { addTopic: addTopic.for({ stream: ["__patternResult", "addTopic"] }, true), touch: touch.for({ stream: ["__patternResult", "touch"] }, true) };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        addTopic: {
            $ref: "#/$defs/AddTopic",
            asCell: ["stream"]
        },
        touch: {
            $ref: "#/$defs/AddTopic",
            asCell: ["stream"]
        }
    },
    required: ["addTopic", "touch"],
    $defs: {
        AddTopic: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: stream-declared-result
// Verifies: a declared result on Stream's second parameter survives the
//   transformer and still satisfies the pattern's own Output annotation.
//   `action` is the sole result-authoring surface — `handler()` produces
//   HandlerFactory<E, T, void>, so the same shape written with `handler` does
//   not compile. C2 lowers the returned value; C3 emits the result schema.
//   Until both land, a returning verb transforms exactly like a value-less
//   one, and this golden is the baseline they move.
//
// The explicit type-argument form does NOT cost the input schema: `addTopic`
// emits `{title: string}` from `action<AddTopic, …>` with an unannotated
// callback parameter, exactly as `touch` does from an annotated one. Worth
// stating because the opposite is easy to conclude from a hand-rolled
// transform — the schema comes out `true` unless the real `commonfabric`
// types are supplied, which the fixture runner does and an ad-hoc script
// does not.
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1,
    __cfHandler_2
});
