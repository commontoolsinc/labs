# EXPLAINER — Trust travels with the photo

*Why this little parking demo is secretly a tour of everything good about the
fabric. For colleagues who know Common Fabric loosely. ~3 screens.*

---

## The hook

Alice photographs **her own car**, on **her own profile**, in some random
parking lot. She never opens the parking app. She is not thinking about the
parking team, or DIDs, or spaces. She is just saying a fact about herself: *this
is my car.*

A few seconds later, on a **different screen**, in a **different space**, owned
by a **different team**, an admin named Carol watches a red **"possible
recurring offender ⚠"** flag turn green and quietly relabel itself **"Alice's
car · ours · seen 4×."**

Nobody typed Alice's plate into the parking system. Carol didn't touch her
screen. Alice didn't open the parking app. The two of them never coordinated.
The flag *cleared itself*.

That's the whole demo. Everything below is why it works — and why it's hard to
do any other way.

---

## The old way vs. the fabric way

**The old way.** The parking admin emails everyone: "send me your plate." People
reply (some don't). The admin types each plate into the parking tool. Someone
buys a new car — the roster goes stale. There are *two* tools (a coordinator and
a lot-watch), so the admin types every plate **twice**. The data about *your*
car lives inside *their* app, maintained by *them*, forever drifting from
reality (c-873: "your identity is inside this app").

**The fabric way.** Alice owns the fact "this is my car" *once*, on her profile.
Every org tool that cares about cars *wishes* for it and stays in sync
automatically. Register once, light up two tools (and the third, and the fourth).
Buy a new car, update one card, everything follows. Your car lives on *your*
profile, not in the parking app (c-319).

---

## The one idea that makes it safe

Here's the trap. If "the parking system trusts a plate," then anyone who can put
a plate in front of it can launder a fake car into "ours." Plates are just
bytes; bytes are forgeable.

So the fabric doesn't trust the plate. **The org does not trust a car; it trusts
a CLAIM made by someone trusted to make it.**

A `VehicleClaim` isn't a row in a spreadsheet — it's an *attributable* assertion.
Alice's self-claim is cryptographically stamped *"authored by Alice"*
(`represents-principal`), and that stamp is enforced by the runtime, not by the
parking app's good behavior. The org's allow-rule is a single, boring sentence:

> Allow any vehicle whose claim was authored by a **current employee**.

That's not an app checking a list of plates. That's a **provenance check on the
data itself** — "policies on data, not apps" (c-573/c-420). "Take a picture" is
just the friendly way to author the claim; the *security* is whose identity it's
attached to.

And this dissolves the one architectural headache we feared. Naively, the
parking tool would have to *write the resolved identity back onto Alice's
profile* — a foreign app scribbling in her private space, which the fabric
rightly forbids. But it never has to. The identity is **already** on her profile,
as her own claim. The parking tool only ever **reads it and checks who signed
it**. Nobody writes where they aren't entitled. The hard problem evaporated.

---

## The superpowers on display

This demo is small on purpose, so each fabric superpower is *visible*:

**The multi-space weave.** Your car lives on YOUR profile space, not in the
parking app's space. The parking tool reaches across a space boundary to *read*
it. "You come for your own fabric, and you stay for interconnecting with others"
(c-319/c-873). Put the admin's screen on a second monitor and *watch* the "ours"
count tick up the instant Alice taps Save.

**Wish-based composition.** The parking coordinator doesn't import Alice's car —
it *wishes* for it: `wish(#car)`. Producer and consumer never agreed on a schema
meeting; they agreed on a tag and a shared `Vehicle` shape, and the fabric wove
them together (c-617 "what if links could be plain-language wishes?", c-994
"little hermetically sealed bits of magic").

**Reactive retro-resolution across spaces.** This is the money shot. A claim
becomes available in one space, and *historic* sightings in another space
reclassify themselves — the red flag clears on a screen no one is touching. Not a
sync job; reactive emergence (c-280/c-997: convergent gremlins each leave the
board strictly better).

**Provenance-as-trust / policies-on-data.** The allow decision is "who signed
this claim?", not "is this plate on a list?" Revoke an employee → drop their DID
from the owner-signed `EmployeeRoster` → every claim they ever made silently
stops counting. Revocation is *reactive subtraction*, not a cleanup job
(c-573/c-420).

**Untrusted pattern, trusted container.** The parking coordinator is *untrusted*
code — and that's the point (c-097/c-191). It computes on Alice's car claim, but
the runtime (the trusted container) guarantees it can only read what it's allowed
to read and can't forge a claim or peek at a private note. "A slime mold in a
trusted jello mold produces whatever shape you want — safely."

**The confidentiality handshake as humane privacy.** Alice can attach a private
note to a claim (*"this is my partner's car, they're picking me up Friday"*).
Carol sees Alice's *identity* — a `ResolvedIdentity` projection of the claim —
but **structurally cannot see the note**. If Carol needs it, she *requests* a
reveal; Alice approves or declines. No permission-prompt deluge, no hollow
consent — the note is simply absent from what Carol's tool can read until Alice
says otherwise. Good privacy is the kind you don't have to think about (c-496).

---

## The honest close

Two things this design does **not** pretend:

**One real open question — the wish fan-out.** `wish(#car)` naturally resolves
*the viewer's* car. The parking tool needs *every* employee's car. The clean v1
answer is to fan the wish over the owner-signed employee roster we already keep
for trust (the same DID set that says "may vouch" also says "whose profile to
read"). A future, cleaner substrate move is an org-scoped wish. This is the one
genuinely unresolved knob, and we're saying so out loud.

**Deferred privacy granularity.** There's a "Share: just-that-I-own-a-car /
description-only / description+plate" dial on the card. Today it's a labeled,
default-on placeholder — we've named the rungs and placed the control, but the
policy engine behind it is future work. We're marking the seam, not building the
wall.

And the deepest honesty: **vouching is scaled trust plus attribution, not
surveillance** (c-757). When Bob vouches for a guest's car, the system doesn't
*prevent* a bad vouch — it records *who* vouched. The parking coordinator is an
extension of each owner's agency, not the building's spy (c-689/c-558).
Personalization isn't creepy; a corporation doing it *to* you is. Here, Alice's
car is *Alice's* fact, shared on *Alice's* terms, read — never owned — by the
tools that serve her.

That's the trick the whole demo is built to show: **trust travels with the
photo.** Alice took one picture of her own car, and a building's worth of tooling
quietly became correct — without anyone surveilling her, without anyone retyping
her plate, and without her ever thinking about any of it.
