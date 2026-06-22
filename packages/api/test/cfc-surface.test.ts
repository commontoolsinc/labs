import { assertEquals } from "@std/assert";
import type {
  Cfc as RootCfc,
  TrustedActionUiContract,
  TrustedActionWrite,
  TrustedActionWriteWithIntegrity,
} from "@commonfabric/api";
import { CFC_CANONICAL_ALIAS_NAMES } from "@commonfabric/api";
import type {
  AddIntegrity,
  AuthoredByCurrentUser,
  CanonicalPointer,
  Cfc,
  CfcAtom,
  CfcBuiltinAtom,
  CfcCaveatAtom,
  CfcInjectionSafeAtom,
  CfcPromptSlotBoundAtom,
  CfcPromptSlotInfluenceAtom,
  CfcResourceAtom,
  CfcUserSurfaceInputAtom,
  Confidential,
  ExactCopy,
  FilteredFrom,
  Integrity,
  LengthPreservedFrom,
  MaxConfidentiality,
  OpaqueInput,
  PathValue,
  PermutationOf,
  Projection,
  ProjectionOf,
  ProjectionPath,
  Ref,
  RefValue,
  RepresentsCurrentUser,
  RequiresIntegrity,
  SubsetOf,
  WriteAuthorizedBy,
} from "@commonfabric/api/cfc";
import { cfcAtom } from "@commonfabric/api/cfc";

Deno.test("CFC API surface preserves the authored runtime value shape", () => {
  const aliasNames = CFC_CANONICAL_ALIAS_NAMES;
  const confidential: Confidential<{ title: string }, readonly ["secret"]> = {
    title: "alpha",
  };
  const integrity: Integrity<{ title: string }, readonly ["trusted"]> = {
    title: "beta",
  };
  const addIntegrity: AddIntegrity<{ title: string }, readonly ["added"]> = {
    title: "gamma",
  };
  const representsCurrentUser: RepresentsCurrentUser<{ name: string }> = {
    name: "Ada",
  };
  const authoredByCurrentUser: AuthoredByCurrentUser<{ body: string }> = {
    body: "hello",
  };
  const requiresIntegrity: RequiresIntegrity<
    { title: string },
    readonly ["required"]
  > = {
    title: "delta",
  };
  const maxConfidentiality: MaxConfidentiality<
    { title: string },
    readonly ["secret"]
  > = {
    title: "epsilon",
  };
  const exactCopy: ExactCopy<{ title: string }, readonly ["source", "title"]> =
    {
      title: "zeta",
    };
  const lengthPreserved: LengthPreservedFrom<
    { items: string[] },
    readonly ["source", "items"]
  > = {
    items: [],
  };
  const filtered: FilteredFrom<{ items: string[] }, readonly ["source"]> = {
    items: [],
  };
  const subset: SubsetOf<{ items: string[] }, readonly ["source"]> = {
    items: [],
  };
  const permutation: PermutationOf<{ items: string[] }, readonly ["source"]> = {
    items: [],
  };
  const opaque: OpaqueInput<{ token: string }> = {
    token: "eta",
  };
  const cfcCarrier: Cfc<
    { title: string },
    { confidentiality: readonly ["secret"] }
  > = {
    title: "theta",
  };
  const rootCfcCarrier: RootCfc<
    { title: string },
    { confidentiality: readonly ["secret"] }
  > = {
    title: "theta-root",
  };
  const projectionPath: ProjectionPath<
    { title: string },
    "/",
    readonly ["title"]
  > = {
    title: "iota",
  };
  const projectionOf: ProjectionOf<
    { title: string },
    readonly ["title"]
  > = {
    title: "kappa",
  };
  const ref: Ref<{ title: string }, readonly ["title"]> = {};
  const projection: Projection<typeof ref> = {
    title: "lambda",
  };
  const pointer: CanonicalPointer<readonly ["a/b", "c~d"]> = "/a~1b/c~0d";
  const pathValue: PathValue<{ title: string }, readonly ["title"]> =
    undefined as never;
  const refValue: RefValue<typeof ref> = undefined as never;

  function localBinding() {}
  const writeAuthorizedBy: WriteAuthorizedBy<
    { title: string },
    typeof localBinding
  > = {
    title: "mu",
  };
  const trustedWrite: TrustedActionWrite<
    { title: string },
    typeof localBinding,
    "SaveTitle",
    "TrustedSaveSurface"
  > = {
    title: "nu",
  };
  const trustedWriteWithIntegrity: TrustedActionWriteWithIntegrity<
    { title: string },
    typeof localBinding,
    "SaveTitle",
    "TrustedSaveSurface",
    readonly ["TrustedSaveSurface", "TrustedDisclosureRendered"]
  > = {
    title: "xi",
  };
  const trustedUiContract: TrustedActionUiContract<
    string,
    "SaveTitle",
    "TrustedSaveSurface"
  > = "omicron";
  const resourceAtom: CfcResourceAtom = cfcAtom.resource("Document", "doc:1");
  const caveatAtom: CfcCaveatAtom = cfcAtom.caveat(
    "reviewed",
    resourceAtom,
  );
  const caveatWithByAtom: CfcCaveatAtom = cfcAtom.caveat(
    "approved",
    resourceAtom,
    caveatAtom,
  );
  const builtinAtom: CfcBuiltinAtom = cfcAtom.builtin("current-user");
  const injectionSafeAtom: CfcInjectionSafeAtom = cfcAtom.injectionSafe();
  const userSurfaceInputAtom: CfcUserSurfaceInputAtom = cfcAtom
    .userSurfaceInput("did:user:1", "TrustedSurface", "sha256:abc");
  const promptSlotBoundAtom: CfcPromptSlotBoundAtom<
    CfcResourceAtom,
    "direct-command"
  > = cfcAtom.promptSlotBound(
    resourceAtom,
    "direct-command",
    "agent-kernel-v1",
    "did:user:1",
    "TrustedSurface",
    "sha256:abc",
  );
  const promptSlotInfluenceAtom: CfcPromptSlotInfluenceAtom<"direct-command"> =
    {
      type: "https://commonfabric.org/cfc/atom/PromptSlotInfluence",
      version: 1,
      role: "direct-command",
      kernelName: "agent-kernel-v1",
      surface: "TrustedSurface",
      runManifest: {
        source: "prompt-input",
      },
    };
  const atomValues: CfcAtom[] = [
    resourceAtom,
    caveatAtom,
    caveatWithByAtom,
    builtinAtom,
    injectionSafeAtom,
    userSurfaceInputAtom,
    promptSlotBoundAtom,
    promptSlotInfluenceAtom,
    cfcAtom.caveat("nested", cfcAtom.resource("Nested")),
  ];

  assertEquals(confidential, { title: "alpha" });
  assertEquals(integrity, { title: "beta" });
  assertEquals(addIntegrity, { title: "gamma" });
  assertEquals(representsCurrentUser, { name: "Ada" });
  assertEquals(authoredByCurrentUser, { body: "hello" });
  assertEquals(requiresIntegrity, { title: "delta" });
  assertEquals(maxConfidentiality, { title: "epsilon" });
  assertEquals(exactCopy, { title: "zeta" });
  assertEquals(lengthPreserved, { items: [] });
  assertEquals(filtered, { items: [] });
  assertEquals(subset, { items: [] });
  assertEquals(permutation, { items: [] });
  assertEquals(opaque, { token: "eta" });
  assertEquals(cfcCarrier, { title: "theta" });
  assertEquals(rootCfcCarrier, { title: "theta-root" });
  assertEquals(projectionPath, { title: "iota" });
  assertEquals(projectionOf, { title: "kappa" });
  assertEquals(projection, { title: "lambda" });
  assertEquals(pointer, "/a~1b/c~0d");
  assertEquals(pathValue, undefined);
  assertEquals(refValue, undefined);
  assertEquals(writeAuthorizedBy, { title: "mu" });
  assertEquals(trustedWrite, { title: "nu" });
  assertEquals(trustedWriteWithIntegrity, { title: "xi" });
  assertEquals(trustedUiContract, "omicron");
  assertEquals(caveatWithByAtom.by, caveatAtom);
  assertEquals(atomValues.length, 9);
  assertEquals(aliasNames, [
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
  ]);
});
