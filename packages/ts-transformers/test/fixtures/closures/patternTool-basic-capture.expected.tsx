import * as __ctHelpers from "commontools";
import { cell, derive, patternTool } from "commontools";
const content = cell("Hello world\nGoodbye world", {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema);
const grepTool = patternTool(({ query, content }: {
    query: string;
    content: unknown;
}) => {
    return derive({
        type: "object",
        properties: {
            query: {
                type: "string"
            }
        },
        required: ["query"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { query }, ({ query }) => {
        return content.get().split("\n").filter((c: string) => c.includes(query));
    });
}, { content: content });
export default grepTool;
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
