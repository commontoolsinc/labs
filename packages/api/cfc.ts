/**
 * Canonical CFC authoring surface.
 *
 * These aliases are compile-time carriers only. They preserve the authored
 * runtime value shape while providing a stable namespace for schema lowering
 * and diagnostics in downstream packages.
 */

export type Cfc<T, Meta> = T & {
  readonly __ct_cfc__?: Meta;
};

export type CfcJsonValue =
  | null
  | boolean
  | number
  | string
  | CfcJsonArray
  | CfcAtomObject;

export interface CfcJsonArray extends ReadonlyArray<CfcJsonValue> {}

export interface CfcAtomObject extends Readonly<Record<string, CfcJsonValue>> {}

export type CfcAtom = CfcJsonValue;

export const CFC_ATOM_TYPE = {
  Builtin: "https://commonfabric.org/cfc/atom/Builtin",
  Caveat: "https://commonfabric.org/cfc/atom/Caveat",
  // Runtime-minted external-ingest provenance: this value arrived through a
  // vouched ingest channel (an owner-granted, revocable append authority held
  // by an outside service). Mirrors `UserSurfaceInput` — human input gets its
  // own origin class; external input is just another origin. Evidence, not
  // authorable in schemas: the *channel* is vouched, the *contents* are not.
  ExternalIngest: "https://commonfabric.org/cfc/atom/ExternalIngest",
  InjectionSafe: "https://commonfabric.org/cfc/atom/InjectionSafe",
  LinkReference: "https://commonfabric.org/cfc/atom/LinkReference",
  Origin: "https://commonfabric.org/cfc/atom/Origin",
  // Hereditary certification (spec §15.1.1 / §3.1.6.1): survives combination
  // via the class-aware meet — present on an output only when present on
  // every input.
  PolicyCertified: "https://commonfabric.org/cfc/atom/PolicyCertified",
  PromptSlotBound: "https://commonfabric.org/cfc/atom/PromptSlotBound",
  PromptSlotInfluence: "https://commonfabric.org/cfc/atom/PromptSlotInfluence",
  Resource: "https://commonfabric.org/cfc/atom/Resource",
  // Runtime-minted derivation provenance (spec §8.9.3): which implementation
  // produced this value. Evidence — not authorable in schemas.
  TransformedBy: "https://commonfabric.org/cfc/atom/TransformedBy",
  UserSurfaceInput: "https://commonfabric.org/cfc/atom/UserSurfaceInput",
} as const;

export const CFC_RUNTIME_SUBJECT = "did:web:commonfabric.org#runtime";

/**
 * Compile-cache attestation atoms. String-shaped (not a `CFC_ATOM_TYPE`
 * record) so the cache's label checks stay plain string comparisons. The
 * prefix is the runtime-minted evidence family: prepare's
 * `gateRuntimeMintedIntegrity` strips any `cf-compiled-by:` atom from a write
 * not authored by a trusted builtin, so pattern-authored schemas cannot mint
 * one (audit S4 posture).
 */
export const CFC_COMPILED_BY_ATOM_PREFIX = "cf-compiled-by:" as const;

/**
 * The single attestation stamped on compile-cache docs: the doc was emitted by
 * the system compiler. Deliberately NOT bound to a user identity — the atom
 * attests to the code that produced the doc, not to who ran it, so a shared
 * space's compile cache is readable by every member. The hard (cryptographic)
 * guarantee lands when compilation becomes server-only and the server attaches
 * real attestation data; until then minting is gated to builtin-authored
 * writes (see prefix doc above).
 */
export const CFC_COMPILED_BY_ATOM = "cf-compiled-by:cf-compiler" as const;

export const CFC_CONCEPT_KIND = {
  PromptInfluence: "https://commonfabric.org/cfc/concepts/prompt-influence",
  PromptInjectionRiskUnscreened:
    "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
} as const;

export const CFC_FUSE_ATOM_CLASS = {
  ProjectionMetadataIncomplete: "CommonFabricFuseProjectionMetadataIncomplete",
  SymlinkTarget: "CommonFabricFuseSymlinkTarget",
  TopologyObservation: "FilesystemTopologyObservation",
} as const;

export type CfcResourceAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.Resource;
  readonly class: string;
  readonly subject: string;
  readonly scope?: CfcAtom;
};

export type CfcCaveatAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.Caveat;
  readonly kind: string;
  readonly source: CfcAtom;
  readonly by?: CfcAtom;
};

export type CfcBuiltinAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.Builtin;
  readonly name: string;
};

export type CfcInjectionSafeAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.InjectionSafe;
};

export type CfcUserSurfaceInputAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.UserSurfaceInput;
  readonly user: string;
  readonly surface: string;
  readonly valueDigest: string;
};

export type CfcExternalIngestAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.ExternalIngest;
  // The ingest channel this value arrived through (a vouched, revocable append
  // grant). Carried by the channel's own space, so this identifies the grant.
  readonly channel: string;
  // The presenter the grant was vouched to (the external service's DID).
  // Recorded for audit/display; NOT enforced here (audience-binding is the
  // federation PR5 dependency — see proposal).
  readonly audience: string;
  // When the operator runtime received the payload (ISO 8601).
  readonly receivedAt: string;
  // Digest of the payload bytes the mark is stamped on. The mark derives only
  // from verified channel metadata plus this digest of the written value —
  // never from attacker-controlled label atoms (the split-mint invariant).
  readonly valueDigest: string;
};

export type CfcPromptSlotBoundAtom<
  Source extends CfcAtom = CfcAtom,
  Role extends string = string,
> = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.PromptSlotBound;
  readonly source: Source;
  readonly role: Role;
  readonly kernelName: string;
  readonly surface: string;
  readonly subject?: string;
  readonly renderRef?: CfcAtom;
  readonly eventId?: string;
  readonly valueDigest?: string;
  readonly slotDigest?: string;
  readonly snapshotDigest?: string;
  readonly targetPath?: string;
};

export type CfcPromptSlotRunManifest = CfcAtomObject & {
  readonly source?: string;
  readonly wishId?: string;
  readonly dispatchClass?: string;
};

export type CfcPromptSlotInfluenceAtom<Role extends string = string> =
  & CfcAtomObject
  & {
    readonly type: typeof CFC_ATOM_TYPE.PromptSlotInfluence;
    readonly version: 1;
    readonly role: Role;
    readonly kernelName: string;
    readonly surface: string;
    readonly subject?: string;
    readonly eventId?: string;
    readonly valueDigest?: string;
    readonly slotDigest?: string;
    readonly snapshotDigest?: string;
    readonly targetPath?: string;
    readonly runManifest?: CfcPromptSlotRunManifest;
  };

export const cfcAtom = {
  resource(
    className: string,
    subject: string = CFC_RUNTIME_SUBJECT,
    scope?: CfcAtom,
  ): CfcResourceAtom {
    return {
      type: CFC_ATOM_TYPE.Resource,
      class: className,
      subject,
      ...(scope === undefined ? {} : { scope }),
    };
  },

  caveat(kind: string, source: CfcAtom, by?: CfcAtom): CfcCaveatAtom {
    return {
      type: CFC_ATOM_TYPE.Caveat,
      kind,
      source,
      ...(by === undefined ? {} : { by }),
    };
  },

  builtin(name: string): CfcBuiltinAtom {
    return {
      type: CFC_ATOM_TYPE.Builtin,
      name,
    };
  },

  injectionSafe(): CfcInjectionSafeAtom {
    return {
      type: CFC_ATOM_TYPE.InjectionSafe,
    };
  },

  userSurfaceInput(
    user: string,
    surface: string,
    valueDigest: string,
  ): CfcUserSurfaceInputAtom {
    return {
      type: CFC_ATOM_TYPE.UserSurfaceInput,
      user,
      surface,
      valueDigest,
    };
  },

  externalIngest(
    channel: string,
    audience: string,
    receivedAt: string,
    valueDigest: string,
  ): CfcExternalIngestAtom {
    return {
      type: CFC_ATOM_TYPE.ExternalIngest,
      channel,
      audience,
      receivedAt,
      valueDigest,
    };
  },

  promptSlotBound<Source extends CfcAtom, Role extends string>(
    source: Source,
    role: Role,
    kernelName: string,
    subject: string,
    surface: string,
    valueDigest: string,
  ): CfcPromptSlotBoundAtom<Source, Role> {
    return {
      type: CFC_ATOM_TYPE.PromptSlotBound,
      source,
      role,
      kernelName,
      subject,
      surface,
      valueDigest,
    };
  },
} as const;

export const CFC_CANONICAL_ALIAS_NAMES = [
  "Cfc",
  "Confidential",
  "Integrity",
  "AddIntegrity",
  "RepresentsCurrentUser",
  "AuthoredByCurrentUser",
  "RequiresIntegrity",
  "MaxConfidentiality",
  "OpaqueInput",
  "WriteAuthorizedBy",
  "TrustedActionWriteWithIntegrity",
  "TrustedActionWrite",
  "TrustedActionUiContract",
  "ExactCopy",
  "ProjectionPath",
  "ProjectionOf",
  "Projection",
  "LengthPreservedFrom",
  "FilteredFrom",
  "SubsetOf",
  "PermutationOf",
] as const;

export type CfcCanonicalAliasName = typeof CFC_CANONICAL_ALIAS_NAMES[number];

export type Ref<Root, Path extends readonly string[]> = {
  readonly __ct_ref_root__?: Root;
  readonly __ct_ref_path__?: Path;
};

export type PathValue<Root, Path extends readonly string[]> = unknown;
export type RefValue<SourceRef> = unknown;

type EscapePointerSegment<Segment extends string> = Segment extends
  `${infer Head}~${infer Tail}` ? `${Head}~0${EscapePointerSegment<Tail>}`
  : Segment extends `${infer Head}/${infer Tail}`
    ? `${Head}~1${EscapePointerSegment<Tail>}`
  : Segment;

type JoinPointerPath<Path extends readonly string[]> = Path extends readonly []
  ? ""
  : Path extends readonly [
    infer First extends string,
    ...infer Rest extends readonly string[],
  ] ? `${EscapePointerSegment<First>}${Rest extends readonly [] ? ""
      : `/${JoinPointerPath<Rest>}`}`
  : never;

export type CanonicalPointer<Path extends readonly string[]> = Path extends
  readonly [] ? "/" : `/${JoinPointerPath<Path>}`;

export type Confidential<T, X extends readonly unknown[]> = Cfc<T, {
  confidentiality: X;
}>;

export type Integrity<T, X extends readonly unknown[]> = Cfc<T, {
  integrity: X;
}>;

export type AddIntegrity<T, X extends readonly unknown[]> = Cfc<T, {
  addIntegrity: X;
}>;

export type RepresentsCurrentUser<T> = Cfc<T, {
  addIntegrity: readonly [{
    readonly kind: "represents-principal";
    readonly subject: { readonly __ctCurrentPrincipal: true };
  }];
}>;

export type AuthoredByCurrentUser<T> = Cfc<T, {
  addIntegrity: readonly [{
    readonly kind: "authored-by";
    readonly subject: { readonly __ctCurrentPrincipal: true };
  }];
}>;

export type RequiresIntegrity<T, X extends readonly unknown[]> = Cfc<T, {
  requiredIntegrity: X;
}>;

export type MaxConfidentiality<T, X extends readonly unknown[]> = Cfc<T, {
  maxConfidentiality: X;
}>;

export type ExactCopy<T, P extends readonly string[]> = Cfc<T, {
  exactCopyOf: P;
}>;

export type LengthPreservedFrom<T, P extends readonly string[]> = Cfc<T, {
  collection: {
    sourceCollection: P;
    lengthPreserved: true;
  };
}>;

export type FilteredFrom<T, P extends readonly string[]> = Cfc<T, {
  collection: {
    filteredFrom: P;
  };
}>;

export type SubsetOf<T, P extends readonly string[]> = Cfc<T, {
  collection: {
    subsetOf: P;
  };
}>;

export type PermutationOf<T, P extends readonly string[]> = Cfc<T, {
  collection: {
    permutationOf: P;
  };
}>;

export type OpaqueInput<
  T,
  Spec extends
    | true
    | {
      schema?: unknown;
      allowPassThrough?: boolean;
    } = true,
> = Cfc<T, { opaque: Spec }>;

export type ProjectionPath<
  T,
  From extends string,
  Path extends readonly string[],
> = Cfc<T, {
  projection: {
    from: From;
    path: CanonicalPointer<Path>;
  };
}>;

export type ProjectionOf<
  Root,
  PathTuple extends readonly string[],
> = ProjectionPath<Root, "/", PathTuple>;

export type Projection<SourceRef> = SourceRef extends Ref<
  infer Root,
  infer Path extends readonly string[]
> ? ProjectionOf<Root, Path>
  : never;

export type WriteAuthorizedBy<T, Binding> = Cfc<T, {
  writeAuthorizedBy: Binding;
}>;

export type TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]],
> = Cfc<
  WriteAuthorizedBy<T, Binding>,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;

export type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = TrustedActionWriteWithIntegrity<T, Binding, Action, Pattern, [Pattern]>;

export type TrustedActionUiContract<
  T,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]] = [Pattern],
> = Cfc<
  T,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;
