import ts from "typescript";
import type { MutableJSONSchema } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";
import type { GenerationContext } from "./interface.ts";

type UiContract = {
  helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
  action?: string;
  surface?: string;
  role?: string;
  kind?: string;
  trustedPattern?: string;
  requiredEventIntegrity?: string[];
};

/**
 * Read the UI contract a caller attached to `typeNode`, falling back to the
 * node the current context is formatting. Synthetic nodes are looked up under
 * their original as well.
 */
export function getUiContractHint(
  context: GenerationContext,
  typeNode: ts.TypeNode | undefined = context.typeNode,
): UiContract | undefined {
  if (!context.schemaHints || !typeNode) {
    return undefined;
  }

  return context.schemaHints.get(typeNode)?.cfcUiContract ??
    context.schemaHints.get(ts.getOriginalNode(typeNode))?.cfcUiContract;
}

/** Emit `uiContract` under the schema's `ifc`, replacing any prior one. */
export function attachUiContract(
  schema: MutableJSONSchema,
  uiContract: UiContract,
): MutableJSONSchema {
  if (typeof schema === "boolean") {
    return schema === false
      ? { not: true, ifc: { uiContract } }
      : { ifc: { uiContract } };
  }

  const existingIfc = isRecord(schema.ifc) ? schema.ifc : {};
  return {
    ...schema,
    ifc: {
      ...existingIfc,
      uiContract,
    },
  };
}
