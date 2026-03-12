import * as __ctHelpers from "commontools";
/**
 * FIXTURE: helper-owned-compute-branches
 * Verifies: helper-owned branches inside computed() can mix compute-owned array
 * maps with reactive Writable captures without losing branch rewriting.
 * Expected transform:
 * - visibleProjects.map(...), project.badges.map(...), project.members.map(...),
 *   and plainPreview.map(...) remain plain Array.map() calls in compute context
 * - fallbackMembers.map(...) still lowers because it comes from a closed-over
 *   Writable array capture
 * - authored ifElse branches still lower safely around the mixed map behavior
 */
import { computed, ifElse, pattern, UI, Writable } from "commontools";
interface Badge {
    text: string;
    active: boolean;
}
interface Project {
    id: string;
    name: string;
    archived: boolean;
    members: string[];
    badges: Badge[];
}
export default pattern((state) => {
    const fallbackMembers = Writable.of(["ops", "sales"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const visibleProjects = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    showArchived: {
                        type: "boolean",
                        asOpaque: true
                    },
                    projects: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Project"
                        },
                        asOpaque: true
                    }
                },
                required: ["showArchived", "projects"]
            }
        },
        required: ["state"],
        $defs: {
            Project: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    name: {
                        type: "string"
                    },
                    archived: {
                        type: "boolean"
                    },
                    members: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    },
                    badges: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Badge"
                        }
                    }
                },
                required: ["id", "name", "archived", "members", "badges"]
            },
            Badge: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    },
                    active: {
                        type: "boolean"
                    }
                },
                required: ["text", "active"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/Project",
            asOpaque: true
        },
        $defs: {
            Project: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    name: {
                        type: "string"
                    },
                    archived: {
                        type: "boolean"
                    },
                    members: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    },
                    badges: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Badge"
                        }
                    }
                },
                required: ["id", "name", "archived", "members", "badges"]
            },
            Badge: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    },
                    active: {
                        type: "boolean"
                    }
                },
                required: ["text", "active"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            showArchived: state.key("showArchived"),
            projects: state.key("projects")
        } }, ({ state }) => state.showArchived
        ? state.projects
        : state.projects.filter((project) => !project.archived));
    const rows = __ctHelpers.derive({
        type: "object",
        properties: {
            visibleProjects: {
                type: "array",
                items: {
                    $ref: "#/$defs/Project",
                    asOpaque: true
                },
                asOpaque: true
            },
            state: {
                type: "object",
                properties: {
                    prefix: {
                        type: "string",
                        asOpaque: true
                    }
                },
                required: ["prefix"]
            },
            fallbackMembers: {
                type: "array",
                items: {
                    type: "string"
                },
                asCell: true
            }
        },
        required: ["visibleProjects", "state", "fallbackMembers"],
        $defs: {
            Project: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    name: {
                        type: "string"
                    },
                    archived: {
                        type: "boolean"
                    },
                    members: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    },
                    badges: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Badge"
                        }
                    }
                },
                required: ["id", "name", "archived", "members", "badges"]
            },
            Badge: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    },
                    active: {
                        type: "boolean"
                    }
                },
                required: ["text", "active"]
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
        visibleProjects: visibleProjects,
        state: {
            prefix: state.key("prefix")
        },
        fallbackMembers: fallbackMembers
    }, ({ visibleProjects, state, fallbackMembers }) => visibleProjects.map((project, projectIndex) => {
        const plainPreview = ["alpha", "beta"].map((label, labelIndex) => `${project.name}-${labelIndex}-${label}`);
        return ifElse({
            type: "boolean"
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
        } as const satisfies __ctHelpers.JSONSchema, project.badges.length > 0, <div>
          <h3>{project.name}</h3>
          {project.badges.map((badge, badgeIndex) => (<span>
              {badge.active
                    ? `${state.prefix}${badge.text}-${projectIndex}`
                    : badgeIndex === 0
                        ? `${project.name}:${badge.text}`
                        : ""}
            </span>))}
          {fallbackMembers.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const member = __ct_pattern_input.key("element");
                const memberIndex = __ct_pattern_input.key("index");
                const project = __ct_pattern_input.params.project;
                return (<small>
              {memberIndex === 0 ? `${project.name}-${member}` : member}
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
                            project: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string",
                                        asOpaque: true
                                    }
                                },
                                required: ["name"]
                            }
                        },
                        required: ["project"]
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
                project: {
                    name: project.name
                }
            })}
          {plainPreview.map((label) => <i>{label}</i>)}
        </div>, <div>
          {project.members.map((member, memberIndex) => (<span>
              {memberIndex === projectIndex
                    ? `${state.prefix}${member}`
                    : member}
            </span>))}
        </div>);
    }));
    return {
        [UI]: <div>{rows}</div>,
    };
}, {
    type: "object",
    properties: {
        projects: {
            type: "array",
            items: {
                $ref: "#/$defs/Project"
            }
        },
        prefix: {
            type: "string"
        },
        showArchived: {
            type: "boolean"
        }
    },
    required: ["projects", "prefix", "showArchived"],
    $defs: {
        Project: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                archived: {
                    type: "boolean"
                },
                members: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                badges: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Badge"
                    }
                }
            },
            required: ["id", "name", "archived", "members", "badges"]
        },
        Badge: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["text", "active"]
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
