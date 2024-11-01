import * as z from "zod";
import { describe, expect, it } from "vitest";
import { prepDeleteInner, prepInsert, prepInsertInner, prepUpdateInner } from "../src/mutatation.js";
import { eid } from "../src/query.js";

const schema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email()
});

describe("mutations", () => {
  it("should construct basic insert", () => {
    const expected = {
      "changes": [
        {
          "Import": {
            "age": 30,
            "email": "alice@bob.net",
            "name": "Alice Bobbertson",
          },
        },
      ],
    };

    const output = prepInsertInner({ entity: {
      age: 30,
      email: "alice@bob.net",
      name: "Alice Bobbertson"
    } });

    console.log(output);
    expect(output).toMatchObject(expected);
  })

  it("should construct basic update", () => {
    const expected = {
      "changes": [
        {"Retract": [ "bafy", "name", "Alice Bobbertson", ], },
        { "Assert": [ "bafy", "name", "Alice Robertson", ], },
      ],
    };

    const e = {
      ".": "bafy",
      age: 30,
      email: "alice@bob.net",
      name: "Alice Bobbertson"
    }

    const output = prepUpdateInner({ eid: eid(e), attribute: "name", prev: "Alice Bobbertson", current: "Alice Robertson" });

    console.log(output);
    expect(output).toMatchObject(expected);
  })

  it("should construct basic delete", () => {
    const expected = {
      "changes": [
        { "Retract": ["bafy", "age", 30], },
        { "Retract": [ "bafy", "email", "alice@bob.net", ] }
      ],
    };

    const e = {
      ".": "bafy",
      age: 30,
      email: "alice@bob.net",
      name: "Alice Bobbertson"
    }

    const output = prepDeleteInner({ entity: e, schema });

    console.log(output);
    expect(output.changes).toHaveLength(3);
    expect(output.changes).toContainEqual({"Retract": ["bafy", "age", 30]});
    expect(output.changes).toContainEqual({"Retract": ["bafy", "email", "alice@bob.net"]});
    expect(output.changes).toContainEqual({"Retract": ["bafy", "name", "Alice Bobbertson"]});
  })
});
