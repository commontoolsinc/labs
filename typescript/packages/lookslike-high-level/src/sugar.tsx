import { z } from "zod";
import { jsonToDatalogQuery, zodSchemaToPlaceholder } from "./schema.js";
import { h, behavior, $, Reference, select } from "@commontools/common-system";

export function query(schema: z.ZodTypeAny) {
  const query = jsonToDatalogQuery(zodSchemaToPlaceholder(schema))

  return {
    render: (fn: any) => {
      return {
        ...query,
        update: fn
      }
    }
  }
}

export const view1 = query(z.object({ id: z.object({}), count: z.number() }))
  .render(({ count, self }: { count: number; self: Reference }) => {
    return (
      <div title={`Clicks ${count}`} entity={self}>
        <div>{count}</div>
        <button onclick="~/on/click">Click me!</button>
      </div>
    );
  });
