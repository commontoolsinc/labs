import { lift } from "@commontools/common-builder";
import { eid } from "./query.js";
import { extractKeysFromZodSchema } from "./schema.js";

export const buildTransactionRequest = (changes: Change[]) => {
  if (!changes) return {};
  return {
    url: `/api/data`,
    options: {
      method: "PATCH",
      body: JSON.stringify(changes),
    },
  };
};

type Change = { Retract: [number, string, any] } | { Assert: [number, string, any] } | { Import: Record<string, any> };

export const prepInsertInner = ({ entity } : { entity: any }) => {
  return {
    changes: [ { Import: entity, } ],
  };
};
export const prepInsertRequest = lift(({ entity }) => {
  const { changes } = prepInsertInner({ entity })
  return buildTransactionRequest(changes);
})

export const prepUpdateInner = ({ eid, attribute, prev, current }: { eid: number, attribute: string, prev: any, current: any }) => {
  return {
    changes: [
      { Retract: [eid, attribute, prev] },
      { Assert: [eid, attribute, current] },
    ] as Change[],
  };
};
export const prepUpdateRequest = lift(({ eid, attribute, prev, current }) => {
  const { changes } = prepUpdateInner({ eid, attribute, prev, current })
  return buildTransactionRequest(changes);
});

export const prepDeleteInner = ({ entity, schema }: { entity: Record<string, any>, schema: any }) => {
  const id = eid(entity);
  const keys = extractKeysFromZodSchema(schema);
  return {
    changes: keys.map((key) => ({
      Retract: [id, key, entity[key]],
    })) as Change[],
  };
};
export const prepDeleteRequest = lift(({ entity, schema }) => {
  const { changes } = prepDeleteInner({ entity, schema })
  return buildTransactionRequest(changes);
});
