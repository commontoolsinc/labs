import * as __ctHelpers from "commontools";
import { Writable, computed, pattern, UI } from "commontools";
interface Habit {
    name: string;
}
interface HabitLog {
    habitName: string;
    date: string;
    completed: boolean;
}
interface Input {
    habits: Habit[];
    logs: Writable<HabitLog[]>;
    todayDate: string;
}
// FIXTURE: map-plain-array-some-alias-in-computed
// Verifies: aliasing the result of .get() inside computed() still keeps nested plain-array callbacks plain
//   const logList = logs.get()
//   logList.some(fn) -> plain JS some(fn), not callback-lowered
// Context: Outer habits.map(...) is pattern-owned, but the inner some() runs on the aliased unwrapped array inside computed()
export default pattern((__ct_pattern_input) => {
    const habits = __ct_pattern_input.key("habits");
    const logs = __ct_pattern_input.key("logs");
    const todayDate = __ct_pattern_input.key("todayDate");
    return {
        [UI]: <div>{habits.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const habit = __ct_pattern_input.key("element");
                const logs = __ct_pattern_input.key("params", "logs");
                const todayDate = __ct_pattern_input.key("params", "todayDate");
                const doneToday = __ctHelpers.derive({
                    type: "object",
                    properties: {
                        logs: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/HabitLog"
                            },
                            asCell: true
                        },
                        habit: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        },
                        todayDate: {
                            type: "string"
                        }
                    },
                    required: ["logs", "habit", "todayDate"],
                    $defs: {
                        HabitLog: {
                            type: "object",
                            properties: {
                                habitName: {
                                    type: "string"
                                },
                                date: {
                                    type: "string"
                                },
                                completed: {
                                    type: "boolean"
                                }
                            },
                            required: ["habitName", "date", "completed"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    logs: logs,
                    habit: {
                        name: habit.key("name")
                    },
                    todayDate: todayDate
                }, ({ logs, habit, todayDate }) => {
                    const logList = logs.get();
                    return logList.some((log) => log.habitName === habit.name &&
                        log.date === todayDate &&
                        log.completed);
                });
                return <span>{__ctHelpers.ifElse({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, {
                    "enum": ["yes", "no"]
                } as const satisfies __ctHelpers.JSONSchema, doneToday, "yes", "no")}</span>;
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Habit"
                    },
                    params: {
                        type: "object",
                        properties: {
                            logs: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/HabitLog"
                                },
                                asCell: true
                            },
                            todayDate: {
                                type: "string"
                            }
                        },
                        required: ["logs", "todayDate"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    HabitLog: {
                        type: "object",
                        properties: {
                            habitName: {
                                type: "string"
                            },
                            date: {
                                type: "string"
                            },
                            completed: {
                                type: "boolean"
                            }
                        },
                        required: ["habitName", "date", "completed"]
                    },
                    Habit: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
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
            } as const satisfies __ctHelpers.JSONSchema), {
                logs: logs,
                todayDate: todayDate
            })}</div>,
    };
}, {
    type: "object",
    properties: {
        habits: {
            type: "array",
            items: {
                $ref: "#/$defs/Habit"
            }
        },
        logs: {
            type: "array",
            items: {
                $ref: "#/$defs/HabitLog"
            },
            asCell: true
        },
        todayDate: {
            type: "string"
        }
    },
    required: ["habits", "logs", "todayDate"],
    $defs: {
        HabitLog: {
            type: "object",
            properties: {
                habitName: {
                    type: "string"
                },
                date: {
                    type: "string"
                },
                completed: {
                    type: "boolean"
                }
            },
            required: ["habitName", "date", "completed"]
        },
        Habit: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
