import {
  recipe,
  lift,
  RecipeFactory,
  Value,
} from "@commontools/common-builder";
import { streamData } from "@commontools/common-builder";
import * as z from "zod";
import { jsonToDatalogQuery, zodSchemaToPlaceholder } from "./schema.js";

const buildQueryRequest = lift(({ query }) => {
  if (!query) return {};
  return {
    url: `/api/data`,
    options: {
      method: "PUT",
      body: JSON.stringify(query),
    },
  };
});

const schemaToQuery = lift(({ schema }) => {
  return jsonToDatalogQuery(zodSchemaToPlaceholder(schema))
})

const tapStringify = lift(({ result, schema }) => {
  console.groupCollapsed('queryRecipe result');
  console.log(JSON.stringify(schema, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.groupEnd();
})

export function queryRecipe<T extends z.ZodTypeAny>(
  schema: T,
  fn: (input: Value<z.infer<typeof schema>[]>) => Value<any>
): RecipeFactory<z.infer<T>, ReturnType<typeof fn>> {
  return recipe(
    schema,
    (args) => {
      console.log('original args', args)
      const query = schemaToQuery({ schema });
      const { result } = streamData<{ id: string, event: string, data: z.infer<typeof schema>[] }>(buildQueryRequest({ query }));
      tapStringify({ result: result.data, schema })

      return fn(result.data)
    }
  )
}
