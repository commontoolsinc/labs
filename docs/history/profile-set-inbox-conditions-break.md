---
status: historical
created: 2026-10-15
archived: 2026-10-15
reason: "Record of the contract finding taken when the profile's setInbox event gained the ifUnset and replacing conditions, so the profile's inbox pointer is checked in the transaction that writes it."
---

# Profile: `setInbox` checks the pointer it replaces

`system/profile-home.tsx`'s `setInbox` stored the link it was sent, whatever
the pointer held. A sender that wanted to point only an unpointed profile
read the pointer in its own transaction and sent the event when it found
none, and Home's `pointAtInboxIfUnset()` and a loom daemon's
`ensureProfileInbox()` both work that way. The read and the write were two
transactions in two spaces, so two senders that each found the pointer unset
both wrote it, and the later write replaced the earlier.

Loom's cf-dist lane measured it, in loom issue #7633. Home pointed a person's
profile at their private inbox, the person's loom daemon then pointed it at a
share inbox it had minted, and a sender that read the pointer after the second
write delivered a direct-room offer to the share inbox. The test, which had
read the first pointer, watched the private inbox. The offer was stored, in
an inbox nothing read for it. Loom #7818, with #8807 here, made Home the one
minter of a profile's inbox: a daemon asks Home first and mints only when Home
declines, which ended that failure in the lane. The publication that remains
where Home declines, and two daemons of one identity, still went through the
same unconditional write, and loom's own reference named a conditional
publication contract here as what closes it.

`SetProfileInboxEvent` gained two optional conditions. With `ifUnset: true`
the pointer is set only while the profile points at no inbox. With
`replacing` it is set only while the profile points at the inbox named, by a
comparison of links. `setInbox` reads the pointer in the transaction that
writes it, so a pointer another sender commits meanwhile makes the commit
stale, and the handler runs again over it. `pointAtInboxIfUnset()` sends
`ifUnset`, and `pointAtInboxInPlaceOf()` sends `replacing`. An event with
neither condition sets or clears the pointer as before.

## What the proof reports

`system/profile-picker.tsx`, `argument.legacyDefaultProfile`, on its four
baselines from `20261003T212417Z` on. That argument is an alternative of a
stored profile or nothing. The proof compares alternatives without the
allowance it gives a property, and the recorded event left `ifUnset` and
`replacing` open, so it reads them as values the candidate refuses.

`system/profile-home.tsx`, `system/profile-create.tsx`, `system/home.tsx` and
`fabrichat/room.tsx` report the change compatible and carry no entry.

## What the break costs

Nothing stored. A stream stores no event, so every stored profile validates
as before. A profile still running the handler it was stored with ignores the
conditions and writes the pointer as it did, until it runs the new handler.
