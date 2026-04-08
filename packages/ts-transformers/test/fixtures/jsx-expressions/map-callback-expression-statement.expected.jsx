function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * TRANSFORM REPRO: patternized map callback should lower reactive expression statements
 *
 * Once `.map(...)` lowers to `.mapWithPattern(...)`, the callback body is pattern-owned.
 * This bare statement call consumes reactive callback fields and should cross an explicit
 * compute boundary instead of operating directly on `file.key(...)` refs in plain code.
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
export default pattern((__cf_pattern_input) => {
    const files = __cf_pattern_input.key("files");
    return {
        [UI]: (<div>
        {files.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const file = __cf_pattern_input.key("element");
                __cfHelpers.derive({
                    type: "object",
                    properties: {
                        file: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                },
                                type: {
                                    type: "string"
                                }
                            },
                            required: ["name", "type"]
                        }
                    },
                    required: ["file"]
                } as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, { file: {
                        name: file.key("name"),
                        type: file.key("type")
                    } }, ({ file }) => console.log("mapping", file.name, file.type));
                return <span>{file.key("name")}</span>;
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
__cfHardenFn(h);
