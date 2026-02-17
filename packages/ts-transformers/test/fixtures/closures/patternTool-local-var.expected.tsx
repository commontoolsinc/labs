import * as __ctHelpers from "commontools";
import { computed, generateText, patternTool, Writable } from "commontools";
const content = Writable.of("Hello world", {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema);
// Regression test: local variables (genResult) must NOT be captured as
// extraParams, even when they have a reactive type. Only module-scoped
// reactive variables (content) should be captured.
const tool = patternTool(({ language, content }: {
    language: string;
    content: string;
}) => {
    const genResult = generateText({
        system: __ctHelpers.derive({
            type: "object",
            properties: {
                language: {
                    type: "string"
                }
            },
            required: ["language"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { language: language }, ({ language }) => `Translate to ${language}.`),
        prompt: __ctHelpers.derive({
            type: "object",
            properties: {
                content: {
                    type: "string"
                }
            },
            required: ["content"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { content: content }, ({ content }) => content),
    });
    return __ctHelpers.derive({
        type: "object",
        properties: {
            genResult: {
                type: "object",
                properties: {
                    pending: {
                        type: "boolean",
                        asOpaque: true
                    },
                    result: {
                        type: "string",
                        asOpaque: true
                    }
                },
                required: ["pending"]
            }
        },
        required: ["genResult"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string",
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, { genResult: {
            pending: genResult.pending,
            result: genResult.result
        } }, ({ genResult }) => {
        if (genResult.pending)
            return undefined;
        return genResult.result;
    });
}, { content });
export default tool;
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
