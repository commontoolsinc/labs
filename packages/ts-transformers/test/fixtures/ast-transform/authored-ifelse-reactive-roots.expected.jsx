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
// FIXTURE: authored-ifelse-reactive-roots
// Verifies: authored ifElse outside JSX and top-level receiver-method roots lower reactively
//   ifElse(show, count + 1, 0)         → compute-wrapped branch
//   ifElse(show, cell.get(), 0)        → reactive branch lowering around Writable.get()
//   ifElse(show, name.trim(), "x")     → reactive receiver-method branch
//   name.trim()                        → top-level receiver-method root lowered via derive
//   identity(name.trim())             → derive-wrapped local-helper root
export default pattern((__cf_pattern_input) => {
    const count = __cf_pattern_input.key("count");
    const show = __cf_pattern_input.key("show");
    const name = __cf_pattern_input.key("name");
    const cell = __cf_pattern_input.key("cell");
    const upper = __cfHelpers.derive({
        type: "object",
        properties: {
            name: {
                type: "string"
            }
        },
        required: ["name"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, { name: name }, ({ name }) => identity(name.trim()));
    return {
        value: ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, show, __cfHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { count: count }, ({ count }) => count + 1), 0),
        cellValue: ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, show, __cfHelpers.derive({
            type: "object",
            properties: {
                cell: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { cell: cell }, ({ cell }) => cell.get()), 0),
        trimmed: ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, show, __cfHelpers.derive({
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { name: name }, ({ name }) => name.trim()), "fallback"),
        upper,
        upperDirect: __cfHelpers.derive({
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { name: name }, ({ name }) => name.trim()),
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
            asCell: true
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
