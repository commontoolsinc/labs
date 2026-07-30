import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

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
  argumentSchema: any;
  resultSchema: any;
  nodes: any[];
};

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
    const live = main!.default;
    const serialized = JSON.parse(JSON.stringify(live)) as CompiledPattern;
    return { live, serialized };
  }

  function nodeAliasSchema(pattern: CompiledPattern) {
    return pattern.nodes[0].inputs.$alias.schema;
  }

  function linkedFolderArrayItems(schema: any) {
    return Object.values(schema.$defs).find((definition: any) =>
      definition?.type === "array" &&
      definition.items?.$ref === "#/$defs/LinkedFolder"
    ) as any;
  }

  it("preserves asCell on flat, recursive, and union node aliases", async () => {
    const flat = (await compileSource(FLAT_LINKED_SOURCE)).serialized;
    expect(
      flat.argumentSchema.properties.items.items.asCell,
    ).toEqual(["cell"]);
    expect(
      nodeAliasSchema(flat).properties.items.items.asCell,
    ).toEqual(["cell"]);

    const recursive = (await compileSource(PURE_RECURSIVE_SOURCE)).serialized;
    expect(
      recursive.argumentSchema.$defs.Folder.properties.children.items.asCell,
    ).toEqual(["cell"]);
    expect(
      nodeAliasSchema(recursive).$defs.Folder.properties.children.items.asCell,
    ).toEqual(["cell"]);

    const union = (await compileSource(UNION_SOURCE)).serialized;
    expect(
      linkedFolderArrayItems(union.argumentSchema).items.asCell,
    ).toEqual(["cell"]);
    expect(
      linkedFolderArrayItems(nodeAliasSchema(union)).items.asCell,
    ).toEqual(["cell"]);
  });

  it("reads recursive node arguments shallowly through the alias schema", async () => {
    const { live, serialized } = await compileSource(PURE_RECURSIVE_SOURCE);
    const aliasSchema = nodeAliasSchema(serialized);

    const tx = runtime.edit();
    const root = runtime.getCell<any>(
      space,
      "recursive-node-alias-root",
      aliasSchema,
      tx,
    );
    root.set({
      title: "root",
      children: [{ title: "child" }],
    });

    const directRoot = root.get();
    expect(isCell(directRoot)).toBe(true);
    expect(isCell(directRoot.get().children[0])).toBe(true);

    const resultCell = runtime.getCell<any>(
      space,
      "recursive-node-alias-result",
      (live as CompiledPattern).resultSchema,
      tx,
    );
    const result = runtime.run(tx, live as any, root, resultCell);
    await tx.commit();
    await runtime.idle();

    const childArgument = result.key("node").getArgumentCell(
      serialized.nodes[0].module.argumentSchema,
    )!;
    const childRoot = childArgument.get();
    expect(isCell(childRoot)).toBe(true);
    expect(isCell(childRoot.get().children[0])).toBe(true);
  });
});
