# 11. Developer Guide

This section covers the developer experience: TypeScript integration for writing labeled code, and static analysis for compile-time validation.

## 11.1 TypeScript Integration and Termination Sensitivity

This subsection specifies how CFC labels integrate with TypeScript types via the existing ts-transformers pipeline, and how termination sensitivity is handled in the reactive framework.

### 11.1.1 Design Principles

#### 11.1.1.1 Inference by Default

Most labels should be inferred automatically:
- Confidentiality: Inherited from input types and space membership (includes `Expires` atoms for temporal constraints)
- Integrity: Derived from data provenance and handler identity

Explicit annotation is the exception, not the rule.

#### 11.1.1.2 Leverage Existing Type System

The ts-transformers already convert TypeScript types to JSON Schema. We extend this:
- TypeScript types → JSON Schema with `ifc` annotations
- Pattern input/output types naturally express label transitions

#### 11.1.1.3 Reactive Semantics Simplify Termination

In a reactive framework:
- Computations are "always running" - they react to input changes
- Success/failure is rendered to the UI, not returned as a value
- The user (who sees the UI) is typically authorized to see the data
- This eliminates most termination sensitivity concerns

---

### 11.1.2 Label Syntax Options

#### 11.1.2.1 Option A: Branded Types (Minimal)

Use TypeScript's branded types for simple cases:

```typescript
// Define label brands
type Confidential<T> = T & { readonly __brand: "confidential" };
type Secret<T> = T & { readonly __brand: "secret" };

// Usage
interface UserProfile {
  name: string;
  email: Confidential<string>;
  ssn: Secret<string>;
}
```

The transformer recognizes brands and emits appropriate `ifc` in JSON Schema.

#### 11.1.2.2 Option B: Generic Wrapper (Explicit)

For full control, a generic labeled type:

```typescript
type L<T, C extends string = "public", I extends string = "any"> = T & {
  readonly __conf?: C;
  readonly __integ?: I;
};

// Usage
interface UserProfile {
  name: string;
  email: L<string, "User(self)">;
  ssn: L<string, "User(self) | SSN", "AuthoredBy(ssa.gov)">;
}
```

This is more verbose but allows arbitrary label expressions.

#### 11.1.2.3 Option C: JSDoc Annotations (Non-Invasive)

Keep types clean, use JSDoc for labels:

```typescript
interface UserProfile {
  name: string;

  /** @ifc { confidentiality: ["User(self)"] } */
  email: string;

  /** @ifc { confidentiality: ["User(self)", "SSN"], integrity: ["AuthoredBy(ssa.gov)"] } */
  ssn: string;
}
```

Transformer extracts JSDoc and emits `ifc` in schema.

#### 11.1.2.4 Recommended: Hybrid Approach

Combine inference with minimal annotation:

```typescript
// Most fields: inferred from context (space membership, handler identity)
interface Email {
  from: string;      // Inferred: User(owner), AuthoredBy(from)
  to: string[];      // Inferred: User(owner)
  subject: string;   // Inferred: User(owner)
  body: string;      // Inferred: User(owner)
}

// Exceptional cases: explicit annotation
interface HealthRecord {
  patientId: string;

  /** @sensitive */
  diagnosis: string;  // Adds: Resource("medical")

  /** @ifc { confidentiality: [{ type: "TTL", seconds: 3600 }] } */
  vitals: VitalSigns; // 1-hour TTL (converted to Expires atom at runtime)
}
```

Reserved annotations:
- `@sensitive` - Adds high-confidentiality resource class
- `@public` - Removes confidentiality (must be justified)
- `@ifc {...}` - Full IFC annotation (includes `writeAuthorizedBy` for store-field updates; TTL atoms converted to Expires at creation time)
- `@integrity(name)` - Adds named integrity requirement

---

### 11.1.3 Inference Rules

#### 11.1.3.1 Space-Based Confidentiality

Data in a space inherits the space's confidentiality:

```typescript
// Pattern in space "my-todos"
// All output automatically has: { confidentiality: [Space("my-todos")] }
export default pattern<{}, { items: Todo[] }>(() => {
  return { items: [...] };
});
```

#### 11.1.3.2 Handler Integrity

Handler outputs are endorsed by the handler:

```typescript
export default pattern<Input, Output>({
  // All handler outputs automatically have:
  // { integrity: [CodeHash(handler), ExecutedBy(pattern)] }
  addItem: (state, item) => {
    return { ...state, items: [...state.items, item] };
  }
});
```

#### 11.1.3.3 Input-to-Output Propagation

Default: outputs inherit joined confidentiality of all inputs:

```typescript
// If input.a has C1 and input.b has C2
// Then output has C1 ∪ C2 unless annotated otherwise
function combine(input: { a: A; b: B }): Combined {
  return { ...input.a, ...input.b };
}
```

Override with transition annotations ([§8](./08-label-transitions.md#8-label-transition-rules)):

```typescript
function selectOne(input: { items: Item[] }): Item {
  // @ifc { passThrough: { from: "/input/items/0" } }
  return input.items[0];
}
```

---

### 11.1.4 Termination Sensitivity

#### 11.1.4.1 The Problem

In traditional IFC, if high-confidentiality data influences whether a computation terminates, an observer who can detect termination has a side channel:

```typescript
// Problematic: termination depends on secret
function leakySearch(secret: Secret<string>, haystack: string[]): boolean {
  for (const s of haystack) {
    if (s === secret) return true;  // Terminates early if found
  }
  return false;
}
// Observer can infer secret by timing/observing which branch returns
```

#### 11.1.4.2 Reactive Framework Advantage

In a reactive framework, this problem is largely eliminated:

1. **No explicit success/failure returns**: Computations update cells, not return values
2. **UI is the observer**: The user sees success/failure in the rendered UI
3. **User is authorized**: The user already has access to the data that influenced the outcome
4. **Continuous updates**: Reactive graphs "always run" - there's no single termination point

**Note on observation channels**: Console output is considered part of the UI the user sees (not an external channel). Analytics and logging happen entirely within the system and are not exposed externally. Neither constitutes an external observation channel in this threat model.

```typescript
// Reactive pattern: no termination to observe
export default pattern<{ query: string; items: Item[] }, { results: Item[] }>({
  view: ({ query, items }) => {
    // This always runs when inputs change
    // "Success" is just: results has items
    // "Failure" is just: results is empty
    // The user sees either outcome in the UI
    return {
      results: items.filter(item => item.name.includes(query))
    };
  }
});
```

#### 11.1.4.3 When Termination Sensitivity Matters

Termination sensitivity is only a concern when:

1. **Background/scheduled processes** - No user watching the UI
2. **External API calls** - Success/failure visible to external service
3. **Timing-sensitive operations** - Adversary can measure execution time
4. **Multi-user observations** - One user's action affects another user's view

#### 11.1.4.4 Progress Labels

For cases where termination sensitivity matters, we use progress labels:

```typescript
type ProgressAtom =
  | { type: "ProgressGlobal" }           // Global termination observable
  | { type: "ProgressSession"; id: string } // Session-scoped observation
  | { type: "ProgressUser"; user: DID };    // User-scoped observation
```

When a control-flow decision depends on high-confidentiality data AND the outcome is observable by an unauthorized party, the output is tagged with the appropriate progress atom.

#### 11.1.4.5 Reactive Patterns: Default Safe

For standard reactive patterns, termination sensitivity is handled automatically:

```typescript
// Safe by default: user sees their own data
export default pattern<Input, Output>({
  view: (input) => {
    // All branches render to the same user
    // No termination sensitivity concern
    if (input.secret) {
      return { message: "Found!" };
    } else {
      return { message: "Not found" };
    }
  }
});
```

The runtime knows:
- The user viewing the UI is the same user whose data is being processed
- No other observer can detect which branch was taken
- Therefore, no progress label is needed

#### 11.1.4.6 Commit Points: Explicit Handling

At commit points (external effects), termination becomes observable:

```typescript
export default pattern<Input, Output>({
  sendEmail: async (state, { recipient, body }) => {
    // This has an external effect - success/failure is observable
    // The intent system (Section 6) handles this:
    // - Intent is single-use
    // - Idempotency key prevents retry-based inference
    // - External service sees success/failure, but that's authorized by the intent
    await commitIntent(intent, () => sendToExternalService(recipient, body));
  }
});
```

The intent system ([§6](./06-events-and-intents.md#6-events-intents-and-single-use-semantics)) ensures:
- External effects require explicit user intent
- The intent authorizes the observation of success/failure
- Retry semantics prevent timing-based inference

---

### 11.1.5 Transformer Pipeline

#### 11.1.5.1 Current Pipeline

```
TypeScript → ts-transformers → JSON Schema → Recipe → Runtime
```

#### 11.1.5.2 Extended Pipeline

```
TypeScript
    ↓
ts-transformers (extended)
    ↓
JSON Schema with ifc annotations
    ↓
Recipe with label metadata
    ↓
Runtime (label propagation + enforcement)
```

#### 11.1.5.3 Transformer Extensions

The ts-transformers are extended to:

1. **Recognize label annotations**: Parse `@ifc`, `@sensitive`, brands, etc.
2. **Infer default labels**: Apply space-based and handler-based defaults
3. **Emit ifc in schema**: Add `ifc` field to JSON Schema properties
4. **Generate transition metadata**: Extract passThrough, projection, collection constraints

```typescript
// Transformer pseudo-code
function transformProperty(prop: ts.PropertyDeclaration): JSONSchemaProperty {
  const schema = baseTransform(prop);

  // Check for explicit annotation
  const ifcAnnotation = getJSDocTag(prop, "ifc");
  if (ifcAnnotation) {
    schema.ifc = parseIfcAnnotation(ifcAnnotation);
  }

  // Check for shorthand annotations
  if (hasJSDocTag(prop, "sensitive")) {
    schema.ifc = schema.ifc || {};
    schema.ifc.confidentiality = schema.ifc.confidentiality || [];
    schema.ifc.confidentiality.push({ type: "Resource", class: "sensitive" });
  }

  // Check for branded types
  const brand = extractBrand(prop.type);
  if (brand) {
    schema.ifc = brandToIfc(brand);
  }

  return schema;
}
```

---

### 11.1.6 Examples

#### 11.1.6.1 Simple Pattern (Fully Inferred)

```typescript
// No explicit labels needed
export default pattern<
  { todos: Todo[] },
  { active: Todo[]; completed: Todo[] }
>({
  view: ({ todos }) => ({
    active: todos.filter(t => !t.done),
    completed: todos.filter(t => t.done)
  })
});

// Inferred labels:
// - Input/output confidentiality: Space(current-space)
// - Output integrity: CodeHash(this-pattern), TransformedBy(view)
// - Collection constraints: active.subsetOf(todos), completed.subsetOf(todos)
```

#### 11.1.6.2 Cross-Space Pattern (Explicit Transition)

```typescript
export default pattern<
  { privateNotes: Note[]; sharedSpace: SpaceRef },
  { sharedNotes: Note[] }
>({
  /** @ifc { passThrough: { from: "/input/privateNotes" } } */
  shareSelected: (state, { noteIds }) => {
    // Sharing requires:
    // 1. User intent (implicit in handler call)
    // 2. Write access to sharedSpace
    // Selected notes move from private to shared confidentiality
    return {
      sharedNotes: state.privateNotes.filter(n => noteIds.includes(n.id))
    };
  }
});
```

#### 11.1.6.3 Sensitive Data (Explicit Classification)

```typescript
interface MedicalRecord {
  patientId: string;

  /** @sensitive @ifc { integrity: ["AuthoredBy(healthcare-provider)"] } */
  diagnosis: string;

  /** @ifc { confidentiality: [{ type: "TTL", seconds: 86400 }] } */
  prescription: Prescription;  // 24-hour TTL
}

export default pattern<{ record: MedicalRecord }, DisplayRecord>({
  view: ({ record }) => {
    // Diagnosis confidentiality automatically includes Resource("sensitive")
    // Prescription has Expires atom (24 hours from creation)
    return formatForDisplay(record);
  }
});
```

#### 11.1.6.4 External Effect (Commit Point)

```typescript
export default pattern<EmailDraft, SendResult>({
  send: async (state, intent) => {
    // Intent carries:
    // - User's authorization
    // - Idempotency key
    // - Expiration
    //
    // External observer (email server) is authorized by the intent
    // No termination sensitivity leak
    return await commitIntent(intent, async () => {
      await emailService.send(state.to, state.subject, state.body);
      return { sent: true };
    });
  }
});
```

---

### 11.1.7 Security Assumptions and Limitations

The claim that "reactive semantics eliminate termination sensitivity" rests on assumptions that may not always hold.

#### 11.1.7.1 Core Assumption

> The user viewing the UI is the same principal whose data influences the computation.

This is the key assumption. When it holds, the user is already authorized to see the secret, so observing success/failure reveals nothing new.

#### 11.1.7.2 When the Assumption Fails

**Multi-user spaces**: Alice and Bob share a space. Alice's secret data influences what Bob sees:

```typescript
// UNSAFE: Bob can infer Alice's secret by observing his own UI
export default pattern<{ aliceSecret: Secret; bobView: View }, Output>({
  view: ({ aliceSecret, bobView }) => {
    if (aliceSecret.value > 100) {
      return { showBobExtra: true };  // Bob sees this!
    }
    return { showBobExtra: false };
  }
});
```

Bob observes `showBobExtra` and infers something about `aliceSecret`.

**Cross-space aggregation**: Data from multiple spaces is combined:

```typescript
// UNSAFE: Observer can infer private data via aggregated output
export default pattern<{ privateItems: Item[]; publicCount: number }, Output>({
  view: ({ privateItems }) => {
    return { count: privateItems.length };  // Leaks private info
  }
});
```

**Derived permissions**: Access control decisions based on secrets:

```typescript
// UNSAFE: Whether the button appears leaks the secret
export default pattern<{ userRole: Secret<Role> }, Output>({
  view: ({ userRole }) => {
    if (userRole === "admin") {
      return { showAdminPanel: true };
    }
    return { showAdminPanel: false };
  }
});
```

#### 11.1.7.3 Observable Side Channels

Even with single-user patterns, side channels exist:

**Timing**: Computation time varies with secret values:
```typescript
// UNSAFE: Timing reveals secret length
view: ({ secret }) => {
  for (let i = 0; i < secret.length; i++) { /* work */ }
  return { done: true };
}
```

**Network requests**: Reactive updates trigger fetches:
```typescript
// UNSAFE: Network observer sees different endpoints
view: ({ secret }) => {
  if (secret) {
    fetch("/api/secret-exists");  // Observable!
  }
  return {};
}
```

**Resource consumption**: Memory/CPU varies:
```typescript
// UNSAFE: Resource usage reveals secret
view: ({ largeSecretList }) => {
  return { processed: largeSecretList.map(heavyComputation) };
}
```

**Error paths**: Exceptions propagate differently:
```typescript
// UNSAFE: Error logging might be observable
view: ({ secret }) => {
  if (secret.invalid) {
    throw new Error("Invalid secret");  // Logged? Monitored?
  }
  return { valid: true };
}
```

#### 11.1.7.4 Threat Model Refinement

We must be explicit about what observers we protect against:

| Observer | Can See | Protected? |
|----------|---------|------------|
| The user themselves | Their own UI | N/A (authorized) |
| Other users in same space | Their own UI | **NO** - cross-user flows must be checked |
| Browser extensions | DOM, network | **NO** - out of scope |
| Network adversary | Request patterns, timing | **PARTIAL** - requires additional mitigations |
| Server logs | Requests, errors | **NO** - requires log hygiene |
| Analytics | Events, performance | **NO** - requires careful instrumentation |

#### 11.1.7.5 Required Invariants

For termination-insensitivity to hold, we require:

1. **Single-principal output**: Each UI render is for exactly one principal, using only that principal's data for control flow decisions.

2. **No cross-principal influence**: User A's secrets cannot affect the presence/absence of UI elements shown to User B.

3. **Trusted rendering**: The browser/runtime is trusted; extensions and side channels are out of scope.

4. **Constant-time where needed**: For network/timing-sensitive operations, implementations must be constant-time or explicitly labeled.

#### 11.1.7.6 Static Checks

The transformer should verify:

```typescript
interface TerminationSafetyCheck {
  // All control-flow branches must produce output for the SAME principal
  checkBranchPrincipals(pattern: Pattern): Principal[];

  // If principals differ, output must carry ProgressXYZ label
  requireProgressLabel(pattern: Pattern, observers: Principal[]): void;

  // Warn on patterns that mix principals in control flow
  warnCrossPrincipalFlow(pattern: Pattern): Warning[];
}
```

#### 11.1.7.7 Runtime Checks

The runtime should enforce:

```typescript
function renderForPrincipal(principal: DID, output: LabeledValue): void {
  // Check: all confidentiality atoms in output are authorized for this principal
  for (const atom of output.label.confidentiality) {
    if (!isAuthorized(principal, atom)) {
      // This output contains data the principal shouldn't see
      // AND we're about to render it (reveal its existence)
      throw new TerminationLeak(atom, principal);
    }
  }
}
```

#### 11.1.7.8 Safe Patterns vs Unsafe Patterns

**Safe** (termination-insensitive):
```typescript
// Single principal, single space
pattern<{ myData: MyData }, { view: View }>

// Filtering my own data
pattern<{ myItems: Item[] }, { filtered: Item[] }>

// All branches show something to the same user
pattern<{ secret: boolean }, { message: string }>({
  view: ({ secret }) => ({
    message: secret ? "Yes" : "No"  // Same observer sees both
  })
})
```

**Unsafe** (requires progress labels or refactoring):
```typescript
// Cross-principal: Alice's data affects Bob's view
pattern<{ aliceData: Data; forBob: true }, View>

// Aggregation across principals
pattern<{ allUsersData: Data[] }, { summary: Summary }>

// Conditional data fetch
pattern<{ shouldFetch: Secret<boolean> }, { data: Data | null }>({
  view: async ({ shouldFetch }) => {
    if (shouldFetch) {
      return { data: await fetch(...) };  // Network observable
    }
    return { data: null };
  }
})
```

#### 11.1.7.9 Sandbox Constraints

Pattern code runs in a restricted environment that eliminates several side channels:

**No Timers**: Patterns cannot access `Date.now()`, `performance.now()`, `setTimeout`, or any timing APIs. This prevents:
- Measuring computation time of secret-dependent operations
- Correlating events across time
- Using timing as a covert channel

**No Cell/Document IDs**: Patterns cannot observe the raw IDs of cells or documents. These IDs are:
- Unique enough to act as cross-session identifiers (like cookies)
- Derived from content hashes that could leak information
- Only accessible to trusted runtime code

```typescript
// BLOCKED: Pattern code cannot do this
const cellId = someCell.id;  // Error: id is not accessible
const hash = refer(someCell);  // ALSO BLOCKED: refer() returns content hash

// ALLOWED: Pattern receives opaque handles
// These are JS objects, Symbols, or sandbox-local temporary IDs
// They have no stable identity across sessions or content relationship
const handle = someCell;  // Opaque handle, not the underlying ID
```

Note: `refer()` from `@commontools/memory` produces content-addressed hashes, which leak information about content. Pattern code cannot call `refer()` directly. The runtime uses it internally for persistence and deduplication.

**No Direct Network Access**: Patterns cannot call `fetch()` directly. Network requests go through the runtime's fetch proxy which:
- Routes through shared IP infrastructure (prevents per-user correlation)
- Only allows pre-declared endpoints
- Applies timing normalization (constant-time or batched responses)

**Implications for Timing Attacks**:

Since patterns can't measure time, even secret-dependent computation time doesn't leak:
```typescript
// This is SAFE despite variable execution time
view: ({ secret }) => {
  // Even though this takes longer for large secrets,
  // the pattern can't observe the duration
  // and the reactive system settles to final state
  for (let i = 0; i < secret.length; i++) { /* work */ }
  return { done: true };
}
```

The reactive system's eventual consistency model helps: all observers see the same final state, not intermediate states or timing.

#### 11.1.7.10 Network Request Tiers

Network requests fall into tiers based on trust and observability:

**Tier 1: Trusted Servers** (no restrictions)
- Servers we operate or contractually trust
- No request logging, no side effects
- Can receive any request without leaking information

**Tier 2: Public URLs via Proxy** (IP-grouped)
- Requests routed through shared IP infrastructure
- All users appear as same origin to destination
- Safe for public, enumerable URLs (e.g., static assets, public APIs)
- Destination sees request but can't correlate to specific user

**Tier 3: Pre-enumerated Fetches** (speculative)
- Pattern declares all possible URLs it might fetch
- Runtime fetches ALL of them (or a covering set)
- Pattern receives only the one it actually needs
- Prevents "which URL was fetched" from leaking

**TODO**: Specify scalability strategy for large URL sets. When patterns might fetch from thousands of possible URLs, fetching all is impractical. Possible approaches include: bucketing, probabilistic fetching, or requiring patterns to use Tier 2 (proxy) for large enumerations.

```typescript
// Pre-enumeration example
/** @prefetch ["/api/status/active", "/api/status/inactive", "/api/status/pending"] */
async function getStatus(status: Secret<Status>): Promise<StatusData> {
  // Runtime fetches all three, returns the matching one
  return await fetch(`/api/status/${status}`);
}
```

**Tier 4: Sensitive Requests** (requires intent)
- Requests that could leak information to untrusted destinations
- Require explicit user intent ([§6](./06-events-and-intents.md#6-events-intents-and-single-use-semantics))
- User is informed that making this request reveals information

#### 11.1.7.11 Multi-User Scenario Analysis

The core rule for multi-user safety:

> **Pattern code must never see data the acting user cannot see.**

This is enforced by the runtime filtering inputs BEFORE they reach the pattern. The pattern cannot branch, abort, or otherwise behave differently based on data it never receives.

**Safe**: Pattern only receives data the acting user can see:
```typescript
// Alice triggers a handler in a shared space
// Runtime filters: Alice only sees items she's authorized for
// Pattern receives pre-filtered data
handler: (state, action) => {
  // state.items only contains items Alice can see
  // Any branching here is based on data Alice is authorized for
  if (state.items.length > 0) {
    return { showList: true };
  }
  return { showEmpty: true };
}
```

**Unsafe**: Pattern sees unauthorized data (even if it "filters" it):
```typescript
// UNSAFE: Pattern receives ALL items, does its own filtering
// Even if output is filtered, pattern BRANCHES on unauthorized data
view: ({ allItems, currentUser }) => {
  // This loop iterates over items currentUser can't see!
  // Termination/timing depends on unauthorized data
  return {
    items: allItems.filter(item => canView(currentUser, item))
  };
}
```

**Unsafe**: Pattern could abort based on unauthorized data:
```typescript
// UNSAFE: Pattern sees unauthorized data, might abort
view: ({ allItems }) => {
  for (const item of allItems) {
    if (item.corrupted) {
      throw new Error("Corrupted item");  // Abort reveals item exists!
    }
  }
  return { items: allItems };
}
```

**The Runtime's Role**:

The runtime ensures patterns only receive authorized data:
1. Before invoking a pattern, filter all inputs to the acting user's authorization level
2. The pattern never sees data it shouldn't, so it can't branch on it
3. Output is naturally safe because input was pre-filtered

```typescript
// Runtime pseudo-code
function invokePattern(pattern, inputs, actingUser) {
  // Filter inputs BEFORE pattern sees them
  const filteredInputs = filterByAuthorization(inputs, actingUser);

  // Pattern only sees authorized data
  return pattern.handler(filteredInputs);
}
```

**Cross-Principal Policies** (rare, requires extra review):

Some scenarios intentionally allow cross-principal influence:
- Aggregations (e.g., "5 people liked this" without revealing who)
- Presence indicators (e.g., "Alice is typing")
- Access control UI (e.g., showing a "request access" button)

These require:
1. Explicit policy declaring the cross-principal flow
2. Progress labels on affected outputs
3. Often additional protections (differential privacy, rate limiting, etc.)

#### 11.1.7.12 Mitigations for Unsafe Patterns

When unsafe patterns are necessary:

1. **Explicit progress labels**: Mark outputs as termination-sensitive
   ```typescript
   /** @ifc { confidentiality: ["ProgressSession(aggregation)"] } */
   summary: Summary
   ```

2. **Constant-time operations**: Ensure branches take equal time
   ```typescript
   // Always fetch, but maybe discard
   const data = await fetch(...);
   return shouldFetch ? { data } : { data: null };
   ```

3. **Batching**: Combine updates to hide individual decisions
   ```typescript
   // Update all users simultaneously, even if only some changed
   batchUpdate(allUsers, computeViews(allUsersData));
   ```

4. **Differential privacy**: Add noise to aggregations
   ```typescript
   return { count: privateItems.length + laplacianNoise() };
   ```

---

### 11.1.8 Summary

| Concern | Approach | Limitations |
|---------|----------|-------------|
| Label syntax | Inference + JSDoc/brands | Complex policies need explicit annotation |
| Confidentiality | Space membership | Cross-space requires explicit handling |
| Integrity | Handler identity | External endorsement needs declaration |
| Termination | Single-principal renders are safe | Multi-principal flows need progress labels |
| External effects | Intent system ([§6](./06-events-and-intents.md#6-events-intents-and-single-use-semantics)) | Network timing out of scope |
| Side channels | Trusted browser model | Extensions, timing attacks not covered |

**Core invariant**: Termination-insensitivity holds when the observer is the same principal whose data influences the computation.

**When this fails**: Cross-principal flows, aggregations, and network-observable decisions require explicit progress labels or mitigations (constant-time, batching, differential privacy).

The goal is: **write normal TypeScript, get IFC for free** for single-principal patterns, with explicit safety analysis required for multi-principal or externally-observable patterns.

---

## 11.2 Static Analysis and Pattern Compilation

This subsection specifies how CFC properties can be verified at pattern compilation time, before runtime execution.

### 11.2.1 Motivation

Runtime validation catches policy violations when they occur, but static analysis provides earlier feedback:

1. **Faster iteration**: Developers learn about flow violations during development, not after deployment
2. **Better UX**: Users don't hit walls late in a workflow when a pattern tries a forbidden operation
3. **Optimization**: Pre-validated patterns can skip some runtime checks
4. **Compositional reasoning**: Verify pattern combinations before they're instantiated

### 11.2.2 Static vs Runtime Validation

| Aspect | Static (Compile-time) | Runtime |
|--------|----------------------|---------|
| **When** | Pattern compilation | Execution |
| **What's known** | Schema, code hash, declared flows | Actual values, actual user, actual labels |
| **Variables** | Templated placeholders | Concrete values |
| **Guarantees** | "If inputs satisfy X, outputs satisfy Y" | "This specific operation is permitted" |

Static analysis proves conditional properties; runtime fills in the conditions.

---

### 11.2.3 Templated Analysis

Many values aren't known until runtime, but static analysis can reason about them using **template variables**.

#### 11.2.3.1 Template Variables

```typescript
interface TemplateVariables {
  // Current user (filled at runtime)
  $actingUser: "template:DID";

  // Event integrity (filled when event occurs)
  $eventIntegrity: "template:IntegrityAtom[]";

  // Space membership (filled from runtime context)
  $hasRole: "template:(user: DID, space: SpaceID, role: Role) => boolean";

  // Current timestamp (filled at runtime)
  $now: "template:number";
}
```

#### 11.2.3.2 Conditional Properties

Static analysis proves properties of the form:

```
∀ user, event, context:
  IF preconditions(user, event, context)
  THEN postconditions(output_labels)
```

**Example**: A pattern that forwards emails

```typescript
// Static analysis proves:
// IF:
//   - $actingUser has HasRole($actingUser, space, writer)
//   - $eventIntegrity includes UIIntent(forward, $actingUser, snapshot)
// THEN:
//   - Output may have Ctx.Email($actingUser) declassified to ForwardedTo(recipients)
//   - Network egress to Gmail API is permitted
```

#### 11.2.3.3 Template Instantiation

At runtime, templates are instantiated with concrete values:

```typescript
function instantiateTemplates(
  pattern: CompiledPattern,
  context: RuntimeContext
): InstantiatedPattern {
  return substitute(pattern, {
    $actingUser: context.actingUser,
    $eventIntegrity: context.eventIntegrity,
    $hasRole: (user, space, role) => context.checkRole(user, space, role),
    $now: Date.now()
  });
}
```

---

### 11.2.4 Pattern Compilation Phases

#### 11.2.4.1 Phase 1: Schema Flow Analysis

Extract data flow declarations from input/output schemas:

```typescript
// IFC annotations embedded in JSON Schema nodes (see Section 8.8).
type IFCAnnotations = IFCTransitionAnnotations & IFCInputAnnotations & IFCHandlerTypeAnnotations;

interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface FlowNode {
  path: string;           // JSON Pointer
  schema: JSONSchema;
  ifc: IFCAnnotations;
}

interface FlowEdge {
  from: string;           // Input path
  to: string;             // Output path
  type: "passThrough" | "projection" | "exactCopy" | "transformation";
  constraints?: Constraint[];
}
```

#### 11.2.4.2 Phase 2: Label Bound Inference

Infer bounds on output labels based on input label bounds and flow edges:

```typescript
function inferLabelBounds(
  graph: FlowGraph,
  inputBounds: Map<string, LabelBound>
): Map<string, LabelBound> {
  const outputBounds = new Map();

  for (const node of graph.outputNodes) {
    const incomingEdges = graph.edgesTo(node.path);

    // Confidentiality: concatenate clauses from all inputs (CNF join)
    const confBound = concatClauseBounds(
      incomingEdges.map(e => inputBounds.get(e.from)?.confidentiality)
    );

    // Integrity: depends on edge type
    const intBound = computeIntegrityBound(incomingEdges, inputBounds);

    outputBounds.set(node.path, { confidentiality: confBound, integrity: intBound });
  }

  return outputBounds;
}
```

#### 11.2.4.3 Phase 3: Policy Satisfaction Check

Verify that declared outputs satisfy policy requirements:

```typescript
function checkPolicySatisfaction(
  pattern: CompiledPattern,
  policies: PolicyRecord[]
): ValidationResult {
  const violations: Violation[] = [];

  for (const output of pattern.outputs) {
    // Check: Can this output's label be declassified at any egress point?
    if (output.ifc?.egress) {
      const canDeclassify = policies.some(p =>
        matchesExchangeRule(output.labelBound, p.exchangeRules, "$eventIntegrity")
      );

      if (!canDeclassify) {
        violations.push({
          path: output.path,
          issue: "No exchange rule permits declassification",
          requiredIntegrity: extractRequiredIntegrity(policies)
        });
      }
    }
  }

  return { valid: violations.length === 0, violations };
}
```

---

### 11.2.5 Validation Errors and Feedback

When static analysis fails, provide actionable feedback:

#### 11.2.5.1 Error Categories

```typescript
type ValidationError =
  | { type: "missing_integrity";
      path: string;
      required: AtomPattern[];
      suggestion: string }
  | { type: "confidentiality_leak";
      from: string;
      to: string;
      missingGuard: AtomPattern[] }
  | { type: "forbidden_egress";
      destination: CapabilityResource;
      blockingPolicy: string }
  | { type: "opaque_read_attempt";
      path: string;
      accessor: string };
```

#### 11.2.5.2 Error Messages

```
❌ Pattern validation failed:

  /output/forwardedEmail → Network(gmail.googleapis.com)

  Missing integrity guard for declassification.

  The output has confidentiality [Ctx.Email($actingUser)]
  but no exchange rule permits sending to gmail.googleapis.com
  without integrity [UIIntent(forward, $actingUser, snapshot)].

  Suggestion: Ensure the handler receives an event with
  forward intent before producing network-bound output.
```

#### 11.2.5.3 Suggestions for AI Agents

When an AI agent generates a pattern that fails validation, the error messages guide toward valid alternatives:

```typescript
interface AgentGuidance {
  // What the agent tried
  attemptedFlow: FlowDescription;

  // Why it failed
  violation: ValidationError;

  // How to fix it
  suggestions: Suggestion[];
}

type Suggestion =
  | { action: "add_intent_requirement"; intentType: string }
  | { action: "use_opaque_input"; path: string }
  | { action: "split_into_subtasks"; boundary: string }
  | { action: "request_user_confirmation"; forAction: string };
```

---

### 11.2.6 Compositional Analysis

When patterns are composed (linked together), verify the composition:

#### 11.2.6.1 Link Compatibility

```typescript
function checkLinkCompatibility(
  source: CompiledPattern,
  target: CompiledPattern,
  link: LinkDeclaration
): ValidationResult {
  const sourceOutput = source.outputs.get(link.sourcePath);
  const targetInput = target.inputs.get(link.targetPath);

  // Check: Source output label ≤ Target input requirement
  if (!labelSatisfies(sourceOutput.labelBound, targetInput.requiredLabel)) {
    return {
      valid: false,
      error: {
        type: "link_label_mismatch",
        sourceLabel: sourceOutput.labelBound,
        targetRequirement: targetInput.requiredLabel
      }
    };
  }

  // Check: If target input is opaque, source must produce reference
  if (targetInput.ifc?.opaque && !sourceOutput.ifc?.producesReference) {
    return {
      valid: false,
      error: { type: "opaque_requires_reference" }
    };
  }

  return { valid: true };
}
```

#### 11.2.6.2 Graph-Level Validation

For multi-pattern graphs, validate the entire flow:

```typescript
function validatePatternGraph(
  graph: PatternGraph,
  policies: PolicyRecord[]
): GraphValidationResult {
  // 1. Topological sort of patterns
  const sorted = topologicalSort(graph);

  // 2. Forward propagation of label bounds
  const labelBounds = propagateLabelBounds(sorted);

  // 3. Check each pattern's policy satisfaction
  const patternResults = sorted.map(p =>
    checkPolicySatisfaction(p, policies)
  );

  // 4. Check egress points against policies
  const egressResults = checkEgressPoints(graph, labelBounds, policies);

  return combineResults(patternResults, egressResults);
}
```

---

### 11.2.7 Incremental Validation

As patterns evolve, re-validate incrementally:

#### 11.2.7.1 Change Detection

```typescript
interface PatternChange {
  type: "schema_change" | "flow_change" | "policy_change";
  affected: string[];  // Paths or pattern IDs
}

function detectChanges(
  previous: CompiledPattern,
  current: CompiledPattern
): PatternChange[] {
  // Compare schemas, IFC annotations, code hashes
  // Return minimal set of changes
}
```

#### 11.2.7.2 Targeted Re-validation

Only re-validate affected portions:

```typescript
function incrementalValidate(
  graph: PatternGraph,
  changes: PatternChange[]
): ValidationResult {
  // Find patterns affected by changes
  const affected = computeAffectedPatterns(graph, changes);

  // Re-validate only affected patterns and their downstream consumers
  return validateSubgraph(graph, affected);
}
```

---

### 11.2.8 Integration with Pattern Development

#### 11.2.8.1 IDE/Editor Integration

Static analysis runs during development:

```
┌─────────────────────────────────────────────────┐
│ pattern.ts                                       │
├─────────────────────────────────────────────────┤
│ export default {                                 │
│   input: {                                       │
│     email: { type: "Email" },                   │
│     priority: { type: "string" }                │
│   },                                             │
│   output: {                                      │
│     destination: { type: "string" },            │
│     email: {                                     │
│       type: "Email",                            │
│       ifc: { passThrough: { from: "/email" } } │ ⚠️ Warning: /email is
│     }                                           │    not marked opaque
│   },                                             │    but routing depends
│   handler: (input) => { ... }                   │    on /priority only
│ }                                                │
└─────────────────────────────────────────────────┘
```

#### 11.2.8.2 CI/CD Integration

Validation as part of deployment pipeline:

```yaml
# Pattern deployment pipeline
steps:
  - name: Compile pattern
    run: ct pattern compile ./pattern.ts

  - name: Static validation
    run: ct pattern validate --policies ./policies/

  - name: Deploy (only if validation passes)
    run: ct pattern deploy ./pattern.ts
    if: steps.validate.outcome == 'success'
```

---

### 11.2.9 Limitations

Static analysis cannot verify everything:

1. **Value-dependent flows**: If routing depends on data content, static analysis sees worst-case
2. **Dynamic policy changes**: Policies may change between compilation and execution
3. **External service behavior**: Can't verify what external APIs actually do
4. **Timing and ordering**: Can't detect race conditions or timing channels

These require runtime validation as a second layer of defense.

---

### 11.2.10 Soundness Guarantee

Static analysis is **sound but not complete**:

- **Sound**: If static analysis says "valid", runtime will not reject (assuming policies don't change)
- **Not complete**: Static analysis may reject patterns that would actually be safe at runtime

This is the safe direction: false positives (rejected safe patterns) are inconvenient but not security holes; false negatives (accepted unsafe patterns) would be security holes.

```
Static analysis says "valid" → Runtime will permit (sound)
Static analysis says "invalid" → Runtime might permit (incomplete, conservative)
```

Developers can add runtime checks or refine schemas to help static analysis recognize safe patterns.

---

## 11.3 Multi-User Sharing Scenarios

This section covers data sharing between users within the system—no external network gates, but clear internal gates when data moves between principals.

### 11.3.1 The Core Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Alice's Private Space                                          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Emails      │    │ Calendar    │    │ Notes       │         │
│  │ User(Alice) │    │ User(Alice) │    │ User(Alice) │         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                  │                  │                 │
│         └──────────────────┼──────────────────┘                 │
│                            ▼                                    │
│                   ┌────────────────┐                           │
│                   │ Pattern:       │                           │
│                   │ "What to share │                           │
│                   │  with Bob?"    │                           │
│                   └────────┬───────┘                           │
│                            │                                    │
│         ┌──────────────────┴──────────────────┐                │
│         ▼                                      ▼                │
│  ┌─────────────────┐                  ┌─────────────────┐      │
│  │ Selection:      │                  │ Suggested Item: │      │
│  │ "vacation pics" │                  │ Photo #42       │      │
│  │ conf: User(A)   │                  │ conf: User(A)   │      │
│  │ (from calendar) │                  │ (original data) │      │
│  └────────┬────────┘                  └────────┬────────┘      │
│           │                                    │                │
│           └────────────────┬───────────────────┘                │
│                            ▼                                    │
│                   ┌────────────────┐                           │
│                   │ UI: "Share     │                           │
│                   │ Photo #42 with │                           │
│                   │ Bob?"          │                           │
│                   │ [Cancel][Share]│                           │
│                   └────────┬───────┘                           │
│                            │ User clicks "Share"                │
│                            ▼                                    │
│                   ┌────────────────┐                           │
│                   │ ShareIntent    │                           │
│                   └────────┬───────┘                           │
└────────────────────────────┼────────────────────────────────────┘
                             │ Exchange rule fires
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Shared Space / Bob's View                                      │
│                   ┌────────────────┐                           │
│                   │ Photo #42      │                           │
│                   │ conf: User(A)  │                           │
│                   │     ∨ User(B)  │                           │
│                   └────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### 11.3.2 Selection vs Content Confidentiality

Two distinct confidentiality concerns:

| Aspect | Source | Confidentiality | Declassified By |
|--------|--------|-----------------|-----------------|
| **Content** | Original data (Photo #42) | `User(Alice)` | Share intent |
| **Selection** | Why this item was suggested | `User(Alice)` (from calendar, emails) | Share action (implicit) |

The act of sharing implicitly declassifies selection confidentiality. When Alice clicks "Share Photo #42 with Bob", she accepts that:
1. Bob will see the photo (content declassification)
2. Bob might infer something about why this photo was suggested (selection declassification)

### 11.3.3 The Exchange Rule for Internal Sharing

```typescript
interface InternalShareRule {
  name: "UserToUserShare";

  preCondition: {
    confidentiality: [{ type: "User", subject: { var: "$owner" } }];
  };

  guard: {
    integrity: [{
      type: "UserIntent",
      action: "share",
      actor: { var: "$owner" },
      recipient: { var: "$recipient" },
      uiAttestation: { type: "SharePreview", shown: true }
    }];
  };

  postCondition: {
    // Add recipient to audience (disjunction)
    confidentiality: [
      { type: "User", subject: { var: "$owner" } },
      { type: "User", subject: { var: "$recipient" } }
    ];
  };
}
```

### 11.3.4 Showing Provenance Before Sharing

The UI should show what influenced the suggested content:

```
┌─────────────────────────────────────────┐
│ Share with Bob?                         │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 🖼️ Beach sunset, July 15            │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ℹ️ This suggestion was based on:       │
│    • Your calendar                      │
│    • Your recent emails                 │
│                                         │
│ Bob will see: The photo                 │
│ Bob won't see: Why it was suggested     │
│                                         │
│         [Cancel]  [Share with Bob]      │
└─────────────────────────────────────────┘
```

### 11.3.5 Examples

**Example 1: Photo Sharing**

```typescript
// Alice's data (all User(Alice) confidentiality)
const calendar = [{ event: "Hawaii vacation", dates: "July 10-20" }];
const photos = [
  { id: 42, location: "Hawaii", date: "July 15", image: "sunset.jpg" }
];

// Pattern suggests sharing based on calendar
// Selection confidentiality: User(Alice) - influenced by calendar
// Content confidentiality: User(Alice) - the photos themselves

// Alice shares photo 42 with Bob
// Result:
// - Photo 42: User(Alice) ∨ User(Bob)
// - Calendar data: still User(Alice) - not shared
```

**Example 2: Collaborative Document**

```typescript
// Alice drafts a document using private notes
const privateNotes = [
  { topic: "Project ideas", content: "..." },  // User(Alice)
];

const proposal = deriveDocument(privateNotes);
// proposal.confidentiality = User(Alice)

// Alice shares the proposal with her team
// Result:
// - proposal: User(Alice) ∨ User(Bob) ∨ User(Carol)
// - privateNotes: still User(Alice) - only proposal was shared
```

**Example 3: Recommendation with Selection Privacy**

```typescript
// Alice's private movie ratings
const ratings = { "Inception": 5, "Matrix": 4 };  // User(Alice)

// Pattern: "Bob also liked Inception - discuss?"
// Selection confidentiality: User(Alice) (from ratings)
// Content: just the movie name "Inception"

// If Alice clicks "Start discussion":
// - The discussion topic: User(Alice) ∨ User(Bob)
// - Alice's rating: still User(Alice)
// - Selection: declassified by accepting recommendation
```

### 11.3.6 Contextual Integrity for Recommendations

A key principle: **certain recommendations should or shouldn't be influenced by certain data**.

This connects to Contextual Integrity—the appropriateness of a data flow depends on context. A pattern that suggests sharing vacation photos based on calendar data is appropriate; one that suggests sharing medical records based on calendar data is not.

**The upstream requirement**: Data must be classified broadly enough that policies can distinguish appropriate from inappropriate influence:

```typescript
interface DataClassification {
  // Broad category for policy decisions
  class: "personal" | "financial" | "medical" | "professional" | "public";

  // More specific sub-classification
  subClass?: string;

  // Who/what assigned this classification
  classifiedBy: IntegrityAtom;
}
```

### 11.3.7 Classification Attacks

**The attack**: A malicious pattern asks for sensitive data but claims it's innocuous:

```typescript
// Malicious pattern
const pattern = {
  input: {
    // Claims this is just a favorite color
    favoriteColor: { type: "string", ifc: { class: "personal" } }
  },

  // But the UI actually asks for SSN
  view: () => html`<input placeholder="Enter your SSN" />`
};
```

The user enters their SSN, but the pattern labels it as "favorite color"—now a downstream pattern might share it thinking it's harmless.

**Mitigations**:

1. **VDOM-based analysis**: Since patterns render to a virtual DOM, the UI structure is inspectable before display. This makes it feasible to automatically compare declared input semantics against what the UI actually asks for. A pattern declaring "favoriteColor" but rendering an input labeled "SSN" produces an analyzable mismatch.

2. **LLM-based screening**: Automated review can catch obvious mismatches between declared types and UI semantics, flagging suspicious patterns for manual review.

3. **User-visible classification**: Show users what classification their input will receive before they enter sensitive data.

### 11.3.8 LLM Review as Trust Amplifier

Automated LLM review can catch many classification attacks and suspicious patterns. The review compares what the pattern declares (input/output types, classifications) against what the UI actually shows and asks for. This doesn't replace policy enforcement, but provides an additional layer for catching obvious attacks before patterns are deployed.

### 11.3.9 LLM-Generated Patterns: The Middle Trust Zone

LLM-generated patterns occupy an interesting trust position:

| Trust Property | Status | Reasoning |
|----------------|--------|-----------|
| **Correctness** | Low trust | LLMs make mistakes, generate buggy code |
| **Non-malice** | Conditional trust | Depends on prompting user's intent |
| **Policy compliance** | Verifiable | Static analysis + runtime enforcement |

**The key insight**: If we can audit the prompt that generated a pattern, we gain significant trust.

**Trust scaling implications**:

1. **User generates their own patterns**: If Alice prompts an LLM to create a pattern for her own use, she's unlikely to create something malicious against herself. The pattern can be treated with moderate trust.

2. **Auditable prompt chain**: If the prompt is available, automated review can check whether it requests anything suspicious. The prompt provenance chain (who requested, what they asked for, which model generated it) enables trust inheritance.

3. **Pattern sandboxing still applies**: Even with prompt trust, the pattern runs in the CFC sandbox—it can't bypass labels, can't forge integrity, can't make unauthorized network requests.

### 11.3.10 Design Summary

Multi-user sharing within the system achieves trust scaling through:

1. **UI-backed intent for all sharing**: Users explicitly approve each share action
2. **Provenance display**: Users see what influenced suggestions before accepting
3. **Selection declassification via action**: The share action itself declassifies selection confidentiality
4. **Data classification upstream**: Broad classification enables appropriate policy decisions
5. **VDOM analyzability**: UI structure is inspectable, enabling automated mismatch detection
6. **LLM review**: Automated screening catches obvious classification attacks
7. **Prompt provenance for LLM patterns**: Auditable generation chain enables trust inheritance

**TODO**: Expand on VDOM-based analysis strategies and prompt auditing mechanisms. This is an active design space where LLM capabilities can significantly amplify human review capacity.
