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
 * FUTURE REPRO: patternized map callbacks should follow array-destructured aliases
 *
 * Destructuring a reactive array-valued field into a local alias should still
 * let later computations lower through that alias.
 */
import { Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface FileEntry {
    name: string;
    tags: [
        "file" | "folder",
        string
    ];
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
                const __ct_destructure_1 = file.key("tags"), kind = __ct_destructure_1.key("0");
                const isFolder = __cfHelpers.derive({
                    type: "object",
                    properties: {
                        kind: {
                            type: "string"
                        }
                    },
                    required: ["kind"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, { kind: kind }, ({ kind }) => kind === "folder");
                return <span>{__cfHelpers.ifElse({
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, isFolder, file.key("name"), "locked")}</span>;
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
                            tags: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        required: ["name", "tags"]
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
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["name", "tags"]
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
