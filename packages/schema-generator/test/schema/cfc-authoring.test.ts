import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: CFC authoring aliases", () => {
  it("lowers Classified and OpaqueInput through the canonical Cfc carrier", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Classified<T, X extends readonly string[]> = Cfc<T, { classification: X }>;
      type OpaqueInput<T, Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true> = Cfc<T, { opaque: Spec }>;
      type ProjectionPath<T, From extends string, Path extends readonly string[]> = Cfc<T, { projection: { from: From; path: Path } }>;
      type ProjectionOf<Root, PathTuple extends readonly string[]> = ProjectionPath<Root, "/", PathTuple>;
      type Ref<Root, Path extends readonly string[]> = {
        readonly __ct_ref_root__?: Root;
        readonly __ct_ref_path__?: Path;
      };
      type Projection<SourceRef> = SourceRef extends Ref<
        infer Root,
        infer Path extends readonly string[]
      > ? ProjectionOf<Root, Path> : never;

      interface SchemaRoot {
        secret: Classified<string, readonly ["secret"]>;
        token: OpaqueInput<string>;
        projectionOf: ProjectionOf<{ title: string }, readonly ["title"]>;
        projectionPath: ProjectionPath<{ title: string }, "/source", readonly ["nested", "path"]>;
        projection: Projection<Ref<{ title: string }, readonly ["nested", "path"]>>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const secret = schema.properties?.secret as any;
    expect(secret.type).toBe("string");
    expect(secret.ifc?.classification).toEqual(["secret"]);

    const token = schema.properties?.token as any;
    expect(token.type).toBe("string");
    expect(token.ifc?.opaque).toBe(true);

    const projectionOf = schema.properties?.projectionOf as any;
    expect(projectionOf.type).toBe("object");
    expect(projectionOf.properties?.title?.type).toBe("string");
    expect(projectionOf.ifc?.projection).toEqual({
      from: "/",
      path: "/title",
    });

    const projectionPath = schema.properties?.projectionPath as any;
    expect(projectionPath.type).toBe("object");
    expect(projectionPath.properties?.title?.type).toBe("string");
    expect(projectionPath.ifc?.projection).toEqual({
      from: "/source",
      path: "/nested/path",
    });

    const projection = schema.properties?.projection as any;
    expect(projection.type).toBe("object");
    expect(projection.properties?.title?.type).toBe("string");
    expect(projection.ifc?.projection).toEqual({
      from: "/",
      path: "/nested/path",
    });
  });

  it("expands nested aliases before lowering canonical Cfc metadata", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Classified<T, X extends readonly string[]> = Cfc<T, { classification: X }>;
      type SecretText<T> = Classified<T, readonly ["secret"]>;

      interface SchemaRoot {
        secret: SecretText<{ value: string }>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const secret = schema.properties?.secret as any;
    expect(secret.type).toBe("object");
    expect(secret.properties?.value?.type).toBe("string");
    expect(secret.ifc?.classification).toEqual(["secret"]);
  });

  it("lowers the remaining canonical metadata aliases and merges nested Cfc metadata", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Classified<T, X extends readonly string[]> = Cfc<T, { classification: X }>;
      type Integrity<T, X extends readonly string[]> = Cfc<T, { integrity: X }>;
      type AddIntegrity<T, X extends readonly string[]> = Cfc<T, { addIntegrity: X }>;
      type RequiresIntegrity<T, X extends readonly string[]> = Cfc<T, { requiredIntegrity: X }>;
      type MaxConfidentiality<T, X extends readonly string[]> = Cfc<T, { maxConfidentiality: X }>;
      type ExactCopy<T, P extends string> = Cfc<T, { exactCopyOf: P }>;
      type LengthPreservedFrom<T, P extends string> = Cfc<T, { collection: { sourceCollection: P; lengthPreserved: true } }>;
      type FilteredFrom<T, P extends string> = Cfc<T, { collection: { filteredFrom: P } }>;
      type SubsetOf<T, P extends string> = Cfc<T, { collection: { subsetOf: P } }>;
      type PermutationOf<T, P extends string> = Cfc<T, { collection: { permutationOf: P } }>;
      type OpaqueInput<T, Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true> = Cfc<T, { opaque: Spec }>;

      interface SchemaRoot {
        classified: Classified<string, readonly ["classified"]>;
        integrity: Integrity<string, readonly ["integrity"]>;
        addIntegrity: AddIntegrity<string, readonly ["add-integrity"]>;
        requiresIntegrity: RequiresIntegrity<string, readonly ["required-integrity"]>;
        maxConfidentiality: MaxConfidentiality<string, readonly ["max-confidentiality"]>;
        exactCopy: ExactCopy<string, "/source">;
        lengthPreserved: LengthPreservedFrom<string[], "/collection">;
        filteredFrom: FilteredFrom<string[], "/filtered">;
        subsetOf: SubsetOf<string[], "/subset">;
        permutationOf: PermutationOf<string[], "/permutation">;
        opaque: OpaqueInput<string, { schema: { type: "string" }; allowPassThrough: false }>;
        merged: Cfc<Classified<{ value: string }, readonly ["nested"]>, { integrity: readonly ["outer"] }>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    expect((schema.properties?.classified as any).ifc?.classification).toEqual([
      "classified",
    ]);
    expect((schema.properties?.integrity as any).ifc?.integrity).toEqual([
      "integrity",
    ]);
    expect((schema.properties?.addIntegrity as any).ifc?.addIntegrity)
      .toEqual(["add-integrity"]);
    expect((schema.properties?.requiresIntegrity as any).ifc?.requiredIntegrity)
      .toEqual(["required-integrity"]);
    expect((schema.properties?.maxConfidentiality as any).ifc?.maxConfidentiality)
      .toEqual(["max-confidentiality"]);
    expect((schema.properties?.exactCopy as any).ifc?.exactCopyOf)
      .toBe("/source");
    expect((schema.properties?.lengthPreserved as any).ifc?.collection).toEqual({
      sourceCollection: "/collection",
      lengthPreserved: true,
    });
    expect((schema.properties?.filteredFrom as any).ifc?.collection).toEqual({
      filteredFrom: "/filtered",
    });
    expect((schema.properties?.subsetOf as any).ifc?.collection).toEqual({
      subsetOf: "/subset",
    });
    expect((schema.properties?.permutationOf as any).ifc?.collection).toEqual({
      permutationOf: "/permutation",
    });
    expect((schema.properties?.opaque as any).ifc?.opaque).toEqual({
      schema: { type: "string" },
      allowPassThrough: false,
    });
    expect((schema.properties?.merged as any).ifc?.classification).toEqual([
      "nested",
    ]);
    expect((schema.properties?.merged as any).ifc?.integrity).toEqual([
      "outer",
    ]);
    expect((schema.properties?.merged as any).properties?.value?.type).toBe(
      "string",
    );
  });
});
