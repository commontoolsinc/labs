import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { type Cell, isCell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  isPattern,
  type JSONSchema,
  type Pattern,
} from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const FLAT_LINKED_SOURCE = `
  import { pattern, type Writable } from "commonfabric";

  interface Child {
    name: string;
  }

  interface Input {
    items: Writable<Child>[];
  }

  const Sink = pattern((input: Input) => ({ input }));

  export default pattern((input: Input) => ({
    node: Sink(input),
  }));
`;

const PURE_RECURSIVE_SOURCE = `
  import { pattern, type Writable } from "commonfabric";

  interface Folder {
    title: string;
    children?: Writable<Folder>[];
  }

  const Sink = pattern((folder: Writable<Folder>) => ({ folder }));

  export default pattern((folder: Writable<Folder>) => ({
    node: Sink(folder),
  }));
`;

const UNION_SOURCE = `
  import { pattern, type Writable } from "commonfabric";

  interface InlineFolder {
    title: string;
    children?: InlineFolder[];
  }

  interface LinkedFolder {
    title: string;
    children?: Writable<LinkedFolder>[];
  }

  type Input = InlineFolder[] | LinkedFolder;

  const Sink = pattern<Input>((input) => ({ input }));

  export default pattern<Input>((input) => ({
    node: Sink(input),
  }));
`;

type CompiledPattern = {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  nodes: Pattern["nodes"];
};

type SchemaObject = Exclude<JSONSchema, boolean>;
type SchemaAliasInput = {
  $alias: {
    schema: JSONSchema;
  };
};

type RuntimeFolder = {
  children: unknown[];
};

function expectPattern(value: unknown): Pattern {
  if (!isPattern(value)) {
    throw new Error("Expected compiled default export to be a pattern");
  }
  return value;
}

function expectCell<T>(value: unknown): Cell<T> {
  if (!isCell(value)) {
    throw new Error("Expected cell");
  }
  return value as Cell<T>;
}

function expectSchemaObject(schema: JSONSchema): SchemaObject {
  if (typeof schema === "boolean") {
    throw new Error("Expected object schema");
  }
  return schema;
}

function schemaProperty(schema: JSONSchema, property: string): JSONSchema {
  const properties = expectSchemaObject(schema).properties;
  if (!properties || !(property in properties)) {
    throw new Error(`Expected schema property ${property}`);
  }
  return properties[property];
}

function schemaDefinition(schema: JSONSchema, name: string): JSONSchema {
  const definitions = expectSchemaObject(schema).$defs;
  if (!definitions || !(name in definitions)) {
    throw new Error(`Expected schema definition ${name}`);
  }
  return definitions[name];
}

function schemaItems(schema: JSONSchema): JSONSchema {
  const items = expectSchemaObject(schema).items;
  if (items === undefined) {
    throw new Error("Expected array item schema");
  }
  return items;
}

function schemaAsCell(schema: JSONSchema) {
  return expectSchemaObject(schema).asCell;
}

function expectNodeAliasInput(input: unknown): SchemaAliasInput {
  if (
    typeof input !== "object" || input === null ||
    !("$alias" in input) ||
    typeof input.$alias !== "object" || input.$alias === null ||
    !("schema" in input.$alias)
  ) {
    throw new Error("Expected node input alias with schema");
  }
  return input as SchemaAliasInput;
}

function nodeImplementationPattern(pattern: CompiledPattern): Pattern {
  return expectPattern(pattern.nodes[0].module.implementation);
}

describe("compiled pattern node alias schemas", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function compileSource(source: string) {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const { main } = await runtime.harness.compileAndEvaluateModules(program);
    const live = expectPattern(main?.default);
    const serialized = JSON.parse(JSON.stringify(live)) as CompiledPattern;
    return { live, serialized };
  }

  function nodeAliasSchema(pattern: CompiledPattern) {
    return expectNodeAliasInput(pattern.nodes[0].inputs).$alias.schema;
  }

  function linkedFolderArrayItems(schema: JSONSchema) {
    const definitions = expectSchemaObject(schema).$defs;
    if (!definitions) {
      throw new Error("Expected schema definitions");
    }
    const arrayItems = Object.values(definitions).find((definition) => {
      if (typeof definition === "boolean") return false;
      const definitionObject = expectSchemaObject(definition);
      const itemSchema = definitionObject.items;
      return definitionObject.type === "array" &&
        itemSchema !== undefined &&
        typeof itemSchema !== "boolean" &&
        itemSchema.$ref === "#/$defs/LinkedFolder";
    });
    if (!arrayItems) {
      throw new Error("Expected linked folder array schema");
    }
    return expectSchemaObject(arrayItems);
  }

  it("preserves asCell on flat, recursive, and union node aliases", async () => {
    const flat = (await compileSource(FLAT_LINKED_SOURCE)).serialized;
    expect(
      schemaAsCell(schemaItems(schemaProperty(flat.argumentSchema, "items"))),
    ).toEqual(["cell"]);
    expect(
      schemaAsCell(schemaItems(schemaProperty(nodeAliasSchema(flat), "items"))),
    ).toEqual(["cell"]);

    const recursive = (await compileSource(PURE_RECURSIVE_SOURCE)).serialized;
    expect(
      schemaAsCell(
        schemaItems(
          schemaProperty(
            schemaDefinition(recursive.argumentSchema, "Folder"),
            "children",
          ),
        ),
      ),
    ).toEqual(["cell"]);
    expect(
      schemaAsCell(
        schemaItems(
          schemaProperty(
            schemaDefinition(nodeAliasSchema(recursive), "Folder"),
            "children",
          ),
        ),
      ),
    ).toEqual(["cell"]);

    const union = (await compileSource(UNION_SOURCE)).serialized;
    expect(
      schemaAsCell(schemaItems(linkedFolderArrayItems(union.argumentSchema))),
    ).toEqual(["cell"]);
    expect(
      schemaAsCell(schemaItems(linkedFolderArrayItems(nodeAliasSchema(union)))),
    ).toEqual(["cell"]);
  });

  it("reads recursive node arguments shallowly through the alias schema", async () => {
    const { live, serialized } = await compileSource(PURE_RECURSIVE_SOURCE);
    const aliasSchema = nodeAliasSchema(serialized);

    const tx = runtime.edit();
    const root = runtime.getCell<unknown>(
      space,
      "recursive-node-alias-root",
      aliasSchema,
      tx,
    );
    root.set({
      title: "root",
      children: [{ title: "child" }],
    });

    const directRoot = expectCell<RuntimeFolder>(root.get());
    expect(isCell(directRoot.get().children[0])).toBe(true);

    const resultCell = runtime.getCell<unknown>(
      space,
      "recursive-node-alias-result",
      live.resultSchema,
      tx,
    );
    const result = runtime.run(tx, live, root, resultCell);
    await tx.commit();
    await runtime.idle();

    const childArgument = result.key("node").getArgumentCell(
      nodeImplementationPattern(serialized).argumentSchema,
    )!;
    const childRoot = expectCell<RuntimeFolder>(childArgument.get());
    expect(isCell(childRoot.get().children[0])).toBe(true);
  });
});
