// transformed: /index.ts
export * from "/ba4jca7apnzcsjtvn6d4xk66o5b7n7fo5xaucah7xuooakxk2zckexpjk/.codex-tmp/files-capture-repros/helper-owned-handler-nested-captures.tsx";
export { default } from "/ba4jca7apnzcsjtvn6d4xk66o5b7n7fo5xaucah7xuooakxk2zckexpjk/.codex-tmp/files-capture-repros/helper-owned-handler-nested-captures.tsx";

// transformed: /ba4jca7apnzcsjtvn6d4xk66o5b7n7fo5xaucah7xuooakxk2zckexpjk/.codex-tmp/files-capture-repros/helper-owned-handler-nested-captures.tsx
import * as __ctHelpers from "commontools";
import { action, Default, pattern, Stream, Writable } from "commontools";
function flushLater(fileId: Writable<Default<string, "">>, content: Writable<Default<string, "">>, savedContent: Writable<Default<string, "">>, onSaveFile: Stream<{
    fileId: string;
    content: string;
}>): void {
    const nextContent = content.get();
    const lastSaved = savedContent.get();
    const targetFileId = fileId.get().trim();
    if (!targetFileId || nextContent === lastSaved)
        return;
    onSaveFile.send({ fileId: targetFileId, content: nextContent });
}
interface Input {
    fileId: Writable<Default<string, "">>;
    content: Writable<Default<string, "">>;
    savedContent: Writable<Default<string, "">>;
    onSaveFile: Stream<{
        fileId: string;
        content: string;
    }>;
}
interface Output {
    trigger: Stream<void>;
}
export default pattern((__ct_pattern_input) => {
    const fileId = __ct_pattern_input.key("fileId");
    const content = __ct_pattern_input.key("content");
    const savedContent = __ct_pattern_input.key("savedContent");
    const onSaveFile = __ct_pattern_input.key("onSaveFile");
    const timer = Writable.of<ReturnType<typeof setTimeout> | null>(null, {
        anyOf: [{
                type: "number"
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema);
    const trigger = __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            timer: {
                anyOf: [{
                        type: "number"
                    }, {
                        type: "null"
                    }],
                asCell: true
            },
            fileId: {
                type: "string",
                "default": "",
                asCell: true
            },
            content: {
                type: "string",
                "default": "",
                asCell: true
            },
            savedContent: {
                type: "string",
                "default": "",
                asCell: true
            },
            onSaveFile: {
                type: "object",
                properties: {
                    fileId: {
                        type: "string"
                    },
                    content: {
                        type: "string"
                    }
                },
                required: ["fileId", "content"],
                asStream: true
            }
        },
        required: ["timer", "fileId", "content", "savedContent", "onSaveFile"]
    } as const satisfies __ctHelpers.JSONSchema, (_, { timer, fileId, content, savedContent, onSaveFile }) => {
        const prev = timer.get();
        if (prev !== null)
            clearTimeout(prev);
        timer.set(setTimeout(() => {
            flushLater(fileId, content, savedContent, onSaveFile);
        }, 10));
    })({
        timer: timer,
        fileId: fileId,
        content: content,
        savedContent: savedContent,
        onSaveFile: onSaveFile
    });
    return { trigger };
}, {
    type: "object",
    properties: {
        fileId: {
            type: "string",
            "default": "",
            asCell: true
        },
        content: {
            type: "string",
            "default": "",
            asCell: true
        },
        savedContent: {
            type: "string",
            "default": "",
            asCell: true
        },
        onSaveFile: {
            type: "object",
            properties: {
                fileId: {
                    type: "string"
                },
                content: {
                    type: "string"
                }
            },
            required: ["fileId", "content"],
            asStream: true
        }
    },
    required: ["fileId", "content", "savedContent", "onSaveFile"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        trigger: {
            asStream: true
        }
    },
    required: ["trigger"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;

