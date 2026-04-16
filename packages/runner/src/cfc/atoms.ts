import type { ImmutableJSONValue } from "@commonfabric/api";

export type CfcAtom = ImmutableJSONValue;

export const CFC_ATOM_TYPE = {
  Resource: "https://commonfabric.org/cfc/atom/Resource",
  Caveat: "https://commonfabric.org/cfc/atom/Caveat",
} as const;

export const CFC_RUNTIME_SUBJECT = "did:web:commonfabric.org#runtime";

export const cfcAtom = {
  resource(
    className: string,
    subject: string = CFC_RUNTIME_SUBJECT,
    scope?: CfcAtom,
  ): CfcAtom {
    return {
      type: CFC_ATOM_TYPE.Resource,
      class: className,
      subject,
      ...(scope === undefined ? {} : { scope }),
    };
  },
  caveat(kind: string, source: CfcAtom, by?: CfcAtom): CfcAtom {
    return {
      type: CFC_ATOM_TYPE.Caveat,
      kind,
      source,
      ...(by === undefined ? {} : { by }),
    };
  },
} as const;
