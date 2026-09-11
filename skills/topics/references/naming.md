# `top/42` — a Topic addressed by the board's name for it

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on member
names and what the deployment carries.

The board gives each Topic a name of its own: a decimal number, dense from `1`,
allocated when the Topic is filed and never reused. It is not a display name — a
Topic's display name stays its title, and the number renders as a badge beside
it. `addTopic` returns the name it allocated as `name` beside the created
`topic`, and each Topic publishes its own as `shortName`, which the board's
`index` rows and mention universe carry a copy of. So a survey reads every name
in one bounded read:

```bash
deno task cf cell get "$TOPICS_BOARD" index --step --select @,title,shortName
```

The number is what a short reference is written with. Once the board's `names`
map is bound as a slug, `<collection>/<member>` names a Topic wherever an
address is taken — `deno task cf cell get /@<space>/top/42 title`,
`deno task cf piece describe --cell /@<space>/top/42`,
`deno task cf piece call --cell /@<space>/top/42 setTitle '{...}'` — and exactly
one segment reaches a member, so `/@<space>/top/42/title` is that Topic's
`title` field. A name with no member after it is refused, naming the piece
holding the collection; and `no member 999 in top` is the refusal for a member
the board does not hold. `packages/cli/README.md` is the whole grammar, and
`docs/specs/collection-naming.md` the design.

A member name is the board's, not the fabric's: it means something only through
the collection that issued it, so a citation carries the collection —
`/@<space>/top/42`, never a bare `42`. A canonical `/of:` address remains the
thing to pass in a reference position; the member name is for a person to read
and type.

**What the Estuary deployment carries.** The verbs in `references/verbs.md` and
the naming above are what the pattern in this checkout declares. The deployed
board runs whatever commit `/api/meta` reports, and until a pattern update lands
there it has no `names` map, no `top` slug, and no named Topic — a Topic
publishes no `shortName` and `/top/42` resolves to nothing. Ask the deployment
before citing a number, and treat `top/42` as unavailable there until the plan's
remaining step is done (`docs/plans/collection-naming-topics.md`). Deploying it
and naming the Topics already on the board are the team's steps, not an agent's.
