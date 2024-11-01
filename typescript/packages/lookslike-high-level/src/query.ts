import {
  recipe,
  lift,
  RecipeFactory,
  Opaque,
  OpaqueRef,
} from "@commontools/common-builder";
import { streamData } from "@commontools/common-builder";
import { addRecipe } from "@commontools/common-runner";
import * as z from "zod";
import { jsonToDatalogQuery, zodSchemaToPlaceholder } from "./schema.js";

export const eid = (e: any) => (e as any)["."];

const buildQueryRequest = lift(({ query }) => {
  if (!query) return {};
  return {
    url: `/api/data`,
    options: {
      method: "PUT",
      body: JSON.stringify(query),
      headers: {
        "content-type": "application/synopsys-query+json",
        accept: "text/event-stream",
      },
    },
  };
});

// export const buildTransactionRequest = lift(({ changes }) => {
//   if (!changes) return {};
//   return {
//     url: `/api/data`,
//     options: {
//       method: "PATCH",
//       body: JSON.stringify(changes),
//     },
//   };
// });

const schemaToQuery = lift(({ schema }) => {
  return jsonToDatalogQuery(zodSchemaToPlaceholder(schema));
});

const tapStringify = lift(({ result, schema, query }) => {
  console.groupCollapsed("queryRecipe result");
  console.log(JSON.stringify(schema, null, 2));
  console.log(JSON.stringify(query, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.groupEnd();
});

export function queryRecipe<T extends z.ZodTypeAny>(
  schema: T,
  fn: (input: Opaque<z.infer<typeof schema>[]>) => Opaque<any>,
): RecipeFactory<z.infer<T>, ReturnType<typeof fn>> {
  return recipe(schema, (args) => {
    console.log("original args", args);
    const query = schemaToQuery({ schema });
    const { result } = streamData<{
      id: string;
      event: string;
      data: z.infer<typeof schema>[];
    }>(buildQueryRequest({ query }));
    tapStringify({ result: result.data, query, schema });

    return fn(result.data);
  });
}

export const schemaQuery = recipe(z.any().describe("schemaQuery"), (schema) => {
  const query = schemaToQuery({ schema });
  const { result } = streamData<{ id: string; event: string; data: any[] }>(
    buildQueryRequest({ query }),
  );
  tapStringify({ result: result.data, query, schema });

  return { result: result.data, query };
}) as <T>(schema: z.ZodType<T>) => {
  result: OpaqueRef<T[]>;
  query: OpaqueRef<any>;
};

export const datalogQuery = recipe(
  z.any().describe("datalogQuery"),
  (query) => {
    const { result } = streamData<{ id: string; event: string; data: any[] }>(
      buildQueryRequest({ query }),
    );
    tapStringify({ result: result.data, query, schema: {} });

    return { result: result.data, query };
  },
) as <T>(schema: z.ZodType<T>) => {
  result: OpaqueRef<T[]>;
  query: OpaqueRef<any>;
};

addRecipe(schemaQuery as RecipeFactory<any, any>);
addRecipe(datalogQuery as RecipeFactory<any, any>);
