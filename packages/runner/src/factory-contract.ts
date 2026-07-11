import type { JSONSchema } from "@commonfabric/api";

/**
 * Trusted, compiler-emitted call contract for one dynamic factory node.
 *
 * This is graph metadata, not authored input and not part of Factory@1 state.
 * The runner compares it with the trusted artifact's normalized schemas before
 * any implementation code can run.
 */
export type FactoryContract =
  | Readonly<{
    kind: "pattern";
    argumentSchema: JSONSchema;
    resultSchema: JSONSchema;
  }>
  | Readonly<{
    kind: "module";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
  }>
  | Readonly<{
    kind: "handler";
    contextSchema?: JSONSchema;
    eventSchema?: JSONSchema;
  }>;
