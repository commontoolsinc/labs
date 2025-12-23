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

The system decomposes network access into three explicit stages:

### 5.2.1 Request Endorsement

A trusted component `endorse_request` verifies that a request complies with the policy of a policy principal present in the request's inputs.

Checks typically include:

- token carries the expected policy principal (e.g. `GoogleAuth(Alice)`),
- request host/path/method matches allowed endpoint class,
- secret appears only in permitted locations (e.g. Authorization header),
- no unsafe features (e.g. redirects, header reflection).

If successful, the component emits an integrity fact:

```
AuthorizedRequest{
  policy = GoogleAuth(Alice),
  user = Alice,
  endpoint = E,
  request_digest = D,
  code_hash = h_endorse
}
```

This step performs no I/O.

### 5.2.2 Fetch (Transport)

A separate `fetch` component performs the actual network request.

Inputs:
- endorsed request,
- associated integrity fact(s).

Outputs:
- response data,
- `NetworkProvenance{host, tls, code_hash}` integrity fact.

`fetch` itself does not assign final confidentiality labels; it only enforces that an endorsed request is present.

### 5.2.3 Response Translation

A trusted policy interpreter evaluates whether policy exchange rules may fire.

Given:
- policy principal in the input labels,
- `AuthorizedRequest` integrity fact,
- network provenance integrity,

it may rewrite confidentiality labels according to policy-defined exchange rules.

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

```
(pre_atoms, guard_integrity)  ==>  post_atoms
```

Meaning: if `pre_atoms` are present in the label, and `guard_integrity` facts are present, the label may be rewritten to `post_atoms`.

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

**Variable binding**: The `$user` variable in error exchange rules binds to the user attempting to access the error. The rule only fires when there's a user context—which is precisely when declassification is useful (someone needs to see the error). If there's no user context, the rule doesn't apply and the error retains full input confidentiality.

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
    "policyPrincipal": { "type": "Policy", "name": "GoogleAuth" }
  },
  "declassification": {
    "sanitizedFields": [
      {
        "path": "/error/code",
        "maxConfidentiality": [{ "type": "User", "subject": { "var": "$user" } }]
      },
      {
        "path": "/error/status",
        "maxConfidentiality": [{ "type": "User", "subject": { "var": "$user" } }]
      },
      {
        "path": "/error/message",
        "maxConfidentiality": [{ "type": "User", "subject": { "var": "$user" } }],
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
