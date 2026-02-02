# 13. Atom Registry (Appendix)

This appendix catalogs the most common atom types referenced throughout the CFC specification. It is intended as a quick reference for implementers and reviewers; it is not an exhaustive registry. Policies and runtimes MAY introduce additional atom types via the extension mechanism described in [§4.1.2](./04-label-representation.md#412-atom-representation-concrete).

## 13.1 Conventions

- **Kind**: whether an atom is primarily used in confidentiality labels, integrity labels, or both.
- **Schema-time vs label-time**: some atoms (notably policy principals) have an authoring-time form used in schemas/templates and a runtime form used in labels/evidence.
- **Equality**: atoms are compared by structural equality over canonicalized JSON ([§4.1.3](./04-label-representation.md#413-atom-comparison)).

## 13.2 Core Confidentiality Atoms

| Atom type | Kind | Parameters | Notes |
|---|---|---|---|
| `User` | Confidentiality | `subject: DID` | “Readable by this user principal.” |
| `Service` | Confidentiality | `subject: DID` | Service identity principal. |
| `Space` | Confidentiality | `id: SpaceID` | Access is typically derived via exchange rules from `HasRole` integrity ([§4.3.3](./04-label-representation.md#433-atom-patterns-and-variables)). |
| `PersonalSpace` | Confidentiality | `owner: DID` | Convenience form for a per-user space principal. |
| `Resource` | Confidentiality | `class: string`, `subject: DID`, `scope?: unknown` | Classification label for a user/service subject (e.g., “SSN”, “EmailSecret”). |
| `Expires` | Confidentiality | `timestamp: number` | Absolute expiration constraint; satisfiable only if `now ≤ timestamp` ([§4.2.3](./04-label-representation.md#423-expiration-ttl-semantics)). |
| `TTL` | Confidentiality (schema-time only) | `seconds: number` | Schema-time convenience; converted to an `Expires` atom at label creation time ([§4.1.2](./04-label-representation.md#412-atom-representation-concrete)). |
| `Capability` | Confidentiality | `resource: { kind: ... }` | Capability principal (e.g., network egress constraints). |
| `Origin` | Confidentiality | `uri: string`, `fetchedAt: number`, `tlsCertHash?: string` | Origin classification for fetched data. |

## 13.3 Policy / Context Principals

Policy principals are confidentiality atoms whose semantics are defined by policy records.

| Atom type | Kind | Parameters | Notes |
|---|---|---|---|
| `Context` (schema-time) | Confidentiality | `name: string`, `subject: DID` | Authoring-time form without `hash`; used in schemas and templates. |
| `Policy` (schema-time) | Confidentiality | `name: string`, `subject: DID` | Authoring-time form without `hash`; used in schemas and templates. |
| `Context` (label-time) | Confidentiality | `name: string`, `subject: DID`, `hash: string` | Runtime label form; `hash` binds the label to an immutable policy record version ([§4.4.2](./04-label-representation.md#442-policy-references-in-labels)). |
| `Policy` (label-time) | Confidentiality | `name: string`, `subject: DID`, `hash: string` | Runtime label form; `hash` binds the label to an immutable policy record version ([§4.4.2](./04-label-representation.md#442-policy-references-in-labels)). |

## 13.4 Common Integrity Atoms

| Atom type | Kind | Parameters | Notes |
|---|---|---|---|
| `CodeHash` | Integrity | `hash: string` | Identifies trusted runtime / handler / refiner / endorser code. |
| `EndorsedBy` | Integrity | `endorser: DID`, `action?: string` | Generic endorsement fact (e.g., UI runtime, consent UI). |
| `AuthoredBy` | Integrity | `sender: DID`, `messageId?: string` | Provider-origin claim, conditional on trusting the provider. |
| `HasRole` | Integrity | `principal: DID`, `space: SpaceID`, `role: "owner" \| "writer" \| "reader"` | Role membership proof; often used as a guard to derive user access from `Space(...)` ([§4.3.3](./04-label-representation.md#433-atom-patterns-and-variables)). |
| `AuthorizedRequest` | Integrity | `policy: PolicyRefAtom`, `user: DID`, `endpoint: string`, `requestDigest: string`, `codeHash: string` | Endorsement output proving request semantics complied with policy ([§5](./05-policy-architecture.md#5-policy-architecture) and [§7](./07-write-actions.md#7-write-actions)). |
| `NetworkProvenance` | Integrity | `host: string`, `tls: boolean`, `tlsCertHash?: string`, `requestDigest?: string`, `codeHash?: string` | Transport-level provenance minted by the trusted runtime ([§5.6](./05-policy-architecture.md#56-provenance-integrity-fetched-data)). |
| `PolicyCertified` | Integrity | `policyId: string`, `enforcer?: Atom` | Certification that a policy requirement was satisfied ([§5.5](./05-policy-architecture.md#55-policy-certification-integrity)). |

## 13.5 Trust and Environment Atoms

These atoms are commonly used to express trust delegation and environment assumptions ([§4.8](./04-label-representation.md#48-trust-delegation-and-conceptual-binding)):

| Atom type | Kind | Parameters | Notes |
|---|---|---|---|
| `Concept` | Principal | `uri: string` | Conceptual principal used in trust statements ([§4.8.2](./04-label-representation.md#482-trust-statements)). |
| `Verifier` | Principal | `subject: DID`, `scope?: string` | Trusted reviewer identity used in trust statements and delegations ([§4.8.2](./04-label-representation.md#482-trust-statements)). |
| `Runtime` | Principal | `environment: RuntimeEnvironment` | Environment principal describing where code runs; often guarded by attestation ([§4.1.2](./04-label-representation.md#412-atom-representation-concrete)). |
| `Attestation` | Integrity | `attester: DID`, `evidence: AttestationEvidence` | Attestation evidence for a runtime environment ([§4.1.2](./04-label-representation.md#412-atom-representation-concrete)). |

## 13.6 Example / Extension Atoms Referenced in This Spec

The following atom types appear in examples throughout the spec but are typically policy-defined (or introduced as extensions). Implementations MAY treat these as application-specific atoms whose semantics are enforced only at trusted boundaries.

| Atom type | Kind | Parameters (illustrative) | Notes |
|---|---|---|---|
| `UserResource` | Confidentiality | `subject: DID` | Example alternative produced by exchange rules to represent user-owned resources. |
| `DisplayableToUser` | Confidentiality | `subject: DID` | Example alternative permitting UI display under guard. |
| `TrustedProvider` | Integrity | `provider: string` | Trust assumption for provider-origin integrity claims ([§5.6.3](./05-policy-architecture.md#563-provider-origin-claims-optional-conditional)). |
| `AudienceRepresents` | Integrity | `principal: DID`, `audience: string` | Binds an identity principal to a network audience for “return-to-sender” flows ([§1.6](./01-gmail-example.md#16-email-provenance-integrity-sender-authored-claims) and [§7.3.6](./07-write-actions.md#736-derived-data-integrity-and-return-to-sender-release)). |
| `GestureProvenance` | Integrity | `snapshot: string`, `target?: string` | UI gesture provenance fact minted by trusted UI runtime ([§3.8](./03-core-concepts.md#38-ui-backed-integrity-and-gesture-provenance) and [§6](./06-events-and-intents.md#6-events-intents-and-single-use-semantics)). |
| `UIIntent` | Integrity | `action: string`, `user: DID`, `snapshot: string` | Example event integrity fact required by policies for declassification. |
| `IntentRefined` | Integrity | `from: string`, `to: string`, `codeHash: string`, `digest: string` | Binds refined intent to source intent ([§7.2](./07-write-actions.md#72-refinement-pipeline)). |
| `ExtractedAttribute` | Integrity | `kind: string`, `valueDigest: string`, `sourceMessageId: string`, `sourceSender: DID`, `extractorHash: string` | Provenance of trusted extraction from an upstream source ([§7.3.6](./07-write-actions.md#736-derived-data-integrity-and-return-to-sender-release)). |
| `SelectedBy` | Integrity | `user: DID` | Example endorsement that a user selected an item ([§8.5.7](./08-label-transitions.md#857-selection-decision-integrity)). |
| `LinkedBy` | Integrity | `user: DID` | Example endorsement that a link was created by a user ([§3.7.2](./03-core-concepts.md#372-link-integrity-additive-endorsement)). |
| `ForwardedBy` | Integrity | `handler: string` | Example endorsement that a forward action occurred via a specific handler ([§8.15](./08-label-transitions.md#815-modification-authorization-write-authority) example). |

## 13.7 Extension Mechanism (Non-Exhaustive)

Runtimes and policies MAY introduce additional atoms by minting JSON objects of the form:

```json
{ "type": "MyCustomAtom", "...": "..." }
```

Extensions SHOULD:
- use globally unique `type` strings (namespaced if needed),
- define canonicalization rules for hashing/digests when relevant,
- and document intended confidentiality/integrity usage and enforcement points.
