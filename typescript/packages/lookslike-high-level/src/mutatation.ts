import { lift } from "@commontools/common-builder";
import { extractKeysFromZodSchema } from "./schema.js";
import { eid } from "./query.js";

export const prepInsertInner = ({ entity } : { entity: any }) => {
  return {
    changes: [ { Import: entity, } ],
  };
};
export const prepInsert = lift(prepInsertInner);

export const prepUpdateInner = ({ eid, attribute, prev, current }: { eid: number, attribute: string, prev: any, current: any }) => {
  return {
    changes: [
      { Retract: [eid, attribute, prev] },
      { Assert: [eid, attribute, current] },
    ],
  };
};
export const prepUpdate = lift(prepUpdateInner);

export const prepDeleteInner = ({ entity, schema }: { entity: Record<string, any>, schema: any }) => {
  const id = eid(entity);
  const keys = extractKeysFromZodSchema(schema);
  return {
    changes: keys.map((key) => ({
      Retract: [id, key, entity[key]],
    })),
  };
};
export const prepDelete = lift(prepDeleteInner);
