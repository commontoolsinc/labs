---
status: historical
created: 2026-08-28
archived: 2026-08-28
reason: "Empirical survey of the skills.sh consumption surface as it stood on 2026-08-28, taken to settle CT-2106's stated unknown."
---

# What skills.sh actually is, mechanically

CT-2106 proposes discovering and loading skills from `https://www.skills.sh/`,
and names its own gap: the issue states a design but does not know the
registry's real API surface. This document is the survey that closes it. Every
claim below is either an observation with the request that produced it, a
reading of source published under a license that permits reading, or an entry
in the undetermined list at the end. Nothing here is inferred from what a
registry of this kind usually does.

All observations are from 2026-08-28. A registry is a live third-party
service; anything here can change without notice, which is itself one of the
findings.

## Summary

skills.sh is **an index over other people's GitHub repositories, not a content
host**. Its own terms say so: "We do not own, host, or relicense skill
content." Identity is a mutable name — `{owner}/{repo}/{slug}` — that resolves
to whatever the upstream default branch holds at read time. It publishes a
`hash` field, but that hash is a server assertion that could not be reproduced
from the payload it accompanies, and the reference client never checks it.
There is no fetch-by-digest endpoint on any surface.

The documented API is gated behind a credential we cannot obtain. The API the
official CLI actually uses is undocumented, unauthenticated, and works.

A separate and much better surface exists next door: the vendor-neutral
`.well-known/agent-skills` discovery protocol, which carries a **mandatory**
`sha256:` digest per entry and which the same CLI verifies fail-closed against
the fetched bytes. skills.sh does not publish one.

## The catalogue's shape

Skills are addressed by a three-segment path, both on the site and in the API:

```
https://www.skills.sh/{owner}/{repo}/{slug}
```

`sitemap-skills-1.xml` alone carries 10,000 `<loc>` entries and there is a
second skills sitemap, so the catalogue is at least five figures. The
documented list endpoint reports `"total": 8420` in its example response,
which does not agree with the sitemap; neither number was confirmable, since
the endpoint that would settle it is credential-gated.

`sitemap-misc.xml` names the non-skill surfaces: `/hot`, `/trending`,
`/picks`, `/official`, `/audits`, `/search`, `/docs`, `/docs/cli`,
`/docs/api`, `/docs/faq`, `/topic/*`, `/agent/*`, `/package/{npm,go,cargo,pip}`.

### How a skill gets into the catalogue

From the FAQ, verbatim: "Skills appear on the leaderboard automatically
through anonymous telemetry when users run `npx skills add <owner/repo>`."

So the index is **populated by unauthenticated client reports**, and listing
requires only a public GitHub repository. There is no submission step, no
review, and no identity check on the publisher beyond owning a repo name.

The install count is the leaderboard's ranking signal, per the same FAQ. In
the CLI's source, telemetry is a bare `fetch()` of a URL with query
parameters, no credential, no signature:

```js
const TELEMETRY_URL = "https://add-skill.vercel.sh/t";
// ...
const p = fetch(`${TELEMETRY_URL}?${params.toString()}`).catch(() => {}).then(() => {});
```

An unauthenticated GET that increments a public ranking is forgeable by
anyone who can make an HTTP request. **This was not tested**, deliberately:
verifying it means writing false data into a third party's service. It is
recorded as a reading of published source, not as an experiment. The
consequence for us stands either way — install count is an attacker-influenced
signal and must not be used as a trust input.

## Authentication: the documented API is closed to us

`https://www.skills.sh/docs/api` documents five endpoints under
`/api/v1/`, and exactly one authentication method: a **Vercel OIDC token**.
The caller is expected to be a deployment on Vercel, whose platform mints a
short-lived JWT scoped to a team and project, verified against
`oidc.vercel.com`. There is no API-key path, no signup form, no anonymous
tier described.

We are not a Vercel deployment, so we cannot obtain this credential. Nothing
was signed up for and no account was created in the course of this survey.

Probed unauthenticated, four of the five documented endpoints refuse:

| Endpoint | Status |
| --- | --- |
| `GET /api/v1/skills` | 401 `authentication_required` |
| `GET /api/v1/skills/search` | 401 `authentication_required` |
| `GET /api/v1/skills/curated` | 401 `authentication_required` |
| `GET /api/v1/skills/{source}/{skill}` | 401 `authentication_required` |
| `GET /api/v1/skills/audit/{source}/{skill}` | **200** |

The audit endpoint is open despite its own documentation carrying an
"Authentication — Required" heading. The docs and the service disagree; the
service is what shipped.

The documented rate limit is 600 requests/minute per (team, project), with
`X-RateLimit-*` headers on every response. No such header appeared on any
unauthenticated response.

## The API the CLI actually uses

The official client is the npm package `skills` (MIT, 1.5.23,
`github.com/vercel-labs/skills`). Its published bundle names its endpoints in
the clear. It does **not** call `/api/v1/` at all. It calls two undocumented
routes, both unauthenticated:

```js
const SEARCH_API_BASE   = process.env.SKILLS_API_URL      || "https://skills.sh";
const DOWNLOAD_BASE_URL = process.env.SKILLS_DOWNLOAD_URL || "https://skills.sh";
// GET ${SEARCH_API_BASE}/api/search?q=&limit=&owner=
// GET ${DOWNLOAD_BASE_URL}/api/download/{owner}/{repo}/{slug}
```

Both were confirmed live with no credential.

**Search** — `GET https://skills.sh/api/search?q=react%20native&limit=3` → 200:

```json
{
  "query": "react native",
  "searchType": "semantic",
  "searchVersion": "legacy",
  "skills": [
    { "id": "vercel-labs/agent-skills/vercel-react-native-skills",
      "skillId": "vercel-react-native-skills",
      "name": "vercel-react-native-skills",
      "installs": 197232,
      "source": "vercel-labs/agent-skills" }
  ],
  "count": 3,
  "duration_ms": 617
}
```

Note what is **absent**: there is no `description` field. The documented v1
search returns one; this one does not. For our purposes that cuts both ways —
less free-text attack surface reaching a model, and less for a model to choose
on than the issue's design assumes.

**Download** — `GET https://skills.sh/api/download/vercel-labs/skills/find-skills`
→ 200, `content-type: application/json`, and a two-key body:

```json
{ "files": [ { "path": "SKILL.md", "contents": "..." } ],
  "hash": "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf" }
```

This is a fetch-by-name endpoint returning full skill text, unauthenticated.
It is the surface a `search_skills` and a skill fetch would actually be built
on.

These two routes are undocumented. `/docs/api` describes a different, gated
API and never mentions them. We would be depending on an unversioned surface
that carries no compatibility promise — see the undetermined list.

## Content addressing: the requirement CT-2106 cannot have as written

CT-2106 requires that "Selection is by content-address/handle, never by the
name or description text." Against skills.sh that is **not implementable as
stated**, for three independent reasons.

**1. There is no fetch-by-digest endpoint.** Not in the documented API, not in
the CLI's routes. Every read path takes `{owner}/{repo}/{slug}` — a name. A
digest can be *checked after* a name-keyed fetch; it cannot be what you ask
for. Selection is by name whether or not verification follows.

**2. The published `hash` could not be reproduced from the payload.** The CLI
defines the algorithm that names the same field — sha256 over path-sorted
`(path, contents)` concatenation:

```js
function computeSnapshotHash(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(file.contents);
  }
  return hash.digest("hex");
}
```

Run over the exact `files` array the service returned, that yields
`913b9d37…`, against the served `b1460085…`. Seven further encodings were
tried — contents alone, NUL-separated, CRLF-normalized, and two JSON
serializations among them — yielding six distinct digests in all, none of
which matched. The served hash is stable
across repeated requests, so it is not noise; it is simply not derivable from
what the endpoint hands you.

**3. The reference client does not verify it.** It adopts the server's number
whenever the file count agrees, and only computes its own when it does not:

```js
snapshotHash: files.length === download.files.length
  ? download.hash
  : computeSnapshotHash(files),
```

So on the skills.sh path, `hash` is an **unverified server assertion about
content we cannot independently bind to that content**. It is usable as a
change detector. It is not a content address, and treating it as one would be
the kind of overclaim that reads as a guarantee and is not.

What *is* available as a real pin: the underlying content is a GitHub
repository, and the CLI supports a `#ref` fragment on git sources, so a commit
SHA can pin a fetch — through GitHub, not through skills.sh. That is a genuine
content address, and it is the one lever this surface offers.

## The good surface next door: `.well-known/agent-skills`

The same CLI implements a second, vendor-neutral provider. A publisher serves
`<origin>/.well-known/agent-skills/index.json` (or `.well-known/skills/`):

```json
{ "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [ { "name": "...", "description": "...",
                "type": "skill-md" | "archive",
                "url": "...", "digest": "sha256:<64 hex>" } ] }
```

Entry validation **requires** the digest — `/^sha256:[a-f0-9]{64}$/` — and an
entry that fails validation is dropped. Acquisition then verifies fail-closed
against the fetched bytes:

```js
const bytes = new Uint8Array(await response.arrayBuffer());
if (this.computeDigest(bytes) !== entry.digest) return null;
```

That is what content-addressed acquisition looks like, and it is exactly what
skills.sh's own surface lacks. Two facts bound its usefulness to us today:

- **skills.sh does not publish one.** `https://www.skills.sh/.well-known/agent-skills/index.json`
  returns the site's HTML 404 page with **status 200** — a soft-404. A client
  that gated on the status code would treat a 404 as a hit. The CLI parses
  JSON and so fails safe by accident rather than by check; ours must gate on
  the parse, not the status.
- **The schema URL does not resolve.** `schemas.agentskills.io` has no DNS
  record (confirmed with `dig` outside the sandbox, so this is the internet's
  answer and not a proxy artifact). The `$schema` value is a version tag the
  CLI string-compares, not a document anyone fetches.

The protocol also deliberately excludes `github.com`, `gitlab.com`,
`huggingface.co` and `raw.githubusercontent.com` from the well-known path, so
it is a surface for self-hosting publishers.

`agentskills.io` itself resolves and serves the Agent Skills format
specification. Per that spec a skill is a **directory**: `SKILL.md` required,
with optional `scripts/` (executable code), `references/`, and `assets/`.
`SKILL.md` is YAML frontmatter plus Markdown, with `name` (≤64 chars,
lowercase-hyphen, must match the directory name) and `description` (≤1024
chars) required, and optional `license`, `compatibility`, `metadata`, and an
experimental `allowed-tools`.

So **a skill is not instructions-only in general**. The one skill inspected
here happened to be a single `SKILL.md`, but the format admits scripts, and
the download endpoint returns whatever files the snapshot holds. CT-2106's
non-goal ("a fetched external skill is instructions-only") is a policy we must
*enforce* on the fetched payload, not a property of the source.

## Terms, robots, and rate limits

The terms are short and unusually favorable, and no acceptance step is
required to read the site or call the public API. Nothing was accepted on
anyone's behalf. The load-bearing clauses:

- *"skills.sh is a directory of third-party skills… we cannot guarantee the
  quality, safety, correctness, or security of any skill listed here."*
  The registry disclaims exactly the property we would need it to supply.
- *"Skills shown in the directory are the property of their authors and
  distributed under the licenses present in the source repositories. We do not
  own, host, or relicense skill content."* Per-skill licensing is the
  upstream repo's, and is not surfaced by the search endpoint.
- *"Use of the public API is rate-limited per IP… Reasonable use, including
  **caching results on your own infrastructure, is encouraged and not
  restricted**."* This is an explicit blessing for the mirror strategy
  CT-2068 already names as its destination.
- No warranty, on the site, the CLI, and the public API alike.

`robots.txt` reads:

```
User-Agent: *
Allow: /
Disallow: /internal/
Disallow: /debug-security/
Disallow: /search
Disallow: /api/
```

`/api/` is disallowed to crawlers while the terms simultaneously describe a
"public API" and the vendor's own CLI calls routes under it. The two
directives are aimed at different things — a crawler versus a client — but the
tension is real and belongs in any decision to automate against it.

A 10-request burst against `/api/search` returned 200 throughout with no
rate-limit headers. The anonymous limit's actual number is undetermined; it was
not probed to failure, because probing a third party's limit to failure is how
you earn an IP block for everyone behind it.

One more path worth naming: skill detail pages render the **full SKILL.md as
HTML**, unauthenticated and outside `robots.txt`'s disallow. Skill text is
therefore publicly readable regardless of the API gate — but as rendered
markup, lossy against the source bytes, and with no digest. It is a fallback,
not a good one.

## Undetermined

Recorded as gaps rather than guessed at.

- **Whether `/api/search` and `/api/download` are supported surfaces.** They
  are undocumented and unversioned. The docs describe a different API. They
  could change or close without notice and we would have no standing to
  object.
- **The anonymous rate limit.** Terms say per-IP; no number is published and
  no headers were returned. Not probed to failure.
- **How the `hash` field is computed.** Eight attempts, six distinct digests,
  none of them the served one.
  Whether it covers a larger file set than the response returns, a different
  normalization, or an upstream tree object, is unknown.
- **Snapshot freshness.** Whether a snapshot is refreshed when upstream
  changes, on what trigger, and with what lag. Not measurable in one session.
- **Whether an `id` can be reassigned.** GitHub owner and repo names can be
  renamed, transferred, and — after deletion — re-registered by a different
  party. Whether skills.sh pins to a repository's numeric id or to the
  `owner/repo` string decides whether an id we trusted can silently become
  someone else's. This is the squatting question and it is open.
- **Whether any read path takes a version or ref.** No such parameter is
  documented and the CLI passes none to skills.sh. Its absence is inferred
  from two independent sources, not confirmed by the operator.
- **The v1 response shapes.** Recorded from the documentation only; every v1
  endpoint but `audit` returned 401, so none was observed.
- **The audit endpoint's meaning.** It returns verdicts from five named
  third parties (Gen Agent Trust Hub, Socket, Snyk, Runlayer, ZeroLeaks) with
  `status`, `riskLevel`, `summary`, and `auditedAt`. What any of those
  verdicts is worth, how the audits are commissioned, and whether they are
  re-run when a skill changes, is unknown. The observed record for
  `vercel-labs/skills/find-skills` carries audit dates in March–April 2026
  — months stale relative to this survey — which by itself argues they are
  not re-run on change.
- **Whether the telemetry endpoint is forgeable in practice.** Read from
  source; deliberately not tested.

## What was not read

- The site's client JavaScript bundles beyond string-grepping the homepage.
  Additional undocumented routes may exist that neither the docs nor the CLI
  name.
- `/api/v1/*` response bodies, which are credential-gated.
- The `skills` CLI's install, update, and pack code paths in full. The
  acquisition, search, digest and telemetry paths were read; the rest was
  skimmed for endpoint strings only.
- `/internal/` and `/debug-security/`, which `robots.txt` disallows. Not
  fetched.
- The Vercel OIDC verification path, which we cannot exercise.

## How the evidence was gathered

Plain HTTP reads with `curl` against public endpoints, at a volume in the low
tens of requests; the published npm tarball for `skills@1.5.23` extracted and
read, never executed; and `dig` from outside the sandbox to settle one DNS
question. No account was created, no terms were accepted, no credential was
sent anywhere, and nothing fetched was run.
