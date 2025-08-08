# Branching & Merging

## Branch create

- `POST /branches` with `from` by heads/epoch/ts.
- New branch copies **heads** of source at that point; no data copy.
- `am_heads` initialized accordingly.

## Writing

- Changes append with contiguous `seq_no` per branch.
- `baseHeads` must equal current heads (or the client must include **merge
  change(s)**).

## Merge

- Client computes **merge changes** (Automerge merge) and submits as a normal
  write.
- Server validates/appends; optionally `is_closed=1` on source;
  `merged_into_branch_id` set.

## Heads integrity

- Every write updates `am_heads.heads_json`, `seq_no`, `tx_id`, and `root_hash`.
