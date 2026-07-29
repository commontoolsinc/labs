function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, handler, Stream } from "commonfabric";
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
interface TopicState {
    count: Cell<number>;
}
// A verb that declares what it produces (verb contract rule 3). The result
// rides `Stream`'s second type parameter; the body returns a matching value.
const addTopic = handler({
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
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.count.set(state.count.get() + 1);
    return { topic: { fid: event.title } };
});
// The value-less shape, unchanged, for contrast.
const touch = handler({
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
} as const satisfies __cfHelpers.JSONSchema, (_event, state) => {
    state.count.set(state.count.get() + 1);
});
interface Verbs {
    addTopic: Stream<AddTopic, AddTopicResult>;
    touch: Stream<AddTopic>;
}
// FIXTURE: stream-declared-result
// Verifies: a declared result on Stream's second parameter survives the
//   transformer, and does not disturb the handler's ARGUMENT schema — which is
//   what `cf piece verbs` publishes and `piece call` validates payloads
//   against. C2 lowers the returned value; C3 emits the result schema. Until
//   both land, a returning verb transforms exactly like a value-less one, and
//   this golden is the baseline they move.
export { addTopic, touch };
export type { Verbs };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
