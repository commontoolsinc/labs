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
});
