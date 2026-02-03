# 5. Policy Architecture

## 5.1 Contextual Integrity Mapping

CFC operationalizes Contextual Integrity's five core parameters:

**(A) Context → Context principal**

In CI, a *context* defines which informational norms apply. In CFC, this is represented by a **context principal** (policy principal) such as `Ctx.Email(Alice)`. All data originating in that context carries this principal, ensuring that only norms defined for that context may authorize flows.

**(B) Actors → Principals and audience bindings**

CI actors (sender, recipient, subject) map directly to principals and audience constraints in labels and intent bindings. This correspondence is direct and requires no additional mechanism beyond the principal lattice.

**(C) Attributes → Resource and data-class atoms**

CI attributes (types of information) correspond to resource-class atoms such as `EmailMetadataSecret` or `EmailBodySecret`. These atoms refine confidentiality within a context.

**(D) Transmission principles → Integrity-guarded exchange rules**

Transmission principles—the core of CI—are implemented in CFC as **exchange rules guarded by integrity evidence**. A flow is permitted not because secrecy was lowered, but because sufficient contextual evidence exists (UI-backed intent, endorsement, provenance) to justify that the transmission conforms to the context's norms.

**(E) Norms → Policy rule sets**

A CI context's norms correspond to the full set of exchange rules defined by a context principal's policy record.

---

## 5.2 Request Authorization Pipeline

The system decomposes network access into stages. Structural checks are handled automatically by the sink gate; semantic checks (intent binding) require explicit endorsement only for write actions.

### 5.2.1 Sink Gate (Structural Authorization)

When data flows to a sink (e.g. `fetchData`), the runtime's **sink gate** evaluates sink-scoped exchange rules — rules with an `allowedSink` field matching the current sink.

For each sink-scoped rule, the gate checks whether taint atoms at the rule's `allowedPaths` match the rule's `confidentialityPre` patterns. If they match, those atoms are stripped from the label.

When any sink-scoped rule fires, the gate emits:

```
AuthorizedRequest{ sinkName = "fetchData" }
```

This handles structural checks that were previously the responsibility of a separate `endorse_request` component:

- token appears only at permitted paths (e.g. `options.headers.Authorization`),
- authority-only atoms are stripped only at those paths,
- misplaced tokens (e.g. in the request body) are not declassified.

### 5.2.2 Request Endorsement (Semantic Authorization — Write Actions Only)

For **write actions** where the request must match user intent bindings, a trusted `endorse_request` component performs additional semantic verification:

- request semantics match `IntentOnce` bindings (audience, endpoint, payload digest, idempotency key),
- the intent is unconsumed and unexpired.

If successful, `endorse_request` emits:

```
EndorsedIntent{
  policy = GoogleAuth(Alice),
  user = Alice,
  endpoint = E,
  requestDigest = D,
  codeHash = h_endorse
}
```

General exchange rules may require `EndorsedIntent` as an `integrityPre` guard for write-specific declassification. For read-only fetches, `endorse_request` is not needed — the sink gate handles authorization.

### 5.2.3 Fetch (Transport)

A separate `fetch` component performs the actual network request.

Inputs:
- sink-declassified request (authority-only atoms already stripped by sink gate),
- associated integrity fact(s).

Outputs:
- response data,
- `NetworkProvenance{host, tls, codeHash}` integrity fact.

`fetch` itself does not assign final confidentiality labels; it only performs transport.

### 5.2.4 Response Translation

After sink-scoped rules and fetch, general exchange rules are applied to the resulting label.

Given:
- remaining confidentiality atoms (authority-only atoms already stripped by sink gate),
- `AuthorizedRequest` integrity fact (from sink gate),
- network provenance integrity (from fetch),

the runtime may further rewrite confidentiality labels according to general (non-sink-scoped) exchange rules.

---

## 5.3 Confidentiality Exchange

### 5.3.1 Authority-Only vs Data-Bearing Inputs

Policies distinguish between:

- **Authority-only inputs** (e.g. OAuth tokens): authorize access but should not taint the response.
- **Data-bearing inputs** (e.g. secret queries): influence the response and therefore taint it.

Default rule:

```
S_response = join of confidentiality of all inputs
```

Policy override (when guarded by integrity):

```
S_response = join of confidentiality of all inputs EXCEPT authority-only fields
             plus resource classification
```

### 5.3.2 Exchange Rules

An exchange rule has the form:

```typescript
type ExchangeRule = {
  confidentialityPre: AtomPattern[];   // Confidentiality atoms that must be present
  integrityPre: AtomPattern[];         // Integrity atoms that must be present
  addAlternatives: AtomPattern[];      // Alternatives to add to matched clauses
  removeMatchedClauses?: boolean;      // If true, drop matched clauses entirely
  variables: string[];                 // Variable bindings (e.g. "$user")

  // Sink-scoped fields (optional):
  allowedSink?: string;                // Sink name (e.g. "fetchData")
  allowedPaths?: (readonly string[])[]; // Paths where declassification applies
};
```

**General rules** (no `allowedSink`): Apply label-wide during fixpoint evaluation. If `confidentialityPre` and `integrityPre` match, the matching clauses gain `addAlternatives` (or are removed if `removeMatchedClauses` is true).

**Sink-scoped rules** (`allowedSink` set): Apply only during `checkSinkAndWrite` for the named sink, and only match taint atoms present at the specified `allowedPaths`. This enables fine-grained, path-aware declassification — e.g. stripping `GoogleAuth(Alice)` only when the token appears at `options.headers.Authorization`.

Both rule types live in a single `exchangeRules` array on the policy record. The runtime partitions them automatically at evaluation time.

---

## 5.4 Error Response Handling

Error responses require special consideration: they inherit input confidentiality by default (safe), but may need structured declassification to be useful.

### 5.4.1 Default Error Behavior (Safe)

When a request fails and no exchange rule fires, the error response inherits the **full input confidentiality**, including any authority-only tokens used in the request.

```typescript
// Example: Gmail API request fails
const request = {
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  headers: {
    Authorization: `Bearer ${oauthToken}`  // GoogleAuth(Alice) confidentiality
  }
};

const errorResponse = {
  status: 401,
  body: { error: { code: 401, message: "Invalid credentials" } }
};

// Default label (no exchange rule fired):
// errorResponse.confidentiality = [GoogleAuth(Alice), User(Alice)]
// This is SAFE - error cannot be displayed without declassification
```

This safe default prevents accidental leakage of error details that might reveal information about the authorization secret or the request parameters.

### 5.4.2 Structured Error Declassification

For errors to be useful (displayed to users, logged, used in retry logic), policies define **error exchange rules** that declassify structured error components.

**Variable binding**: The `$actingUser` variable in error exchange rules binds to the user attempting to access the error. The rule only fires when there's a user context—which is precisely when declassification is useful (someone needs to see the error). If there's no user context, the rule doesn't apply and the error retains full input confidentiality.

```typescript
interface ErrorExchangeRule {
  name: string;

  // When this rule applies
  preCondition: {
    // Must be an error response
    isError: true;
    // From this policy context
    policyPrincipal: AtomPattern;
    // Error type (optional - match specific errors)
    errorCode?: number | number[];
  };

  // What can be declassified
  declassification: {
    // Sanitized fields that can be released
    sanitizedFields: {
      path: string;           // JSON path in error response
      maxConfidentiality: Atom[];  // Target confidentiality
    }[];

    // Fields that must stay at full confidentiality
    retainedFields: string[];
  };

  // Required integrity for this declassification
  requiredIntegrity: AtomPattern[];
}
```

### 5.4.3 Example: Gmail Error Exchange Rules

```json
{
  "name": "GmailErrorDeclassification",
  "preCondition": {
    "isError": true,
    "policyPrincipal": { "type": "Policy", "name": "GoogleAuth", "subject": { "var": "$actingUser" } }
  },
  "declassification": {
    "sanitizedFields": [
      {
        "path": "/error/code",
        "maxConfidentiality": [{ "type": "User", "subject": { "var": "$actingUser" } }]
      },
      {
        "path": "/error/status",
        "maxConfidentiality": [{ "type": "User", "subject": { "var": "$actingUser" } }]
      },
      {
        "path": "/error/message",
        "maxConfidentiality": [{ "type": "User", "subject": { "var": "$actingUser" } }],
        "sanitizer": "error-message-sanitizer-v1"
      }
    ],
    "retainedFields": [
      "/error/details",
      "/headers"
    ]
  },
  "requiredIntegrity": [
    { "type": "AuthorizedRequest", "policy": { "var": "$policy" } },
    { "type": "NetworkProvenance", "tls": true }
  ]
}
```

**Result**: After this exchange rule fires:
- `error.code` and `error.status` become `User(Alice)` confidentiality (displayable)
- `error.message` is sanitized and becomes `User(Alice)` confidentiality
- `error.details` and response headers retain `GoogleAuth(Alice)` confidentiality (not displayable)

### 5.4.4 Error Message Sanitization

Raw error messages may contain sensitive information (query parameters, partial tokens, internal paths). Sanitization removes or redacts such content:

```typescript
interface ErrorSanitizer {
  // Unique identifier for this sanitizer
  id: string;

  // Patterns to redact from messages
  redactPatterns: {
    pattern: RegExp;
    replacement: string;
  }[];

  // Maximum length (truncate after)
  maxLength: number;

  // Whether to allow the original error type through
  preserveErrorType: boolean;
}

// Example sanitizer
const gmailErrorSanitizer: ErrorSanitizer = {
  id: "error-message-sanitizer-v1",
  redactPatterns: [
    { pattern: /Bearer [A-Za-z0-9._-]+/, replacement: "Bearer [REDACTED]" },
    { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, replacement: "[EMAIL]" },
    { pattern: /\/users\/[^\/]+/, replacement: "/users/[USER]" }
  ],
  maxLength: 200,
  preserveErrorType: true
};
```

### 5.4.5 Error Categories and Default Rules

Common error categories with suggested default handling:

| Error Category | Status Codes | Declassify | Notes |
|---------------|--------------|------------|-------|
| **Client errors** | 400, 422 | code, sanitized message | Request was malformed |
| **Auth errors** | 401, 403 | code only | Message may reveal auth state |
| **Not found** | 404 | code, sanitized message | Existence may be sensitive |
| **Rate limits** | 429 | code, retry-after header | Safe to expose |
| **Server errors** | 500-599 | code only | Details may reveal internals |

### 5.4.6 Error Integrity

Successfully declassified errors gain integrity marking their sanitization:

```typescript
interface SanitizedErrorIntegrity {
  type: "SanitizedError";
  originalErrorCode: number;
  sanitizer: string;      // Sanitizer ID used
  sanitizedAt: number;
  // Does NOT include original error content
}
```

This integrity atom indicates the error was properly processed through the sanitization pipeline, enabling downstream components to trust the error format without trusting arbitrary error content.

### 5.4.7 Policy Requirements

Every policy that authorizes requests **should** include error exchange rules. Without them:
- Error responses stay at full input confidentiality
- Users cannot see error messages
- Retry logic cannot inspect error codes
- Debugging becomes difficult

This is a **safe** default (no information leaks), but operationally limiting. Policy authors should explicitly consider error handling for their contexts.

---

## 5.5 Policy Certification Integrity

Policy certification adds integrity atoms that attest outputs were produced under specific policy constraints. This enables downstream consumers to require that data was processed according to certain rules.

### 5.5.1 The Core Concept

```
PolicyCertified { policy: PolicyID, enforcer: Principal }
```

**Distinction from code hash integrity**:
- `CodeHash(h)` → attests WHAT code ran
- `PolicyCertified(P)` → attests UNDER WHAT CONSTRAINTS code ran

The runtime automatically adds `PolicyCertified` atoms when computation occurs in a policy-governed context. Patterns don't explicitly request certification—it's a consequence of the execution environment.

### 5.5.2 How Certification Works

When the runtime executes a pattern under policy P:

1. **Policy enforcement**: Runtime enforces P's constraints during execution (e.g., blocks disallowed model calls, restricts network access)
2. **Automatic attestation**: If execution completes successfully under P, outputs automatically gain `PolicyCertified(P)`
3. **Verifiable log**: The attestation is recorded in the runtime's verifiable log (existing infrastructure)

```
Pattern executes under Policy("ApprovedModels"):
  - Pattern calls claude-3 ✓ (allowed)
  - Pattern calls random-model ✗ (blocked by policy)
  - Execution completes
  - Output gains: PolicyCertified(ApprovedModels, runtime)
```

### 5.5.3 Data Flow and Weakest Link

When computation mixes data from different policy contexts, certification follows the **weakest link** principle:

**Default rule**: Output is only certified for a policy if ALL inputs were processed under that policy.

```
Input A: PolicyCertified(ApprovedModels)
Input B: PolicyCertified(ApprovedModels)
Output:  PolicyCertified(ApprovedModels) ✓

Input A: PolicyCertified(ApprovedModels)
Input B: (no certification)
Output:  (no ApprovedModels certification)
```

**Fine-grained variant**: If the system tracks which output properties were influenced by which inputs, certification can be preserved for properties that only depend on certified inputs.

```
Output.summary: depends only on Input A → PolicyCertified(ApprovedModels)
Output.metadata: depends on Input B → (no certification)
```

### 5.5.4 Composing Multiple Certifications

Downstream patterns can require multiple policy certifications:

```typescript
// Pattern requires inputs certified under multiple policies
input: {
  analysis: {
    integrity: [
      "PolicyCertified(ApprovedModels)",
      "PolicyCertified(GDPRCompliant)"
    ]
  }
}
```

Both certifications must be present for the input to be accepted.

### 5.5.5 Example: ML Model Restrictions

**Policy definition**:
```
Policy "ApprovedModels":
  allowedModels: [gpt-4, claude-3, llama-3]
  requireLogging: true
  noFineTunedVariants: true (without explicit approval)
```

**Execution**:
```
Pattern runs, calls claude-3
  → Runtime verifies claude-3 ∈ allowedModels ✓
  → Runtime logs the call ✓
  → Execution completes
  → Output gains PolicyCertified(ApprovedModels)
```

**Downstream requirement**:
```typescript
// A pattern that only accepts model-certified analysis
interface CertifiedAnalysis {
  content: string;
  // @integrity PolicyCertified(ApprovedModels)
}

export default pattern<{ analysis: CertifiedAnalysis }, Report>({
  generateReport: ({ analysis }) => {
    // Can trust analysis used only approved models
    return { ... };
  }
});
```

### 5.5.6 Use Cases

| Policy Type | What It Certifies | Example Use |
|-------------|-------------------|-------------|
| **Model restrictions** | Only approved ML models influenced output | Enterprise AI governance |
| **Regulatory compliance** | Processing followed GDPR/HIPAA rules | Healthcare, finance |
| **Geographic constraints** | Computation ran in specific jurisdiction | Data sovereignty |
| **Audit requirements** | All access was logged | Compliance reporting |
| **Human oversight** | Human reviewed before release | High-stakes decisions |

### 5.5.7 Scope and Limitations

**What policy certification covers**:
- Constraints the runtime can enforce (model calls, network access, etc.)
- Rules that are mechanically verifiable during execution

**What it doesn't cover**:
- User actions outside the runtime (copy-paste, screenshots)
- Semantic correctness of the computation
- Constraints that require human judgment

**Trust model**: Policy certification is the runtime's attestation. It's as trustworthy as the runtime itself. The attestation is recorded in the verifiable log, providing an audit trail.

### 5.5.8 Retroactive Verification via Compute Receipts

The runtime produces **auditable compute receipts** that record the full execution trace. This enables retroactive policy verification:

1. **At execution time**: Runtime attests `PolicyCertified(P)` based on enforcement during execution
2. **After the fact**: Any party with access to the compute receipt can independently verify that policy P was followed

**Implications**:
- Policy certification isn't just "trust the runtime said so"—it's independently verifiable from the execution record
- Auditors can verify compliance without re-running the computation
- Disputes about whether a policy was followed can be resolved by inspecting the receipt
- New policies can be checked against historical computations (with caveats—see below)

**Retroactive policy application**:
```
Compute receipt from T=yesterday
New policy defined at T=today

Can verify: "Did yesterday's computation happen to satisfy today's policy?"
Cannot claim: "Yesterday's output was PolicyCertified(TodaysPolicy)"
  (certification requires policy to be in effect during execution)
```

The distinction matters: retroactive verification answers "did this satisfy constraints X?" but doesn't provide the same trust guarantees as execution-time enforcement (which could have blocked violations).

### 5.5.9 Relationship to Contextual Integrity

Policy certification maps to CI's transmission principles. A transmission principle like "medical data may only be processed by certified healthcare systems" translates to:

```
Exchange rule:
  pre: [MedicalData]
  guard: [PolicyCertified(HealthcareCertified)]
  post: [MedicalData, ProcessedByHealthcare]
```

The certification provides the integrity evidence that the transmission principle was satisfied.

---

## 5.6 Provenance Integrity (Fetched Data)

Confidentiality controls who may *learn* a value; integrity controls what may be *believed* about a value. For data fetched from external services, CFC uses provenance integrity to make explicit which claims are justified by trusted transport and trusted parsing.

### 5.6.1 Network Provenance (Transport Evidence)

The `fetch` boundary emits a non-malleable integrity fact describing how the response was obtained:

```
NetworkProvenance{
  host,
  tls,
  tlsCertHash?,
  requestDigest,
  time,
  codeHash
}
```

This fact is minted only by trusted runtime code and binds the response to:
- the intended destination (`host` / origin),
- the security of the transport (`tls`, optional `tlsCertHash`),
- the endorsed request semantics (`requestDigest`),
- and the runtime implementation (`codeHash`).

### 5.6.2 Schema-Validated Parsing (Translator Evidence)

Policies SHOULD require that responses are translated by trusted components before integrity is attached. Typical translation steps include:
- content-type checks,
- schema validation,
- normalization/canonicalization,
- and strict rejection of unexpected fields.

The translator may emit a parsing/translation integrity fact:

```
TranslatedBy{
  endpointClass,
  schemaId,
  translatorHash,
  evidence
}
```

### 5.6.3 Provider-Origin Claims (Optional, Conditional)

Some external data supports stronger origin claims (e.g., "this email was authored by sender X") but these claims are *conditional* on trusting the provider as an intermediary.

Example (email):

```
AuthoredBy{ messageId, sender=did:mailto:sender@example.com, provider=Gmail, evidence }
TrustedProvider(Gmail)  ⊓  AuthoredBy(...)  ⇒  I_sender_authored(did:mailto:sender@...)
```

This keeps the trust assumption explicit: if the system does not trust Gmail as a provider, it MUST NOT treat `AuthoredBy` as establishing sender-authorship integrity.

### 5.6.4 How Policies Use Provenance Integrity

Policies commonly require provenance integrity as a guard for confidentiality exchange:

- **Authority-only token untainting**: only drop/relax authority-only secrecy when the endorsed request and network provenance facts are present ([§5.3](#53-confidentiality-exchange)).
- **Error declassification**: only declassify structured error fields when `AuthorizedRequest` and `NetworkProvenance` prove the error is from the expected destination ([§5.4](#54-error-response-handling)).
- **Safe derived facts**: only mint derived integrity (e.g., extracted attributes) when upstream provenance integrity is present.

### 5.6.5 Non-Goals

Provenance integrity does NOT claim:
- that the remote service is honest,
- that the response content is semantically correct,
- or that transport/parsing is free of side channels.

It claims only what the trusted boundary can justify: where the bytes came from and which trusted components processed them.
