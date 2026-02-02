# 1. Gmail OAuth Example

## 1.1 Token

```
S_token = { User(Alice), GoogleAuth(Alice) }
```

`GoogleAuth(Alice)` policy defines:

- Egress allowed only to `https://gmail.googleapis.com/...` via Authorization header.
- Authority-only classification for the token.

---

## 1.2 Read: List Messages (No Query)

Request:

```
GET https://gmail.googleapis.com/gmail/v1/users/me/messages
Authorization: Bearer <token>
```

Steps:
1. `endorse_request` emits `AuthorizedRequest{policy=GoogleAuth(Alice), endpoint=messages.list}`.
2. `fetch` performs request and emits `NetworkProvenance`.
3. Policy exchange rule fires:

```
{ User(Alice), GoogleAuth(Alice) }
  + AuthorizedRequest + NetworkProvenance
==>
{ User(Alice), EmailMetadataSecret(Alice) }
```

The response does **not** inherit `GoogleAuth(Alice)` secrecy.

Integrity: responses from Gmail may also carry **provenance integrity** (see [§5.6](./05-policy-architecture.md#56-provenance-integrity-fetched-data)) indicating that message fields originate from Gmail under trusted transport and parsing.


---

## 1.3 Read: Search with Secret Query

If a secret query `q` is included:

```
S_q = { NotesSecret(Alice) }
```

Request is endorsed only if the query is bound to Alice's authorization.

Response label becomes:

```
{ User(Alice), EmailMetadataSecret(Alice), NotesSecret(Alice) }
```

The query secrecy taints the response; the token does not.

---

## 1.4 Write: Forward (UI Evidence, Intent Refinement, Endorsement, Commit)

This example shows how an event-scoped action compiles from UI interaction into a precise, consumable authorization for a Gmail write endpoint.

### 1.4.1 Gmail Forward VDOM Illustration (Labeled)

The UI is rendered from a labeled VDOM. The following is an illustrative shape (not a required concrete syntax).

**Bound data (labeled):**

- `email`: labeled value representing the message being viewed
  - `email.id` (opaque string)
  - `email.threadId` (optional)
  - `email.headers.subject`
  - `email.body` (may be more sensitive than metadata)
  - `S_email = { User(Alice), EmailSecret(Alice, participants(email)) }`
- `recipientInput`: labeled user input value (string)
  - `S_recipientInput = { User(Alice) }`

**VDOM sketch:**

```json
{
  "type": "EmailView",
  "nodeId": "view:email:123",
  "props": {
    "emailRef": {"valueDigest": "H(email)", "labelSummary": "S_email"}
  },
  "children": [
    {
      "type": "EmailHeader",
      "nodeId": "hdr:subject",
      "props": {
        "textRef": {"valueDigest": "H(email.headers.subject)", "labelSummary": "S_email"}
      }
    },
    {
      "type": "EmailBody",
      "nodeId": "body",
      "props": {
        "contentRef": {"valueDigest": "H(email.body)", "labelSummary": "S_email"}
      }
    },
    {
      "type": "TextInput",
      "nodeId": "input:recipient",
      "props": {
        "valueRef": {"valueDigest": "H(recipientInput)", "labelSummary": "S_recipientInput"},
        "placeholder": "Forward to…"
      }
    },
    {
      "type": "Button",
      "nodeId": "btn:forward",
      "props": {
        "action": "ForwardClicked",
        "enabled": true
      },
      "children": [{"type": "Text", "props": {"text": "Forward"}}]
    }
  ]
}
```

The trusted UI runtime computes:

- `snapshotDigest = H(c14n(vdomTree + boundValueDigests + labelSummaries))`.

Label summaries may include confidentiality atoms and selected integrity atoms but not raw secret content.

---

### 1.4.2 Declarative Condition: Recognize ForwardClicked

A trusted declarative condition `Cond.ForwardClicked` recognizes the semantic action and mints a high-integrity intent event.

**Inputs:**

- `UIEvent` produced by trusted UI runtime, including `targetNodeId` and `snapshotDigest`.
- current labeled bindings referenced by the snapshot for:
  - `email.id` (and `threadId` if present)
  - `recipientInput`
- the rendered node metadata for `btn:forward`, including `action="ForwardClicked"`.

**Condition checks:**

1. `UIEvent.kind == "click"`.
2. `UIEvent.targetNodeId == "btn:forward"`.
3. In the referenced snapshot, the target node has `props.action == "ForwardClicked"` and `enabled == true`.
4. Extract and normalize recipients from `recipientInput`:
   - normalize Unicode, trim whitespace,
   - parse one or more recipients,
   - normalize email addresses (lowercase where appropriate, punycode domain),
   - deduplicate and sort.
5. Ensure recipients are non-empty and within policy bounds (e.g. max count).
6. Extract `emailId` (and `threadId` if present) from the rendered email binding.
7. Assemble evidence:
   - `snapshotDigest`,
   - `targetNodeId`,
   - value digests for `emailId` and normalized `recipientSet`,
   - label summaries for the referenced bindings (`S_email`, `S_recipientInput`).

**Output (high-integrity intent event):**

- `IntentEvent{ action="ForwardClicked", parameters={ emailId, threadId?, recipientSet }, evidence, exp, nonce }`

The intent event integrity includes the trusted UI runtime hash and the condition identity.

Notes:

- The condition is *not* arbitrary application code; it is treated as part of the trusted runtime/policy layer.
- The intent event does not include secret email body bytes; it includes stable identifiers/digests and label summaries.

---

### 1.4.3 User intent event

A trusted UI runtime + condition mint a user-event intent:

- `ForwardClicked{ emailId, recipientSet, uiContext, snapshotDigest, nonceUi, expUi }`

This intent is not directly consumable by sinks.

### 1.4.4 Intent refinement into a consumable sink capability

A trusted refinement component `refine_intent_forward` consumes `ForwardClicked` and mints:

- `IntentOnce{ op=Gmail.Forward, subject=Alice, audience=https://gmail.googleapis.com, endpoint=gmail.messages.send, emailId, recipientSet, payloadDigest, idempotencyKey, exp, maxAttempts }`

Binding requirements:

- `emailId` binds the intent to a specific source message.
- `recipientSet` binds the intent to a specific set of recipients.
- `audience` and `endpoint` bind the intent to a specific service and operation.
- `payloadDigest = H(c14n(ForwardPlan))` binds the intent to the semantic content of the forward.
- `idempotencyKey` provides stable identity for retries.

The refinement step emits an integrity fact binding source intent to derived intent:

- `IntentRefined{ from=ForwardClicked, to=IntentOnce, codeHash=h_refine, digest=H(...) }`

Refinement is consumptive: once an `IntentOnce` is minted, the source `ForwardClicked` is marked spent.

### 1.4.5 Constructing and endorsing the Gmail request

A request constructor builds a specific API call consistent with the intent. A common implementation uses:

- `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`
- `Authorization: Bearer <token>`
- request body containing a raw RFC 2822 message (base64url), constructed according to `ForwardPlan`.

The trusted `endorse_request` step must:

1. Verify token label contains `GoogleAuth(Alice)`.
2. Verify endpoint and method match `gmail.messages.send`.
3. Verify the token appears only in the Authorization header.
4. Compute `requestDigest = H(c14n(RequestSemantics))`.
5. Verify the request semantics match the `IntentOnce` bindings:
   - `RequestSemantics.audience == IntentOnce.audience`
   - `RequestSemantics.endpointClass == IntentOnce.endpoint`
   - `RequestSemantics.emailId == IntentOnce.emailId` (if represented explicitly)
   - `RequestSemantics.recipientSet == IntentOnce.recipientSet`
   - `RequestSemantics.bodyDigest == IntentOnce.payloadDigest` (or a policy-defined equivalence)
   - `RequestSemantics.idempotencyKey == IntentOnce.idempotencyKey`

If successful, endorsement emits:

- `AuthorizedRequest{ policy=GoogleAuth(Alice), user=Alice, endpoint=gmail.messages.send, requestDigest, codeHash=h_endorse }`

### 1.4.6 Fetch as commit point with retries

The `fetch` sink is the commit point for this write action:

- It requires a matching unconsumed `IntentOnce`.
- It performs the network request.
- It consumes `IntentOnce` only on commit.

Commit success criteria for `gmail.messages.send` are policy-defined; minimally:

- HTTP 2xx,
- response schema validation (e.g., contains `id`),
- and (if available) confirmation consistent with the idempotency key.

On failure (network error, non-2xx, schema invalid), the intent remains unconsumed, allowing retry up to `maxAttempts` before `exp`.

### 1.4.7 Result labeling

The response from a send/forward call is typically metadata (message id, thread id). It is labeled according to mailbox/resource policy, not token policy:

- `{ User(Alice), EmailSentMetadataSecret(Alice) }`

If additional secrets (e.g., confidential recipient selection derived from private notes) influenced the forward plan, those secrets taint the request and therefore taint the resulting metadata.

## 1.5 Incorrect Usage: Token in Query

If the token appears outside the Authorization header:

- `endorse_request` fails or emits no integrity fact.
- No exchange rule may fire.
- Response confidentiality conservatively includes `GoogleAuth(Alice)`.

---

## 1.6 Email Provenance Integrity (Sender-Authored Claims)

In addition to confidentiality, CFC may attach integrity claims to Gmail-derived email objects. These claims capture what the system is justified in believing about the *origin* of the data.

### 1.6.1 Sender principal

Let sender identity be represented as a principal:

- `did:mailto:sender@example.com`

This principal can appear in integrity labels and facts.

### 1.6.2 Gmail-backed provenance fact

When an email `m` is fetched from Gmail and parsed by trusted components, the runtime may mint a provenance integrity fact of the form:

- `AuthoredBy{ messageId, sender=did:mailto:sender@example.com, context=Ctx.Email(Alice), provider=Gmail, evidence }`

Where `evidence` binds:

- the Gmail endpoint class used,
- the network provenance,
- parsing/normalization component hashes,
- and the extracted sender header field(s).

### 1.6.3 Trust conditional on provider

The system may treat `AuthoredBy` as conditionally trusted under a provider trust assumption:

- `TrustedProvider(Gmail)` (or `TrustedProvider(Google)`) is an integrity atom.

Policies can then express rules such as:

- `TrustedProvider(Gmail) ⊓ AuthoredBy(...)  ⇒  I_sender_authored(did:mailto:sender@...)`

This makes sender-authorship integrity explicitly dependent on trusting Gmail as the delivery/authentication intermediary.

### 1.6.4 Binding sender principals to network audiences

To support "return-to-sender" releases and other flows where a sender principal authorizes a network destination, CFC introduces a mapping from identity principals to network audiences.

**Goal:** justify that a destination `audience` (host/origin) is controlled by, or appropriately represents, a principal such as `did:mailto:hotel@example.com`.

CFC supports one or more of the following binding mechanisms. Policies may require stronger or weaker bindings depending on risk.

1) **Domain-based binding (organizational policy)**

A policy record may declare an explicit mapping:

- `PrincipalAudienceMap{ principal=did:mailto:hotel@example.com, audiences=[https://api.hotel.example.com, https://hotel.example.com] }`

This is suitable where the application or user explicitly configures trusted destinations.

2) **PKI/TLS binding (certificate subject constraints)**

A trusted verifier may emit:

- `AudienceBoundToDomain{ audience=https://api.hotel.example.com, domain=hotel.example.com, evidence }`

and a mapping rule may relate mail domains to service domains (e.g., `example.com`).

3) **DID/VC binding (recommended for generality)**

A verifiable credential (or equivalent attestation) can bind an email identity to one or more service endpoints:

- `EndpointCredential{ subject=did:mailto:hotel@example.com, endpoints=[https://api.hotel.example.com], issuer=..., exp=... }`

A trusted verifier emits:

- `VerifiedEndpointBinding{ principal=did:mailto:hotel@example.com, audience=https://api.hotel.example.com, evidence }`

4) **Provider-mediated binding (email provider assertions)**

Where available, provider assertions (e.g., verified sender programs) may be used as additional evidence, but policies should treat these as weaker unless explicitly trusted.

**Uniform integrity fact:** regardless of mechanism, flows should rely on a normalized integrity predicate:

- `AudienceRepresents{ principal=did:mailto:hotel@example.com, audience=https://api.hotel.example.com }`

This fact is minted only when sufficient evidence is verified under trusted code.

Policies may then express return-to-sender rules requiring `AudienceRepresents`.
