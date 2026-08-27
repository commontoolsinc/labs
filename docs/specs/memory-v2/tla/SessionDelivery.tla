-------------------------- MODULE SessionDelivery --------------------------
(***************************************************************************)
(* A bounded model of ONE session's watch-delivery state across a          *)
(* reconnect (docs/specs/memory-v2/04-protocol.md sections 4.1.2, 4.3.5,   *)
(* 4.6): the server's per-session delivery memory, the client's replica,   *)
(* and what a reconnect's catch-up frame is diffed against.  It exists to  *)
(* check the property the pending-stack model (PendingStacks.tla) leaves   *)
(* out of scope — connection loss — for the delivery side: that a          *)
(* reconnect brings the replica to the watch union's current state, and    *)
(* does so without re-delivering what the replica already holds.           *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*                                                                         *)
(*   - One session, one watch union covering every document in Docs.  A    *)
(*     document's state is the seq of its latest write (0 = never          *)
(*     written), which is what the server's delivery diff compares         *)
(*     (`sameSnapshot` in server-sync.ts: id, instance, seq, deletedness;  *)
(*     a tombstone is a seq like any other here).                          *)
(*                                                                         *)
(*   - A push while connected is one frame: the server records it as       *)
(*     delivered (`session.entities`), and the client either ABSORBS it or *)
(*     LOSES it — the client-side absorb defect class OW61 owns             *)
(*     (verification-coverage.md), bounded by MaxLoss.  A push while       *)
(*     disconnected is not recorded: the implementation rolls a frame that  *)
(*     failed to send back out of its delivery memory.                     *)
(*                                                                         *)
(*   - A reconnect either RESUMES (the server still holds the session) or  *)
(*     RE-ESTABLISHES it (the session expired while disconnected).  Its    *)
(*     frame delivers every document whose current seq differs from the    *)
(*     diff BASE, and elides the rest.  Mode chooses the base:             *)
(*       "memory"   the server's own delivery memory on resume, and         *)
(*                  nothing on re-establishment (full delivery) — the       *)
(*                  design before client-declared holdings;                 *)
(*       "holdings" the client's declaration of what it holds, on both.    *)
(*     Catch-up frames are absorbed: the pre-watch loss they were subject   *)
(*     to is fixed and pinned separately (#6292); the residual loss class   *)
(*     is the steady-state push, which is what MaxLoss models.             *)
(*                                                                         *)
(*   - Reset models a replaced replica (`SpaceReplica.reset()` under route  *)
(*     replacement): the client's state is wiped while the server session  *)
(*     survives.                                                           *)
(*                                                                         *)
(*   - The client is honest: its declaration IS its replica.  A client     *)
(*     declaring documents it does not hold is outside the model, as a     *)
(*     client fabricating reads is outside PendingStacks.                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Docs,        \* the watch union, e.g. {"d1", "d2"}
  MaxWrites,   \* bound on writes
  MaxLoss,     \* bound on frames the client fails to absorb
  AllowReset,  \* whether the replica may be wiped under a live session
  Mode         \* "memory" | "holdings"

ASSUME Mode \in {"memory", "holdings"}
ASSUME MaxWrites \in Nat \ {0}
ASSUME MaxLoss \in Nat
ASSUME AllowReset \in BOOLEAN

VARIABLES
  seq,             \* the server's current seq
  ver,             \* per document: seq of its latest write (0 = none)
  mem,             \* the server's memory of what it delivered this session
  rep,             \* the client's replica: the seq it holds each doc at
  connected,       \* transport up
  alive,           \* the server still holds the session (resume possible)
  losses,          \* frames lost so far
  resets,          \* replica wipes so far
  justReconnected, \* the last step was a reconnect (the check point)
  redundant        \* some reconnect delivered a document the client held

vars == <<seq, ver, mem, rep, connected, alive, losses, resets,
          justReconnected, redundant>>

Nothing == [d \in Docs |-> 0]

Init ==
  /\ seq = 0
  /\ ver = Nothing
  /\ mem = Nothing
  /\ rep = Nothing
  /\ connected = TRUE
  /\ alive = TRUE
  /\ losses = 0
  /\ resets = 0
  /\ justReconnected = FALSE
  /\ redundant = FALSE

(* A write lands on the server.  Connected and alive, the push frame is
   recorded as delivered and the client absorbs it or loses it. *)
Write(d) ==
  /\ seq < MaxWrites
  /\ seq' = seq + 1
  /\ ver' = [ver EXCEPT ![d] = seq + 1]
  /\ IF connected /\ alive
     THEN /\ mem' = [mem EXCEPT ![d] = seq + 1]
          /\ \/ /\ rep' = [rep EXCEPT ![d] = seq + 1]
                /\ UNCHANGED losses
             \/ /\ losses < MaxLoss
                /\ UNCHANGED rep
                /\ losses' = losses + 1
     ELSE UNCHANGED <<mem, rep, losses>>
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<connected, alive, resets, redundant>>

Disconnect ==
  /\ connected
  /\ connected' = FALSE
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, mem, rep, alive, losses, resets, redundant>>

(* The session lapses while the client is away: the server forgets it. *)
Expire ==
  /\ ~connected
  /\ alive
  /\ alive' = FALSE
  /\ mem' = Nothing
  /\ UNCHANGED <<seq, ver, rep, connected, losses, resets, justReconnected,
                 redundant>>

(* A replaced replica: the client's state is wiped, the session is not. *)
Reset ==
  /\ AllowReset
  /\ resets < 1
  /\ rep' = Nothing
  /\ resets' = resets + 1
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, mem, connected, alive, losses, redundant>>

(* The diff base a reconnect's frame is computed against. *)
Base ==
  IF Mode = "holdings" THEN rep
  ELSE IF alive THEN mem
  ELSE Nothing

Reconnect ==
  /\ ~connected
  /\ connected' = TRUE
  /\ alive' = TRUE
  /\ LET delivered == {d \in Docs : ver[d] # Base[d]}
     IN /\ rep' = [d \in Docs |-> IF d \in delivered THEN ver[d] ELSE rep[d]]
        /\ redundant' = (redundant \/ (\E d \in delivered : rep[d] = ver[d]))
  /\ mem' = ver
  /\ justReconnected' = TRUE
  /\ UNCHANGED <<seq, ver, losses, resets>>

Next ==
  \/ \E d \in Docs : Write(d)
  \/ Disconnect
  \/ Expire
  \/ Reset
  \/ Reconnect

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Properties.                                                             *)
(***************************************************************************)

TypeOK ==
  /\ \A d \in Docs : rep[d] <= ver[d] /\ mem[d] <= ver[d]
  /\ losses <= MaxLoss

(* A reconnect brings the replica to the union's current state: whatever
   was lost, wiped, or written while away is held afterwards at its
   current seq.  Under "memory", a document the server remembers delivering
   but the client lost is elided forever on resume — the schema-doc
   quarantine residual; under "holdings" the client's statement is the
   base and the document comes back. *)
ReconnectConverges == justReconnected => rep = ver

(* A reconnect never re-delivers what the client already holds.  Under
   "memory" a re-established session is delivered in full; under
   "holdings" the base is the replica on both paths. *)
NoRedundantDelivery == ~redundant

=============================================================================
