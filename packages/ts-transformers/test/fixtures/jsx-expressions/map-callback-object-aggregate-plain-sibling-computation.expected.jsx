function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * FUTURE REPRO: patternized map callbacks should not overtaint plain siblings
 *
 * If a local object aggregate mixes reactive and plain fields, later
 * computations over the plain field should stay plain.
 */
import { Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface FileEntry {
    name: string;
    type: "file" | "folder";
}
interface Input {
    files: Writable<Default<FileEntry[], [
    ]>>;
}
interface Output {
    [UI]: VNode;
}
export default pattern((__ct_pattern_input) => {
    const files = __ct_pattern_input.key("files");
    return {
        [UI]: (<div>
        {files.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const file = __ct_pattern_input.key("element");
                const meta = { kind: file.key("type"), label: "plain" };
                const shout = meta.label + "!";
                return <span>{shout}</span>;
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/FileEntry"
                    }
                },
                required: ["element"],
                $defs: {
                    FileEntry: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            type: {
                                "enum": ["file", "folder"]
                            }
                        },
                        required: ["name", "type"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
                    }],
                $defs: {
                    UIRenderable: {
                        type: "object",
                        properties: {
                            $UI: {
                                $ref: "https://commonfabric.org/schemas/vnode.json"
                            }
                        },
                        required: ["$UI"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema), {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        files: {
            type: "array",
            items: {
                $ref: "#/$defs/FileEntry"
            },
            "default": [],
            asCell: true
        }
    },
    required: ["files"],
    $defs: {
        FileEntry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                }
            },
            required: ["name", "type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
