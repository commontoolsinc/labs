/// <cts-enable />
import { Cell, Stream, Default, JSONSchema } from "commontools";
// 1) Nested: Child/Doc with property docs and root doc
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
// 2) Precedence: explicit description overrides root JSDoc
/** Root docstring to be overridden */
interface HasDocs {
    /** Name of item */
    name: string;
}
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
// 3) Intersections: same vs conflicting property docs
interface A {
    /** Name doc */
    name: string;
}
interface B {
    /** Name doc */
    name: string;
    /** Age */
    age: number;
}
type AB = A & B;
const schemaAB = {
    type: "object",
    properties: {
        name: {
            type: "string",
            description: "Name doc"
        },
        age: {
            type: "number",
            description: "Age"
        }
    },
    required: ["name", "age"]
} as const satisfies JSONSchema;
interface C {
    /** First name doc */
    name: string;
}
interface D {
    /** Second name doc */
    name: string;
}
type CD = C & D;
const schemaCD = {
    type: "object",
    properties: {
        name: {
            type: "string",
            description: "First name doc (Consolidated from intersection constituents)"
        }
    },
    required: ["name"]
} as const satisfies JSONSchema;
// 4) Extends-based inheritance of docs
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
const schemaDerived = {
    type: "object",
    properties: {
        name: {
            type: "string",
            description: "Derived name"
        },
        id: {
            type: "string",
            description: "Base id"
        }
    },
    required: ["name", "id"],
    description: "Derived type"
} as const satisfies JSONSchema;
// 5) Index signature and Record-like
/** Map of values */
interface Dict {
    /** Description for arbitrary keys */
    [key: string]: number;
}
const schemaDict = {
    type: "object",
    properties: {},
    additionalProperties: {
        type: "number",
        description: "Description for arbitrary keys"
    },
    description: "Map of values"
} as const satisfies JSONSchema;
/** Record of counts */
type Counts = {
    /** per-key count */
    [k: string]: number;
};
const schemaCounts = {
    type: "object",
    properties: {},
    additionalProperties: {
        type: "number",
        description: "per-key count"
    },
    description: "Record of counts"
} as const satisfies JSONSchema;
// 6) Root JSDoc with tags; property doc
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
// 7) Wrappers on properties
interface WrappedProps {
    /** Titles in a cell */
    titles: Cell<string[]>;
    /** Count as stream */
    count: Stream<number>;
    /** Level with default */
    level: Default<number, 3>;
}
const schemaWrapped = {
    type: "object",
    properties: {
        titles: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: true,
            description: "Titles in a cell"
        },
        count: {
            type: "number",
            asStream: true,
            description: "Count as stream"
        },
        level: {
            type: "number",
            default: 3,
            description: "Level with default"
        }
    },
    required: ["titles", "count", "level"]
} as const satisfies JSONSchema;
// 8) Optional and undefined unions
interface OptionalProps {
    /** maybe label */
    label?: string;
    /** maybe flag */
    flag: boolean | undefined;
}
const schemaOptional = {
    type: "object",
    properties: {
        label: {
            type: "string",
            description: "maybe label"
        },
        flag: {
            type: "boolean",
            description: "maybe flag"
        }
    },
    required: ["flag"]
} as const satisfies JSONSchema;
// 9) Root alias docs
/** Root alias doc */
interface BaseRoot {
    /** id */
    id: string;
}
type RootAlias = BaseRoot;
const schemaRootAlias = {
    type: "object",
    properties: {
        id: {
            type: "string",
            description: "id"
        }
    },
    required: ["id"],
    description: "Root alias doc"
} as const satisfies JSONSchema;
// 10) Recursive with $ref
interface Tree {
    /** node name */
    name: string;
    /** Child nodes */
    children: Tree[];
}
const schemaTree = {
    $ref: "#/definitions/Tree",
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: {
        Tree: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "node name"
                },
                children: {
                    type: "array",
                    items: {
                        $ref: "#/definitions/Tree"
                    },
                    description: "Child nodes"
                }
            },
            required: ["name", "children"]
        }
    }
} as const satisfies JSONSchema;
// 11) Array property JSDoc applies to array, not items
interface ArrayDocProps {
    /** tags of the item */
    tags: string[];
}
const schemaArrayDoc = {
    type: "object",
    properties: {
        tags: {
            type: "array",
            items: {
                type: "string"
            },
            description: "tags of the item"
        }
    },
    required: ["tags"]
} as const satisfies JSONSchema;
export { schemaDoc, schemaPrecedence, schemaDerived, schemaDict, schemaCounts, schemaTags, schemaWrapped, schemaOptional, schemaRootAlias, schemaTree, schemaArrayDoc };
