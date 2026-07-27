// Content of the Common Fabric mappa mundi, extracted from the source
// document. Text is verbatim; only the "Why" panel is transcribed from the
// published page, which carries a section the exported file does not.
//
// Seg[] models a run of prose with emphasis, so bold spans survive without a
// markdown parser at render time.

export interface Seg {
  t: string;
  b?: boolean;
}

export interface Chip {
  label: string;
  code?: string;
  tip: string;
}

export interface Claim {
  name: string;
  tag: string;
  principle: string;
  lede: string;
  villain: Seg[];
  benefit: Seg[];
  mech: Seg[];
}

export interface ParadigmCell {
  row: string;
  fab: boolean;
  label: string;
  epigraph?: string;
}

export interface Why3 {
  key: string;
  body: Seg[];
}

export interface Layer {
  tone: string;
  name: string;
  tag: string;
  what: Seg[];
  gate: string;
  chips: Chip[];
}

export interface TierGroup {
  label: string;
  layer: string;
  chips: Chip[];
}

export interface Tier {
  ttag: string;
  tname: string;
  tline: string;
  health: string;
  groups: TierGroup[];
}

export interface ConcernRow {
  name: string;
  tip?: string;
  layer: string;
  layerCls: string;
  status: string;
  flag?: string;
}

export interface StripSeg {
  w: number;
  c: string;
}

export interface Domain {
  title: string;
  flags: number;
  strip: StripSeg[];
  rows: ConcernRow[];
}

export interface Band {
  title: string;
  sub: string;
  layer: string;
  domains: Domain[];
}

export interface TabDef {
  id: string;
  label: string;
}

export const TABS: TabDef[] = [
  {
    "id": "why",
    "label": "Why",
  },
  {
    "id": "claims",
    "label": "Promises",
  },
  {
    "id": "orient",
    "label": "Three layers",
  },
  {
    "id": "reach",
    "label": "Loom prototype",
  },
  {
    "id": "ledger",
    "label": "Concerns",
  },
];

export const HEADER: { eyebrow: string; dek: string } = {
  "eyebrow": "COMMON FABRIC · MAPPA MUNDI · 2026·07·14",
  "dek":
    "A map of the world as it stands: five promises, the three layers that keep them, what the prototype has charted, and where dragons yet be.",
};

export const WHY: { title: string; paras: string[] } = {
  "title": "Why a new paradigm",
  "paras": [
    "Every paradigm exhausts itself eventually, and mobile has: apps you discover and stitch together by hand, notifications that long ago broke their promise to guard your attention, focus modes bolted onto a system built to hack your dopamine. Underneath it all, one root: apps own the data, so data piles up where data already is, and the rest is downstream physics. AI is the trigger for the next paradigm, and we keep mistaking it for a feature on top of the old one.",
    "What comes next looks less like a product and more like a fabric: intimate, contextual, running across your devices, holding your intent privately and brokering capability without locking you in. Every serious player is racing to own it. And the architecture that could finally make computing calm is the same architecture that, in the wrong hands, becomes the most intimate surveillance system ever built. From the outside, the two might look identical until it's too late to tell them apart.",
    "The five promises on the next page are how you tell: each names the status quo you're living in now, what a person is owed instead from software that knows them—intimately, and the mechanism that keeps it. The map that follows exists to keep them.",
  ],
};

export const CLAIMS_INTRO: string[] = [
  "Five promises",
  "What software that knows you owes you. Each opens with the status quo, then what you get with fabric instead, then the mechanism that keeps it; parentheses name its resonant-computing principle.",
];

export const CLAIMS: Claim[] = [
  {
    "name": "Loyalty",
    "tag": "—who serves you",
    "principle": "(Dedicated)",
    "lede":
      "Whose side are your agents on? Systems that know everything about you either work for you or work on you.",
    "villain": [
      {
        "t":
          "Divided loyalties: you're one customer among several, and not the paying one. The advertiser and shareholder sit at the table; software answers to whoever pays. The broken promise underneath most of the digital world's deadening.",
      },
    ],
    "benefit": [
      {
        "t":
          "Software that answers to you alone and uses your context the way you'd expect: no hidden agenda, no second customer.",
      },
    ],
    "mech": [
      {
        "t":
          "Every piece of your data carries a label saying where it came from and what may happen to it, and the label travels through every computation, so even untrustworthy code can work over your context without being able to smuggle it out. The same guarantee follows your data into the cloud: servers can run the work and prove what they ran, but they cannot look inside. Nothing leaves except through a deliberate human act: share, send, nothing implicit. Even a tricked model can't betray you: anything touched by untrusted words stays marked, and the system, never the model, decides what's allowed out. And the business model closes the loop: a flat subscription, priced like a utility, for access not engagement. ",
      },
      {
        "t": "Nothing in the stack is paid to betray you.",
        "b": true,
      },
    ],
  },
  {
    "name": "Ownership",
    "tag": "—what you own",
    "principle": "(Private)",
    "lede":
      "Whoever holds the context holds the power. Your digital life shouldn't be a lease. Memory, data, relationships: portable, inspectable, yours. Trust stops being a brand promise and becomes architecture.",
    "villain": [
      {
        "t":
          "The aggregator: value accrues to whoever hoards the most context. Your data mined and warehoused, no insight or control for you: your context weaponized into personalized persuasion against you.",
      },
    ],
    "benefit": [
      {
        "t":
          "Your context is yours to steward: provable, portable, revocable. Data has many stakeholders; you stay the primary steward of your own.",
      },
    ],
    "mech": [
      {
        "t":
          "The root of all permission lives on your own devices; everyone else, software included, borrows access you can renew or take back. Every place your data lives has an unforgeable address, and every change records who made it in a way no one can fake. Software doesn't own your data; it visits. And it visits on your turf: the code comes to your context and runs there, so ",
      },
      {
        "t": "the software maker never sees your data at all.",
        "b": true,
      },
    ],
  },
  {
    "name": "Selves",
    "tag": "—who you are",
    "principle": "(Plural)",
    "lede":
      "Life is multiplayer and you contain multitudes. Software built for one user, one profile, one central owner gets all three wrong.",
    "villain": [
      {
        "t":
          "The walled garden: one fixed, cumulative identity, locked in everywhere: every context you join inherits the baggage of every context before it.",
      },
    ],
    "benefit": [
      {
        "t":
          "As many selves as contexts, linked when you choose, never by default.",
      },
    ],
    "mech": [
      {
        "t":
          "A new self costs nothing to create and starts anonymous. You connect selves one relationship at a time: you can prove to one person that two of your selves are the same you while everyone else sees strangers. Exposure becomes a decision, not a residue. The same move scales up: ",
      },
      {
        "t":
          "no central owner means plural ecosystems, not just plural selves.",
        "b": true,
      },
    ],
  },
  {
    "name": "Calm",
    "tag": "—how it feels",
    "principle": "(Adaptable)",
    "lede":
      "Don't fix the attention economy, obsolete it. Software that isn't paid to keep you can shape itself to your needs and give your time back. Calm is what aligned incentives feel like.",
    "villain": [
      {
        "t":
          "The attention machine: it adapts in one direction only: more of itself, never quieter, because quieter costs it. Feeds engineered to capture, notifications wearing the costume of signal, systems that win when you lose your evening. The overload isn't a bug; it's the revenue.",
      },
    ],
    "benefit": [
      {
        "t":
          "Your time back. Quiet returns to the menu: attention spent on purpose, not harvested by default.",
      },
    ],
    "mech": [
      {
        "t":
          "Nothing can buy its way onto your screen. Software auditions in private: it tries itself against your context silently, surfaces when it earns attention, and fades when it doesn't. And when it surfaces, it knocks on the same door as everything else: no side channel for suggestions. The rules for what may interrupt you are themselves yours, running under your own authority. The system can afford to protect your attention because nothing upstream is funded by engagement. The machine does the watching: ",
      },
      {
        "t": "one decision surfaced, a hundred absorbed.",
        "b": true,
      },
    ],
  },
  {
    "name": "Commons",
    "tag": "—what's ours",
    "principle": "(Prosocial)",
    "lede":
      "Every place you've loved online eventually got a landlord. This one can't: no one holds the deed.",
    "villain": [
      {
        "t":
          "The tollbooth: participation requires permission and pays rent. Gatekept distribution, engagement as the scoreboard, you as a spectator of other people's lives.",
      },
    ],
    "benefit": [
      {
        "t":
          "Places that outlive their builders, tools that make us better neighbors and collaborators, online and off. Communities keep what they make, and leaving costs you nothing: your stuff, your history, your people come with you.",
      },
    ],
    "mech": [
      {
        "t":
          "There is no center: many personal fabrics agreeing on a common language. Publishing needs no gatekeeper because publishing grants no power; safety is built into the structure, so anyone can take part without anyone's permission. When software builds on other software it inherits its guarantees, so trust accumulates like a web of vouches rather than a brand. Working together is explicit and reversible: ",
      },
      {
        "t": "groups form, work, dissolve, boundaries intact.",
        "b": true,
      },
    ],
  },
];

export const PARADIGM: { names: string[]; cells: ParadigmCell[] } = {
  "names": [
    "operating system",
    "the web",
    "common fabric",
  ],
  "cells": [
    {
      "row": "edge",
      "fab": false,
      "label": "apps",
    },
    {
      "row": "edge",
      "fab": false,
      "label": "webpages",
    },
    {
      "row": "edge",
      "fab": true,
      "label": "Patterns",
      "epigraph": "the open shore",
    },
    {
      "row": "mid",
      "fab": false,
      "label": "the desktop, a shell",
    },
    {
      "row": "mid",
      "fab": false,
      "label": "the browser",
    },
    {
      "row": "mid",
      "fab": true,
      "label": "Shell",
      "epigraph": "the chosen surface",
    },
    {
      "row": "core",
      "fab": false,
      "label": "the kernel",
    },
    {
      "row": "core",
      "fab": false,
      "label": "the www",
    },
    {
      "row": "core",
      "fab": true,
      "label": "Fabric",
      "epigraph": "the bedrock",
    },
  ],
};

export const WHISPER: Seg[] = [
  {
    "t": "Fabric ",
  },
  {
    "t": "is",
    "b": true,
  },
  {
    "t":
      " the core, and it defines the gates above it: the boundary between two layers is always the same kind of thing, a syscall, same-origin, a signed authorization. An open layer's freedom is made safe by a guarded layer's rules. ",
  },
  {
    "t": "Loom",
    "b": true,
  },
  {
    "t":
      " is the prototype: it lives in the two layers above and reaches down through the gates into Fabric's core. What it surfaced fills the Loom prototype and Concerns tabs.",
  },
];

export const WHY3: Why3[] = [
  {
    "key": "Patterns are wild.",
    "body": [
      {
        "t":
          "The world owns them: the edge where infinite software lives. Anyone publishes, no one asks permission: the web's permissionless innovation, kept safe not by review boards but by what a pattern structurally cannot do. Trust here is ",
      },
      {
        "t": "delegated and contained",
        "b": true,
      },
      {
        "t": ".",
      },
    ],
  },
  {
    "key": "Shells are chosen.",
    "body": [
      {
        "t":
          "Few, accountable, replaceable: user agents in the web's original sense: software whose only client is you. A shell earns its position and loses it the day it stops deserving it. Trust here is ",
      },
      {
        "t": "chosen and accountable",
        "b": true,
      },
      {
        "t": ".",
      },
    ],
  },
  {
    "key": "Fabric is guaranteed.",
    "body": [
      {
        "t":
          "The narrow waist everything else stands on, like IP or the kernel: small, neutral, held in trust rather than owned, changed slowly and in the open, and attested: you verify the code itself, not the company running it. Trust here is ",
      },
      {
        "t": "guaranteed by construction",
        "b": true,
      },
      {
        "t": ".",
      },
    ],
  },
];

export const LAYERS: Layer[] = [
  {
    "tone": "edge",
    "name": "Patterns",
    "tag": "(assembled)",
    "what": [
      {
        "t":
          "The open edge: replaceable code running under authority it is lent, where invention lives and a rival is free to differ. ",
      },
      {
        "t": "The world owns these; no one asks permission.",
        "b": true,
      },
    ],
    "gate":
      "Authority it cannot escalate: sandboxed, allowlisted, one channel no policy may read. Improvise freely; you cannot mint trust or dispose data, and what leaves carries its taint.",
    "chips": [
      {
        "label": "Visit data, never own it",
        "tip":
          "Computation comes to your context under delegated authority; the author never sees your data. Spans: every pattern surface.",
      },
      {
        "label": "Propose, never dispose",
        "tip":
          "Candidates, drafts, suggestions; terminal decisions belong to you or the substrate. Spans: trusted-source discipline, approvals.",
      },
      {
        "label": "Taste lives here",
        "tip":
          "Views, copy, vocabularies, ranking, budgets, brand: everything a rival should be free to do differently on the same substrate.",
      },
      {
        "label": "Judgment lives here, on a leash",
        "tip":
          "What matters, what deserves attention: proposed by patterns, priced and gated by the substrate. Spans: surfacing, suggestions, triage.",
      },
      {
        "label": "Compose freely",
        "tip":
          "Patterns build from patterns and inherit their proofs; wishes find data without knowing where it lives. Spans: composition, discovery.",
      },
      {
        "label": "Speak every modality",
        "tip":
          "One meaning, renderable as glance, speech, or touch, at whatever capacity the moment allows. Spans: semantic surface, representations.",
      },
      {
        "label": "Safe because contained",
        "tip":
          "Sandboxes, allowlists, viral taint: tricked or honest, what leaves a pattern carries its label and the runtime stops the sensitive act.",
      },
      {
        "label": "No self-raised authority",
        "tip":
          "Nothing a pattern emits can raise its own loudness or power; emitter fields never escalate. Spans: the ext discipline.",
      },
      {
        "label": "Infinite software",
        "tip":
          "Cheap in the small, personal by default, plentiful: the edge where anyone builds and no one asks permission. Spans: distribution, publishing.",
      },
    ],
  },
  {
    "tone": "shell",
    "name": "Shell",
    "tag": "(chosen)",
    "what": [
      {
        "t": "The user's ",
      },
      {
        "t": "trusted, replaceable surface",
        "b": true,
      },
      {
        "t":
          ": the one piece of software whose only client is you. Swap it out; the contract stays. ",
      },
      {
        "t": "You choose one; it answers to you and earns its place.",
        "b": true,
      },
    ],
    "gate":
      "The host contract: exactly two things a host must provide, navigation owned by the host, and a duty to fail closed at every boundary.",
    "chips": [
      {
        "label": "Renders what Fabric holds",
        "tip":
          "The trusted surface draws the graph and owns where your eyes go. Spans: embedding, navigation.",
      },
      {
        "label": "Carries your consent",
        "tip":
          "Adopt, approve, send: the human acts. The shell confirms them; it never manufactures them. Spans: consent writes, routing confirmation.",
      },
      {
        "label": "Declares who you are right now",
        "tip":
          "Entering work, entering the diary: explicit, cheap, always visible, unspoofable. Spans: context slicing, active-context indicator.",
      },
      {
        "label": "Fits the moment",
        "tip":
          "Hands, eyes, ears, attention available now; one mechanism serves disability, situation, and preference alike. Spans: presentation, accessibility.",
      },
      {
        "label": "Guards the room",
        "tip":
          "What the screen shows when others can see it is a disclosure decision. Spans: environment disclosure, guest mode.",
      },
      {
        "label": "One inbox for intent",
        "tip":
          "Capture anywhere; compound utterances split and routed to the right selves, confirmed before anything acts. Spans: universal input.",
      },
      {
        "label": "The pixel no pattern can fake",
        "tip":
          "Shell chrome is always distinguishable from pattern content: anti-phishing inside your own system. Spans: trusted marks.",
      },
      {
        "label": "Undo everywhere, explain on demand",
        "tip":
          "One gesture takes an agent act back; every surfacing can answer why am I seeing this. Spans: cross-cutting duties.",
      },
      {
        "label": "Follows you across devices",
        "tip":
          "Hand off mid-thought, deliver to the eyes you are using, evict a lost phone in one gesture. Spans: continuity.",
      },
      {
        "label": "Shows what holds authority",
        "tip":
          "See what has what; revoke in one gesture. Spans: the permission surface.",
      },
      {
        "label": "Fails closed, degrades gracefully",
        "tip":
          "Unsure whether data may leave: it doesn't. Fabric unreachable: the shell stays honest about what it can't do. Spans: egress duty, safe mode.",
      },
    ],
  },
  {
    "tone": "core",
    "name": "Fabric",
    "tag": "(core platform)",
    "what": [
      {
        "t":
          "The substrate every layer above must be able to trust, across every source and host. The promises everything else leans on live here. ",
      },
      {
        "t": "Held in trust, neutral by design: guaranteed.",
        "b": true,
      },
    ],
    "gate":
      "Keys, labels, and write-gates: nothing enters unmarked, nothing acts without verified authority.",
    "chips": [
      {
        "label": "One living graph of your context",
        "tip":
          "Everything canonical in one reactive graph: cells, facts, causal history, across every source and host. Spans: storage, state.",
      },
      {
        "label": "Identity roots in your keys",
        "tip":
          "A root key on your devices derives selves; each self is its own space, linked only by choice. Spans: identity, isolation.",
      },
      {
        "label": "Every datum carries its origin",
        "tip":
          "Provenance minted at every border; every change signed by its author. Spans: ingestion, ownership, audit.",
      },
      {
        "label": "Policy travels with the data",
        "tip":
          "Confidentiality and integrity labels propagate through every derivation; the runtime, never a model, decides what may flow. Spans: CFC, egress, clipboard.",
      },
      {
        "label": "Authority is delegated, named, revocable",
        "tip":
          "No ambient power: grants are explicit, inspectable, evictable; writes verified against their author. Spans: delegation, owner-gates, least privilege.",
      },
      {
        "label": "Agents run contained, on the record",
        "tip":
          "Sandboxed execution, a signed manifest for every run; delegation cannot launder authority. Spans: harness, subagents.",
      },
      {
        "label": "Which self governs the moment is policy",
        "tip":
          "Activation resolves container-less intent to the right self; what each relationship may know is governed, not guessed. Spans: active-self, linkage, recipient knowledge.",
      },
      {
        "label": "Time is a substrate promise",
        "tip":
          "Wake, remind, realert, escalate: kept by the core, not by a poll loop. Spans: timers, attention policy records.",
      },
      {
        "label": "One door to your attention",
        "tip":
          "A suggestion is a notification wearing different clothes: whatever wants your moment, notice, suggestion, speculative result, enters through the same governed door and is priced the same way. No side doors. Spans: attention, suggestions, speculation.",
      },
      {
        "label": "Sessions bind to one host",
        "tip":
          "Audience-bound, challenge-protected connections between fabrics; nothing replays, spaces open and close. Spans: federation.",
      },
      {
        "label": "Collaboration is structural",
        "tip":
          "Spaces are shared across people; multiplayer by default; groups form, work, and dissolve with boundaries intact. Spans: commons, multi-user spaces, federation.",
      },
      {
        "label": "Verify the code, not the company",
        "tip":
          "Encrypted VMs prove cryptographically what runs; keys bind to attested code; a mesh of mutually attesting nodes. Spans: confidential compute.",
      },
      {
        "label": "Nothing held hostage",
        "tip":
          "Quotas so nothing eats the machine; everything exports; keys rotate; a bad pattern can be stopped without a gatekeeper. Spans: resources, recovery, security response.",
      },
      {
        "label": "Names people can say",
        "tip":
          "Human-meaningful names over unforgeable keys; anything addressable from anywhere. Spans: naming, versioned distribution.",
      },
    ],
  },
];

export const REACH_INTRO: Seg[] = [
  {
    "t": "What the prototype knows.",
    "b": true,
  },
  {
    "t":
      " Read top to bottom, frontier to settled: untouched, mid-flight between layers, shipping, and landed in Fabric.",
  },
];

export const TIERS: Tier[] = [
  {
    "ttag": "Not yet started · anywhere",
    "tname": "The frontier",
    "tline":
      "Nothing built, in any layer: drawn from the shell domains and the general-purpose-computing borrow list, grouped by destined layer.",
    "health": "OPEN",
    "groups": [
      {
        "label": "destined for patterns",
        "layer": "edge",
        "chips": [
          {
            "label": "Compound-intent splitting",
            "tip":
              "One utterance, N routable intents: 'add milk to my grocery list and send bosslady my progress today' splits into two intents, two selves, two authority levels.",
          },
          {
            "label": "Alternate representations per modality",
            "tip":
              "Patterns supply alternate representations (spoken, glanceable, haptic) over the same semantic surface.",
          },
        ],
      },
      {
        "label": "destined for the shell",
        "layer": "shell",
        "chips": [
          {
            "label": "Context switch surface",
            "tip":
              "Entering work / entering the diary as a first-class consent act: the icon-tap rebuilt; plus an unspoofable always-visible active-context indicator.",
          },
          {
            "label": "Routing confirmation",
            "tip":
              "The consent moment for compound intent: milk to Family list; progress to Bosslady, from Work-you. Confirm before acting.",
          },
          {
            "label": "Modality negotiation",
            "tip":
              "The capacity profile of the moment: hands, eyes, ears, attention available. One mechanism for permanent disability, situational disability, and preference (curb-cut principle).",
          },
          {
            "label": "Environment disclosure",
            "tip":
              "Is the screen shared, projected, or visible to others in the room? The room is a recipient; suppress cross-context disclosure accordingly.",
          },
          {
            "label": "Universal undo surface",
            "tip":
              "One gesture takes back what an agent just did; Loom already has an op journal with undo tests to build on.",
          },
          {
            "label": "Permission surface",
            "tip":
              "The Settings-Privacy of delegated authority: see what has what, grant, revoke; renew-or-evict as one gesture.",
          },
        ],
      },
      {
        "label": "destined for Fabric",
        "layer": "core",
        "chips": [
          {
            "label": "Activation policy",
            "tip":
              "Which self governs a container-less moment: activation policy (channel / time / counterparty / situation to presumed self) as a governed object, not a model guess.",
          },
          {
            "label": "Labeled clipboard",
            "tip":
              "Copy carries provenance and CFC label; pasting into another space is a disclosure decision, not a memcpy.",
          },
          {
            "label": "Device roles + presence",
            "tip":
              "Device roles (approver, remote, second screen) on existing device keys; presence-aware delivery: notify the device you are looking at.",
          },
          {
            "label": "Capacity datum",
            "tip":
              "The situation as a labeled datum: driving, cooking, walking; who may know it is a CFC question.",
          },
          {
            "label": "Timer-wake substrate",
            "tip":
              "A wall-clock timer-wake substrate: realert, escalation, notBefore timeliness without a poll loop.",
          },
          {
            "label": "Human naming",
            "tip":
              "Human-meaningful names over unforgeable key-pairs: Zooko's triangle, petnames vs registries; plus universal links to anything.",
          },
        ],
      },
    ],
  },
  {
    "ttag": "Not yet started · by the prototype",
    "tname": "Waiting in Fabric, unreached",
    "tline":
      "Already real in the substrate, never called from the prototype. Grouped by the layer that would wire each.",
    "health": "UNTOUCHED",
    "groups": [
      {
        "label": "patterns would declare",
        "layer": "edge",
        "chips": [
          {
            "label": "Owner-gated writes, unused",
            "code": "writeAuthorizedBy",
            "tip":
              "The CFC write-authority binding (api/cfc.ts), enforced by writeAuthorizedByReason (prepare.ts:2788); 40+ uses in Fabric, zero in Loom's .ops/.",
          },
        ],
      },
      {
        "label": "the shell would consume",
        "layer": "shell",
        "chips": [
          {
            "label": "The may-this-leave check, unused",
            "code": "cfcLabelViewIsPublic",
            "tip":
              "Egress predicate exported from cfc-label.ts (host-embedding seam 4); the shell's fail-closed duty; Loom does not yet persist outside the runtime.",
          },
          {
            "label": "The audit lens, unused",
            "code": "state-inspector",
            "tip":
              "packages/state-inspector + cf inspect: the offline read lens over the store; Loom hand-rolls JSONL ledgers instead.",
          },
        ],
      },
      {
        "label": "Fabric-internal",
        "layer": "core",
        "chips": [
          {
            "label": "Nothing ever closes a space",
            "code": "teardown",
            "tip":
              "Federation Part B is design-only: space? still optional (builder/types.ts:298); no dispose/evict path in runner or lib-shell; opened spaces accumulate.",
          },
        ],
      },
    ],
  },
  {
    "ttag": "In flight · the graduation queue",
    "tname": "Learned, living in the wrong layer",
    "tline":
      "Proven by the prototype and Fabric-shaped: state standing in for the substrate, and features built in pattern space. All of it destined to descend.",
    "health": "IN FLIGHT",
    "groups": [
      {
        "label": "living in patterns",
        "layer": "edge",
        "chips": [
          {
            "label": "Email decisions read-model",
            "code": "email-dispositions.json",
            "tip":
              "Rebuildable read-model in coord_dir (email_dispositions.py, loom-email-dispositions-read-model-v1); shadows a platform changes-projection.",
          },
          {
            "label": "Dismissed notices",
            "code": "attention-notice-dismissed.json",
            "tip":
              "Server-side dismissed-keys JSON via _write_text_atomic (local-loom.py:65196); sibling of the localStorage seen-state.",
          },
          {
            "label": "The Weaver's flight recorder",
            "code": "weaver-activity.jsonl",
            "tip":
              "Append-only JSONL event log with file lock and dedupe (weaver-activity-ledger.ts); shadows the memory-v2 commit log / state-inspector.",
          },
          {
            "label": "Per-page judgment log",
            "code": "page-ledger.jsonl",
            "tip":
              "Append-only page ledger with FNV-1a dedupe (weaver-ledger.ts); same class as the golden-pattern store.",
          },
          {
            "label": "Deadlines by polling",
            "code": "weaver-wake",
            "tip":
              "setInterval dispatch loop (main.ts DISPATCH_INTERVAL_MS=5000) plus disk-persisted nextRun/dueAt (weaver-wake.ts); shadows a platform timer-wake substrate.",
          },
          {
            "label": "Vetted-pattern registry",
            "code": "golden-pattern",
            "tip":
              "Append-only observations JSONL with co-located registry index (golden-pattern-store.ts).",
          },
        ],
      },
      {
        "label": "living in the shell",
        "layer": "shell",
        "chips": [
          {
            "label": "What you've seen, kept in the browser",
            "code": "localStorage",
            "tip":
              "Durable seen-state per browser: loom:patternsTabLastSeenAt and friends (app.js); pattern-attention.ts persists seededLastSeenAt to localStorage inline. Shadows a platform seen-store.",
          },
        ],
      },
      {
        "label": "Fabric-shaped, built in pattern space",
        "layer": "core",
        "chips": [
          {
            "label": "Outbound writes gated by your consent",
            "code": "write_gate",
            "tip":
              "Actuation is authority, so this descends to Fabric. Today: connectors/shared/write_gate.py, two independent fail-closed checks inside the apply stage ('the sole trust boundary'): kill-switch + per-account OAuth consent.",
          },
          {
            "label": "One browser, shared politely",
            "tip":
              "A contended singleton device is resource governance, kernel territory; only the interrupt-consent moment is Shell. Today: browser_service.py lease pool + browser-access-lock.sh mutex; dispatch defers rather than interrupts.",
          },
          {
            "label": "Agents get only the tools they need",
            "tip":
              "Least-privilege is authority, so enforcement descends to Fabric (run manifest + sandbox); the profile vocabulary stays pattern-pace policy input. Today: capability_profiles.py, dispatch_class crossed with named tool-token grants.",
          },
          {
            "label": "One door to your attention",
            "code": "decisionQueue",
            "tip":
              "Loom funnels every ask, notice, suggestion, question, through the single Weaver decisionQueue: the sole ask-channel. The one-spectrum contract is Fabric-shaped and destined to descend.",
          },
        ],
      },
    ],
  },
  {
    "ttag": "Learned · shipping",
    "tname": "Proven where it belongs",
    "tline":
      "Built in its destined layer and shipping: Loom assembling patterns, Loom being a chosen shell.",
    "health": "SHIPPING",
    "groups": [
      {
        "label": "Loom prototyping patterns",
        "layer": "edge",
        "chips": [
          {
            "label": "The Weaver: judges what's worth surfacing",
            "tip":
              "Loom's surfacing engine: weaver-wake trigger, LLM judging call (weaver-judging.ts), normalizeSurface validates level/timing/title/whyClearsBar/whyNow, enqueue to canopy.weaver.decisionQueue.",
          },
          {
            "label": "Who's who: one person across sources",
            "tip":
              "The proposer half is Pattern taste; the assert_same / assert_distinct decision ledger is canonical user-authoritative state, Fabric-shaped. Min-cut suppression of merge edges (canonicalizer.py, decisions.py).",
          },
          {
            "label": "Email triage: what matters, what can wait",
            "tip":
              "Email salience: score 0..1 with bands urgent/active/ambient/ledger; durable DISPOSITION_STATES feedback (email_dispositions.py, email_triage_*).",
          },
          {
            "label": "One search across mail, messages, notes",
            "tip":
              "Ranking and merging are Pattern taste; the index wants to be a Fabric service and the omnibox is Shell. Today: umbrella.py fans one query across connectors and the File Cabinet.",
          },
        ],
      },
      {
        "label": "Loom as the shell",
        "layer": "shell",
        "chips": [
          {
            "label": '"Why now" decision cards',
            "tip":
              "app.js renders canopy.weaver.decisionQueue served at /page-intention-canopy; whyNow becomes the 'Why now' paragraph; options / expectsReply drive replies.",
          },
          {
            "label": "Unseen dots and the bell",
            "tip":
              "updatePatternsNavAttention (app.js) and computePatternsAttention (pattern-attention.ts): unseen counts computed shell-side.",
          },
          {
            "label": "The donut: spatial attention ranking",
            "tip":
              "Pond donut attention surface (app.js, pond/attention-donut-notes.md); ordering derived at read, rendered shell-side.",
          },
          {
            "label": "Mounts patterns, routes navigation",
            "tip":
              "pattern-host.js: provides runtimeContext/spaceContext, binds cf-navigate and cf-open-external (preventDefault only when handled).",
          },
          {
            "label": "Hosts the new-profile surface",
            "tip":
              "Loom mounts the labs ProfileCreate trusted surface (profile-create.tsx); required event-integrity: TRUSTED_PROFILE_CREATE_SURFACE.",
          },
        ],
      },
    ],
  },
  {
    "ttag": "Settled · landed in Fabric",
    "tname": "Load-bearing substrate contracts",
    "tline":
      "Adopted from Fabric and exercised daily, grouped by the layer that exercises them.",
    "health": "LOAD-BEARING",
    "groups": [
      {
        "label": "exercised as patterns",
        "layer": "edge",
        "chips": [
          {
            "label": "Profile pages as patterns",
            "tip":
              "profile-home.tsx / profile-embed render #profile; resolution is a runtime builtin (loom profile_resolver.py uses the same runner builtin).",
          },
        ],
      },
      {
        "label": "exercised by the shell",
        "layer": "shell",
        "chips": [
          {
            "label": "The new-profile surface",
            "tip":
              "ProfileCreate trusted surface (profile-create.tsx); uiContract.requiredEventIntegrity gates identity minting to a certified surface.",
          },
          {
            "label": "Shell seams consumed: 4 of 7",
            "tip":
              "HOST_EMBEDDING.md: 7 CI-tested seams; Loom consumes contexts, both navigation shapes, guarded define; egress predicate and trusted-mark not yet exercised.",
          },
        ],
      },
      {
        "label": "Fabric contracts",
        "layer": "core",
        "chips": [
          {
            "label": "Incoming data marked at the border",
            "code": "split-mint",
            "tip":
              "ExternalIngest split-mint (prepare.ts:4713): mark derived from operator-verified channel metadata + payload digest; runtime strips attacker-supplied marks; custodyIngest carries OAuth + Plaid today, webhooks not yet.",
          },
          {
            "label": "Sessions bound to one host, no replay",
            "code": "session.open",
            "tip":
              "verifySessionOpenAuthorization hard-requires aud (server DID), iat, exp, and a single-use server challenge (session-open-auth.ts); required, not opt-in.",
          },
          {
            "label": "Signed manifest on every agent run",
            "code": "run-manifest",
            "tip":
              "LoomRunManifest (contracts/run-manifest.ts): wishId, dispatchClass, capabilityProfile, model, cfc.enforcementMode; minted by harness_batch.py.",
          },
        ],
      },
    ],
  },
];

export const LEDGER_INTRO: Seg[] = [
  {
    "t": "The full survey: every concern, at implementation grain.",
    "b": true,
  },
  {
    "t":
      " Which layer owns each, where the code stands today, and where the design still needs discourse. Hover a concern for the precise referent; hover a flag for the question.",
  },
];

export const BANDS: Band[] = [
  {
    "title": "The person's moment",
    "sub": "what you touch",
    "layer": "shell",
    "domains": [
      {
        "title": "Attention & interruption",
        "flags": 1,
        "strip": [
          {
            "w": 30.0,
            "c": "good",
          },
          {
            "w": 35.0,
            "c": "warn",
          },
          {
            "w": 5.0,
            "c": "ink3",
          },
          {
            "w": 30.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Notice / surface envelope",
            "tip":
              "Weaver decisionQueue; whyNow/whyClearsBar required (weaver-judging.ts@6ccaf8d25)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Loudness assignment",
            "tip": "Model-judged in the wake-judge loop (weaver-judging.ts).",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
            "flag":
              "Is the model the permanent arbiter of what interrupts you, or does a deterministic governor eventually gate it? Judgment quality vs accountable calm. Use case: Dinner with your kids: the model alone decides whether a work thread buzzes the table.",
          },
          {
            "name": "Canonical candidate store",
            "tip":
              "canopy.weaver.decisionQueue (weaver-decision-queue.ts@ce42136d0)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Unseen dots / bell",
            "tip": "app.js",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "live",
          },
          {
            "name": "Spatial ranking (donut)",
            "tip": "app.js; pond attention notes",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "live",
          },
          {
            "name": "why-now justification",
            "tip": "Schema-required whyNow (weaver-judging.ts:2620)",
            "layer": "Pattern",
            "layerCls": "edge",
            "status": "live",
          },
          {
            "name": "One spectrum, no side doors",
            "tip":
              "Suggestions and speculatively run results surface through the same envelope and loudness pricing as any notice. Loom already funnels everything through the Weaver decisionQueue, the sole ask-channel; a Fabric-level contract does not exist yet",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Posture ladder",
            "tip":
              "ATTENTION_POSTURES stored, unconsumed (source_linkage.py@cf29a1e9e)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Seen-state",
            "tip":
              "Product-side, per-browser localStorage (pattern-attention.ts@776a7ed36); known mis-layering",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Approval-bearing notices",
            "tip":
              "Weaver action-approval gate; no authorization_state (weaver-decision-queue.ts:1660)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Feedback verbs",
            "tip":
              "Split: terminal disposition state is Fabric; the capture surface is Shell; calibration rides ext back to the Pattern. Today email-scoped: DISPOSITION_STATES (email_dispositions.py@3659e519f)",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "partial",
          },
          {
            "name": "Retraction (supersedes)",
            "tip": "threadKey + superseded state exist; no unified field",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Today block",
            "tip": "Home label only (app.js)",
            "layer": "Pattern",
            "layerCls": "edge",
            "status": "partial",
          },
          {
            "name": "Deterministic surfacing resolver",
            "tip":
              "resolve_attention_interruption, 0 production callers (uom_runtime.py:1095); contract-first, unwired",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "stranded",
          },
          {
            "name": "While-you-were-away",
            "tip":
              "Split: the changes projection is Fabric; the catch-up view is a Pattern; the Shell mounts it",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
          {
            "name": "Digest",
            "layer": "Pattern",
            "layerCls": "edge",
            "status": "absent",
          },
          {
            "name": "Channels / genres / claim-kind",
            "layer": "Pattern",
            "layerCls": "edge",
            "status": "absent",
          },
          {
            "name": "Mute / quiet-hours / realert",
            "tip": "Doc-only; generalizes to situational postures",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
          {
            "name": "Timer-wake substrate",
            "tip":
              "Realert, escalation, notBefore timeliness ride a poll-driven daemon (weaver-wake.ts); no platform timer",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
          {
            "name": "Stance vocabularies",
            "tip": "fabric-watch retired",
            "layer": "Pattern",
            "layerCls": "edge",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Presentation & modality",
        "flags": 2,
        "strip": [
          {
            "w": 100.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Capacity profile of the moment",
            "tip":
              "Hands, eyes, ears, attention available now. One mechanism serves permanent disability, situational disability, and preference: the curb-cut principle. Shell senses; Fabric holds it labeled",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
            "flag":
              "One mechanism for disability, situation, and preference (curb-cut), or special-cased modes? And who may know your current capacity? Use case: Hands in dough, sun on the screen, or one working arm: the same big-button, voice-first answer serves all three.",
          },
          {
            "name": "Modality negotiation",
            "tip":
              "Voice-first, glanceable, haptic, full-visual per capacity; the surface envelope has level/intent, no modality",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
          },
          {
            "name": "Portable presentation preferences",
            "tip":
              "Type scale, contrast, motion, density, language, verbosity: user-owned Fabric cells any shell honors",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
          {
            "name": "Safety-critical suppression",
            "tip": "Driving mode as fail-closed policy, not best-effort",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
          {
            "name": "Environment disclosure",
            "tip":
              "Is the screen shared, projected, visible to the room? The room is a recipient; unnamed anywhere",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
            "flag":
              "Is the room a recipient? What the screen shows when others can see it is a disclosure decision nobody owns yet. Use case: You are screen-sharing in standup when a therapy reminder slides in from your private life.",
          },
        ],
      },
      {
        "title": "Context slicing",
        "flags": 1,
        "strip": [
          {
            "w": 100.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Context entry / switching",
            "tip":
              "The icon-tap rebuilt as a first-class consent act; the Fabric containers are live, no surface exercises them",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
            "flag":
              "What replaces the icon-tap? Choosing which self is active must be explicit, cheap, and unspoofable. Use case: Sunday night: you want tomorrow's meetings without being shown your work inbox; entering work must be a choice, not a leak.",
          },
          {
            "name": "Active-context indicator",
            "tip":
              "Always-visible, unspoofable 'which self is on screen'; backed by trusted-mark",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
          },
          {
            "name": "Slice-scoped attention & search",
            "tip":
              "Diary mode gets no work pings; attention state pools across selves today",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
          {
            "name": "Guest / handed-device mode",
            "tip":
              "Show the photos without handing over your life; a situational persona slice",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Universal input & intent routing",
        "flags": 1,
        "strip": [
          {
            "w": 25.0,
            "c": "good",
          },
          {
            "w": 25.0,
            "c": "warn",
          },
          {
            "w": 50.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Universal search",
            "tip":
              "Split: the index is a substrate service (Fabric), ranking and merging are Pattern taste, the omnibox is Shell. Today: umbrella.py fans one query across connectors and the File Cabinet",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Counterparty resolution",
            "tip":
              "Same split as who's-who: the proposer is Pattern, the user-authoritative decision ledger is Fabric-shaped. 'bosslady' resolves via the people canonicalizer",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Capture anywhere",
            "tip":
              "Wake word, hotkey, share-sheet; Loom has a capture dispatch class",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "partial",
          },
          {
            "name": "Mixed authority per utterance",
            "tip":
              "Milk needs nothing; the send crosses the outbound gate. Gate live, no per-fragment UX",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "partial",
          },
          {
            "name": "Compound-intent splitting",
            "tip":
              "'Add milk and send bosslady my progress': one utterance, N intents",
            "layer": "Pattern",
            "layerCls": "edge",
            "status": "absent",
          },
          {
            "name": "Per-intent identity labeling",
            "tip":
              "Grocery to family space, progress from work self; active-self resolution per fragment, governed not guessed",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "One utterance, several selves: is routing per fragment governed by policy or guessed by the model? Use case: Add milk and send bosslady my progress: one breath, two selves; milk to the family list, progress from work-you.",
          },
          {
            "name": "Routing-confirmation surface",
            "tip":
              "'Milk to Family list; progress to Bosslady, from Work-you. OK?'",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
          },
          {
            "name": "Speaker identity on voice",
            "tip":
              "Whose utterance is this, on a family device; ingress-actor on the input side",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Cross-device continuity",
        "flags": 1,
        "strip": [
          {
            "w": 20.0,
            "c": "ink3",
          },
          {
            "w": 80.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Device eviction surface",
            "tip":
              "Revocation is the Ownership claim, renew-or-evict; no one-gesture surface",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "latent",
          },
          {
            "name": "Labeled clipboard",
            "tip":
              "Copy carries provenance + CFC label; paste across spaces is a disclosure decision, not a memcpy",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Is a paste across spaces a disclosure decision? Frictionless copy vs the classic exfiltration channel. Use case: Copy a paragraph from your diary, paste into a work doc: the paste should know where those words were born.",
          },
          {
            "name": "Session handoff",
            "tip":
              "Split: the session contract is Fabric; the handoff choreography is Shell. Start on the phone, continue at the desk, mid-thought",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
          {
            "name": "Device roles / coordinated use",
            "tip":
              "Phone as approver or remote for a desk session; device keys exist, roles don't",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
          {
            "name": "Presence-aware delivery",
            "tip": "Notify the device you're looking at, not all five",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Shell duties, cross-cutting",
        "flags": 1,
        "strip": [
          {
            "w": 50.0,
            "c": "warn",
          },
          {
            "w": 50.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Universal undo",
            "tip":
              "One gesture takes back an agent act; Loom has an op journal with undo tests",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "partial",
          },
          {
            "name": "Graceful degradation",
            "tip": "Seams degrade by contract; no offline story",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "partial",
          },
          {
            "name": "Why am I seeing this",
            "tip":
              "Provenance rendered on demand; the provenance itself is live in Fabric",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
          },
          {
            "name": "Trusted-surface distinguishability",
            "tip":
              "The user can always tell shell chrome from pattern content: anti-phishing inside your own system",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
            "flag":
              "Can the user always tell shell chrome from pattern content, unspoofably? Anti-phishing inside your own system. Use case: A pattern draws a pixel-perfect fake approval dialog; the real one must be impossible to imitate.",
          },
        ],
      },
      {
        "title": "Permission surface",
        "flags": 1,
        "strip": [
          {
            "w": 100.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "See-what-has-what",
            "tip":
              "The Settings-Privacy of delegated authority; the grants exist as code, no surface shows them",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
            "flag":
              "Can a person actually audit delegated authority at a glance? Complete disclosure vs comprehensible disclosure. Use case: Which agents can still read my calendar should be one glance, one screen, revocable on the spot.",
          },
          {
            "name": "Grant / revoke UX",
            "tip": "Renew-or-evict as one gesture",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
          },
          {
            "name": "Prompt-fatigue economics",
            "tip":
              "When to ask vs infer vs default; the OS permission-prompt lesson",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
        ],
      },
    ],
  },
  {
    "title": "The ecosystem",
    "sub": "what builders touch",
    "layer": "edge",
    "domains": [
      {
        "title": "Embedding & the shell seam",
        "flags": 2,
        "strip": [
          {
            "w": 57.1,
            "c": "good",
          },
          {
            "w": 14.3,
            "c": "warn",
          },
          {
            "w": 14.3,
            "c": "ink3",
          },
          {
            "w": 14.3,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Seam contract (7 seams, CI-tested)",
            "tip": "HOST_EMBEDDING.md@86dcb41f4",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "runtimeContext / spaceContext",
            "tip": "runtime-context.ts@0dbb18ee2",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Navigation intent",
            "tip": "cf-navigate / cf-open-external (pattern-host.js@e5a8bd2e7)",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "live",
          },
          {
            "name": "Guarded define",
            "tip": "Seam 5 + test",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Trusted-mark certification",
            "tip": "uiContract policy record; not exercised",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Egress predicate",
            "tip": "cfcLabelViewIsPublic unused by the shell (cfc-label.ts).",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "latent",
            "flag":
              "Who owns fail-closed at each host boundary: every shell independently, or a substrate check no host can skip? Use case: A shell caches a preview thumbnail of a private document to unencrypted disk; which layer was supposed to say no?",
          },
          {
            "name": "Semantic surface contract",
            "tip":
              "Patterns ship meaning, shells choose form; the seam accessibility and modality both require. No seam exists",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "How much form may the shell impose on a pattern's meaning? Pattern expressiveness vs re-renderable accessibility. Use case: Driving, you ask for your morning brief; the pattern only ships pixels, so the shell has nothing to speak aloud.",
          },
        ],
      },
      {
        "title": "Distribution & updates",
        "flags": 1,
        "strip": [
          {
            "w": 16.7,
            "c": "good",
          },
          {
            "w": 83.3,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Wishes: declarative discovery",
            "tip":
              "wish({query}) resolves data by policy, not location; the found datum's rules travel with it (labs wish system)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Publish & discover patterns",
            "tip":
              "Permissionless publishing that grants no power: registry, signing, discovery. Commons-critical",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
            "flag":
              "Discovery without a gatekeeper: how do people find good patterns if no one may own the index? Permissionless publishing vs curation power. Use case: A first-time author ships a great pattern; how does anyone find it without an app store deciding winners?",
          },
          {
            "name": "Suggestions: find-and-run",
            "tip":
              "The system proposes a pattern to fulfil a need, not just data. Discovery lives here; the surfacing half rides the attention spectrum, one door, no exceptions",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
          {
            "name": "Versioned updates & rollback",
            "tip": "Evergreen patterns without breakage; rollback as a right",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
          {
            "name": "Data schema migration",
            "tip":
              "Long-lived user data must survive pattern evolution; Loom's SETUP_VERSION gate is the product-side proof of need",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
          {
            "name": "Composition & proof inheritance",
            "tip":
              "Patterns inherit proofs from patterns they compose (the Commons mechanism); design only",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Naming & addressing",
        "flags": 1,
        "strip": [
          {
            "w": 33.3,
            "c": "warn",
          },
          {
            "w": 66.7,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Universal links to anything",
            "tip":
              "Wikilinks + cf-cell-link exist product-side; no cross-shell universal address",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "partial",
          },
          {
            "name": "Human names over key-pairs",
            "tip":
              "Key-pairs are unforgeable but unmemorable: Zooko's triangle, petnames vs registries",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Zooko's triangle: memorable, unique, decentralized, pick two. Petnames or registries? Use case: Tell your mom where to reach you: a key fingerprint is not an address she can remember.",
          },
          {
            "name": "Cross-space addressing",
            "tip": "Refer to a thing in another space without copying it",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Developer experience",
        "flags": 1,
        "strip": [
          {
            "w": 33.3,
            "c": "warn",
          },
          {
            "w": 33.3,
            "c": "ink3",
          },
          {
            "w": 33.3,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Pattern test harness",
            "tip": "Labs seam tests exist; no author-facing harness",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Inspector / devtools",
            "tip":
              "state-inspector + cf inspect exist, unwired into any developer experience",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "latent",
          },
          {
            "name": "Debugging without seeing user data",
            "tip":
              "CFC-compatible devtools: reproduce a bug over context you may not inspect. A genuinely novel problem",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
            "flag":
              "How does an author reproduce a bug over context they may not inspect? Developer velocity vs the no-inspection guarantee. Use case: Your meal-planner mangles someone's grocery list; you must fix it without ever reading their groceries.",
          },
        ],
      },
      {
        "title": "Resource governance",
        "flags": 1,
        "strip": [
          {
            "w": 33.3,
            "c": "good",
          },
          {
            "w": 66.7,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Contended singletons",
            "tip":
              "Browser-access lease pool + single-flight sync leases; product-side today",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Runaway containment",
            "tip":
              "Quotas so one pattern can't eat the machine; today only ad hoc budgets (a $0.25 judging cap)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
          {
            "name": "Speculation metering",
            "tip":
              "Speculative execution costs compute: who pays, what bounds it. The economics under Calm",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Speculation is Calm's engine and it costs compute: who pays, and what bounds it before it becomes its own attention economy? Use case: A hundred patterns quietly audition against your context all night; your battery and fan pay for it.",
          },
        ],
      },
      {
        "title": "Security response",
        "flags": 1,
        "strip": [
          {
            "w": 100.0,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Retraction without a tollbooth",
            "tip":
              "Pulling a malicious pattern without becoming the gatekeeper: the Commons tension",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Who can pull a malicious pattern, and by what right? Rapid security response vs the power to de-platform. Use case: A popular pattern turns out to exfiltrate; someone must be able to stop it tonight without holding a kill switch over everything.",
          },
          {
            "name": "Vulnerability pipeline",
            "tip":
              "Disclosure, patch, notify: whose job, in a centerless system?",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "absent",
          },
          {
            "name": "Key-compromise recovery",
            "tip": "Rotate a root without losing a life",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
    ],
  },
  {
    "title": "The bedrock",
    "sub": "what everything stands on",
    "layer": "core",
    "domains": [
      {
        "title": "Identity & selves",
        "flags": 4,
        "strip": [
          {
            "w": 55.6,
            "c": "good",
          },
          {
            "w": 44.4,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Profile rendering",
            "tip": "#profile resolution (runtime builtin) + profile-home.tsx",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Profile creation",
            "tip": "Trusted create surface (profile-create.tsx@217e47398)",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "live",
          },
          {
            "name": "Owner-gated writes",
            "tip":
              "Pattern-declared Cfc WriteAuthorizedBy; platform-enforced writeAuthorizedByReason (prepare.ts:2788)",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Per-profile isolation",
            "tip": "Own anonymous space, structural (shared-profile-space.md)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Who's-who canonicalization",
            "tip":
              "Split: matching heuristics and merge proposals are Pattern taste; the assert_same / assert_distinct decision ledger is canonical, user-authoritative state, Fabric-shaped (canonicalizer.py@20da03939, decisions.py)",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Behavioral unlinkability",
            "tip":
              "Crypto persona separation ships; nothing stops one model re-linking two spaces by style",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Can one model serve two of your selves without becoming the link between them? Model quality from shared context vs structural separation. Use case: A developer contributes under a pseudonym; one assistant has seen their style under both names and outs them just by being consistent.",
          },
          {
            "name": "Active-self resolution",
            "tip":
              "Which self governs a container-less intent; activation policy as a governed object",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Who decides which self a container-less moment belongs to: governed policy, model guess, or always-ask? Friction vs misdirected disclosure. Use case: A teacher steps out, posts under another name, walks back to class; the next utterance must land in the right life.",
          },
          {
            "name": "Linkage as governed object",
            "tip":
              "The edge between two selves as first-class: disclosable per relationship, revocable",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Is the edge between two selves itself data, with its own disclosure policy? Even when both endpoints are public, the connection may be the secret. Use case: Your band profile and your work profile are each public and harmless; a parent discovering they share a root is the actual leak.",
          },
          {
            "name": "Recipient-knowledge model",
            "tip":
              "What does this counterparty already know; no primitive exists",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Where does 'what this counterparty already knows' live, and who may read it? A dossier on others is itself sensitive context. Use case: The same sentence is harmless to the coworker who knows you are job-hunting and radioactive to the one who doesn't.",
          },
        ],
      },
      {
        "title": "Sharing & collaboration",
        "flags": 0,
        "strip": [
          {
            "w": 33.3,
            "c": "good",
          },
          {
            "w": 33.3,
            "c": "warn",
          },
          {
            "w": 33.3,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Shared spaces across people",
            "tip":
              "Spaces are key-pairs; access by capability delegation; DIDs identify participants (labs identity, shared-profile-space)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Real-time co-presence",
            "tip":
              "Causal consistency and subscriptions carry multiplayer by default; shared-presence UX not grounded",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Groups form, work, dissolve",
            "tip":
              "Reversible collaboration with boundaries intact: the Commons mechanism, design only",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
      {
        "title": "External context & ingestion",
        "flags": 2,
        "strip": [
          {
            "w": 66.7,
            "c": "good",
          },
          {
            "w": 16.7,
            "c": "warn",
          },
          {
            "w": 16.7,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Account importers",
            "tip":
              "Split: the durable write path is Fabric (custodyIngest: oauth2-common.utils.ts@ea12cdfd9); each connector body is a Pattern",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Provenance at the border",
            "tip": "ExternalIngest split-mint (prepare.ts:4713)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Bidirectional sync",
            "tip": "editWithRetry CAS + importer discipline",
            "layer": "Pattern",
            "layerCls": "edge",
            "status": "live",
          },
          {
            "name": "Outbound actuation gate",
            "tip":
              "write_gate.py: two fail-closed checks, 'the sole trust boundary'; lives in pattern space, Fabric-shaped.",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
            "flag":
              "Where is actuation's home: pattern-space discipline or a Fabric gate? Acting on the world is the highest-stakes egress. Use case: Send bosslady my progress drafts harmlessly; the actual send is the moment that must cross a gate.",
          },
          {
            "name": "DID-less inbound",
            "tip":
              "Journal-sink live; webhook path still unmarked (webhooks.handlers.ts)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Ingress-actor verification",
            "tip":
              "An SMS number or email address is not a DID; nothing vouches an inbound identity",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "What vouches an inbound identity? An SMS number is not a DID; how much authority can an unverified sender reach? Use case: A text from an unknown number: this is your daughter, new phone, send the door code.",
          },
        ],
      },
      {
        "title": "Storage",
        "flags": 0,
        "strip": [
          {
            "w": 33.3,
            "c": "good",
          },
          {
            "w": 33.3,
            "c": "warn",
          },
          {
            "w": 33.3,
            "c": "ink3",
          },
        ],
        "rows": [
          {
            "name": "Instance-local derived state",
            "tip":
              "coord_dir read-models and ledgers, outside both the File Cabinet and the space store",
            "layer": "Mixed",
            "layerCls": "mix",
            "status": "live",
          },
          {
            "name": "Attention-state stores",
            "tip": "Three product-side substrates, no unified contract",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Activity / audit projection",
            "tip": "state-inspector exists; Loom hand-rolls JSONL ledgers",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "latent",
          },
        ],
      },
      {
        "title": "Agent execution & harness",
        "flags": 2,
        "strip": [
          {
            "w": 63.6,
            "c": "good",
          },
          {
            "w": 18.2,
            "c": "warn",
          },
          {
            "w": 18.2,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Background runs",
            "tip": "harness_batch.py@8d1d5bc44",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Interactive chat transport",
            "tip": "codex_app_server.py; cf_harness_chat_stdio.py",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Harness abstraction",
            "tip": "harness_registry.py: claude, codex, cf-harness",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Run manifests",
            "tip": "LoomRunManifest (run-manifest.ts@21dd450fa)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Snapshots / transcripts / reports",
            "tip": "artifacts.ts@d5444f27f",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Resumability / artifacts",
            "tip": "harness_batch.py; local-loom.py",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Subagent delegation",
            "tip": "contracts/subagent.ts@c68969a23; sanitized returns",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Sandboxing",
            "tip":
              "Autonomous dispatch is pinned to the cf-harness docker/runsc sandbox whenever docker is present: read-only File Cabinet mount, network-disabled parent (wish-dispatch.sh page-authority pin, #4104). Docker-less machines fall back loudly with degraded page-write authority; interactive chat remains unsandboxed.",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "CFC on execution",
            "tip":
              "Four modes built; observe runs live on every autonomous wish via the page-authority pin (#4104; sweep pinned too, #4102). Enforcing modes still unexercised, retire-by 2026-08-01.",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
            "flag":
              "When does observe become enforce, and what breaks first? Enforcement guarantees vs agent capability while trusted labels are incomplete. Use case: An agent drafting a reply quotes a confidential thread to an outside recipient; observe logs it, enforce would have stopped it.",
          },
          {
            "name": "Model-judgment attestation",
            "tip":
              "Containment, not attestation, is the security doctrine: the runtime, never the model, decides.",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
            "flag":
              "Containment is the security doctrine. Is it also enough for Calm's arbiter, or does surfacing judgment need its own accountability? Use case: A notification broke your evening; nothing can show why the model judged it worthy, or that the judgment ran unmodified.",
          },
          {
            "name": "Delegation ceilings / eviction",
            "tip":
              "Manifest carries dispatchClass/capabilityProfile; ceilings and eviction as policy cells not built",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Federation & multi-host",
        "flags": 0,
        "strip": [
          {
            "w": 66.7,
            "c": "good",
          },
          {
            "w": 33.3,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Audience-bound session.open",
            "tip":
              "Required aud/iat/exp/challenge (session-open-auth.ts@84f6b93c8)",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Protocol versioning",
            "tip": "v1 removed; memory-v2 wire protocol",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "live",
          },
          {
            "name": "Space lifecycle teardown",
            "tip": "Opened spaces accumulate; no dispose path",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Confidential compute",
        "flags": 0,
        "strip": [
          {
            "w": 33.3,
            "c": "warn",
          },
          {
            "w": 66.7,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Remote attestation",
            "tip":
              "Demonstrated in the sibling RATSnest stack: TDX quotes verified remotely, tunnels keyed to the quote, runtime measured at boot. Not yet exercised from the Fabric serving path we grounded",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Attested serving mesh",
            "tip":
              "Mutually attesting nodes as the default way Fabric runs in the cloud: verify the code, not the company",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
          {
            "name": "Transparency log",
            "tip":
              "Published fingerprints of what the attested fleet runs, so tampering has nowhere quiet to happen",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
      {
        "title": "Fault isolation & recovery",
        "flags": 0,
        "strip": [
          {
            "w": 33.3,
            "c": "warn",
          },
          {
            "w": 66.7,
            "c": "hair",
          },
        ],
        "rows": [
          {
            "name": "Crash containment",
            "tip":
              "A pattern crash can't take the shell; the dispatch sandbox is pinned-on where docker exists, absent elsewhere",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "partial",
          },
          {
            "name": "Safe mode",
            "tip": "Boot with patterns disabled; recover from a bad one",
            "layer": "Shell",
            "layerCls": "shell",
            "status": "absent",
          },
          {
            "name": "Backup / restore / export",
            "tip":
              "Ownership implies export-everything; File Cabinet markdown is exportable by accident, not by contract",
            "layer": "Fabric",
            "layerCls": "core",
            "status": "absent",
          },
        ],
      },
    ],
  },
];

export const SECTIONS: { glyph: string; title: string; sub: string[] }[] = [
  {
    "glyph": "◷",
    "title": "A familiar shape",
    "sub": [
      "Durable substrates tend to divide the same way: an open edge, a mediating surface, a guarded core. Two you've met, and then Fabric, read the same direction the layers do below: open at the top, foundation at the base.",
    ],
  },
  {
    "glyph": "◔",
    "title": "Why three",
    "sub": [
      "Not two, not four. Three layers because there are three kinds of trust, and each needs a different owner.",
      "Collapse any boundary and a promise breaks. Merge the shell into the platform and the substrate owns your eyes: the bundled-browser story. Merge the shell into the patterns and every surface can phish: the app grid we live in now. Add a fourth layer and you add a seam without adding a new kind of trust. Three is the count the trust demands.",
    ],
  },
  {
    "glyph": "◱",
    "title": "The three layers",
    "sub": [
      "Each layer separates the same three kinds of concern: how it works, who it serves, and how it's abused. Stated as principles; the code behind each lives under Concerns.",
    ],
  },
];

export const FIGURE: { alt: string; caption: string } = {
  "alt":
    "Common Fabric drawn as a medieval mappa mundi: three walled rings (Fabric the bedrock, Shell the chosen surface, Patterns the open shore) inside a ring of the five promises, five sea beasts offshore, red dragons where questions remain open, and HIC SVNT DRACONES over the uncharted sector.",
  "caption":
    "A mappa mundi is a world-picture, not a chart: everything known, believed, and feared, on one page. The promises ring the edge; the three layers are the geography; the five beasts offshore are the five status quos, kept off by the architecture; the wall's one gate is the door to your attention; the dragons roost where the open questions live. Each tab reads a region of this map, at its own altitude.",
};

export const FOOTER: string =
  "Grounded in code · loom @5cd0701e1 · Common Fabric via labs pin loom-stable-2026-07-14 · 2026·07·14";
