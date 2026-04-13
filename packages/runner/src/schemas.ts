/**
 * /!\ Shared between client and runtime threads.
 * /!\ Take care in only importing lightweight types,
 * /!\ interfaces and utilities.
 */

import { NAME, type Schema, TYPE, UI } from "./shared.ts";
import { toDeepFrozenSchema } from "@commonfabric/data-model/schema-utils";

export const rendererVDOMSchema = toDeepFrozenSchema(
  {
    $id: "https://commonfabric.org/schemas/vdom.json",
    $defs: {
      vdomRenderNode: {
        anyOf: [
          { $ref: "#/$defs/vdomNode" },
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "undefined" },
          {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode", asCell: ["cell"] },
          },
        ],
      },
      vdomNode: {
        type: "object",
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          props: {
            type: "object",
            properties: {
              style: { anyOf: [{ type: "object" }, { type: "string" }] },
            },
            additionalProperties: {
              anyOf: [{
                type: "string",
              }, {
                type: "number",
              }, {
                type: "boolean",
              }, {
                type: "null",
              }, {
                type: "undefined",
              }, {
                type: "object",
                properties: {}, // stop query from descending
              }, {
                type: "array",
                items: { type: "null" }, // stop query from descending
              }, {
                asCell: ["stream"],
                type: "unknown",
              }],
            },
            asCell: ["cell"],
          },
          children: {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode", asCell: ["cell"] },
            asCell: ["cell"],
          },
          [UI]: { $ref: "#/$defs/vdomNode" },
        },
      },
    },
    $ref: "#/$defs/vdomNode",
  },
  true,
);

/**
 * Debug variant of rendererVDOMSchema.
 * Children expand inline (no asCell) so the full tree is readable in one .get().
 * Props keep asCell since prop values can be large and aren't needed for structural debugging.
 */
export const debugVDOMSchema = toDeepFrozenSchema(
  {
    $id: "https://commonfabric.org/schemas/vdom-debug.json",
    $defs: {
      vdomRenderNode: {
        anyOf: [
          { $ref: "#/$defs/vdomNode" },
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "undefined" },
          {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode" },
          },
        ],
      },
      vdomNode: {
        type: "object",
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          props: {
            type: "object",
            additionalProperties: { asCell: ["cell"] },
          },
          children: {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode" },
          },
          [UI]: { $ref: "#/$defs/vdomNode" },
        },
      },
    },
    $ref: "#/$defs/vdomNode",
  },
  true,
);

export const vnodeSchema = toDeepFrozenSchema(
  {
    $id: "https://commonfabric.org/schemas/vnode.json",
    $ref: "#/$defs/VNode",
    $defs: {
      UIRenderable: {
        type: "object",
        properties: {
          $UI: {
            $ref: "#/$defs/VNode",
          },
        },
        required: ["$UI"],
      },
      VNode: {
        type: "object",
        properties: {
          type: {
            type: "string",
            "enum": ["vnode"],
          },
          name: {
            type: "string",
          },
          props: {
            $ref: "#/$defs/Props",
          },
          children: {
            $ref: "#/$defs/RenderNode",
          },
          $UI: {
            $ref: "#/$defs/VNode",
          },
        },
        required: ["type", "name", "props"],
      },
      RenderNode: {
        anyOf: [{
          type: "string",
        }, {
          type: "number",
        }, {
          type: "boolean",
        }, {
          $ref: "#/$defs/VNode",
        }, {
          type: "object",
          properties: {},
        }, {
          $ref: "#/$defs/UIRenderable",
        }, {
          type: "object",
          properties: {},
        }, {
          type: "array",
          items: {
            $ref: "#/$defs/RenderNode",
          },
        }, {
          type: "null",
        }, {
          type: "undefined",
        }],
      },
      Props: {
        type: "object",
        properties: {
          style: { anyOf: [{ type: "object" }, { type: "string" }] },
        },
        additionalProperties: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "number",
            },
            {
              type: "boolean",
            },
            {
              type: "object",
              properties: {}, // stop query from descending
            },
            {
              type: "array",
              items: { type: "null" }, // stop query from descending
            }, // this was generated, but is a bit problematic to have
            //    both cell and stream, since both will always match.
            {
              asCell: ["cell"],
            },
            {
              asCell: ["stream"],
            },
            {
              type: "null",
            },
            {
              type: "undefined",
            },
          ],
        },
      },
    },
  },
  true,
);

export const nameSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: { [NAME]: { type: "string" } },
    required: [NAME],
  },
  true,
);

export type NameSchema = Schema<typeof nameSchema>;

export const uiSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: { [UI]: rendererVDOMSchema },
    required: [UI],
  },
  true,
);

export type UISchema = Schema<typeof uiSchema>;

// We specify type unknown for the items, since we don't want to recursively
// load them
export const pieceListSchema = toDeepFrozenSchema(
  {
    type: "array",
    items: { type: "unknown", asCell: ["cell"] },
    default: [],
  },
  true,
);

export const pieceLineageSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      piece: { type: "object", properties: {}, asCell: ["cell"] },
      relation: { type: "string" },
      timestamp: { type: "number" },
    },
    required: ["piece", "relation", "timestamp"],
  },
  true,
);
export type PieceLineage = Schema<typeof pieceLineageSchema>;

export const pieceSourceCellSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      [TYPE]: { type: "string" },
      spell: { type: "object" },
      lineage: {
        type: "array",
        items: pieceLineageSchema,
        default: [],
      },
      llmRequestId: { type: "string" },
    },
  },
  true,
);

export const processSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      argument: { type: "object" },
      [TYPE]: { type: "string" },
      spell: { type: "object" },
    },
    required: [TYPE],
  },
  true,
);

// Primitive schemas for UI component cell bindings
export const stringSchema = toDeepFrozenSchema(
  { type: "string" },
  true,
);
export const booleanSchema = toDeepFrozenSchema(
  { type: "boolean" },
  true,
);
export const numberSchema = toDeepFrozenSchema(
  { type: "number" },
  true,
);
export const stringArraySchema = toDeepFrozenSchema(
  {
    type: "array",
    items: { type: "string" },
  },
  true,
);
