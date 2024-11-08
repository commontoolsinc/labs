import * as z from "zod";
import { describe, expect, it } from "vitest";
import { extractKeysFromZodSchema, jsonToDatalogQuery, zodSchemaToPlaceholder } from "../src/schema.js";
import { view1 } from "../src/sugar.js"

const schema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email()
});

function query(schema: z.ZodTypeAny) {
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

describe("charm sugar", () => {
  it.only("sdfalskdfskf", () => {
    const x = view1
    expect(x.select).toEqual({ ".": "?item", "id": {}, "count": "?count" })
    expect(x.where).toEqual([{ "Case": ["?item", "count", "?count"] }])
    const y = view1.update({ count: 2 })
    expect(y.children[0].children[0].text).toEqual("2")
  })
});
