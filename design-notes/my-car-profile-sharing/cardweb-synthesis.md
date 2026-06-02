# Card-web synthesis: prior thinking for the "my cars × parking-coordinator" worked example

**Source:** SQLite store at `/Users/alex/Code/loom-files/.scripts/shared/card_web/cache/card_web.db` — 9,885 live cards (collection `everything/bits-and-bobs`, tags `common-tools` 5,017 / `internal` 514). DB was readable; FTS5 (`cards_fts`) and `body_text` queried directly. The `cache/images/` dir is empty and there is no separate rendered-notes folder — card bodies live only in SQLite, as the README/SKILL state. Card titles are auto-generated word-salad; real content is in `body_text`. Public URL form: `https://cards.komoroske.com/bits-and-bobs/<card-id>`.

Below, each card is `card_id` (= db `card_id`, and the URL slug). Quotes are verbatim from `body_text`.

---

## Theme 1 — Privacy / policy / sharing / granularity (the spine of this example)

**c-573-fcd767** — *Policies on data, not apps.* The single most load-bearing card for the design. Argues permissions belong on data (which is close-ended) not the origin/app (open-ended). The "my cars" pattern is exactly this: a policy that travels with the car record.
> "Imagine a system where data always flows with its policies, and all systems that can perform computation are known to faithfully follow those policies."
> "You wouldn't even need permission dialogs for things well covered by policies, because policies could neatly cover nearly all of the dangerous cases."

**c-420-eee402** — *Don't put policies on code; put them on data.*
> "Code is open-ended, inherently… ACLs implicitly put policies on code… Instead, put policies on data. Data is close-ended."

**c-370-faa091** — *Default policies are load-bearing.* The granularity dial (owner → description → +plate) is a default-policy design problem.
> "The amount of value the agentic system can unlock is directly proportional to how closely the defaults match what users would want… if they had infinite time to consider it."
> "Everything not forbidden by the policies is allowed… the tighter the policies are, the more value that can be created."

**c-645-ffb166** — *Most people's policies converge if expressible.* Justifies a small set of sharing presets covering nearly everyone.
> "People don't actually differ that much in what policies they want, it's that there's no language to express it… 90% of users could be covered by 90% of policies."

**c-358-bbc096 / c-870-cbb161** — *Viral / taint policies.* When a parking-coordinator joins a plate (sensitive) to a recurring-offender record, the offender record should inherit the plate's restrictions.
> "Every bit of data that touches data with restrictive policies absorbs those policies, too… it becomes sensitive too." (c-358)
> "data taints other data, absorbing its most restrictive policies… The data that have heavily restrictive policies are 'cursed'." (c-870)

**c-246-dea579** — *Taint-minimizing policy as redaction.* Directly models the granularity dial.
> "In a taint minimizing system, the policy effectively says, 'I could tell you… but I'd have to kill you.'"

**c-443-fce753** — *Split into small black boxes to contain taint.* Architectural argument for many small patterns/gremlins over one monolith.
> "Taint containment effectiveness degrades super-linearly as black box size increases. One bit of taint inside a box taints everything else."

**c-496-abd833** — *Good privacy = you don't have to think about privacy.* The UX north star: the granularity slider should feel empowering, not like a consent gate.
> "People's naive view of privacy technology is 'more annoying prompts that get in the way.' That's bad privacy technology."

**c-321-cde463** — *Legibility replaces permission dialogs with in-context UI.* Why the cars pattern should be a native pattern, not an iframe.
> "Pattern UI can have policies attached that say, 'as long as these three components were on screen next to each other when the user clicked, it's fine…'"
> "The permission dialogs fade away to in-context UI."

**c-296-dca004** — *The four bad outcomes of same-origin* (prompt deluge; hollow consent + data sloshing; creepy long tail nobody builds; hyper-aggregation). The negative space this example is meant to escape.
> "a black and white choice for a fractally nuanced question"
> "you get software that is maximally used and minimally liked"

**c-529-acb891** — *Responsibility laundering / hollow consent.* What NOT to do at the parking/plate boundary.
> "Technically, they consent. But they don't understand what they consented to, so the consent is hollow… the same origin paradigm never grappling with the fact that data is naturally viral."

Supporting: **c-199-ddc651** ("Permissions should be on data. Unix got it right… the permissions flow with it everywhere it goes"), **c-275-cbd925** (turing-complete-below-a-policy is why same-origin needs blanket trust), **c-368-cbf780** ("The same origin policy is what dooms us to aggregation… It's the same origin's fault, not privacy!"), **c-073-dfb974** ("The default policies are what coevolve with the ecosystem. The laws of physics stay the same."), **c-716-bcc416** ("Privacy is a means to the power inversion"), **c-438-dbf448** (Simon Willison's lethal trifecta: private data + external comms + untrusted content), **c-007-cdd516** (same-origin forces close-endedness; a different model gets privacy *and* open-endedness).

---

## Theme 2 — Surveillance ethics / "creepy" / cars (the parking-coordinator's moral hazard)

No literal license-plate/parking-surveillance cards exist (those are the invented domain); the "car" hits are metaphorical. But the **creepy / power-inversion** cluster is the exact ethical frame for a system that tracks recurring offenders and matches employee vs. guest cars.

**c-689-dac621** — *Personalization isn't creepy; the corporation doing it is.* A parking-coordinator that watches plates is creepy if it's the building's surveillance tool; right if it's an extension of each car-owner's own agency.
> "Personalization is not the problem. It's the corporation doing it on your behalf that's the creepy part… requires a system that is human-focused, not corporation focused."

**c-689-fcf904** — *Proactive requires ownership.*
> "To be proactive it has to be yours. Otherwise it's creepy. It's your data, and it should be your rules, too."

**c-558-ace540** — *The core design question of this whole example, almost verbatim.*
> "Services not knowing you is challenging for users… and also the service! How do you create a safe way for services to know you without being dangerous or creepy?"

**c-425-ddb578** — "Coactive computing to not be creepy must be trusted to be an extension of your agency."  **c-561-efe809** — "A corporation collating your context is creepy… this problem is explosive."

**c-026-aca484 / k-anonymity (in c-325-bbc479)** — *Aggregate-only release.* The recurring-offender tracker should release data only above an anonymity threshold:
> "allow data to flow outside the system if it is aggregated to a certain k-anonymity threshold." (c-325)

---

## Theme 3 — Composition of patterns

**c-960-ecf925** — *Safe composability can't be retconned; it's the defining bet.*
> "The only way to have a system with safe, low-friction composition is for it to have that property from the beginning and then never lose it."
> "clicking a link should never be directly dangerous" (the web's invariant to emulate)

**c-702-cfb596** — "arbitrary, safe composability allows software experiences perfectly tailored to you… Safe arbitrary composition would be a killer feature."

**c-301-bae108** — "Apps are islands: little monoliths… one-size-fits-all shape." (the foil: "my cars" and "parking-coordinator" are NOT apps that must agree on one schema)

**c-617-cff649** — *The two superpowers framing* (and the literal phrase "superpowers"): "the link and the iframe… What if links could be plain language wishes? What if you could compose anything else, safely?"

**c-994-efe701** — *What a pattern is.* "Patterns are skills with mechanistic guardrails built in… composable UIs, and safely wish for other information. Little hermetically sealed bits of magic."

**c-131-ccc962** — "A blackboard system is a natural way for a swarm of little programs to collaborate in a composable way. A great substrate for coactive software." (the cars-broadcast → parking-coordinator interop IS a blackboard)

---

## Theme 4 — Gremlins, emergence & the reactive runtime

**c-280-fac032** — *The structural blueprint for the parking-coordinator's gremlins.* Describes a swarm of tiny single-task agents on a blackboard — and its worked example (a "LinkedIn enricher" that fills a missing field) is structurally identical to a plate-extractor gremlin.
> "Each one should do one concrete task, reliably. Trigger based on an obvious case and then either do no harm, or move the thing it's operating on to a better state. Everyone should agree that what it leaves is better than what was there before. As long as this asymmetry is met, the system is default-converging."
> "One gremlin on its own is not very powerful (or scary). But a swarm of gremlins can create significant emergent value."

**c-997-fcf834** — *The iron law of reactive systems.* The convergence rule the plate-extraction/offender-tracking gremlins must obey.
> "ensure every update gets you incrementally closer to a convergent state… If the modifications are diverging… the global emergent behavior will be runaway."

**c-383-aba011** — "In a reactive system, read-only is the safe default. Because otherwise an upstream change could blow away the edit you made." (the car-owner is writer; the parking-coordinator is reader)

**c-202-caa652 / c-938-dce628** — *Emergence is amoral; cultivate or contain.* The "data emergence" pitch needs this honesty.
> "Sometimes the emergent effects are bugs. Sometimes they are wonderful unplanned accidents that create all of the value… Emergence cannot be controlled. It can be contained, or it can be cultivated." (c-202)

**c-642-bac479** — "Things that emerge are shaped by their constraints… The most foundational constraints are the security model. If you want a new kind of ecosystem to blossom you need to focus on the constraints." (i.e., the privacy policy is what makes the good emergence emerge)

**c-818-ebe895** — "Emergence isn't controllable, but it is tunable… Think like a gardener, not a builder."  **c-638-beb375** — "One-ply thinking can predict… cars, but not… traffic jams" (multi-ply reasoning; cars→jams is a nice native metaphor for this example). Supporting gremlin cards: **c-714-eae119** ("swarms of gremlins… Every system around agents will have to be resilient"), **c-977-dbc046**, **c-146-cfa825** ("agentic harness… marshal dumb gremlins to extraordinary results… it's about… the accumulating state").

---

## Theme 5 — Multi-user / multi-space / collaboration

**c-542-bde034** — *Why same-origin can't do this and the fabric can.* The crisp statement of why a shared substrate matters.
> "If everyone has their own app, you can't collaborate. Collaboration in the same origin model requires using the same app to collaborate."

**c-319-fbd712** — *The multi-space weave* — almost a tagline for the example's architecture.
> "It's your secure fabric, but you can weave it to others' to collaborate… You come for your own personal fabric, and you stay for interconnecting with others."

**c-106-cbf316** — *Trust governs how much you share.* The car-owner↔parking-coordinator is a semi-adversarial collaboration; granularity = the "thin thread."
> "Adversarial collaborations… share the bare minimum… This makes it unlikely to have unexpected downside… but also very unlikely to have unexpected upside."

**c-213-dbf463** — *Coactive computing manifesto* (human-centered, private, prosocial, "perfectly aligned with the human's interests"). **c-235-cab554** — *Cheap multiplayer tricks* (chunk small so last-write-wins is fine; comment-only roles) — practical guidance if the example needs conflict handling. **c-922-acd911** — "Open systems grow quickly but have a privacy problem… can't coordinate without breaking privacy in today's laws of physics" (the gap CF closes).

---

## Theme 6 — Identity / profiles / wishes / capabilities

**c-974-edc322** — *The user's wish, and why it forces multi-user/multi-space.* Reads like the example's origin story.
> "I want a tool to vibe code with my personal data. Safely… My canonical personal data has to be synchronized with others (e.g. my husband.)"

**c-873-fee810** — "Web 2.0: 'your identity is inside this app.'… Literally impossible to imagine [taking it out]." (the foil: in CF, your "cars" live on your profile, not inside the parking app)

**Wishes** — the "I wish" UX the granularity dial should feel like: **c-001-baa049** (Folk Software: "Code that starts with 'I wish this existed'"), **c-754-bef336** ("Wishes are the threads that tie the fabric of possibility together"), **c-335-aba048** ("Wishes are dependency injection"), **c-875-dec506** ("Wishes from the user should be interpreted… like the word of god. Written down, persisted, always followed"), **c-322-aab592** ("The fabric is a wish-granting machine"), and the cautionary **c-400-bfd098** ("The third wish is always 'undo the first two wishes.' Goodhart's law drives monkey's paw dynamics").

**Capabilities** — **c-559-faf083** ("Capability-scoped systems also reduce the blast radius of successful attacks"), **c-301-edf047** ("trust at the bottom you don't have to trust anything on top… allows open-ended value creation").

---

## Theme 7 — Trust & security model

**c-097-dcc994** — *Untrusted process, trusted container* — the runtime guarantee that lets a parking-coordinator (untrusted) compute on your car data safely.
> "An untrusted process in a trusted container can produce trusted output… A slime mold in a novelty jello mold can produce whatever arbitrary shapes you want."

**c-191-abf159 / c-907-bbd434** — *"Untrusted" is good, not bad.* "What it really means is 'a thing that you don't have to trust'… The more components that can be untrusted, the more rigorously the system works!"

**c-757-aac484** — "A trustless society is impossible and undesirable… What you want is scaled trust… Infrastructure that helps your trust go further helps society thrive." (the example sells *scaled* trust between strangers — owner and parking lot)

**c-325-bbc479 / c-353-dea502** — *Private Cloud Enclaves / verifiable+private+confidential.* Deep substrate for the "policies are faithfully enforced" claim; relevant if the example wants to gesture at *why* you can trust the parking-coordinator's enforcement. **c-314-eda114** — provenance/CFC headers surviving a round-trip out of the fabric (relevant if a plate-match notification emails a guest).

**c-329-acc123** — *The Wild-West roundup* (real agent-security disasters) — useful "this is what happens by default in same-origin" color, ending: "it requires the origin and its software to do the right thing with its data."

---

## "Superpowers of the fabric" — the framing cards

**c-049-cad080** — "You can pin things from across the fabric into your own pocket of the fabric… The fabric comes alive with possibility, powered by collective intention and intelligence." **c-735-fea394** — "The Common Fabric structurally weaves privacy into the fabric instead of bolting it on." **c-803-aad219** — "The Common Fabric is an enchanted fabric that weaves itself." **c-029-aad268** — "giving people superpowers by removing the need to fear bad outcomes." **c-050-eae844** — "A coactive fabric is a self-paving cowpath." **c-622-faa175** — coactive = both human and LLM modify a shared substrate "including with structured data and UI."

---

## Design principles to carry into the worked example

1. **Policies live on data, not on patterns.** The car record carries its own sharing policy; the parking-coordinator inherits, never overrides it. (c-573, c-420, c-199)
2. **Get the defaults right — they're load-bearing.** Granularity presets (owner / description / +plate) should match "what the user would want with infinite time," because everything not forbidden is allowed. (c-370, c-645)
3. **Make sensitivity viral.** When a plate (sensitive) is joined into an offender record, that record absorbs the plate's restrictions automatically. Demonstrate taint propagation as a feature. (c-358, c-870, c-246)
4. **Replace permission prompts with in-context, legible UI.** Sharing should feel like a "wish," never a consent gate. Good privacy = you don't have to think about privacy. (c-321, c-496, c-296, c-529)
5. **The creepiness test:** the parking-coordinator is acceptable only as an extension of each owner's agency, never as the building's surveillance apparatus. Release aggregates above a k-anonymity threshold. (c-689×2, c-558, c-325)
6. **Compose untrusted patterns inside trusted containers.** The owner trusts the runtime's enforcement, not the parking-coordinator's code — "untrusted" is the goal. Trust at the bottom so nothing on top needs trusting. (c-097, c-191/c-907, c-301-edf047)
7. **Build the parking logic as a swarm of convergent gremlins.** Each does one task (extract plate, match employee, flag repeat), each leaves the blackboard strictly better, every update moves toward convergence. (c-280, c-997, c-131)
8. **Lead with the multi-space weave, not the app.** "You come for your own fabric, and you stay for interconnecting with others" — your cars live on your profile and interoperate across spaces; identity is not trapped inside the parking app. (c-319, c-542, c-873, c-974)
9. **Be honest that emergence is amoral — and that constraints (the privacy model) are what make the *good* emergence bloom.** Frame yourself as a gardener tuning constraints, not a builder controlling outcomes. (c-202, c-642, c-818)
