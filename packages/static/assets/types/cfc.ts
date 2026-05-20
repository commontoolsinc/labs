/**
 * Declaration-only mirror of `packages/api/cfc.ts` for the in-memory pattern
 * compiler. This file must not emit runtime JavaScript.
 */

export type Cfc<T, Meta> = T & {
  readonly __ct_cfc__?: Meta;
};

export declare const CFC_CANONICAL_ALIAS_NAMES: readonly [
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
  "ExactCopy",
  "ProjectionPath",
  "ProjectionOf",
  "Projection",
  "LengthPreservedFrom",
  "FilteredFrom",
  "SubsetOf",
  "PermutationOf",
];

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
