import { $, Reference } from "../../common-system/lib/adapter.js";
import { h, Select, select, View } from '@commontools/common-system'

type SchemaType = { [key: string]: { type: 'number' | 'string' | 'boolean' } }

type InferSchemaType<T extends SchemaType> = {
  [K in keyof T]: T[K]['type'] extends 'number' ? number :
  T[K]['type'] extends 'string' ? string :
  T[K]['type'] extends 'boolean' ? boolean :
  never
}
export function createQueryFromSchema<T extends SchemaType>(schema: T) {
  // Build the select object with all properties
  const selectObj = Object.keys(schema).reduce((acc, key) => {
    return { ...acc, [key]: $[key] }
  }, { self: $.self } as const);

  // Create the base select
  let queryBuilder = select(selectObj);

  // Add match for each property
  Object.keys(schema).forEach(key => {
    queryBuilder = queryBuilder.match($.self, key, $[key]);
  });

  return queryBuilder as Select<InferSchemaType<T> & { self: unknown }>;
}

// Helper function to make the schema definition more ergonomic
export const b = {
  object: <T extends SchemaType>(schema: T) => createQueryFromSchema(schema),
  number: () => ({ type: 'number' as const }),
  string: () => ({ type: 'string' as const }),
  boolean: () => ({ type: 'boolean' as const }),
};
