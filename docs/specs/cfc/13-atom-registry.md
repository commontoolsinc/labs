# 13. Atom Registry (Appendix)

This appendix catalogs the most common atom types referenced throughout the CFC specification. It is intended as a quick reference for implementers and reviewers; it is not an exhaustive registry. Policies and runtimes MAY introduce additional atom types via the extension mechanism described in Section 4.1.2.

## 13.1 Conventions

- **Kind**: whether an atom is primarily used in confidentiality labels, integrity labels, or both.
- **Schema-time vs label-time**: some atoms (notably policy principals) have an authoring-time form used in schemas/templates and a runtime form used in labels/evidence.
- **Equality**: atoms are compared by structural equality over canonicalized JSON (Section 4.1.3).

## 13.2 Core Confidentiality Atoms

| Atom type | Kind | Parameters | Notes |
|---|---|---|---|
| `User` | Confidentiality | `subject: DID` | “Readable by this user principal.” |
| `Service` | Confidentiality | `subject: DID` | Service identity principal. |
| `Space` | Confidentiality | `id: SpaceID` | Access is typically derived via exchange rules from `HasRole` integrity (Section 4.1.3). |
| `PersonalSpace` | Confidentiality | `owner: DID` | Convenience form for a per-user space principal. |
| `Resource` | Confidentiality | `class: string`, `subject: DID`, `scope?: unknown` | Classification label for a user/service subject (e.g., “SSN”, “EmailSecret”). |
| `Expires` | Confidentiality | `timestamp: number` | Absolute expiration constraint; satisfiable only if `now ≤ timestamp` (Section 4.2.3). |
| `TTL` | Confidentiality (schema-time only) | `seconds: number` | Schema-time convenience; converted to an `Expires` atom at label creation time (Section 4.1.2). |
| `Capability` | Confidentiality | `resource: { kind: ... }` | Capability principal (e.g., network egress constraints). |
| `Origin` | Confidentiality | `uri: string`, `fetchedAt: number`, `tlsCertHash?: string` | Origin classification for fetched data. |

## 13.3 Policy / Context Principals

Policy principals are confidentiality atoms whose semantics are defined by policy records.

| Atom type | Kind | Parameters | Notes |
|---|---|---|---|
| `Context` (schema-time) | Confidentiality | `name: string`, `subject: DID` | Authoring-time form without `hash`; used in schemas and templates. |
| `Policy` (schema-time) | Confidentiality | `name: string`, `subject: DID` | Authoring-time form without `hash`; used in schemas and templates. |
| `Context` (label-time) | Confidentiality | `name: string`, `subject: DID`, `hash: string` | Runtime label form; `hash` binds the label to an immutable policy record version (Section 4.4.2). |
| `Policy` (label-time) | Confidentiality | `name: string`, `subject: DID`, `hash: string` | Runtime label form; `hash` binds the label to an immutable policy record version (Section 4.4.2). |

## 13.4 Common Integrity Atoms

| Atom type | Kind | Parameters | Notes |
|---|---|---|---|
| `CodeHash` | Integrity | `hash: string` | Identifies trusted runtime / handler / refiner / endorser code. |
| `EndorsedBy` | Integrity | `endorser: DID`, `action?: string` | Generic endorsement fact (e.g., UI runtime, consent UI). |
| `AuthoredBy` | Integrity | `sender: DID`, `messageId?: string` | Provider-origin claim, conditional on trusting the provider. |
| `HasRole` | Integrity | `principal: DID`, `space: SpaceID`, `role: "owner" \| "writer" \| "reader"` | Role membership proof; often used as a guard to derive user access from `Space(...)` (Section 4.3.3). |
| `AuthorizedRequest` | Integrity | `policy: PolicyRefAtom`, `user: DID`, `endpoint: string`, `requestDigest: string`, `codeHash: string` | Endorsement output proving request semantics complied with policy (Sections 5 and 7). |
| `NetworkProvenance` | Integrity | `host: string`, `tls: boolean`, `tlsCertHash?: string`, `requestDigest?: string`, `codeHash?: string` | Transport-level provenance minted by the trusted runtime (Section 5.6). |
| `PolicyCertified` | Integrity | `policyId: string`, `enforcer?: Atom` | Certification that a policy requirement was satisfied (Section 5.5). |

## 13.5 Extension Mechanism (Non-Exhaustive)

Runtimes and policies MAY introduce additional atoms by minting JSON objects of the form:

```json
{ "type": "MyCustomAtom", "...": "..." }
```

Extensions SHOULD:
- use globally unique `type` strings (namespaced if needed),
- define canonicalization rules for hashing/digests when relevant,
- and document intended confidentiality/integrity usage and enforcement points.

