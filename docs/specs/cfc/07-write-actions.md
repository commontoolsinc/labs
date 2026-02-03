# 7. Write Actions

CFC handles side effects through intent as integrity, canonicalization for binding, and idempotency for safe retries.

## 7.1 Intent as Integrity

User intent is modeled as integrity-bearing events and capabilities. Two kinds are distinguished:

- **Event-scoped (consumable) intent**: authorizes a single action (e.g. "send this message now").
- **State-scoped (persistent) intent**: authorizes a durable policy change (e.g. "share with my friends").

Event-scoped intent is represented as an unforgeable, single-use capability (`IntentOnce`) and must be **consumed at a commit point** for the action to occur.

State-scoped intent is represented as a durable policy update (confidentiality label rewrite or policy-store state).

---

## 7.2 Refinement Pipeline

The system supports trusted refinement of intents into more precise, consumable forms. This enables:

- a user-facing intent (e.g. button click) to be progressively compiled into an exact side-effect authorization,
- reuse of generic UI intents across multiple implementations,
- correct retry logic by controlling where consumption occurs.

### 7.2.1 Intent Forms

1) **User event intent** (`IntentEvent`):

- minted by trusted UI code (hash-identified),
- human-meaningful, potentially underspecified,
- not directly consumable by sinks.

Example:

- `ForwardClicked{ emailId, recipientSet, uiContext }`

2) **Consumable sink intent** (`IntentOnce`):

- single-use, bound to specific sink/action parameters,
- consumable only at designated commit points.

Example:

- `IntentOnce{ op=Gmail.Forward, audience=gmail.googleapis.com, payloadDigest, exp, nonce }`

### 7.2.2 Refinement Rule

A refinement component `refine_intent` consumes a source intent and produces a more precise intent:

- Input: `IntentEvent` (or a higher-level `IntentOnce`)
- Output: `IntentOnce` for the target sink

The refinement is justified by integrity:

- the code hash of the refinement component,
- and a binding between:
  - source intent fields,
  - derived sink parameters,
  - payload digest.

Refinement is consumptive: the source intent is marked as spent once a derived intent is minted, preventing double-spend across alternative refinements.

---

## 7.3 Canonicalization and Binding

Robust binding requires canonical representations for intent payloads and request semantics. This section defines canonicalization rules sufficient to:

- prevent intent theft or repurposing,
- stabilize idempotency across retries,
- avoid malleability in request digests,
- and make policy checks deterministic.

### 7.3.1 Canonical Encoding

All canonical objects are serialized using:

- deterministic field ordering,
- explicit type tags,
- explicit null/absent handling,
- UTF-8 for strings,
- normalized Unicode (NFC) for user-provided text,
- and a stable binary-to-text encoding where required.

Hashes use a fixed algorithm `H(·)` (e.g., BLAKE3) over canonical bytes.

### 7.3.2 ForwardPlan Canonicalization

`ForwardPlan` represents the semantic meaning of a forward action, independent of wire encoding.

Fields (canonical form):

- `type = "ForwardPlan"`
- `account = Alice` (stable user identifier)
- `sourceEmailId` (opaque string)
- `sourceThreadId` (optional)
- `recipientSet`:
  - `to`: sorted list
  - `cc`: sorted list
  - `bcc`: sorted list
- `includePolicy`:
  - whether body is included
  - whether attachments are included
  - which MIME parts are included if selective
- `subjectPolicy`:
  - e.g., prefix rules such as `"Fwd: "`
- `userNoteDigest`:
  - `H(c14n(UserNote))` or empty
- `renderingVersion`:
  - identifies the formatting rules used to construct the RFC 2822 message

Normalization rules:

- Email addresses are lowercased where appropriate and normalized (punycode for domains).
- Recipient lists are deduplicated and sorted.
- Optional fields must be explicitly absent vs empty.
- `renderingVersion` must be included to prevent semantic drift across code updates.

The intent binding uses:

- `payloadDigest = H(c14n(ForwardPlan))`.

### 7.3.3 RequestSemantics Canonicalization

`RequestSemantics` captures the policy-relevant meaning of an HTTP request.

Fields (canonical form):

- `type = "RequestSemantics"`
- `method` (uppercase)
- `origin` (scheme + host + port)
- `path` (normalized)
- `endpointClass` (policy-defined stable name)
- `queryParams`:
  - only include parameters declared "data-bearing" by policy
  - canonicalized as sorted key/value lists
- `headers`:
  - include only headers declared data-bearing by policy
  - explicitly exclude authority-only headers (e.g., Authorization) when policy permits
- `bodyDigest`:
  - digest of canonical request body semantics
- `idempotencyKey`:
  - if used, included here and in the digest

Notes:

- Policies define which fields are authority-only vs data-bearing.
- If a value appears in an unauthorized location (e.g., token in query), endorsement must fail.

### 7.3.4 AuthorizedRequest Digest

`AuthorizedRequest.requestDigest = H(c14n(RequestSemantics))`.

Endorsement binds:

- `policy principal` (e.g., `GoogleAuth(Alice)`)
- `user`
- `endpointClass`
- `requestDigest`
- `codeHash`

The endorsement must also check compatibility with a supplied `IntentOnce`:

- `IntentOnce.payloadDigest == RequestSemantics.bodyDigest` (or equals a body-derived digest)
- `IntentOnce.recipientSet == RequestSemantics.recipientSet` (if represented)
- `IntentOnce.idempotencyKey == RequestSemantics.idempotencyKey`

### 7.3.5 IntentOnce Canonicalization

`IntentOnce` is canonicalized similarly, including:

- `type = "IntentOnce"`
- `op`, `subject`, `audience`, `endpointClass`
- `scope` (e.g., `emailId`)
- `recipientSet`
- `payloadDigest`
- `idempotencyKey`
- `exp`, `maxAttempts`

`IntentOnce.digest = H(c14n(IntentOnce))` may be used for auditing and internal indexing.

### 7.3.6 Derived Data Integrity and Return-to-Sender Release

CFC supports deriving new facts from high-integrity sources and using those facts to justify narrowly scoped releases back to parties who already possessed them.

#### 7.3.6.1 Extracted attribute claims

A trusted extractor may produce an integrity fact asserting that a derived value was correctly extracted from a trusted source:

- `ExtractedAttribute{ kind, valueDigest, sourceMessageId, sourceSender, extractorHash, evidence }`

Example:

- `ExtractedAttribute{ kind="HotelMembershipNumber", valueDigest=H(number), sourceMessageId=m, sourceSender=did:mailto:hotel@example.com, extractorHash=h_extract, evidence=... }`

This fact should be guarded by:

- provenance integrity (e.g., `AuthoredBy{..., sender=did:mailto:hotel@example.com}`),
- and extractor correctness assumptions (extractor hash is trusted for this extraction kind).

#### 7.3.6.2 Confidentiality labeling of derived values

A derived value (e.g., membership number) carries confidentiality appropriate to the subject/user by default, e.g.:

- `S_number = { User(Alice), Ctx.Email(Alice) }`

Optionally, a context-specific atom may be added (e.g., `HotelMembershipSecret(Alice)`), but the default is user secrecy.

#### 7.3.6.3 Return-to-sender declassification path

Policies may define a declassification path allowing release of a derived value to the original sender, under integrity guard:

- Preconditions:
  - `ExtractedAttribute{ kind=HotelMembershipNumber, sourceSender=S }`
  - and/or `AuthoredBy{ sender=S }`
- Guard:
  - user intent (event-scoped) to transmit the number to the sender principal,
  - **late-bound verification** that the destination audience represents that principal (verified at send time, not stored).

This corresponds to a CI transmission principle of reciprocity/return-to-origin: the recipient is a party who already knew the information.

#### 7.3.6.4 Late Binding for Audience Verification

**Critical**: Audience-to-principal bindings must be verified **at send time**, not cached or stored early. This prevents staleness attacks where:
- Domain ownership changes
- API endpoints migrate
- TLS certificates rotate

The membership number's confidentiality label references the **sender principal** (e.g., `did:mailto:hotel@example.com`), NOT the audience URL. Only at the commit point does the runtime verify the audience represents that principal.

```typescript
interface AudienceVerification {
  // The principal that must control the audience
  requiredPrincipal: DID;

  // The target audience to verify
  audience: string;

  // Verification performed at send time
  verification: {
    // When this verification was performed
    verifiedAt: number;

    // How verification was done
    method: "dns-txt" | "well-known" | "tls-cert" | "oauth-discovery";

    // Evidence (for audit)
    evidence: {
      // DNS TXT record or well-known document
      record?: string;
      // TLS certificate hash if verified
      tlsCertHash?: string;
      // OAuth authorization server metadata
      oauthMetadata?: string;
    };

    // Short validity window (e.g., 5 minutes)
    validUntil: number;
  };
}

// Verification happens at commit time, not before
async function verifyAudienceAtCommit(
  principal: DID,
  audience: string
): Promise<AudienceVerification | null> {
  // Fresh verification - no caching
  const now = Date.now();

  // Try verification methods in order
  for (const method of ["well-known", "dns-txt", "oauth-discovery"]) {
    const evidence = await fetchVerificationEvidence(audience, method);
    if (evidence && evidence.claimedPrincipal === principal) {
      return {
        requiredPrincipal: principal,
        audience,
        verification: {
          verifiedAt: now,
          method,
          evidence,
          validUntil: now + 5 * 60 * 1000  // 5 minute window
        }
      };
    }
  }

  return null;  // Verification failed - cannot send
}
```

#### 7.3.6.5 Verification Endpoint Specifications

Each verification method has a defined format:

**1. Well-Known Endpoint (`/.well-known/cfc-principal`)**

The audience host serves a JSON document at `https://{host}/.well-known/cfc-principal`:

```json
{
  "version": 1,
  "principals": [
    {
      "did": "did:mailto:hotel@example.com",
      "proof": {
        "type": "dns-txt",
        "record": "_cfc.example.com"
      }
    },
    {
      "did": "did:web:example.com",
      "proof": {
        "type": "self",
        "note": "Implicitly valid for did:web matching this domain"
      }
    }
  ],
  "expires": 1735689600
}
```

**Requirements**:
- MUST be served over HTTPS with valid certificate
- Content-Type: `application/json`
- `expires` is Unix timestamp; document must be re-fetched after expiry
- Each principal entry may include a `proof` object for cross-verification

**2. DNS TXT Record (`_cfc.{domain}`)**

A TXT record at `_cfc.{domain}` contains principal claims:

```
_cfc.example.com.  IN TXT "cfc=1 did=did:mailto:hotel@example.com"
_cfc.example.com.  IN TXT "cfc=1 did=did:web:example.com"
```

**Format**: `cfc=1 did={DID} [expires={unix-timestamp}]`

**Requirements**:
- Multiple TXT records may exist (one per principal)
- `cfc=1` is the version identifier
- `expires` is optional; if absent, record is valid until DNS TTL
- DNSSEC is RECOMMENDED for high-security deployments

**3. OAuth Authorization Server Metadata**

For OAuth-protected APIs, the authorization server metadata (`/.well-known/oauth-authorization-server`) may include CFC principal bindings:

```json
{
  "issuer": "https://auth.example.com",
  "authorization_endpoint": "...",
  "token_endpoint": "...",
  "cfc_principals": [
    {
      "did": "did:mailto:hotel@example.com",
      "resource_servers": ["https://api.hotel.example.com"]
    }
  ]
}
```

**Requirements**:
- Extension field `cfc_principals` is an array of principal-to-resource bindings
- Each entry lists which resource servers represent that principal

**4. TLS Certificate (Fallback)**

When no explicit CFC metadata exists, the runtime MAY use TLS certificate validation as weak evidence:

- `did:web:{domain}` is assumed valid if the domain's TLS certificate is valid
- `did:mailto:{user}@{domain}` requires explicit DNS or well-known proof (email cannot be verified from TLS alone)

This is the weakest verification method and SHOULD only be used when stronger methods are unavailable.

**Verification Priority**:

Implementations SHOULD try methods in this order:
1. `well-known` (most explicit)
2. `dns-txt` (domain-level proof)
3. `oauth-discovery` (for OAuth-protected resources)
4. `tls-cert` (fallback, did:web only)

#### 7.3.6.6 Worked Example: Hotel Membership Number Return

**Scenario:**

- Alice receives an email from `hotel@example.com` containing a membership number.
- The system extracts the membership number.
- Alice later chooses "Send membership number to hotel".

**Step A — Gmail provenance integrity**

From [§5.6](./05-policy-architecture.md#56-provenance-integrity-fetched-data), the runtime has minted:

- `AuthoredBy{ messageId=m, sender=did:mailto:hotel@example.com, provider=Gmail, ... }`
- and (when trusted): `I_sender_authored(did:mailto:hotel@example.com)`.

**Step B — Extraction integrity**

A trusted extractor produces:

- `ExtractedAttribute{ kind="HotelMembershipNumber", valueDigest=H(num), sourceMessageId=m, sourceSender=did:mailto:hotel@example.com, extractorHash=h_extract, ... }`

Policy assumes `h_extract` is trusted for this extraction kind.

**Step C — Data remains labeled with sender principal**

The extracted membership number carries confidentiality:

- `S_number = { User(Alice), AuthoredBy(did:mailto:hotel@example.com) }`

Note: **No `AudienceRepresents` binding is created yet.** The data is labeled with the sender principal, not any specific API endpoint.

**Step D — User intent and refinement**

A UI condition emits an intent event:

- `IntentEvent{ action="SendMembershipNumber", parameters={ valueDigest=H(num), targetPrincipal=did:mailto:hotel@example.com }, evidence=..., exp, nonce }`

Note: Intent references the **principal**, not a specific URL. The user is authorizing "send to hotel", not "send to api.hotel.example.com".

A refinement step mints:

- `IntentOnce{ op=Hotel.SendMembershipNumber, targetPrincipal=did:mailto:hotel@example.com, payloadDigest=H(c14n({num})), idempotencyKey, exp, maxAttempts }`

**Step E — Late-bound audience verification at commit**

At the commit point, `endorse_request` performs **fresh semantic verification** (structural checks — token placement — are handled by the sink gate's sink-scoped exchange rules):

1. Determine candidate audience URL (from UI selection or discovery)
2. **Verify at this moment** that the URL represents the target principal:
   - Check `https://api.hotel.example.com/.well-known/cfc-principal`
   - Or verify DNS TXT record for `hotel.example.com`
   - Or check OAuth authorization server metadata
3. Only if verification succeeds AND is fresh (< 5 minutes), authorize the request

```typescript
// At commit time
const verification = await verifyAudienceAtCommit(
  intent.targetPrincipal,  // did:mailto:hotel@example.com
  selectedAudience         // https://api.hotel.example.com
);

if (!verification) {
  return { error: "audience_verification_failed" };
}

// Proceed with endorsed request
```

The sink (`fetch`) commits only when success criteria are met.

**Resulting policy justification (CFC/CI):**

The release is justified because:

- the value was derived from a message authored by the hotel sender principal,
- **at the moment of sending**, the destination audience was verified to represent that same principal,
- the verification is fresh (not stale/cached),
- and the user provided explicit event-scoped intent.

---

## 7.4 Idempotency and Retry

External side effects are commonly subject to partial failure (timeouts, lost responses, duplicate delivery). This system supports safe retries without introducing double-send behavior.

### 7.4.1 Idempotency-Keyed Commit

A derived `IntentOnce` may include an `idempotencyKey` (nonce) that is carried into the request in a policy-approved field. The key is bound into:

- `IntentOnce.idempotencyKey`
- `RequestSemantics.idempotencyKey`
- `AuthorizedRequest.requestDigest`

The sink treats multiple attempts with the same key as the same logical action.

### 7.4.2 Commit Conditions

Policies define commit conditions per endpoint. Typical conditions:

- HTTP status class (e.g., 2xx)
- Response schema validation
- Server confirmation sufficient to deduplicate retries

Where servers do not provide explicit idempotency semantics, policies must be conservative:

- cap attempts,
- keep windows short,
- and require user re-authorization beyond the window.

### 7.4.3 Replay and Abuse Bounds

To prevent replay or brute-force retry abuse:

- `IntentOnce.exp` bounds time,
- `IntentOnce.maxAttempts` bounds retries,
- and refined intents should be audience- and payload-bound.

---

## 7.5 Commit Points

Sinks that perform side effects (e.g. `fetch` for write endpoints) are commit points. A commit point:

- requires a matching `IntentOnce`,
- atomically consumes it if and only if the effect is considered committed.

To support retries and failure handling, commit semantics distinguish:

- **attempt**: a network request is sent, but no consumption occurs yet,
- **commit**: success criteria are satisfied (policy-defined), and the intent is consumed.

Success criteria are endpoint-specific and may include:

- HTTP status class,
- response schema validation,
- server-provided idempotency confirmation.

### 7.5.1 Retry Semantics

Retries are safe if and only if intent consumption is coupled to a commit condition.

Two supported patterns:

1) **No-consume-on-failure** (default)
   - intent is consumed only on successful commit.
   - failures leave the intent unconsumed, allowing retry.

2) **Idempotency-keyed commit** (recommended for external APIs)
   - derived `IntentOnce` includes an idempotency key (nonce) placed in a safe request field.
   - the sink treats repeated attempts with the same key as the same logical action.

To avoid replay abuse, retries must be bounded by:

- expiration (`exp`),
- maximum attempts (policy-defined),
- and/or explicit user re-authorization if the window lapses.

### 7.5.2 Write Endpoints

Write actions (e.g. `messages.send`, `messages.modify`, "forward") are side effects that require:

1. Appropriate confidentiality (data may flow to the sink)
2. Authorized request integrity
3. A matching consumable intent (`IntentOnce`) that is consumed at the final sink commit

Only when all three are satisfied may the side effect occur.
