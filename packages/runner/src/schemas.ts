/**
 * /!\ Shared between client and runtime threads.
 * /!\ Take care in only importing lightweight types,
 * /!\ interfaces and utilities.
 */

import { JSONSchema, NAME, type Schema, TYPE, UI } from "./shared.ts";

export const rendererVDOMSchema = {
  $id: "https://commontools.dev/schemas/vdom.json",
  $defs: {
    vdomNode: {
      type: "object",
      properties: {
        type: { type: "string" },
        name: { type: "string" },
        props: {
          type: "object",
          additionalProperties: { asCell: true },
        },
        children: {
          type: "array",
          items: {
            anyOf: [
              { $ref: "#/$defs/vdomNode" },
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
              {
                type: "array",
                items: { $ref: "#/$defs/vdomNode", asCell: true },
              },
            ],
            asCell: true,
          },
          asCell: true,
        },
        [UI]: { $ref: "#/$defs/vdomNode" },
      },
    },
  },
  $ref: "#/$defs/vdomNode",
} as const satisfies JSONSchema;

export const nameSchema = {
  type: "object",
  properties: { [NAME]: { type: "string" } },
  required: [NAME],
} as const satisfies JSONSchema;

export type NameSchema = Schema<typeof nameSchema>;

export const uiSchema = {
  type: "object",
  properties: { [UI]: rendererVDOMSchema },
  required: [UI],
} as const satisfies JSONSchema;

export type UISchema = Schema<typeof uiSchema>;

// We specify not true for the items, since we don't want to recursively load them
export const pieceListSchema = {
  type: "array",
  items: { type: "object", properties: {}, asCell: true },
  default: [],
} as const satisfies JSONSchema;

export const pieceLineageSchema = {
  type: "object",
  properties: {
    piece: { type: "object", properties: {}, asCell: true },
    relation: { type: "string" },
    timestamp: { type: "number" },
  },
  required: ["piece", "relation", "timestamp"],
} as const satisfies JSONSchema;
export type PieceLineage = Schema<typeof pieceLineageSchema>;

export const pieceSourceCellSchema = {
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
} as const satisfies JSONSchema;

export const processSchema = {
  type: "object",
  properties: {
    argument: { type: "object" },
    [TYPE]: { type: "string" },
    spell: { type: "object" },
  },
  required: [TYPE],
} as const satisfies JSONSchema;

// Primitive schemas for UI component cell bindings
export const stringSchema = { type: "string" } as const satisfies JSONSchema;
export const booleanSchema = { type: "boolean" } as const satisfies JSONSchema;
export const numberSchema = { type: "number" } as const satisfies JSONSchema;
export const stringArraySchema = {
  type: "array",
  items: { type: "string" },
} as const satisfies JSONSchema;
