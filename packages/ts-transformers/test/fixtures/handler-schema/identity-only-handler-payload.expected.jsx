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
import { equals, handler, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type MentionablePiece = {
    title?: string;
    isHidden?: boolean;
    mentioned?: MentionablePiece[];
    backlinks?: MentionablePiece[];
};
const addPiece = handler({
    type: "object",
    properties: {
        piece: {
            $ref: "#/$defs/MentionablePiece",
            asCell: ["comparable"]
        }
    },
    required: ["piece"],
    $defs: {
        MentionablePiece: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                isHidden: {
                    type: "boolean"
                },
                mentioned: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/MentionablePiece"
                    }
                },
                backlinks: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/MentionablePiece"
                    }
                }
            }
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        pieceRegistry: {
            type: "array",
            items: {
                type: "unknown",
                asCell: ["comparable"]
            },
            asCell: ["cell"]
        }
    },
    required: ["pieceRegistry"]
} as const satisfies __cfHelpers.JSONSchema, (event, { pieceRegistry }) => {
    const piece = event?.piece;
    if (!piece)
        return;
    const current = pieceRegistry.get();
    if (!current.some((c) => equals(c, piece))) {
        pieceRegistry.push(piece);
    }
});
__cfBindVerifiedBinding(addPiece, {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 2 },
    bindingName: "addPiece"
});
const trackRecent = handler({
    type: "object",
    properties: {
        piece: {
            $ref: "#/$defs/MentionablePiece",
            asCell: ["comparable"]
        }
    },
    required: ["piece"],
    $defs: {
        MentionablePiece: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                isHidden: {
                    type: "boolean"
                },
                mentioned: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/MentionablePiece"
                    }
                },
                backlinks: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/MentionablePiece"
                    }
                }
            }
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        recentPieces: {
            type: "array",
            items: {
                type: "unknown",
                asCell: ["comparable"]
            },
            asCell: ["cell"]
        }
    },
    required: ["recentPieces"]
} as const satisfies __cfHelpers.JSONSchema, ({ piece }, { recentPieces }) => {
    const current = recentPieces.get();
    const filtered = current.filter((c) => !equals(c, piece));
    const updated = [piece, ...filtered].slice(0, 10);
    recentPieces.set(updated);
});
__cfBindVerifiedBinding(trackRecent, {
    sourceFile: "/test.tsx",
    position: { line: 27, col: 2 },
    bindingName: "trackRecent"
});
// FIXTURE: identity-only-handler-payload
// Verifies: handler payloads and array items used only for identity/passthrough
// shrink to unknown instead of retaining full recursive structural schemas.
export { addPiece, trackRecent };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
