import * as __ctHelpers from "commontools";
import { derive, patternTool } from "commontools";
// No external captures - should not be transformed by PatternToolStrategy
const tool = patternTool(({ query, content }: {
    query: string;
    content: string;
}) => {
    return derive({
        type: "object",
        properties: {
            query: {
                type: "string"
            },
            content: {
                type: "string"
            }
        },
        required: ["query", "content"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { query, content }, ({ query, content }) => {
        return content.split("\n").filter((c: string) => c.includes(query));
    });
});
export default tool;
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
