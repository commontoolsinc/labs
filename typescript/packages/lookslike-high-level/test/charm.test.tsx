import * as z from "zod";
import { describe, expect, it } from "vitest";
import { extractKeysFromZodSchema, jsonToDatalogQuery, zodSchemaToPlaceholder } from "../src/schema.js";
import { view1 } from "../src/sugar.js"
import { Variable } from 'synopsys'
import { h } from '@commontools/common-system'

const schema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email()
});

describe("charm sugar", () => {
  it.only("sdfalskdfskf", () => {
    const x = view1
    console.log(JSON.stringify(x))
    expect(JSON.parse(JSON.stringify(x.select))).toEqual({
      "self": { "?": { "id": 1 } },
      "count": { "?": { "id": 2 } },
    })
    expect(JSON.parse(JSON.stringify(x.where)))
      .toEqual([{ "Case": [{ "?": { "id": 1 } }, "count", { "?": { "id": 2 } }] }])
    const y = view1.update({ count: 2 })
    console.log(JSON.stringify(y))
    expect(y.children[0].children[0].text).toEqual("2")
  })
});
