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
 * FUTURE REPRO: patternized map callbacks should follow tuple aggregate aliases
 *
 * If a reactive field is packed into a local tuple aggregate, later tuple-index
 * computations should still lower correctly.
 */
import { Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
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
const __cfLift_1 = __cfHelpers.lift<{
    info: readonly ["file" | "folder", string];
}, boolean>(({ info }) => info[0] === "folder", {
    type: "object",
    properties: {
        info: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["info"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 36, col: 27 },
    bindingName: "isFolder"
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const file = __cf_pattern_input.key("element");
    const info = [file.key("type"), file.key("name")] as const;
    const isFolder = __cfLift_1({ info: info }).for("isFolder", true);
    return <span>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, isFolder, info[1], "locked")}</span>;
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 34, col: 19 }
});
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const files = __cf_pattern_input.key("files");
    return {
        [UI]: (<div>
        {files.mapWithPattern(__cfPattern_1, {})}
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
            asCell: ["cell"]
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
    position: { line: 30, col: 38 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1
});
