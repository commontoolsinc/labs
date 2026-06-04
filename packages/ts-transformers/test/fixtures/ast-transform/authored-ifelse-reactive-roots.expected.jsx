function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { ifElse, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const identity = __cfHardenFn(<T,>(value: T) => value);
const __cfLift_1 = __cfHelpers.lift<{
    name: string;
}, string>({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ name }) => identity(name.trim()));
const __cfLift_2 = __cfHelpers.lift<{
    count: number;
}, number>({
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, ({ count }) => count + 1);
const __cfLift_3 = __cfHelpers.lift<{
    cell: __cfHelpers.Writable<number>;
}, number>({
    type: "object",
    properties: {
        cell: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, ({ cell }) => cell.get());
const __cfLift_4 = __cfHelpers.lift<{
    name: string;
}, string>({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ name }) => name.trim());
const __cfLift_5 = __cfHelpers.lift<{
    name: string;
}, string>({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ name }) => name.trim());
// FIXTURE: authored-ifelse-reactive-roots
// Verifies: authored ifElse outside JSX and top-level receiver-method roots lower reactively
//   ifElse(show, count + 1, 0)         → compute-wrapped branch
//   ifElse(show, cell.get(), 0)        → reactive branch lowering around Writable.get()
//   ifElse(show, name.trim(), "x")     → reactive receiver-method branch
//   name.trim()                        → top-level receiver-method root lowered to lift-applied
//   identity(name.trim())             → lift-applied local-helper root
export default pattern((__cf_pattern_input) => {
    const count = __cf_pattern_input.key("count");
    const show = __cf_pattern_input.key("show");
    const name = __cf_pattern_input.key("name");
    const cell = __cf_pattern_input.key("cell");
    const upper = __cfLift_1({ name: name }).for("upper", true);
    return {
        value: ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_2({ count: count }), 0).for(["__patternResult", "value"], true),
        cellValue: ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_3({ cell: cell }), 0).for(["__patternResult", "cellValue"], true),
        trimmed: ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_4({ name: name }), "fallback").for(["__patternResult", "trimmed"], true),
        upper,
        upperDirect: __cfLift_5({ name: name }).for(["__patternResult", "upperDirect"], true)
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        show: {
            type: "boolean"
        },
        name: {
            type: "string"
        },
        cell: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count", "show", "name", "cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        cellValue: {
            type: "number"
        },
        trimmed: {
            type: "string"
        },
        upper: {
            type: "string"
        },
        upperDirect: {
            type: "string"
        }
    },
    required: ["value", "cellValue", "trimmed", "upper", "upperDirect"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
