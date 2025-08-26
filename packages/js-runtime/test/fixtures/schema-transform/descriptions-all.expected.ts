/// <cts-enable />
import { JSONSchema } from "commontools";
interface ChildNode {
    /** The main text content of the child node */
    body: string;
    /** Children of the child node */
    children: any[];
    /** Attachments associated with the child node */
    attachments: any[];
}
/** Outliner document */
type Doc = {
    /** The main text content of the node */
    body: string;
    /** Child nodes of this node */
    children: ChildNode[];
    /** Attachments associated with this node */
    attachments: any[];
    /** Version of document */
    version: number;
};
/** Root docstring to be overridden */
interface HasDocs {
    /** Name of item */
    name: string;
}
/** Base type */
interface Base {
    /** Base id */
    id: string;
}
/** Derived type */
interface Derived extends Base {
    /** Derived name */
    name: string;
}
/** Map of values */
interface Dict {
    /** Description for arbitrary keys */
    [key: string]: number;
}
/** Record of counts */
type Counts = {
    /** per-key count */
    [k: string]: number;
};
/** Summary line
 *
 * Longer details here.
 * @deprecated Use NewType instead.
 * @example
 *   const x = 1;
 */
interface WithTags {
    /** A value */
    value: number;
}
const schemaDoc = {
    type: "object",
    properties: {
        body: {
            type: "string",
            description: "The main text content of the node"
        },
        children: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    body: {
                        type: "string",
                        description: "The main text content of the child node"
                    },
                    children: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: true
                        },
                        description: "Children of the child node"
                    },
                    attachments: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: true
                        },
                        description: "Attachments associated with the child node"
                    }
                },
                required: ["body", "children", "attachments"]
            },
            description: "Child nodes of this node"
        },
        attachments: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: true
            },
            description: "Attachments associated with this node"
        },
        version: {
            type: "number",
            description: "Version of document"
        }
    },
    required: ["body", "children", "attachments", "version"],
    description: "Outliner document"
} as const satisfies JSONSchema;
const schemaPrecedence = {
    type: "object",
    properties: {
        name: {
            type: "string",
            description: "Name of item"
        }
    },
    required: ["name"],
    description: "Explicit description"
} as const satisfies JSONSchema;
const schemaDerived = {
    type: "object",
    properties: {
        id: {
            type: "string",
            description: "Base id"
        },
        name: {
            type: "string",
            description: "Derived name"
        }
    },
    required: ["id", "name"],
    description: "Derived type"
} as const satisfies JSONSchema;
const schemaDict = {
    type: "object",
    additionalProperties: {
        type: "number",
        description: "Description for arbitrary keys"
    }
} as const satisfies JSONSchema;
const schemaCounts = {
    type: "object",
    additionalProperties: {
        type: "number",
        description: "per-key count"
    }
} as const satisfies JSONSchema;
const schemaTags = {
    type: "object",
    properties: {
        value: {
            type: "number",
            description: "A value"
        }
    },
    required: ["value"],
    description: "Summary line\n\nLonger details here."
} as const satisfies JSONSchema;
export { schemaDoc, schemaPrecedence, schemaDerived, schemaDict, schemaCounts, schemaTags };


