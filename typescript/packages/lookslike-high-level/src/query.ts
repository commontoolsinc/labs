import {
  recipe,
  lift,
  RecipeFactory,
  Opaque,
  OpaqueRef
} from "@commontools/common-builder";
import { streamData } from "@commontools/common-builder";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { jsonToDatalogQuery, jsonSchemaToPlaceholder } from "./schema.js";

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
        accept: "text/event-stream"
      }
    }
  };
});

export const buildTransactionRequest = lift(({ changes }) => {
  if (!changes) return {};
  return {
    url: `/api/data`,
    options: {
      method: "PATCH",
      body: JSON.stringify(changes)
    }
  };
});

const schemaToQuery = lift(({ schema }) => {
  return jsonToDatalogQuery(jsonSchemaToPlaceholder(schema));
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
  fn: (input: Opaque<z.infer<typeof schema>[]>) => Opaque<any>
): RecipeFactory<z.infer<T>, ReturnType<typeof fn>> {
  return recipe(schema, args => {
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

export const jsonSchemaQuery = recipe(
  z.any().describe("jsonSchemaQuery"),
  schema => {
    const query = schemaToQuery({ schema });
    const { result } = streamData<{ id: string; event: string; data: any[] }>(
      buildQueryRequest({ query })
    );
    tapStringify({ result: result.data, query, schema });

    return { result: result.data, query };
  }
) as <T>(schema: any) => OpaqueRef<{
  result: T[];
  query: any;
}>;

export const JsonSchemaFromZod = (schema: z.ZodTypeAny): any => {
  const jsonSchema = zodToJsonSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
};

export const zodSchemaQuery = <T>(schema: z.ZodType<T>) =>
  jsonSchemaQuery(JsonSchemaFromZod(schema)) as OpaqueRef<{
    result: T[];
    query: any;
  }>;

export const datalogQuery = recipe(z.any().describe("datalogQuery"), query => {
  const { result } = streamData<{ id: string; event: string; data: any[] }>(
    buildQueryRequest({ query })
  );
  tapStringify({ result: result.data, query, schema: {} });

  return { result: result.data, query };
}) as <T>(schema: z.ZodType<T>) => {
  result: OpaqueRef<T[]>;
  query: OpaqueRef<any>;
};
