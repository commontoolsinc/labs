/**
 * /!\ Shared between client and runtime threads.
 * /!\ Take care in only importing lightweight types,
 * /!\ interfaces and utilities.
 */

import { JSONSchema, NAME, type Schema, TYPE, UI } from "./shared.ts";

export const vdomSchemaDefs: Record<string, JSONSchema> = {
  VNode: {
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
            { $ref: "#/$defs/VNode", asCell: true },
            { type: "string", asCell: true },
            { type: "number", asCell: true },
            { type: "boolean", asCell: true },
            { type: "array", items: { $ref: "#/$defs/VNode", asCell: true } },
          ],
        },
        asCell: true,
      },
      [UI]: { $ref: "#/$defs/VNode" },
    },
  },
};

export const vdomSchemaNoDefs: JSONSchema = {
  $ref: "#/$defs/VNode",
} as const;

export const vdomSchema: JSONSchema = {
  ...vdomSchemaNoDefs,
  $defs: vdomSchemaDefs,
} as const;

export const nameSchema = {
  type: "object",
  properties: { [NAME]: { type: "string" } },
  required: [NAME],
} as const satisfies JSONSchema;

export type NameSchema = Schema<typeof nameSchema>;

export const uiSchema = {
  type: "object",
  properties: { [UI]: vdomSchema },
  required: [UI],
} as const satisfies JSONSchema;

export type UISchema = Schema<typeof uiSchema>;

// We specify not true for the items, since we don't want to recursively load them
export const charmListSchema = {
  type: "array",
  items: { not: true, asCell: true },
  default: [],
} as const satisfies JSONSchema;

export const charmLineageSchema = {
  type: "object",
  properties: {
    charm: { not: true, asCell: true },
    relation: { type: "string" },
    timestamp: { type: "number" },
  },
  required: ["charm", "relation", "timestamp"],
} as const satisfies JSONSchema;
export type CharmLineage = Schema<typeof charmLineageSchema>;

export const charmSourceCellSchema = {
  type: "object",
  properties: {
    [TYPE]: { type: "string" },
    spell: { type: "object" },
    lineage: {
      type: "array",
      items: charmLineageSchema,
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
