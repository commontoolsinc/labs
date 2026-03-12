import * as __ctHelpers from "commontools";
/**
 * FIXTURE: nested-computed-output-maps
 * Verifies: nested computed outputs can flow back into later pattern-owned
 * maps while their inner compute-owned array maps stay plain, and callback
 * captures survive across multiple cloned callbacks.
 * Expected transform:
 * - laneLabels.map(...) lowers after calling a module-scope lift in pattern context
 * - visibleThreads.map(...), visibleComments.map(...), comment.reactions.map(...),
 *   and plainSeparators.map(...) remain plain Array.map() calls inside computed()
 * - liftedSeparators.map(...) lowers after calling that same module-scope lift
 *   inside the current compute callback
 * - reboundComments.map(...) lowers because a nested computed() re-wraps the
 *   local array inside the current compute callback
 * - threadRows.map(...) lowers once the flow re-enters pattern-owned UI
 * - closures preserve thread/comment indices, state.lane, and local Writables
 */
import { computed, handler, ifElse, lift, pattern, UI, Writable, } from "commontools";
interface Comment {
    id: string;
    text: string;
    flagged: boolean;
    reactions: string[];
}
interface Thread {
    id: string;
    title: string;
    muted: boolean;
    comments: Comment[];
}
const jumpToComment = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        selectedCommentId: {
            type: ["string", "undefined"]
        },
        threadId: {
            type: "string"
        },
        commentId: {
            type: "string"
        },
        lane: {
            type: "string"
        },
        outerIndex: {
            type: "number"
        },
        innerIndex: {
            type: "number"
        }
    },
    required: ["selectedCommentId", "threadId", "commentId", "lane", "outerIndex", "innerIndex"]
} as const satisfies __ctHelpers.JSONSchema, (_event, state) => state);
const passthroughLabels = lift({
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __ctHelpers.JSONSchema, (labels: string[]) => labels);
export default pattern((state) => {
    const selectedCommentId = Writable.of<string | undefined>(undefined, {
        type: ["string", "undefined"]
    } as const satisfies __ctHelpers.JSONSchema);
    const laneLabels = passthroughLabels(["lane", "detail", "summary"]);
    const visibleThreads = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    threads: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Thread"
                        },
                        asOpaque: true
                    },
                    showFlagged: {
                        type: "boolean",
                        asOpaque: true
                    }
                },
                required: ["threads", "showFlagged"]
            }
        },
        required: ["state"],
        $defs: {
            Thread: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    title: {
                        type: "string"
                    },
                    muted: {
                        type: "boolean"
                    },
                    comments: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Comment"
                        }
                    }
                },
                required: ["id", "title", "muted", "comments"]
            },
            Comment: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    text: {
                        type: "string"
                    },
                    flagged: {
                        type: "boolean"
                    },
                    reactions: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["id", "text", "flagged", "reactions"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "object",
            properties: {
                thread: {
                    $ref: "#/$defs/Thread",
                    asOpaque: true
                },
                outerIndex: {
                    type: "number",
                    asOpaque: true
                },
                visibleComments: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Comment",
                        asOpaque: true
                    }
                }
            },
            required: ["thread", "outerIndex", "visibleComments"]
        },
        asOpaque: true,
        $defs: {
            Comment: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    text: {
                        type: "string"
                    },
                    flagged: {
                        type: "boolean"
                    },
                    reactions: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["id", "text", "flagged", "reactions"]
            },
            Thread: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    title: {
                        type: "string"
                    },
                    muted: {
                        type: "boolean"
                    },
                    comments: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Comment"
                        }
                    }
                },
                required: ["id", "title", "muted", "comments"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            threads: state.key("threads"),
            showFlagged: state.key("showFlagged")
        } }, ({ state }) => state.threads.map((thread, outerIndex) => ({
        thread,
        outerIndex,
        visibleComments: state.showFlagged
            ? thread.comments.filter((comment) => comment.flagged)
            : thread.comments,
    })));
    const threadRows = __ctHelpers.derive({
        type: "object",
        properties: {
            visibleThreads: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        thread: {
                            $ref: "#/$defs/Thread",
                            asOpaque: true
                        },
                        outerIndex: {
                            type: "number",
                            asOpaque: true
                        },
                        visibleComments: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Comment",
                                asOpaque: true
                            }
                        }
                    },
                    required: ["thread", "outerIndex", "visibleComments"]
                },
                asOpaque: true
            },
            selectedCommentId: {
                type: ["string", "undefined"],
                asCell: true
            },
            state: {
                type: "object",
                properties: {
                    lane: {
                        type: "string",
                        asOpaque: true
                    }
                },
                required: ["lane"]
            }
        },
        required: ["visibleThreads", "selectedCommentId", "state"],
        $defs: {
            Comment: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    text: {
                        type: "string"
                    },
                    flagged: {
                        type: "boolean"
                    },
                    reactions: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["id", "text", "flagged", "reactions"]
            },
            Thread: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    title: {
                        type: "string"
                    },
                    muted: {
                        type: "boolean"
                    },
                    comments: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Comment"
                        }
                    }
                },
                required: ["id", "title", "muted", "comments"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/UIRenderable"
        },
        asOpaque: true,
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
    } as const satisfies __ctHelpers.JSONSchema, {
        visibleThreads: visibleThreads,
        selectedCommentId: selectedCommentId,
        state: {
            lane: state.key("lane")
        }
    }, ({ visibleThreads, selectedCommentId, state }) => visibleThreads.map(({ thread, outerIndex, visibleComments }) => {
        const plainSeparators = ["top", "bottom"].map((edge) => `${thread.title}-${edge}`);
        const liftedSeparators = passthroughLabels(plainSeparators);
        const reboundComments = __ctHelpers.derive({
            type: "object",
            properties: {
                visibleComments: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Comment",
                        asOpaque: true
                    },
                    asOpaque: true
                }
            },
            required: ["visibleComments"],
            $defs: {
                Comment: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        },
                        text: {
                            type: "string"
                        },
                        flagged: {
                            type: "boolean"
                        },
                        reactions: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["id", "text", "flagged", "reactions"]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/Comment",
                asOpaque: true
            },
            asOpaque: true,
            $defs: {
                Comment: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        },
                        text: {
                            type: "string"
                        },
                        flagged: {
                            type: "boolean"
                        },
                        reactions: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["id", "text", "flagged", "reactions"]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, { visibleComments: visibleComments }, ({ visibleComments }) => visibleComments);
        return (<article>
          <h2>{thread.title}</h2>
          {visibleComments.map((comment, innerIndex) => (<div>
              <button type="button" onClick={jumpToComment({
                    selectedCommentId: selectedCommentId,
                    threadId: thread.id,
                    commentId: comment.id,
                    lane: state.lane,
                    outerIndex,
                    innerIndex,
                })}>
                {comment.flagged
                    ? <strong>{comment.text}</strong>
                    : ifElse({
                        type: "boolean",
                        asOpaque: true
                    } as const satisfies __ctHelpers.JSONSchema, {
                        anyOf: [{}, {
                                type: "object",
                                properties: {}
                            }]
                    } as const satisfies __ctHelpers.JSONSchema, {
                        anyOf: [{}, {
                                type: "object",
                                properties: {}
                            }]
                    } as const satisfies __ctHelpers.JSONSchema, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true,
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
                    } as const satisfies __ctHelpers.JSONSchema, thread.muted, <em>{comment.text}</em>, <span>{comment.text}</span>)}
              </button>
              {comment.reactions.map((reaction, reactionIndex) => (<span>
                  {reactionIndex === innerIndex
                        ? `${state.lane}:${reaction}`
                        : reaction}
                </span>))}
            </div>))}
          {reboundComments.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const comment = __ct_pattern_input.key("element");
                const reboundIndex = __ct_pattern_input.key("index");
                const outerIndex = __ct_pattern_input.params.outerIndex;
                const state = __ct_pattern_input.key("params", "state");
                return (<aside>
              {reboundIndex === outerIndex
                        ? `${state.key("lane")}:${comment.key("id")}`
                        : comment.key("text")}
            </aside>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Comment",
                        asOpaque: true
                    },
                    index: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            outerIndex: {
                                type: "number",
                                asOpaque: true
                            },
                            state: {
                                type: "object",
                                properties: {
                                    lane: {
                                        type: "string",
                                        asOpaque: true
                                    }
                                },
                                required: ["lane"]
                            }
                        },
                        required: ["outerIndex", "state"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Comment: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            text: {
                                type: "string"
                            },
                            flagged: {
                                type: "boolean"
                            },
                            reactions: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        required: ["id", "text", "flagged", "reactions"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema), {
                outerIndex: outerIndex,
                state: {
                    lane: state.lane
                }
            })}
          {liftedSeparators.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const edge = __ct_pattern_input.key("element");
                const edgeIndex = __ct_pattern_input.key("index");
                const outerIndex = __ct_pattern_input.params.outerIndex;
                const state = __ct_pattern_input.key("params", "state");
                return (<small>
              {edgeIndex === outerIndex ? `${state.key("lane")}:${edge}` : edge}
            </small>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    },
                    index: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            outerIndex: {
                                type: "number",
                                asOpaque: true
                            },
                            state: {
                                type: "object",
                                properties: {
                                    lane: {
                                        type: "string",
                                        asOpaque: true
                                    }
                                },
                                required: ["lane"]
                            }
                        },
                        required: ["outerIndex", "state"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema), {
                outerIndex: outerIndex,
                state: {
                    lane: state.lane
                }
            })}
          {plainSeparators.map((edge) => <small>{edge}</small>)}
        </article>);
    }));
    return {
        [UI]: (<div>
        {laneLabels.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const label = __ct_pattern_input.key("element");
                const labelIndex = __ct_pattern_input.key("index");
                const state = __ct_pattern_input.key("params", "state");
                return (<header data-lane-label={labelIndex}>
            {__ctHelpers.ifElse({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string",
                    asOpaque: true
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                    type: "object",
                    properties: {
                        labelIndex: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["labelIndex"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, { labelIndex: labelIndex }, ({ labelIndex }) => labelIndex === 0), __ctHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                lane: {
                                    type: "string",
                                    asOpaque: true
                                }
                            },
                            required: ["lane"]
                        },
                        label: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["state", "label"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, {
                    state: {
                        lane: state.key("lane")
                    },
                    label: label
                }, ({ state, label }) => `${state.lane}:${label}`), label)}
          </header>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    },
                    index: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    lane: {
                                        type: "string",
                                        asOpaque: true
                                    }
                                },
                                required: ["lane"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema), {
                state: {
                    lane: state.key("lane")
                }
            })}
        {threadRows.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const row = __ct_pattern_input.key("element");
                const rowIndex = __ct_pattern_input.key("index");
                return (<section data-row={rowIndex}>{row}</section>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/UIRenderable"
                    },
                    index: {
                        type: "number"
                    }
                },
                required: ["element"],
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
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        threads: {
            type: "array",
            items: {
                $ref: "#/$defs/Thread"
            }
        },
        lane: {
            type: "string"
        },
        showFlagged: {
            type: "boolean"
        }
    },
    required: ["threads", "lane", "showFlagged"],
    $defs: {
        Thread: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                title: {
                    type: "string"
                },
                muted: {
                    type: "boolean"
                },
                comments: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Comment"
                    }
                }
            },
            required: ["id", "title", "muted", "comments"]
        },
        Comment: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                text: {
                    type: "string"
                },
                flagged: {
                    type: "boolean"
                },
                reactions: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id", "text", "flagged", "reactions"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
