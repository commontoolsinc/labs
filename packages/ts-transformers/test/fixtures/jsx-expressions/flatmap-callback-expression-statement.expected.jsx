function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * TRANSFORM REPRO: patternized flatMap callback should lower reactive expression statements
 */
import { pattern, UI, VNode, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface FileEntry {
    name: string;
    type: "file" | "folder";
}
interface Input {
    files: FileEntry[];
}
interface Output {
    [UI]: VNode;
}
const __cfLift_1 = __cfHelpers.lift<{
    file: {
        name: string;
        type: string;
    };
}, void>(({ file }) => console.log("mapping", file.name, file.type), {
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
} as const satisfies __cfHelpers.JSONSchema, {
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 30, col: 10 }
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const file = __cf_pattern_input.key("element");
    __cfLift_1({ file: {
            name: file.key("name"),
            type: file.key("type")
        } });
    return [<span>{file.key("name")}</span>];
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
    type: "array",
    items: {
        $ref: "#/$defs/JSXElement"
    },
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 29, col: 23 }
});
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const files = __cf_pattern_input.key("files");
    return {
        [UI]: (<div>
        {files.flatMapWithPattern(__cfPattern_1, {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        files: {
            type: "array",
            items: {
                $ref: "#/$defs/FileEntry"
            }
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 25, col: 38 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1
});
