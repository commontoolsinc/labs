# CT Protocol: Append-Only Log & Authorization (Sections 8–9)

See `docs/specs/verifiable-execution/README.md` for navigation.

## 8. Append-Only Log

### 8.1 Mandatory Global Log

All facts MUST be included in a **single append-only log per space** maintained
by the server for that space.

The log provides:
- A total order over all facts
- Efficient inclusion proofs
- A global consistency anchor for time, authorization, and delegation state

### 8.2 Server Role

The server's role is **intentionally constrained**: it establishes order and
publishes checkpoints. It does not decide who is authorized or whether a fact is
correct; it merely records that a fact was observed at a particular position in
history.

This separation is fundamental: **servers order but do not authorize.**

### 8.3 Storage Schema

Current implementation uses SQLite:

```sql
-- JSON data (deduplicated by content hash)
CREATE TABLE datum (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference
  source  JSON                        -- The actual JSON
);

-- Fact history (append-only)
CREATE TABLE fact (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference for {the, of, is, cause}
  the     TEXT NOT NULL,              -- Media type
  of      TEXT NOT NULL,              -- Entity URI
  "is"    TEXT NOT NULL,              -- Reference to datum (or "undefined")
  cause   TEXT,                       -- Reference to prior fact (or unclaimed reference for genesis)
  since   INTEGER NOT NULL            -- Lamport clock
);

-- Current state (mutable pointer to latest fact)
CREATE TABLE memory (
  the     TEXT NOT NULL,
  of      TEXT NOT NULL,
  fact    TEXT NOT NULL,              -- Reference to current fact
  PRIMARY KEY (the, of)
);
```

### 8.4 Why Ordering Matters

Receipts gain much of their power from ordering. Authorization changes over
time. Delegations are granted and revoked. Policies evolve. By anchoring each
receipt to a position in an immutable sequence, the CT Protocol allows verifiers
to answer time-sensitive questions precisely:

- _Was this signer authorized at the moment this change occurred?_
- _Which policy was in force when this computation ran?_

Without temporal grounding, trust collapses into a perpetual present, where past
actions are judged by current rules. With it, history becomes a stable reference
against which claims can be evaluated.

---

## 9. Authorization Emerges from State

### 9.1 The Problem with External Authorization

In most systems, authorization floats above the system as a separate concern—
configuration files, database tables hidden behind an API, or out-of-band
settings. This creates several problems:

- Authorization changes are not auditable events
- Verifying historical actions requires institutional memory
- Retroactive policy changes can rewrite the meaning of past actions

### 9.2 ACLs as Evolving State

In the CT Protocol, authorization does not float above the system. **It lives
_inside_ the same historical record as everything else.**

Access-control lists are state, expressed as facts like any other. Adding a
writer, removing a delegate, or transferring ownership produces a new fact that
commits to the updated ACL.

```typescript
type Capability = "READ" | "WRITE" | "OWNER";

type ACL = {
  [user in DID | "*"]?: Capability;
};
```

This design has two consequences:

1. **Delegation and revocation become auditable events.** One can trace when
   authority was granted, by whom, and when it was withdrawn.

2. **Authorization becomes inherently time-sensitive.** A fact that modifies
   state binds itself to the ACL that existed _at the moment it was appended to
   the log_.

### 9.3 Authorization at Commit Time

This notion—_authorization at commit time_—is central. When verifying a
historical action, the CT Protocol does not ask whether the signer is authorized
now. **It asks whether they were authorized then.**

The answer is determined mechanically by replaying facts in order. There is no
need to consult current configuration, no ambiguity about retroactive policy
changes, and no reliance on institutional memory.

### 9.4 Genesis Trust

- Each space is itself a DID (often `did:key`)
- The **initial commit** for a space establishes the root of trust
- For full trust anchoring, the genesis commit SHOULD be signed by the space DID

### 9.5 Verification of Authorization

To verify a fact `F`:

1. Verify receipt signature (if present)
2. Verify log inclusion and ordering
3. Resolve the referenced ACL fact
4. Verify the ACL fact chain up to genesis
5. Check that signer DID is authorized under that ACL state
6. If UCANs are present, verify them and ensure consistency with ACL

Authorization is therefore **state-based**, not server-asserted.

---

Prev: `docs/specs/verifiable-execution/04-receipts.md`  
Next: `docs/specs/verifiable-execution/06-cfc-and-trust.md`
