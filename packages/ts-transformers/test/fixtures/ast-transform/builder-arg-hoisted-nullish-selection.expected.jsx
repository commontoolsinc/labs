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
import { type Cell, Default, handler, pattern, UI, Writable, wish, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Profile {
    name: string;
}
const join = handler({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        myName: {
            type: "string",
            asCell: ["writeonly"]
        },
        profile: {
            anyOf: [{
                    $ref: "#/$defs/Profile"
                }, {
                    type: "undefined"
                }],
            asCell: ["readonly"]
        }
    },
    required: ["myName"],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (event, { myName, profile }) => {
    const resolved = profile?.get();
    myName.set(resolved ? resolved.name : event.name);
});
__cfBindVerifiedBinding(join, {
    sourceFile: "/test.tsx",
    position: { line: 22, col: 2 },
    bindingName: "join"
});
interface CardState {
    myName: Default<string, "">;
    profile?: Cell<Profile>;
}
const __cfLift_1 = __cfHelpers.lift<{
    profile?: __cfHelpers.Cell<Profile> | undefined;
    profileWish: {
        result: Profile | undefined;
    };
}, Profile | __cfHelpers.Cell<Profile> | undefined>(({ profile, profileWish }) => profile ?? profileWish.result, {
    type: "object",
    properties: {
        profile: {
            anyOf: [{
                    $ref: "#/$defs/Profile"
                }, {
                    type: "undefined"
                }],
            asCell: ["readonly"]
        },
        profileWish: {
            type: "object",
            properties: {
                result: {
                    $ref: "#/$defs/Profile"
                }
            }
        }
    },
    required: ["profileWish"],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "undefined"
        }, {
            $ref: "#/$defs/Profile"
        }, {
            $ref: "#/$defs/Profile",
            asCell: ["cell"]
        }],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 48, col: 24 },
    bindingName: "activeProfile"
});
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        boundJoin: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"],
            asCell: ["stream"]
        }
    },
    required: ["boundJoin"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { boundJoin }) => boundJoin.send({ name: "guest" }));
__cfBindVerifiedBinding(__cfHandler_1, {
    sourceFile: "/test.tsx",
    position: { line: 56, col: 28 }
});
// FIXTURE: builder-arg-hoisted-nullish-selection
// Verifies: the remedy the `reactive:call-argument-computation` diagnostic
//   advises — a reactive `??` selection hoisted to a body-level const and
//   bound into a bound-handler's builder args — lowers cleanly:
//   const activeProfile = profile ?? profileWish.result;
//     -> __cfLift_1({profile, profileWish:{result: ...key("result")}})
//        .for("activeProfile", true)   (authored-name cause)
//   join({ myName, profile: activeProfile })
//     -> binds the named derived node, with builder-layer cause layering
//        .for(["boundJoin", "profile"], true)
// Context: the INLINE form of this `??` in the builder args is rejected with
//   the hoist diagnostic (see fixtures/bug-repro/ and
//   test/builder-argument-computation-diagnostic.test.ts); this golden pins
//   that the advised hoisted form compiles, and what it compiles to.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const myName = __cf_pattern_input.key("myName");
    const profile = __cf_pattern_input.key("profile");
    const profileWish = wish<Profile>({ query: "#profile" }, {
        type: "object",
        properties: {
            name: {
                type: "string"
            }
        },
        required: ["name"]
    } as const satisfies __cfHelpers.JSONSchema).for("profileWish", true);
    const activeProfile = __cfLift_1({
        profile: profile,
        profileWish: {
            result: profileWish.key("result")
        }
    }).for("activeProfile", true);
    const boundJoin = join({
        myName,
        profile: activeProfile.for(["boundJoin", "profile"], true)
    }).for({ stream: "boundJoin" }, true);
    return {
        [UI]: (<div>
        <cf-button onClick={__cfHandler_1({
            boundJoin: boundJoin
        })}>
          Join
        </cf-button>
      </div>),
    };
}, {
    type: "object",
    properties: {
        myName: {
            type: "string",
            "default": ""
        },
        profile: {
            $ref: "#/$defs/Profile",
            asCell: ["cell"]
        }
    },
    required: ["myName"],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 46, col: 34 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    join,
    __cfLift_1,
    __cfHandler_1
});
