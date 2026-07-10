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
  // Generic sink-time context minted by trusted boundaries per evaluation
  // (sink name, sink class, field role, purpose — spec §15.4/§8.10.5). Feeds
  // exchange-rule `boundary` guards; never persisted onto values (Epic B).
  BoundaryContext: "https://commonfabric.org/cfc/atom/BoundaryContext",
  Builtin: "https://commonfabric.org/cfc/atom/Builtin",
  Caveat: "https://commonfabric.org/cfc/atom/Caveat",
  // Scoped assessor/verifier judgment for caveat-bearing profiles (spec
  // §15.4): evidence for policy, not global clearance. Trusted-minted.
  CaveatAssessment: "https://commonfabric.org/cfc/atom/CaveatAssessment",
  // Screening evidence for caveat-bearing profiles (spec §15.4/§10.1):
  // ingress-stage evidence claims the source was screened; value-stage
  // evidence binds the exact current value via `valueRef`. Trusted-minted.
  CaveatScreened: "https://commonfabric.org/cfc/atom/CaveatScreened",
  // Conceptual principal (spec §15.5/§4.8.1): names an abstract requirement
  // in trust statements and exchange-rule integrity guards. A guard of this
  // shape is satisfied via the acting principal's trust closure — never by a
  // literal Concept atom in carried integrity.
  Concept: "https://commonfabric.org/cfc/atom/Concept",
  // Trusted evidence that a source-linked disclaimer was attached to content
  // emitted through a sink (spec §15.4). Trusted-minted.
  DisclaimerAttached: "https://commonfabric.org/cfc/atom/DisclaimerAttached",
  // Explicit user acknowledgment bound to a rendered disclosure (spec §15.4).
  // Trusted-minted by the UI runtime.
  DisclosureAcknowledged:
    "https://commonfabric.org/cfc/atom/DisclosureAcknowledged",
  // Trusted disclosure evidence that a caveat-linked warning/notice was
  // rendered for a particular sink (spec §15.4). Trusted-minted.
  DisclosureRendered: "https://commonfabric.org/cfc/atom/DisclosureRendered",
  // Absolute expiration constraint (confidentiality; spec §4.2.3): the clause
  // is satisfiable only while `now <= timestamp`. The one atom family with an
  // entailment ORDER (`atomEntails`): an earlier deadline entails a later one.
  Expires: "https://commonfabric.org/cfc/atom/Expires",
  // Runtime-minted external-ingest provenance: this value arrived through a
  // vouched ingest channel (an owner-granted, revocable append authority held
  // by an outside service). Mirrors `UserSurfaceInput` — human input gets its
  // own origin class; external input is just another origin. Evidence, not
  // authorable in schemas: the *channel* is vouched, the *contents* are not.
  ExternalIngest: "https://commonfabric.org/cfc/atom/ExternalIngest",
  // Role-membership fact (integrity; spec §4.9.3/§15.4) minted by the trusted
  // runtime from verified space membership — the guard that derives user
  // access from `Space(...)` confidentiality via exchange rules.
  HasRole: "https://commonfabric.org/cfc/atom/HasRole",
  InjectionSafe: "https://commonfabric.org/cfc/atom/InjectionSafe",
  LinkReference: "https://commonfabric.org/cfc/atom/LinkReference",
  // Runtime-minted LLM-derivation provenance: these bytes were produced by a
  // model (assistant content, or a tool result entering the dialog
  // transcript). Makes "untrusted model output" EXPLICIT provenance rather
  // than mere absence of integrity, so requiredIntegrity floors fail
  // positively on model-derived values (Epic D1,
  // docs/history/specs/cfc-trusted-agent-tool-integrity.md piece B). Evidence — not
  // authorable in schemas.
  LlmDerived: "https://commonfabric.org/cfc/atom/LlmDerived",
  Origin: "https://commonfabric.org/cfc/atom/Origin",
  // Hereditary certification (spec §15.1.1 / §3.1.6.1): survives combination
  // via the class-aware meet — present on an output only when present on
  // every input.
  PolicyCertified: "https://commonfabric.org/cfc/atom/PolicyCertified",
  // Personal-space principal (confidentiality; spec §15.2): a per-user space,
  // a convenience form for `Space(...)` that names its owner directly. The
  // default display ceiling (§8.10.6) admits `PersonalSpace(actingUser)` by
  // exact match — the acting user is the audience — so it needs no exchange
  // rule, unlike a shared `Space(...)`.
  PersonalSpace: "https://commonfabric.org/cfc/atom/PersonalSpace",
  PromptSlotBound: "https://commonfabric.org/cfc/atom/PromptSlotBound",
  PromptSlotInfluence: "https://commonfabric.org/cfc/atom/PromptSlotInfluence",
  Resource: "https://commonfabric.org/cfc/atom/Resource",
  // Space principal (confidentiality; spec §15.2): access is typically
  // derived via exchange rules from `HasRole` integrity, not satisfied
  // directly.
  Space: "https://commonfabric.org/cfc/atom/Space",
  // Runtime-minted derivation provenance (spec §8.9.3): which implementation
  // produced this value. Evidence — not authorable in schemas.
  TransformedBy: "https://commonfabric.org/cfc/atom/TransformedBy",
  // User principal (confidentiality; spec §15.2): readable by this user.
  User: "https://commonfabric.org/cfc/atom/User",
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
  // The §10.1 screening-gradient risk tiers. A tier upgrade ADDS the
  // higher-tier caveat as an alternative in the same clause (never replaces
  // the lower tier), guarded by `CaveatScreened` evidence whose stage matches:
  // `ingress` evidence for `-ingress-screened`; `value` evidence (with a
  // `valueRef` binding the exact current value) for `-value-screened`.
  PromptInjectionRiskIngressScreened:
    "https://commonfabric.org/cfc/concepts/prompt-injection-risk-ingress-screened",
  PromptInjectionRiskUnscreened:
    "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
  PromptInjectionRiskValueScreened:
    "https://commonfabric.org/cfc/concepts/prompt-injection-risk-value-screened",
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

export type CfcLlmDerivedAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.LlmDerived;
  // The model that produced the bytes, when known. Audit/display metadata —
  // policies match on the atom type, so the default mint omits it to keep
  // the persisted atom canonical across models.
  readonly model?: string;
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

export type CfcUserAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.User;
  readonly subject: string;
};

export type CfcSpaceAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.Space;
  readonly id: string;
};

export type CfcPersonalSpaceAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.PersonalSpace;
  readonly owner: string;
};

export type CfcExpiresAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.Expires;
  readonly timestamp: number;
};

export type CfcHasRoleAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.HasRole;
  readonly principal: string;
  readonly space: string;
  readonly role: "owner" | "writer" | "reader";
};

export type CfcBoundaryContextAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.BoundaryContext;
  readonly key: string;
  readonly value?: string;
  readonly ref?: CfcAtom;
};

export type CfcCaveatScreenedAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.CaveatScreened;
  readonly kind: string;
  readonly source: CfcAtom;
  readonly stage: string;
  readonly detector: CfcAtom;
  readonly verdict: string;
  readonly valueRef?: CfcAtom;
  readonly profileHash?: string;
  readonly screenedAt?: number;
};

export type CfcDisclosureRenderedAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.DisclosureRendered;
  readonly kind: string;
  readonly source: CfcAtom;
  readonly sink: string;
  readonly renderRef: CfcAtom;
  readonly snapshotDigest: string;
  readonly user?: string;
};

export type CfcDisclosureAcknowledgedAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.DisclosureAcknowledged;
  readonly user: string;
  readonly kind: string;
  readonly source: CfcAtom;
  readonly renderRef: CfcAtom;
  readonly snapshotDigest: string;
  readonly sink?: string;
};

export type CfcDisclaimerAttachedAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.DisclaimerAttached;
  readonly sink: string;
  readonly kind: string;
  readonly source: CfcAtom;
  readonly disclaimerDigest: string;
  readonly formatter?: CfcAtom;
};

export type CfcConceptAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.Concept;
  readonly uri: string;
};

export type CfcCaveatAssessmentAtom = CfcAtomObject & {
  readonly type: typeof CFC_ATOM_TYPE.CaveatAssessment;
  readonly kind: string;
  readonly source: CfcAtom;
  readonly assessor: CfcAtom;
  readonly evidenceDigest: string;
  readonly result: "supported" | "rejected";
  readonly sink?: string;
  readonly intentId?: CfcAtom;
  readonly purpose?: string;
  readonly assessedAt?: number;
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

/**
 * Drops explicit-`undefined` entries so minted atoms never carry them: atoms
 * compare by structural equality over canonical JSON (spec §4.1.3), and
 * `{ sink: undefined }` must mint the same record as omitting `sink`.
 */
const pruneOptional = <T extends Record<string, unknown>>(fields: T): T => {
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) pruned[key] = value;
  }
  return pruned as T;
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

  llmDerived(model?: string): CfcLlmDerivedAtom {
    return model === undefined
      ? { type: CFC_ATOM_TYPE.LlmDerived }
      : { type: CFC_ATOM_TYPE.LlmDerived, model };
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

  user(subject: string): CfcUserAtom {
    return { type: CFC_ATOM_TYPE.User, subject };
  },

  space(id: string): CfcSpaceAtom {
    return { type: CFC_ATOM_TYPE.Space, id };
  },

  personalSpace(owner: string): CfcPersonalSpaceAtom {
    return { type: CFC_ATOM_TYPE.PersonalSpace, owner };
  },

  expires(timestamp: number): CfcExpiresAtom {
    return { type: CFC_ATOM_TYPE.Expires, timestamp };
  },

  hasRole(
    principal: string,
    space: string,
    role: "owner" | "writer" | "reader",
  ): CfcHasRoleAtom {
    return { type: CFC_ATOM_TYPE.HasRole, principal, space, role };
  },

  boundaryContext(
    key: string,
    value?: string,
    ref?: CfcAtom,
  ): CfcBoundaryContextAtom {
    return {
      type: CFC_ATOM_TYPE.BoundaryContext,
      key,
      ...(value === undefined ? {} : { value }),
      ...(ref === undefined ? {} : { ref }),
    };
  },

  // The option-object mint helpers spell their field types explicitly rather
  // than `Omit<CfcXAtom, "type">`: the atom types intersect `CfcAtomObject`'s
  // string index signature, and `Omit` over an index-signatured type collapses
  // `keyof` to `string`, silently dropping every literal (required) key.

  caveatScreened(fields: {
    kind: string;
    source: CfcAtom;
    stage: string;
    detector: CfcAtom;
    verdict: string;
    valueRef?: CfcAtom;
    profileHash?: string;
    screenedAt?: number;
  }): CfcCaveatScreenedAtom {
    return { ...pruneOptional(fields), type: CFC_ATOM_TYPE.CaveatScreened };
  },

  disclosureRendered(fields: {
    kind: string;
    source: CfcAtom;
    sink: string;
    renderRef: CfcAtom;
    snapshotDigest: string;
    user?: string;
  }): CfcDisclosureRenderedAtom {
    return { ...pruneOptional(fields), type: CFC_ATOM_TYPE.DisclosureRendered };
  },

  disclosureAcknowledged(fields: {
    user: string;
    kind: string;
    source: CfcAtom;
    renderRef: CfcAtom;
    snapshotDigest: string;
    sink?: string;
  }): CfcDisclosureAcknowledgedAtom {
    return {
      ...pruneOptional(fields),
      type: CFC_ATOM_TYPE.DisclosureAcknowledged,
    };
  },

  disclaimerAttached(fields: {
    sink: string;
    kind: string;
    source: CfcAtom;
    disclaimerDigest: string;
    formatter?: CfcAtom;
  }): CfcDisclaimerAttachedAtom {
    return { ...pruneOptional(fields), type: CFC_ATOM_TYPE.DisclaimerAttached };
  },

  caveatAssessment(fields: {
    kind: string;
    source: CfcAtom;
    assessor: CfcAtom;
    evidenceDigest: string;
    result: "supported" | "rejected";
    sink?: string;
    intentId?: CfcAtom;
    purpose?: string;
    assessedAt?: number;
  }): CfcCaveatAssessmentAtom {
    return { ...pruneOptional(fields), type: CFC_ATOM_TYPE.CaveatAssessment };
  },

  concept(uri: string): CfcConceptAtom {
    return { type: CFC_ATOM_TYPE.Concept, uri };
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
