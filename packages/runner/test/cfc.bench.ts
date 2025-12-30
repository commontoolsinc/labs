import { ContextualFlowControl } from "../src/cfc.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const cfc = new ContextualFlowControl();

// Simple flat schema
const simpleSchema: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
  },
};

// Nested schema (3 levels deep)
const nestedSchema: JSONSchema = {
  type: "object",
  properties: {
    user: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
        },
      },
    },
  },
};

// Deeply nested schema (10 levels)
const deeplyNestedSchema: JSONSchema = {
  type: "object",
  properties: {
    l1: {
      type: "object",
      properties: {
        l2: {
          type: "object",
          properties: {
            l3: {
              type: "object",
              properties: {
                l4: {
                  type: "object",
                  properties: {
                    l5: {
                      type: "object",
                      properties: {
                        l6: {
                          type: "object",
                          properties: {
                            l7: {
                              type: "object",
                              properties: {
                                l8: {
                                  type: "object",
                                  properties: {
                                    l9: {
                                      type: "object",
                                      properties: {
                                        value: { type: "string" },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// Schema with $defs and $ref
const schemaWithRefs: JSONSchema = {
  type: "object",
  $defs: {
    Address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zip: { type: "string" },
      },
    },
    Person: {
      type: "object",
      properties: {
        name: { type: "string" },
        address: { $ref: "#/$defs/Address" },
      },
    },
  },
  properties: {
    owner: { $ref: "#/$defs/Person" },
    billing: { $ref: "#/$defs/Address" },
    shipping: { $ref: "#/$defs/Address" },
  },
};

// Schema with nested $refs (ref pointing to ref)
const schemaWithNestedRefs: JSONSchema = {
  type: "object",
  $defs: {
    BaseAddress: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
      },
    },
    USAddress: {
      $ref: "#/$defs/BaseAddress",
      properties: {
        zip: { type: "string" },
      },
    },
    Person: {
      type: "object",
      properties: {
        name: { type: "string" },
        address: { $ref: "#/$defs/USAddress" },
      },
    },
  },
  properties: {
    user: { $ref: "#/$defs/Person" },
  },
};

// Schema with anyOf
const schemaWithAnyOf: JSONSchema = {
  type: "object",
  properties: {
    contact: {
      anyOf: [
        {
          type: "object",
          properties: {
            email: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            phone: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            address: { type: "string" },
          },
        },
      ],
    },
  },
};

// Schema with ifc classifications
const schemaWithIfc: JSONSchema = {
  type: "object",
  properties: {
    public: { type: "string" },
    secret: {
      type: "object",
      ifc: { classification: ["secret"] },
      properties: {
        password: { type: "string" },
        token: { type: "string" },
      },
    },
  },
};

// Array schema
const arraySchema: JSONSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
        },
      },
    },
  },
};

// Complex schema combining multiple features
const complexSchema: JSONSchema = {
  type: "object",
  $defs: {
    Item: {
      type: "object",
      properties: {
        id: { type: "number" },
        data: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            {
              type: "object",
              properties: {
                nested: { type: "string" },
              },
            },
          ],
        },
      },
    },
  },
  properties: {
    metadata: {
      type: "object",
      ifc: { classification: ["confidential"] },
      properties: {
        created: { type: "string" },
        modified: { type: "string" },
      },
    },
    items: {
      type: "array",
      items: { $ref: "#/$defs/Item" },
    },
  },
};

// Benchmarks

Deno.bench("getSchemaAtPath - simple schema, shallow path (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(simpleSchema, ["name"], simpleSchema);
  }
});

Deno.bench("getSchemaAtPath - nested schema, 3-level path (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(nestedSchema, ["user", "profile", "name"], nestedSchema);
  }
});

Deno.bench(
  "getSchemaAtPath - deeply nested schema, 10-level path (10000x)",
  () => {
    const deepPath = [
      "l1",
      "l2",
      "l3",
      "l4",
      "l5",
      "l6",
      "l7",
      "l8",
      "l9",
      "value",
    ];
    for (let i = 0; i < 10000; i++) {
      cfc.getSchemaAtPath(deeplyNestedSchema, deepPath, deeplyNestedSchema);
    }
  },
);

Deno.bench("getSchemaAtPath - schema with $ref (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(schemaWithRefs, ["owner", "address", "city"], schemaWithRefs);
  }
});

Deno.bench("getSchemaAtPath - schema with nested $refs (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(
      schemaWithNestedRefs,
      ["user", "address", "street"],
      schemaWithNestedRefs,
    );
  }
});

Deno.bench("getSchemaAtPath - schema with anyOf (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(schemaWithAnyOf, ["contact", "email"], schemaWithAnyOf);
  }
});

Deno.bench("getSchemaAtPath - schema with ifc classifications (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(schemaWithIfc, ["secret", "password"], schemaWithIfc);
  }
});

Deno.bench("getSchemaAtPath - array schema, element access (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(arraySchema, ["items", "0", "name"], arraySchema);
  }
});

Deno.bench("getSchemaAtPath - complex schema with all features (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(complexSchema, ["items", "0", "data"], complexSchema);
  }
});

// Compare different path lengths on same schema
Deno.bench("getSchemaAtPath - path length 1 (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(nestedSchema, ["user"], nestedSchema);
  }
});

Deno.bench("getSchemaAtPath - path length 2 (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(nestedSchema, ["user", "profile"], nestedSchema);
  }
});

Deno.bench("getSchemaAtPath - path length 3 (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(nestedSchema, ["user", "profile", "name"], nestedSchema);
  }
});

// Multiple $ref resolutions in one path
Deno.bench("getSchemaAtPath - multiple $ref in path (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    // owner -> Person($ref) -> address -> Address($ref) -> city
    cfc.getSchemaAtPath(schemaWithRefs, ["owner", "address", "city"], schemaWithRefs);
  }
});

// Empty path (root schema)
Deno.bench("getSchemaAtPath - empty path / root (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(complexSchema, [], complexSchema);
  }
});

// Non-existent path
Deno.bench("getSchemaAtPath - non-existent path (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(simpleSchema, ["nonexistent", "path"], simpleSchema);
  }
});

// Array index paths
Deno.bench("getSchemaAtPath - array index path (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(arraySchema, ["items", "3"], arraySchema);
  }
});

Deno.bench("getSchemaAtPath - array index then property (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(arraySchema, ["items", "42", "name"], arraySchema);
  }
});

// Array with ifc (to test lub on array elements)
const arrayWithIfcSchema: JSONSchema = {
  type: "object",
  properties: {
    secrets: {
      type: "array",
      ifc: { classification: ["secret"] },
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
      },
    },
  },
};

Deno.bench("getSchemaAtPath - array with ifc, index access (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.getSchemaAtPath(arrayWithIfcSchema, ["secrets", "5", "key"], arrayWithIfcSchema);
  }
});

// Direct lub benchmark
Deno.bench("lub - single classification (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.lub(new Set(["secret"]));
  }
});

Deno.bench("lub - multiple classifications (10000x)", () => {
  for (let i = 0; i < 10000; i++) {
    cfc.lub(new Set(["confidential", "secret"]));
  }
});
