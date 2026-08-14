--------------------------- MODULE PendingStacks ---------------------------
(***************************************************************************)
(* A bounded model of the Memory v2 pending-stack commit protocol          *)
(* (docs/specs/memory-v2/03-commit-model.md sections 3.3-3.6), built to    *)
(* check the invariant catalog (09-invariants.md) over all small           *)
(* interleavings for each dependency-recording and staleness-basis         *)
(* variant.                                                                *)
(*                                                                         *)
(* Abstractions (see tla/README.md for the full argument):                 *)
(*                                                                         *)
(*   - One space, one branch, one scope, one document whose leaf paths     *)
(*     are the constant set Paths.  Overlap collapses to path equality;    *)
(*     the Tier-1 path-blind set/delete check and the ancestor/descendant  *)
(*     structure of real paths are not modeled (they only widen conflict   *)
(*     detection, i.e. move within INV-2's safe direction).                *)
(*                                                                         *)
(*   - Every write is an append: the value of a path is the SET of         *)
(*     accepted commits that wrote it.  A read's observation is recorded   *)
(*     as its contributor sets (confirmed seqs + pending localSeqs), and   *)
(*     coherence is set equality against durable history at the reader's   *)
(*     resolution seq.  This models mergeable/blind writes directly and    *)
(*     makes both failure directions of INV-1 visible: a phantom           *)
(*     contributor (CT-1872 "1c") and a missed concurrent write            *)
(*     (CT-1910).                                                          *)
(*                                                                         *)
(*   - Verdict delivery is a mode (DeliveryMode below).  "atomic" fuses    *)
(*     the server's verdict with the client's mirrored effects, the       *)
(*     original abstraction; "channel" splits them: the server decides,    *)
(*     the client learns each verdict later by an explicit Deliver step    *)
(*     (in submission order, matching inline transact responses), and the  *)
(*     rejection drop-and-cascade runs at DELIVERY, not decision.  The     *)
(*     channel mode is what brings INV-6 (accepted-versus-dropped          *)
(*     agreement) and the decided-but-not-yet-applied window of CT-1927    *)
(*     verdict parking into scope, and it is where sparse dependency       *)
(*     arrays (03-commit-model.md section 3.5) earn their keep: a commit   *)
(*     built after a delivered rejection's drop records only the           *)
(*     surviving layers.  Timing of the drop past delivery (the           *)
(*     read-repair gate) is deliberately collapsed into the Deliver step:  *)
(*     a commit built between delivery and a later drop records the same   *)
(*     dependency array as one built before delivery, so the extra         *)
(*     interleavings add no observably distinct states.                    *)
(*                                                                         *)
(*   - Per-session server processing is FIFO, which is INV-5 by            *)
(*     construction (the current implementation rejects rather than        *)
(*     holds, preserving the same order).                                  *)
(*                                                                         *)
(* Modes:                                                                  *)
(*                                                                         *)
(*   DepMode - how a commit that reads path p through the pending stack    *)
(*     records its dependency set (INV-3):                                 *)
(*       "fullstack" shipped #4606 shape: every pending layer of the       *)
(*                   reader's view.                                        *)
(*       "filtered"  proposed CT-1872 refinement: layers whose footprint   *)
(*                   overlaps p, plus always the top-of-stack layer.       *)
(*                                                                         *)
(*   BasisMode - where the staleness scan for a pending read starts:       *)
(*       "maxdep"    legacy: served only to pending reads that carry no    *)
(*                   basisSeq; scans from the resolution seq of the        *)
(*                   highest recorded dependency (CT-1910's over-advance). *)
(*       "confirmed" CT-1910 repair, shipped: clients declare basisSeq     *)
(*                   and the scan runs from that confirmed basis with the  *)
(*                   reader's own session excluded.                        *)
(*                                                                         *)
(*   DeliveryMode - when the client learns a verdict (see above):          *)
(*       "atomic"    verdict and mirrored client effects in one action.    *)
(*       "channel"   verdicts delivered later, in order, by Deliver.       *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Sessions,     \* logical sessions, e.g. {"s1", "s2"}
  Paths,        \* leaf paths of the single modeled document, e.g. {"p1", "p2"}
  MaxTotal,     \* bound on the total number of commits built, all sessions
  DepMode,      \* "fullstack" | "filtered"
  BasisMode,    \* "maxdep" | "confirmed"
  DeliveryMode  \* "atomic" | "channel"

ASSUME DepMode \in {"fullstack", "filtered"}
ASSUME BasisMode \in {"maxdep", "confirmed"}
ASSUME DeliveryMode \in {"atomic", "channel"}
ASSUME MaxTotal \in Nat \ {0}

VARIABLES
  log,        \* accepted commit log; seq n is log[n]
  pend,       \* per session: the pending stack (layers the client's view
              \* still sits on: undecided, decided-but-undelivered, and
              \* accepted-not-yet-integrated commits, in localSeq order)
  res,        \* per session, per localSeq: SERVER verdict [st, seq]
              \* st \in {"none", "acc", "rej"}; seq is 0 unless st = "acc"
  known,      \* per session, per localSeq: CLIENT-known fate
              \* ("none" | "acc" | "rej"); trails res in channel mode,
              \* mirrors it in atomic mode.  A cascade victim's "rej" is
              \* fabricated locally, possibly before its server verdict.
  localrej,   \* per session: localSeqs the client rejected locally (cascade
              \* victims of a delivered rejection) - the INV-6 witness set
  nextLocal,  \* per session: next localSeq to assign
  csn,        \* per session: confirmed seq (integrated log prefix length)
  built       \* total commits built (bound: MaxTotal)

vars == <<log, pend, res, known, localrej, nextLocal, csn, built>>

LSeqs == 1..MaxTotal

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

(***************************************************************************)
(* Client-side view at build time (single-snapshot rule: Build is one      *)
(* atomic action against csn[s] plus the current pending stack).           *)
(***************************************************************************)

StackIdx(s) == DOMAIN pend[s]
StackLseqs(s) == {pend[s][j].lseq : j \in StackIdx(s)}
LayersWriting(s, p) ==
  {pend[s][j].lseq : j \in {i \in StackIdx(s) : p \in pend[s][i].writes}}
ObsConfirmed(s, p) == {i \in 1..csn[s] : p \in log[i].writes}

(* The read record a client produces for path p: kind, recorded dependency
   set (per DepMode), the confirmed basis at build time, and the observed
   contributor sets that ReadCoherence later checks.  The recorded set is
   drawn from the CURRENT stack, so in channel mode a build after a
   delivered rejection's drop is sparse relative to session history -
   exactly the view-relative completeness of 03-commit-model.md section
   3.5. *)
ReadRecord(s, p) ==
  LET stack == StackLseqs(s)
      wl == LayersWriting(s, p)
      isPending == stack # {}
      deps ==
        CASE DepMode = "fullstack" -> stack
          [] DepMode = "filtered" ->
               wl \cup (IF stack # {} THEN {Max(stack)} ELSE {})
  IN [path |-> p,
      kind |-> IF isPending THEN "pending" ELSE "confirmed",
      deps |-> IF isPending THEN deps ELSE {},
      cbasis |-> csn[s],
      obsC |-> ObsConfirmed(s, p),
      obsP |-> wl]

Build(s, R, W) ==
  /\ built < MaxTotal
  /\ LET c == [lseq |-> nextLocal[s],
               writes |-> W,
               reads |-> {ReadRecord(s, p) : p \in R}]
     IN pend' = [pend EXCEPT ![s] = Append(@, c)]
  /\ nextLocal' = [nextLocal EXCEPT ![s] = @ + 1]
  /\ built' = built + 1
  /\ UNCHANGED <<log, res, known, localrej, csn>>

(***************************************************************************)
(* Server admission (FIFO within a session).  In atomic mode the client's  *)
(* mirrored drop cascade is fused into rejection; in channel mode          *)
(* rejection is server-side only and the client's effects wait for         *)
(* Deliver.                                                                *)
(***************************************************************************)

Unresolved(s) == {j \in StackIdx(s) : res[s][pend[s][j].lseq].st = "none"}

ScanBasis(s, r) ==
  IF r.kind = "confirmed" THEN r.cbasis
  ELSE IF BasisMode = "maxdep" THEN res[s][Max(r.deps)].seq
  ELSE r.cbasis

(* A write at log index i invalidates read r of session s when it touches
   the read path inside the scan interval -- except that the "confirmed"
   basis mode excludes the reader's own resolved session stack from the
   pending-read scan (the CT-1910 repair). *)
InvalidatedBy(s, r, i, k) ==
  /\ i > ScanBasis(s, r)
  /\ i < k
  /\ r.path \in log[i].writes
  /\ ((BasisMode = "confirmed" /\ r.kind = "pending") => log[i].sess # s)

HasConflict(s, c, k) ==
  \E r \in c.reads : \E i \in DOMAIN log : InvalidatedBy(s, r, i, k)

DepsOf(c) == UNION {r.deps : r \in c.reads}

(* A named dependency that is not accepted at processing time can never
   resolve: FIFO decides lower localSeqs first, so a dependency still
   marked "none" is one the client dropped from its stack before the
   server ever decided it.  Mirrors resolvePendingReads' "pending
   dependency not resolved" rejection.  In atomic mode this predicate is
   unreachable (a dead layer leaves every stack in the same action that
   rejects it), which is exactly why the fused abstraction could omit it. *)
HasDeadDep(s, c) == \E d \in DepsOf(c) : res[s][d].st # "acc"

(* Transitive client-side cascade: dropping localSeq set D also drops every
   stacked commit whose recorded dependency set names a member of D. *)
RECURSIVE Doomed(_, _)
Doomed(s, D) ==
  LET more == {pend[s][j].lseq : j \in {i \in StackIdx(s) :
                 /\ pend[s][i].lseq \notin D
                 /\ DepsOf(pend[s][i]) \cap D # {}}}
  IN IF more = {} THEN D ELSE Doomed(s, D \cup more)

(* Atomic-mode rejection: the server verdict, the client's drop of every
   doomed layer, and the client's knowledge of all of it, in one action.
   Cascade victims are marked rejected in res as well - the fused
   abstraction does not distinguish a server dep-edge rejection from a
   local one. *)
AtomicReject(s, c) ==
  LET D == Doomed(s, {c.lseq})
  IN /\ res' = [res EXCEPT ![s] =
                  [l \in LSeqs |->
                     IF l \in D THEN [st |-> "rej", seq |-> 0]
                     ELSE res[s][l]]]
     /\ known' = [known EXCEPT ![s] =
                    [l \in LSeqs |-> IF l \in D THEN "rej" ELSE known[s][l]]]
     /\ pend' = [pend EXCEPT ![s] = SelectSeq(@, LAMBDA e : e.lseq \notin D)]
     /\ UNCHANGED <<log, localrej, csn, nextLocal, built>>

(* Channel-mode rejection: the verdict alone.  The layer stands in pend -
   visible to dependency recording - until Deliver runs the drop. *)
ChannelReject(s, c) ==
  /\ res' = [res EXCEPT ![s][c.lseq] = [st |-> "rej", seq |-> 0]]
  /\ UNCHANGED <<log, pend, known, localrej, csn, nextLocal, built>>

Accept(s, c, k) ==
  /\ log' = Append(log, [sess |-> s, lseq |-> c.lseq,
                         writes |-> c.writes, reads |-> c.reads])
  /\ res' = [res EXCEPT ![s][c.lseq] = [st |-> "acc", seq |-> k]]
  /\ known' = IF DeliveryMode = "atomic"
              THEN [known EXCEPT ![s][c.lseq] = "acc"]
              ELSE known
  /\ UNCHANGED <<pend, localrej, csn, nextLocal, built>>

Process(s) ==
  /\ Unresolved(s) # {}
  /\ LET c == pend[s][Min(Unresolved(s))]
         k == Len(log) + 1
     IN IF HasDeadDep(s, c) \/ HasConflict(s, c, k)
        THEN IF DeliveryMode = "atomic"
             THEN AtomicReject(s, c)
             ELSE ChannelReject(s, c)
        ELSE Accept(s, c, k)

(***************************************************************************)
(* Verdict delivery (channel mode).  Verdicts reach the client in          *)
(* submission order - inline transact responses.  Delivering an accept     *)
(* only records knowledge (promotion still waits for Integrate, the        *)
(* CT-1927 parking); delivering a rejection runs the drop and the          *)
(* transitive cascade, fabricating local rejections for the victims        *)
(* (recorded in localrej - the INV-6 witness).  A verdict for a localSeq   *)
(* the client already rejected locally is never delivered: known is        *)
(* already set, which is the model's suppressed-late-verdict.              *)
(***************************************************************************)

Undelivered(s) == {l \in LSeqs : res[s][l].st # "none" /\ known[s][l] = "none"}

Deliver(s) ==
  /\ DeliveryMode = "channel"
  /\ Undelivered(s) # {}
  /\ LET l == Min(Undelivered(s))
     IN IF res[s][l].st = "acc"
        THEN /\ known' = [known EXCEPT ![s][l] = "acc"]
             /\ UNCHANGED <<pend, localrej>>
        ELSE LET D == Doomed(s, {l})
             IN /\ known' = [known EXCEPT ![s] =
                               [m \in LSeqs |->
                                  IF m \in D THEN "rej" ELSE known[s][m]]]
                /\ localrej' = [localrej EXCEPT ![s] = @ \cup (D \ {l})]
                /\ pend' = [pend EXCEPT ![s] =
                              SelectSeq(@, LAMBDA e : e.lseq \notin D)]
  /\ UNCHANGED <<log, res, csn, nextLocal, built>>

(***************************************************************************)
(* Integration: the client advances its confirmed view one log entry at a  *)
(* time; integrating its own accepted commit removes that pending layer -  *)
(* the parked promotion.  The guard on own entries models the section      *)
(* 4.11 server obligation that a commit's transact response is sent        *)
(* before any frame whose marker covers it: the covering frame cannot      *)
(* arrive ahead of the verdict.                                            *)
(***************************************************************************)

Integrate(s) ==
  /\ csn[s] < Len(log)
  /\ LET e == log[csn[s] + 1]
     IN /\ (e.sess = s) => (known[s][e.lseq] = "acc")
        /\ pend' = IF e.sess = s
                   THEN [pend EXCEPT ![s] =
                           SelectSeq(@, LAMBDA x : x.lseq # e.lseq)]
                   ELSE pend
  /\ csn' = [csn EXCEPT ![s] = @ + 1]
  /\ UNCHANGED <<log, res, known, localrej, nextLocal, built>>

(***************************************************************************)
(* Specification.                                                          *)
(***************************************************************************)

ReadChoices == {{}} \cup {{p} : p \in Paths}
WriteChoices == (SUBSET Paths) \ {{}}

(* Override target for deeper bounded runs (see PendingStacks_Filtered5.cfg):
   restricting builds to single-path writes keeps MaxTotal = 5 tractable. *)
SingletonWrites == {{p} : p \in Paths}

Init ==
  /\ log = <<>>
  /\ pend = [s \in Sessions |-> <<>>]
  /\ res = [s \in Sessions |-> [l \in LSeqs |-> [st |-> "none", seq |-> 0]]]
  /\ known = [s \in Sessions |-> [l \in LSeqs |-> "none"]]
  /\ localrej = [s \in Sessions |-> {}]
  /\ nextLocal = [s \in Sessions |-> 1]
  /\ csn = [s \in Sessions |-> 0]
  /\ built = 0

Next ==
  \/ \E s \in Sessions : \E R \in ReadChoices : \E W \in WriteChoices :
       Build(s, R, W)
  \/ \E s \in Sessions : Process(s)
  \/ \E s \in Sessions : Deliver(s)
  \/ \E s \in Sessions : Integrate(s)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants (IDs from docs/specs/memory-v2/09-invariants.md).            *)
(***************************************************************************)

(* INV-1.  The contributor set a read observed, mapped through resolution
   (a rejected or unresolved pending contributor maps to 0, which is never
   durable), equals the set of accepted writes to that path below the
   reader's own seq. *)
MappedObs(s, r) == r.obsC \cup {res[s][d].seq : d \in r.obsP}
DurableWriters(p, k) == {i \in 1..(k - 1) : p \in log[i].writes}

ReadCoherence ==
  \A k \in DOMAIN log :
    \A r \in log[k].reads :
      MappedObs(log[k].sess, r) = DurableWriters(r.path, k)

(* INV-4 (with INV-3(a)): no accepted commit names a dependency that did
   not itself resolve to acceptance. *)
CascadeTotality ==
  \A k \in DOMAIN log :
    \A r \in log[k].reads :
      \A d \in r.deps : res[log[k].sess][d].st = "acc"

(* INV-5: within a session, resolution seq is monotonic in localSeq. *)
MonotonicResolution ==
  \A s \in Sessions : \A l1, l2 \in LSeqs :
    (l1 < l2 /\ res[s][l1].st = "acc" /\ res[s][l2].st = "acc")
      => res[s][l1].seq < res[s][l2].seq

(* INV-6: server and client never disagree about a commit's fate - a
   commit the client rejected locally (a cascade victim, dropped ahead of
   or instead of its own server verdict) is never durably accepted.  In
   the model this rests on FIFO plus the dead-dependency admission rule;
   the invariant is what makes that reasoning checked rather than
   assumed. *)
AcceptedVersusDropped ==
  \A s \in Sessions : \A l \in LSeqs :
    l \in localrej[s] => res[s][l].st # "acc"

TypeOK ==
  /\ built \in 0..MaxTotal
  /\ Len(log) <= built
  /\ \A s \in Sessions : csn[s] <= Len(log)
  /\ \A s \in Sessions : \A l \in LSeqs :
       known[s][l] \in {"none", "acc", "rej"}
  /\ \A s \in Sessions : localrej[s] \subseteq LSeqs

=============================================================================
