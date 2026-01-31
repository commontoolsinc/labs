# 3. Core Concepts

## 3.1 Label Lattices

CFC tracks two dimensions:

- **Confidentiality**: who may learn a value.
- **Integrity**: what must be trusted to believe a value or a decision.

### 3.1.1 Confidentiality: CNF Structure

Confidentiality labels use **Conjunctive Normal Form (CNF)**—an AND of clauses, where each clause is either a single atom or an OR of atoms.

```typescript
// A clause is a single atom or OR of atoms
type Clause = Atom | Atom[];

// A confidentiality label is AND of clauses
type ConfidentialityLabel = Clause[];
```

**Examples:**

```typescript
// Simple conjunctive label
[User(Alice), GoogleAuth(Alice), Ctx.Email(Alice)]
// Meaning: Alice ∧ GoogleAuth ∧ Email

// With disjunction (after exchange rule adds alternative)
[User(Alice), [GoogleAuth(Alice), UserResource(Alice)], Ctx.Email(Alice)]
// Meaning: Alice ∧ (GoogleAuth ∨ UserResource) ∧ Email
```

**Why CNF:**
- Exchange rules naturally create disjunctions (multiple valid disclosure paths)
- Join (combining data) is simple concatenation of clauses
- No exponential blowup from data combination
- Access check is straightforward: each clause must have a satisfiable alternative

### 3.1.2 Confidentiality Join (Combining Data)

When data is combined, confidentiality labels are joined by **concatenating clauses**:

```typescript
function joinConfidentiality(L1: Clause[], L2: Clause[]): Clause[] {
  return [...L1, ...L2];
}
```

**Example:**

```
L1 = [User(Alice), GoogleAuth(Alice)]
L2 = [User(Bob), Ctx.Email(Bob)]

L1 ⊔ L2 = [User(Alice), GoogleAuth(Alice), User(Bob), Ctx.Email(Bob)]
// Must satisfy ALL four clauses
```

This is more restrictive (conjunction): combining two data sources requires satisfying requirements from both.

### 3.1.3 Exchange Rules Add Alternatives

When an exchange rule fires, it adds an alternative to an existing clause rather than replacing it:

```typescript
// Before exchange rule
[User(Alice), GoogleAuth(Alice)]

// After "GoogleAuth can convert to UserResource" fires
[User(Alice), [GoogleAuth(Alice), UserResource(Alice)]]
// Now EITHER GoogleAuth(Alice) OR UserResource(Alice) satisfies that clause
```

Multiple rules can fire on the same clause:

```typescript
// Two rules applicable
[User(Alice), [GoogleAuth(Alice), UserResource(Alice), DisplayableToUser(Alice)]]
// Any of the three alternatives satisfies the clause
```

**Growth is linear**: in the common case, each exchange rule application adds one alternative to one clause. Some rules may also remove a matched alternative/requirement (e.g., dropping an `Expires(...)` constraint on derived metadata under guard); removals do not introduce blowup.

### 3.1.4 Access Check

A principal can access data if they satisfy **at least one alternative in every clause**:

```typescript
function canAccess(principal: Principal, label: Clause[]): boolean {
  return label.every(clause => {
    const alternatives = Array.isArray(clause) ? clause : [clause];
    return alternatives.some(atom => principal.satisfies(atom));
  });
}
```

See [§4.4.5](./04-label-representation.md#445-exchange-rule-evaluation) for a concrete definition of `Principal` and `principal.satisfies(...)` (including special handling for `Expires`).

### 3.1.5 Dead Alternatives

After some transformations, certain exchange paths become foreclosed (e.g., once precise GPS coordinates influence a selection, the "round to city" declassifier can no longer apply).

Rather than tracking foreclosure explicitly, the system keeps all alternatives. Dead paths simply fail to satisfy at access check time—no valid exchange rule sequence leads to access. Since atoms are content-addressed hashes, storage cost is minimal.

### 3.1.6 Integrity: Simple Conjunction

Integrity labels remain **simple conjunctions** (sets of atoms). Unlike confidentiality, integrity doesn't need disjunction because:

- Integrity represents what IS trusted, not what COULD BE trusted
- Combining data yields the **intersection** (meet) of integrity—only claims true of all inputs
- Endorsement adds integrity without disjunction

```typescript
type IntegrityLabel = Atom[];  // Simple set, no CNF needed
```

**Join for integrity:**

```typescript
function joinIntegrity(I1: Atom[], I2: Atom[]): Atom[] {
  // Intersection: only atoms present in both
  return I1.filter(a => I2.some(b => atomEquals(a, b)));
}
```

### 3.1.7 Complete Label Structure

```typescript
interface Label {
  // CNF: AND of clauses, each clause is atom or OR of atoms
  confidentiality: Clause[];

  // Simple conjunction
  integrity: Atom[];
}

// Join operation
function joinLabels(L1: Label, L2: Label): Label {
  return {
    confidentiality: [...L1.confidentiality, ...L2.confidentiality],
    integrity: intersect(L1.integrity, L2.integrity)
  };
}
```

---

## 3.2 Confidentiality Atoms

Confidentiality atoms may represent:

- **Principals**: `User(Alice)`, `Sender(Bob)`
- **Resource classes**: `EmailSecret(Alice, participants)`
- **Policy principals**: atoms whose semantics are defined by a policy record
- **Temporal constraints**: `Expires(timestamp)` - data becomes inaccessible after this time

Policies are treated as principals to allow them to propagate naturally through the lattice. They are interpreted only at trusted boundary points.

**Expiration as confidentiality**: Time-based access restrictions are expressed as `Expires(t)` atoms in the confidentiality label. When data is combined, expiration atoms concatenate like other clauses—the result expires at the earliest time (most restrictive). At access check time, if any `Expires(t)` atom has `t < now`, the clause cannot be satisfied.

Example:

```
S = { User(Alice), GoogleAuth(Alice) }
```

---

## 3.3 Integrity Atoms and Facts

Integrity tracks justification rather than secrecy. Integrity atoms include:

- **Code identity**: cryptographic hash of the executing component
- **Event provenance**: user intent events
- **Endorsements**: proofs about request structure or validation

Three broad classes of integrity claims are distinguished:

1. **Absence-of-badness integrity**
   - Asserts that no undesired behavior was introduced
   - Example: sanitizers, validators
   - Does not automatically justify control-flow decisions

2. **Semantic correctness integrity**
   - Asserts correctness of a transformation
   - Example: unit conversions, resolution reduction
   - May preserve or refine upstream integrity claims

3. **Endorsement integrity**
   - Asserts a relationship, selection, or annotation without transforming the underlying data
   - Example: user selection, link creation, tagging
   - **Additive at creation**: endorsing data adds new integrity atoms without removing existing ones
   - Does not weaken the integrity of the endorsed data; instead, it adds provenance about the endorsement itself

**Important**: All integrity classes use **intersection** when combining data. "Additive" describes what happens when creating an endorsement (atoms are added), not when joining data flows. If inputs A and B are combined, the output only has integrity atoms present in *both*—this applies equally to all three classes.

The distinction matters for understanding how integrity is minted:
- Transformation integrity (classes 1-2) typically replaces upstream integrity with a new claim
- Endorsement integrity (class 3) adds facts alongside existing integrity

Integrity facts are minted only by trusted code and are non-malleable.

**Policy certification integrity**: A special class of integrity atom attests that data was produced under a specific policy regime being enforced. For example, `PolicyCertified(ApprovedModels)` indicates the output was computed while a policy restricting ML model usage was in effect. See [§5.5](./05-policy-architecture.md#55-policy-certification-integrity) for details.

**Write authorization (modifications)**: Modifying stored state is authorized by a field-level **write-authority set** derived from handlers that declare `writes: true`. This is an access-control capability (“who may write”), not value integrity (“what may be believed”). See [§8.15](./08-label-transitions.md#815-modification-authorization-write-authority) for the full model.

---

## 3.4 Control (PC) Integrity

In addition to data integrity, the system tracks **control integrity** (PC integrity):

> What must be trusted to believe that this control path or side effect occurred.

In an FRP system, PC integrity arises from:

- gating (`filter`),
- selection (`switch`),
- sampling and timing,
- triggering side effects.

This specification minimizes broad PC propagation by relying on **consumable intents** as the primary authorization mechanism for one-shot side effects. Minimal control-integrity constraints remain for:

- minting intents from UI gestures,
- policy-state transitions.

---

## 3.5 Context Principals

A **context principal** is a confidentiality atom representing a social or functional context. Context principals map directly to Contextual Integrity (CI) contexts.

Examples:

- `Ctx.Email(Alice)` – Alice's email communication context
- `Ctx.Search(Alice)` – Alice's search context
- `Ctx.Documents(TeamX)` – a collaborative document context

In CFC, contexts *are* policies:

- A context principal identifies which norms apply
- A **policy record** defines those norms as concrete exchange rules

A context principal's policy record specifies:

1. Allowed egress paths (where information may flow from this context)
2. Endorsement rules (what evidence is required to justify a flow)
3. **Transmission principles** as integrity-guarded exchange rules
4. Dependency classification (authority-only vs data-bearing)

Context principals propagate like ordinary confidentiality atoms and are interpreted only at trusted boundary points.

---

## 3.6 Spaces and Role-Based Confidentiality

CFC uses **spaces** as the primary mechanism for confidentiality in collaborative and social contexts. Spaces provide a clean solution to the problem of disjunctive authorization ("any member can view") without complicating the label algebra.

### 3.6.1 Space Principals

Each piece of stored data belongs to exactly one space. The space is represented as a confidentiality principal:

- `Space(id=abc123)`

Data inherits its space from the context in which it is created.

**Note on examples**: Many examples write `User(Alice)` to mean “visible only to Alice.” In a concrete runtime, this is equivalent to placing the data in `PersonalSpace(Alice)` ([§3.6.4](#364-personal-spaces)). Spaces are the general mechanism; `User(·)` is often used as a shorthand in narrative examples.

### 3.6.2 Role Membership

Spaces have dynamic membership organized into roles:

- **owner**: full control, can manage membership and delete the space
- **writer**: can create and modify data in the space
- **reader**: can view data in the space

Role hierarchy: `owner ⊃ writer ⊃ reader` (owners are implicitly writers; writers are implicitly readers).

Membership is stored in the space's policy record and may be updated by owners (or writers, depending on space policy).

### 3.6.3 Role-Based Exchange Rules

Authorization flows through role predicates rather than explicit user enumeration:

```
Space(X) + HasRole(user, X, reader) → display to user
Space(X) + HasRole(user, X, writer) + WriteIntent → write permitted
Space(X) + HasRole(user, X, owner) + AddMemberIntent(newUser, role) → membership change permitted
```

This achieves **disjunctive authorization** without DNF labels: "any reader can view" emerges naturally because the exchange rule fires for any user who holds the reader role. The disjunction lives in role membership, not in the label algebra.

### 3.6.4 Personal Spaces

Each user has an implicit personal space where they are the sole owner:

- `PersonalSpace(Alice)` with `owners: {Alice}, writers: {Alice}, readers: {Alice}`

Personal spaces behave like spaces for role-based checks, but with fixed membership.

Private data defaults to the user's personal space. The user may share by either:
- moving/copying data to a shared space, or
- adding members to their personal space (converting it to a shared space).

### 3.6.5 Adding Members

When a new member is added to a space:
- The space's membership record is updated
- No labels on existing data need to be rewritten
- The new member immediately gains access to all data in the space (per their role)

This avoids the label rewriting problem that would arise if confidentiality were encoded as explicit user sets.

---

## 3.7 Cross-Space Links

The data model supports **links**: references from data in one space to data in another space. Links are the reactive equivalent of copying data without modification.

### 3.7.1 Link Confidentiality (Conjunctive)

A link from data in Space A to data in Space B creates a **conjunctive** confidentiality requirement:

- The link itself lives in Space A
- The target lives in Space B
- Viewing the dereferenced content requires access to **both** spaces

```
Link in Space(A) → target in Space(B)
View requires: HasRole(user, A, reader) ∧ HasRole(user, B, reader)
```

This is the natural interpretation: to see linked content, you must be able to see both the link and the target.

### 3.7.2 Link Integrity (Additive Endorsement)

Creating a link is an **endorsement** that adds integrity facts without transforming the target data:

- Target data has integrity `I_target` (e.g., `{AuthoredBy(hotel@example.com)}`)
- Link creation adds endorsement integrity `I_link` (e.g., `{SelectedBy(Alice), InSpace(A)}`)
- Traversing the link yields data with integrity `I_target ∪ I_link`

The link endorses the target: "Alice selected this item" or "this was referenced from Space A." This is additive—the target's original integrity is preserved and augmented, not diluted.

### 3.7.3 Link Creation Requirements

To create a link from Space A to target in Space B:

- **Write access to A**: the link is data in Space A
- **Read access to B**: the creator must be able to see what they're linking to

The second requirement prevents confused deputy attacks where a user links to data they cannot see, hoping to trick someone with broader access into revealing it.

### 3.7.4 Example: Calendar Referencing a Message

A message thread in `Space(thread-123)` contains "let's meet at 8pm." A calendar component in `PersonalSpace(Alice)` creates a link to this message for context.

- The link lives in Alice's personal space
- The target lives in the thread space
- Viewing the calendar entry with context requires: reader of both spaces
- The calendar entry carries endorsement integrity: `{LinkedBy(Alice), SelectedAt(timestamp)}`
- The message retains its original integrity: `{AuthoredBy(Bob), InThread(123)}`

---

## 3.8 UI-Backed Integrity and Gesture Provenance

This system supports minting high-integrity user intent events from UI interaction. The UI is represented as a labeled VDOM whose nodes may reference labeled data.

### 3.8.1 Labeled VDOM

- A VDOM tree is a pure description of rendered UI.
- Text, attributes, and bound values may reference data `v` that carries confidentiality/integrity labels.
- The runtime maintains a **render snapshot**:
  - `snapshotDigest = H(c14n(vdomTree + boundValueDigests + labelSummaries))`.

Label summaries are policy-defined projections sufficient for later justification (e.g., include confidentiality atoms and selected integrity atoms, but not raw secret values).

Note: Snapshot digests alone could theoretically fingerprint displayed content, but each event carries its own random `nonce` (see [§3.8.2](#382-gesture-events)), so event identity is not predictable from content.

### 3.8.2 Gesture Events

A low-level gesture event is produced by the platform (pointer/keyboard). The trusted UI runtime upgrades this to a high-integrity **UIEvent** only when it can bind the gesture to a concrete rendered element in the current snapshot.

- `UIEvent{ kind, targetNodeId, snapshotDigest, time, nonce, uiRuntimeHash }`

The UI runtime hash (or other trust anchor) is included to justify that the mapping from gesture to VDOM node was performed correctly.

### 3.8.3 Semantic Action Conditions (Declarative)

To avoid trusting arbitrary application code to interpret UI events, the system allows **declarative conditions** that recognize higher-level user actions.

A condition consumes:

- the current VDOM snapshot digest,
- the `UIEvent` (e.g., click on a specific button node),
- and the labeled values referenced by relevant VDOM nodes (e.g., the email being displayed, the recipient input value).

If satisfied, it emits a high-integrity **IntentEvent**:

- `IntentEvent{ action, parameters, evidence, exp, nonce }`

Where:

- `action` is a stable identifier such as `ForwardClicked`.
- `parameters` include references/digests such as `emailId`, `recipientSet`, and other UI state.
- `evidence` includes `snapshotDigest`, `targetNodeId`, and label summaries of the values the user was shown and acted upon.

Conditions are treated as part of the trusted runtime/policy layer (they may be data-driven rather than general code).

### 3.8.4 Standard Condition Library

The runtime provides a standard library of declarative conditions with uniform evidence requirements. Policies and application code should prefer these conditions to bespoke code.

Each condition MUST:

- bind to a specific `snapshotDigest` and `targetNodeId`,
- extract only the minimum necessary parameters from labeled bindings,
- include label summaries for each referenced binding,
- produce parameters in canonical form (see canonicalization rules),
- set a short `exp` to mitigate TOCTOU,
- and emit an integrity fact identifying the condition.

The following conditions are defined.

#### 3.8.4.1 `Cond.ClickAction`

Recognizes a click on a VDOM node annotated with `props.action = <ActionName>`.

Inputs:
- `UIEvent(kind="click")`
- snapshot node metadata for `targetNodeId`

Checks:
- node exists in snapshot
- node has `props.action` and `enabled == true`

Emits:
- `IntentEvent{ action=<ActionName>, parameters={}, evidence={snapshotDigest, targetNodeId}, exp, nonce }`

Use for simple actions that do not depend on other UI state.

#### 3.8.4.2 `Cond.ClickWithBindings`

Recognizes a click action and additionally captures a set of named bindings from the snapshot.

Inputs:
- `UIEvent(kind="click")`
- `bindingSpec = { name -> nodeId + extractor }` (policy-defined)

Checks:
- all referenced nodes exist in snapshot
- extractors are permitted for those node types

Emits:
- `IntentEvent{ action, parameters={ name -> canonicalValue }, evidence={snapshotDigest, targetNodeId, bindingValueDigests, bindingLabelSummaries}, exp, nonce }`

Use for actions such as `ForwardClicked` where parameters come from rendered state.

#### 3.8.4.3 `Cond.FormSubmit`

Recognizes a submit gesture (button click or enter key) for a form scope.

Inputs:
- `UIEvent(kind in {"click","enter"})`
- `formScopeId`

Checks:
- target is within form scope
- form is enabled

Emits:
- `IntentEvent{ action="FormSubmit", parameters={fields...}, evidence={...}, exp, nonce }`

Fields captured are declared by a `formFieldSpec` and must be canonicalized.

#### 3.8.4.4 `Cond.SelectionConfirm`

Recognizes confirmation of a selection (e.g., selecting an email/thread and clicking a confirm button).

Inputs:
- `UIEvent(kind="click")`
- `selectionBinding` (e.g., selected ids)

Checks:
- selection binding exists and is non-empty

Emits:
- `IntentEvent{ action, parameters={selectionSet}, evidence={...}, exp, nonce }`

#### 3.8.4.5 `Cond.ToggleState`

Recognizes a toggle interaction and emits a persistent-state intent event.

Inputs:
- `UIEvent(kind="click")`
- `toggleNodeId`

Checks:
- node exists and is enabled

Emits:
- `IntentEvent{ action="ToggleState", parameters={toggleId, newState}, evidence={...}, exp, nonce }`

Intended for generating events that may drive policy-state transitions when separately authorized.

---

### 3.8.5 Trust and Threat Model Notes

The UI-backed integrity story relies on:

- unforgeability of `UIEvent` and `IntentEvent`,
- protection against UI spoofing/clickjacking within the trusted UI runtime,
- TOCTOU defenses via snapshot digests and expirations,
- binding of intent parameters to what was actually rendered.

---

### 3.8.6 Integrity Requirements for Intent Parameters (Robust Declassification)

Intent parameters that influence declassification decisions must meet policy-defined integrity requirements. This ensures that low-integrity (attacker-influenced) inputs cannot manipulate *what* gets declassified or *where* it flows.

1. **Scope parameters** (e.g., `emailId`, `selectionSet`) identify *what* data is released. These must have high integrity—typically derived from trusted sources or user-controlled state created under high PC integrity. A low-integrity scope parameter would allow an attacker to influence which secrets are released.

2. **Destination parameters** (e.g., `recipientSet`, `audience`) identify *where* data flows. Policies may:
   - require high-integrity destinations (e.g., verified audience bindings via `AudienceRepresents`), or
   - accept user-provided destinations but treat the release as user-attributable (endorsed by user intent rather than system policy).

3. **User-provided low-integrity parameters**: When a policy permits user-provided values (e.g., typed recipient addresses), the resulting flow is attributable to the user's explicit intent, not system policy. Evidence must reflect this distinction, and the user bears responsibility for the release.

The intent refinement step (`refine_intent`) MUST verify that parameters meet policy-defined integrity thresholds before minting a consumable `IntentOnce`. If integrity requirements are not met, refinement fails and no declassification occurs.

This corresponds to the principle of **robust declassification**: the decision to declassify must not be influenceable by low-integrity inputs.

---

### 3.8.7 Transparent Endorsement

Endorsement (upgrading data from low to high integrity) must not depend on confidential data in ways that create covert channels.

**Requirement**: The decision to endorse low-integrity input must not branch on comparisons with high-confidentiality values. Otherwise, an attacker could observe whether endorsement occurred and infer secrets.

Safe endorsement patterns in CFC:

1. **Structural endorsement** (`endorse_request`): Checks request structure (host, method, header placement) without examining secret content.

2. **User-mediated endorsement** (links, intent minting): The user already has access to displayed data before choosing to act. The endorsement reflects user intent, not a secret-dependent branch.

3. **Provenance endorsement** (`AuthoredBy`, network provenance): Derived from trusted transport/parsing, not from matching against secrets.

Unsafe patterns (prohibited):

- Endorsing user input if it matches a secret value
- Conditionally minting integrity facts based on secret comparisons
- Any endorsement decision that reveals secret bits through success/failure

When integrity must depend on content (e.g., signature verification), the verifier must be designed to avoid timing or observable-failure side channels.

This is the dual of robust declassification: **transparent endorsement** ensures that high-confidentiality data cannot influence what gets endorsed.

---

## 3.9 Multi-Party Confidentiality

When data from multiple principals is combined, CFC must handle the resulting conjunctive confidentiality. This section describes how multi-party operations work, using calendar scheduling as a worked example.

### 3.9.1 The Multi-Party Problem

Consider finding meeting times across multiple calendars:

```
Alice's calendar → [intersection computation] → Available slots
Bob's calendar   →                            ↓
Carol's calendar →                         Output visible to all three?
```

**The label problem:**
- Each calendar has `confidentiality: [User(owner)]`
- Computation reads all three → output gets `[User(Alice), User(Bob), User(Carol)]`
- Conjunctive confidentiality means **all three** must authorize access
- But we want the result visible to all three!

### 3.9.2 Solution: Scoped Multi-Party Consent

Each participant provides a **scoped consent intent** that authorizes:
- What data is shared (scope)
- With whom (participants)
- For what purpose (operation)
- What result can be revealed (output constraints)

```typescript
interface MultiPartyConsentIntent {
  // Who is consenting
  participant: DID;

  // What operation is being consented to
  operation: string;  // e.g., "FindMeetingTime"

  // Who may see the results
  sharedWith: DID[];

  // Scope constraints on input data
  inputScope: {
    // Time range to consider
    timeRange: { start: number; end: number };
    // Further constraints
    constraints?: {
      // Only consider future times
      onlyFuture?: boolean;
      // Day-of-week restrictions
      daysOfWeek?: number[];
      // Time-of-day restrictions
      hoursRange?: { start: number; end: number };
    };
  };

  // Constraints on what can be revealed
  outputConstraints: {
    // Maximum number of results to reveal
    maxResults: number;
    // Whether to reveal "no results found"
    allowEmptyResult: boolean;
    // Minimum granularity (e.g., 30 minutes)
    minimumGranularity?: number;
  };

  // Evidence and integrity
  evidence: {
    snapshotDigest: string;
    timestamp: number;
  };

  // Expiration
  exp: number;
}
```

#### 3.9.2.1 How Consent Is Minted

Consent uses the same UI event mechanism as other intents ([§3.8](#38-ui-backed-integrity-and-gesture-provenance)):

1. **UI Display**: The participant views a consent UI showing what data will be shared, with whom, for what purpose, and what constraints apply
2. **UI Event**: The participant clicks "Allow" or equivalent, generating a `UIEvent` with `snapshotDigest` binding to the displayed consent details
3. **Intent Minting**: A semantic condition (e.g., `Cond.ConsentGrant`) upgrades the event to a `MultiPartyConsentIntent`

**Trust requirements**: For the consent to be valid, a verifier trusted by the participant must have:
- **Certified the UI**: Declared the consent UI as clearly and accurately representing what is being consented to
- **Certified the pattern**: Declared the multi-party computation pattern as correctly implementing the consented operation (respecting input scopes, output constraints, etc.)

This is the same trust model as other intents—the participant trusts their verifier, and the verifier certifies both the UI and the implementation.

### 3.9.3 Worked Example: Calendar Intersection

**Scenario:** Alice, Bob, and Carol want to find 3 possible 1-hour meeting slots in the next 2 weeks, during business hours.

**Step 1: Each participant provides consent**

```typescript
// Alice's consent
const aliceConsent: MultiPartyConsentIntent = {
  participant: "did:key:alice",
  operation: "FindMeetingTime",
  sharedWith: ["did:key:alice", "did:key:bob", "did:key:carol"],
  inputScope: {
    timeRange: { start: now, end: now + 14 * DAY },
    constraints: {
      onlyFuture: true,
      hoursRange: { start: 9, end: 17 }
    }
  },
  outputConstraints: {
    maxResults: 3,
    allowEmptyResult: true,
    minimumGranularity: 60  // 1 hour slots
  },
  evidence: { snapshotDigest: "...", timestamp: now },
  exp: now + 1 * HOUR
};
```

Bob and Carol provide equivalent consents with the same `sharedWith` and compatible constraints.

**Step 2: Consent validation**

Before computation proceeds, the runtime verifies:
1. All participants in `sharedWith` have provided consent
2. Consent scopes are compatible (overlapping time ranges, etc.)
3. Output constraints are compatible (take minimum of `maxResults`)
4. All consents are unexpired

```typescript
function validateMultiPartyConsent(
  consents: MultiPartyConsentIntent[]
): { valid: boolean; effectiveScope: EffectiveScope } {
  // All consents must agree on participants
  const participants = new Set(consents.map(c => c.participant));
  for (const consent of consents) {
    const sharedSet = new Set(consent.sharedWith);
    if (!setsEqual(sharedSet, participants)) {
      return { valid: false, error: "participant_mismatch" };
    }
  }

  // Compute effective scope (intersection of input scopes)
  const effectiveTimeRange = intersectTimeRanges(
    consents.map(c => c.inputScope.timeRange)
  );

  // Compute effective output constraints (most restrictive)
  const effectiveMaxResults = Math.min(
    ...consents.map(c => c.outputConstraints.maxResults)
  );

  return {
    valid: true,
    effectiveScope: { timeRange: effectiveTimeRange, maxResults: effectiveMaxResults }
  };
}
```

**Step 3: Computation with scoped access**

The trusted computation component:
1. Reads only data within each participant's consented scope
2. Computes the intersection
3. Returns at most `maxResults` slots

```typescript
async function findMeetingTimes(
  consents: MultiPartyConsentIntent[],
  calendars: Map<DID, Calendar>
): Promise<MeetingSlot[]> {
  const validation = validateMultiPartyConsent(consents);
  if (!validation.valid) throw new Error(validation.error);

  const { effectiveScope } = validation;
  const availableSlots: MeetingSlot[] = [];

  // For each time slot in the effective range
  for (const slot of generateSlots(effectiveScope.timeRange)) {
    // Check if all participants are free
    const allFree = consents.every(consent => {
      const calendar = calendars.get(consent.participant);
      // Only access data within consented scope
      return isAvailable(calendar, slot, consent.inputScope);
    });

    if (allFree) {
      availableSlots.push(slot);
      if (availableSlots.length >= effectiveScope.maxResults) {
        break;  // Respect output constraints
      }
    }
  }

  return availableSlots;
}
```

**Step 4: Output labeling**

The result has special multi-party confidentiality:

```typescript
// Result label
{
  confidentiality: [
    { type: "MultiPartyResult", participants: ["alice", "bob", "carol"] }
  ],
  integrity: [
    { type: "ComputedBy", codeHash: "sha256:findMeetingTimes..." },
    { type: "ConsentedBy", consents: [aliceConsent.id, bobConsent.id, carolConsent.id] }
  ]
}
```

The `MultiPartyResult` atom has a special exchange rule:

```typescript
// Multi-party result exchange rule
{
  preCondition: {
    confidentiality: [{ type: "MultiPartyResult", participants: { var: "P" } }],
    integrity: [{ type: "ConsentedBy", consents: { var: "C" } }]
  },
  postCondition: {
    // Any participant can view
    confidentiality: [{ type: "User", subject: { var: "$actingUser" } }]
  },
  guard: {
    // Acting user must be in the participant list
    condition: "participants.includes($actingUser)"
  }
}
```

### 3.9.4 What Leaks By Design

Multi-party computations intentionally reveal some information. The consent system makes this explicit:

| Revealed Information | Mitigation |
|---------------------|------------|
| "No slots found" = all busy during scope | `allowEmptyResult: false` to suppress |
| 3 specific slots = mutual availability then | Necessary for the feature to work |
| Probing attacks (narrow windows) | Participants must trust each other |

**Required trust:**
1. **Trust in computation**: The code hash is verified; participants trust it computes only what's consented
2. **Trust in participants**: Participants could probe with narrow windows; this is inherent to the problem
3. **Scoping limits blast radius**: Only 2 weeks, business hours, 3 results—not full calendar

### 3.9.5 Comparison to Default Join

Without multi-party consent, combining calendars produces:

```typescript
// Default: CNF join (concatenate clauses)
{
  confidentiality: [User(Alice), User(Bob), User(Carol)]
  // Three singleton clauses, each must be satisfied
}
// Meaning: ALL THREE must authorize for anyone to see
// Result: Nobody can see the intersection!
```

Multi-party consent transforms this to:

```typescript
// With consent: disjunctive access for participants
{
  confidentiality: [MultiPartyResult([Alice, Bob, Carol])]
}
// Meaning: Any participant can see (via exchange rule)
```

### 3.9.6 Multi-Party Consent as Exchange Rule

The consent mechanism is a special case of exchange rules:

```typescript
// Implicit exchange rule from multi-party consent
{
  name: "MultiPartyConsentExchange",
  preCondition: {
    // Input data from multiple users
    confidentiality: [
      { type: "User", subject: { var: "P1" } },
      { type: "User", subject: { var: "P2" } },
      // ... more participants
    ]
  },
  guard: {
    // All participants have provided compatible consent
    integrity: [
      { type: "MultiPartyConsent", participant: { var: "P1" }, ... },
      { type: "MultiPartyConsent", participant: { var: "P2" }, ... },
      // ... consents from all
    ]
  },
  postCondition: {
    // Result visible to all participants
    confidentiality: [
      { type: "MultiPartyResult", participants: [{ var: "P1" }, { var: "P2" }, ...] }
    ]
  }
}
