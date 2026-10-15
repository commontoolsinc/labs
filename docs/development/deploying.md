# Deploying a commit

A commit reaches a server host by way of the bastion. The deploy jobs open an
SSH connection to the bastion and run one command there, `/opt/cf/deploy.sh`,
passing the environment to deploy and the commit to deploy to it. That script
does the rest: it deploys the binaries that CI already built and uploaded for
that commit.

Two browser shells reach users, and they are configured in different places.
The toolshed binary carries one and serves it from its own origin, so it is
configured when that binary is built; "The shell inside the binary" below
covers it. The other is a static site published to its own bucket, and "The
staging shell" covers that one.

Three jobs do this. Two of them deploy to staging, and only one of those two
runs at a time, as "Where staging is deployed from" below describes:

| Job | Workflow | Environment passed | Trigger |
| --- | --- | --- | --- |
| `deploy-rapids` | `.github/workflows/main-green.yml` | `rapids`, written out in the step | a CI run of a push to `main` that passed |
| `deploy-rapids` | `.github/workflows/deno.yml` | `rapids`, written out in the step | a push to `main`, while the `STAGING_DEPLOY_FROM_CI_RUN` variable is `true` |
| `deploy-estuary` | `.github/workflows/deploy-production.yml` | `DEPLOYMENT_ENVIRONMENT` variable | manual dispatch, naming the ref to deploy |

The production job reads the environment name from a repository variable rather
than naming it, because the variable is defined on the GitHub environment the
job declares.

The script deploys binaries rather than building them, so there is nothing to
deploy until the `attest-binaries` job of the CI workflow has uploaded the
artifacts for the commit. Both staging jobs start after it. Main Green's acts
only on a CI run that passed, and `attest-binaries` is one of that run's jobs.
The CI workflow's own waits on `attest-binaries` directly. The production job
downloads those same artifacts itself, and fails with a message naming the
commit if they are not there.

Each `deploy-rapids` job declares GitHub's `toolshed` environment, which is
where its bastion credentials live. Renaming that environment is a
repository-settings change, and both jobs have to be updated in the same
change.

## Staging follows the newest green commit

Staging is deployed by `.github/workflows/main-green.yml`, unless a repository
variable selects the CI run's own deploy jobs, which "Where staging is deployed
from" below covers. This section and the next describe Main Green.

The CI workflow, `.github/workflows/deno.yml`, tests a commit and publishes its
binaries. Main Green starts whenever a run of that workflow finishes, and acts
when the run was of a push to `main` and every job in it passed. That is a
stricter condition than the lanes passing. The run's `Status` job and
`attest-binaries` are part of it, so a commit whose run failed the topology
check, or could not publish its binaries, is not deployed.

The workflow's first job, `advance`, moves the `main-green` branch to the
commit whose run passed, which keeps the branch at the newest commit of `main`
whose run passed. Runs of `main` overlap and take most of an hour, so they
finish in no particular order, and the job moves the branch only forward. When
the run of an older commit finishes after the run of a newer one, the branch
stays where it is and the workflow does nothing more for that run. Every later
job works from the branch rather than from the run that started the workflow,
so an older run finishing late does not move staging backward.

`advance` is the only job that moves the branch. No ruleset restricts it,
though, so anyone who can write to the repository can move or delete it too.
`deploy-rapids` therefore deploys what the branch names only when that is a
commit of `main`, and fails otherwise.

One deploy runs at a time, and at most one waits. `deploy-rapids` belongs to a
concurrency group, so a run that reaches it while another is deploying waits.
When a third run arrives, it waits in the second's place and the second is
cancelled. The job reads `main-green` when it starts, after any wait, and
deploys that commit. So when four commits pass while one deploy is running, the
next deploy is of the newest of the four, and the three before it are never
deployed.

GitHub records every run of this workflow against the tip of `main`, so each
run is named for the commit its CI run tested: `Main Green for <commit>`.

### When a run of Main Green is not green

- **`deploy-rapids` or `deploy-shell-staging` was cancelled while it waited.**
  A later run replaced it, and there is nothing to do.
- **The run was cancelled anywhere else.** Someone stopped it, or a job ran
  past its bound. Treat it as a failure.
- **`advance` failed.** `main-green` could be neither moved to the commit nor
  shown to be at it or ahead of it. One cause is a branch that was moved to a
  commit that is not on `main`.
- **`deploy-rapids` failed.** Nothing retries a failed deploy, and a run of an
  older commit that finishes later stops at `advance`. Re-run the failed job,
  which deploys whatever `main-green` names as of the re-run, or wait for the
  next green run of `main`.

To deploy the commit `main-green` names once more, re-run every job of the run
named for that commit. `advance` finds the branch already there, and the
deploy follows. Re-run a `deploy-shell-staging` job only in that run. In an
older run it publishes nothing, and it can cancel a newer run's shell job that
is waiting.

To put `main-green` back on a commit of `main`:

```bash
gh api --method PATCH repos/commonfabric/labs/git/refs/heads/main-green \
  -f sha=<commit> -F force=true
```

Choose a commit whose CI run passed, because a deploy checks only that the
commit is on `main`. Moving the branch by hand deploys nothing and does not
start loom's workflow. The next green run of a newer commit moves the branch
forward from there and does both. A branch set ahead of every green commit
fails nothing: runs of older commits stop at `advance`, and staging stays as it
is until a newer commit passes. A branch that was deleted is created again by
the next green run to finish, at that run's commit.

To hold staging at the commit it is running, disable the workflow with
`gh workflow disable main-green.yml`. `main-green` and loom's pin stop moving
too while it is off. This holds staging only while Main Green's jobs are the
ones selected to deploy.

## Where staging is deployed from

Two workflows hold a `deploy-rapids` job and a `deploy-shell-staging` job, and
the repository variable `STAGING_DEPLOY_FROM_CI_RUN` selects which pair runs.
One pair runs when the variable is `true` and the other when it is not, so
every value selects exactly one pair. GitHub compares the value without regard
to letter case.

| `STAGING_DEPLOY_FROM_CI_RUN` | Which jobs deploy | Which commit |
| --- | --- | --- |
| unset, or anything but `true` | Main Green's | the newest commit of `main` whose CI run passed |
| `true` | the CI workflow's, in the run of each push to `main` | that run's own commit |

Setting the variable selects the CI run's jobs:

```bash
gh variable set STAGING_DEPLOY_FROM_CI_RUN --body true --repo commonfabric/labs
```

Each run of a push to `main` then deploys its own commit in its own jobs:
`deploy-rapids` once `attest-binaries` has published the binaries, and
`deploy-shell-staging` once the lanes have passed. Those deploys differ from
Main Green's in five ways:

- Every commit whose run reaches those jobs is deployed. None is skipped
  because a newer one passed in the meantime.
- Runs of different commits do not wait for each other. Two deploys can run at
  once, and a run of an older commit that finishes last leaves staging on that
  older commit until the next push passes.
- A deploy does not wait for the run's `Status` job, so a commit can be deployed
  from a run that goes on to fail.
- The shell is published beside the deploy to rapids rather than after it, and
  whether or not that deploy succeeds.
- A deploy that fails makes the CI run fail. Main Green acts only on a run that
  passed, so `main-green` and loom's pin do not move to a commit whose staging
  deploy failed.

Main Green keeps running while the variable is set. For each CI run that
passes it still moves `main-green` and starts loom's workflow, and its two
deploy jobs are skipped. Use this route when Main Green's deploys are failing
for a reason of their own: it does not depend on that workflow, on the branch,
or on the token that moves it.

Deleting the variable selects Main Green's jobs again:

```bash
gh variable delete STAGING_DEPLOY_FROM_CI_RUN --repo commonfabric/labs
```

GitHub does not say when a run reads a variable, so a CI run already under way
when the variable changes may act on either value, and its two deploy jobs may
not act on the same one. The commit of such a run can be deployed by both
routes, by neither, or in part by each. The first push to `main` after the
change is deployed by the route the variable selects.

The variable selects where staging is deployed from and nothing else. Loom's
automatic bump has a switch of its own, the `LOOM_LABS_PIN_BY_HAND` variable in
loom, which "The automatic labs bump" in loom's vendoring policy describes.

## Loom's pin follows the same branch

[Loom](https://github.com/commonfabric/loom) vendors this repository at a
pinned commit, and moves that pin to `main-green`. The `start-loom-pin` job of
`.github/workflows/main-green.yml` starts loom's `bump-labs-pin.yml` workflow
each time `main-green` moves, and that is all this repository does. How the pin
moves is decided in loom, and "The automatic labs bump" in loom's vendoring
policy describes it.

The job runs beside the deploy jobs and does not wait for them, because loom's
pin does not depend on what staging is running.

A pin landing on loom's `main` also requests a production deploy. Loom
dispatches `deploy-production.yml` here for the commit it pinned, and that
deploy waits for a reviewer on the `estuary` environment. Each time it acts for
a pin, loom cancels the requests it made earlier that are still waiting, and
`docs/operations/labs-estuary-deploy.md` in loom has the rules.

Loom dispatches only for a commit whose CI run here passed. While Main Green
deploys staging, that run's conclusion says whether the commit passed and
nothing about staging, so a commit can reach production review without having
been deployed to rapids.

Starting a workflow in loom takes a credential this repository's own token does
not carry, because a workflow's token reaches only the repository the workflow
runs in. The job creates one from a GitHub App installed on loom with write
access to Actions there. The `LOOM_DISPATCH_APP_ID` repository variable names
the app, and the `LOOM_DISPATCH_APP_PRIVATE_KEY` secret of the `loom`
environment, which the job declares, holds its private key. With the variable
set, the job fails unless loom's default branch holds that workflow.

The automatic bump depends on this job. While the variable is unset the job is
skipped, and when the job fails nothing else tells loom that `main-green`
moved. Loom's workflow is then started only by events in loom, a pin landing
there or the tests of an open bump ending, and no such event follows a run
that found the pin at `main-green`. From then on the pin stays where it is, and
loom reports nothing, because no run there failed. The failed job shows as a
failed run of Main Green here. An unset variable is not the way to switch the
bump off, though: a pin a person lands in loom still starts a run that bumps.
Loom's `LOOM_LABS_PIN_BY_HAND` variable is the switch.

## One commit, one set of artifacts

The `build-toolshed` and `build-cf` jobs in `.github/workflows/deno.yml` build
the binaries. Once every lane of the full run has passed, the `attest-binaries`
job signs them, packs them into `labs-<commit>.tar.gz`, writes that
tarball's SHA-256 into `labs-<commit>.hash.txt`, and copies both objects into
the `commontools-build-artifacts` bucket. A deploy is given a commit rather than
a build, so those two objects are the whole of what a commit means to a host.
The host downloads them, checks the tarball against the checksum, and unpacks
it.

Building one commit twice does not produce the same tarball. The binaries are
compiled again, and `tar` records the modification time of every file it packs.
The two objects therefore have to be published together, and what they were
published as has to stay put. A host holding one build's tarball beside another
build's checksum fails `sha256sum -c`, and its deploy stops there.

Two things keep a commit to one pair. The CI workflow's concurrency group keys
a push by the commit that was pushed, so a second run of a commit waits for the
first to finish instead of building alongside it. Main does receive the same
head commit twice from time to time, which is what starts two runs of one
commit. The second guard is in the publish step: a commit that already has both
objects in the bucket keeps them, so a later build of that commit leaves alone
what an earlier build published and a host may already be holding. That covers
the ways a second build starts without a second run, a re-run of the job among
them. Removing either object from the bucket by hand lets the next build of
that commit publish both of them again.

## A host keeps what it has already downloaded

The deploy playbook downloads the tarball and the checksum only when the
release directory for the commit is missing a binary, and Ansible's `get_url`
leaves a destination file that is already there as it is. So a release
directory that failed verification stays as it is across later deploys of that
commit. The download tasks report no change, the same mismatched pair is
checked again, and the deploy fails the same way. A re-run cannot recover on
its own; someone has to remove the directory on the host.

That playbook is `ansible/playbooks/toolshed_binary_deploy.yml` in the
[infra repository](https://github.com/commonfabric/infra), behind the
`/opt/cf/deploy.sh` wrapper described above. Making the download replace what
it finds, rather than skip it, is a change in that repository.

## The wrapper is owned by another repository

`/opt/cf/deploy.sh` is not in this repository. The
[infra repository](https://github.com/commonfabric/infra) generates it, in
`ansible/playbooks/bastion.yml`, and writes it to the bastion when that
playbook runs. Nothing here reads it, imports it, or tests it against the real
thing.

The script validates what it is given, and it takes exactly two arguments: an
environment name it recognizes, and a 40-character commit SHA. Given anything
else — an extra argument, an unknown environment, a revision that is not a
full SHA — it prints its usage and exits with status 1, and the deploy job
fails without deploying anything.

This is the seam to be careful about. A staging deploy job runs only after a
push to `main`, whichever workflow holds it, and Main Green's runs from the
copy of its workflow on the default branch. So a deploy step that no longer
matches the script cannot fail on the pull request that introduces it. It fails
on the first green run of `main` afterwards, and then on every one after that
until someone fixes it. The
`Deploy steps call the bastion wrapper the way it accepts` case in
[`tasks/ci-workflow.test.ts`](../../tasks/ci-workflow.test.ts) reads the
`script:` line out of each deploy step and checks it against that contract, so
a mismatch fails on the pull request instead.

Changing the argument list therefore takes a change in each repository, in
order: land the infra change, apply the bastion playbook so the host has the
new script, then change the call sites here.

## The shell inside the binary

`toolshed` serves a browser shell from the `shell-frontend` directory beside
it, so <https://estuary.saga-castor.ts.net/> and
<https://rapids.saga-castor.ts.net/> each serve the shell that the binary they
run was built with. `tasks/build-binaries.ts` builds `packages/shell` as part
of the toolshed build and moves the output there. Configuring this shell is
therefore something the `build-toolshed` job does, and a deploy carries
whatever that build baked in. It needs no API host: it is served from the same
origin as the API it calls, which is what the shell falls back to.

## The staging shell

The `deploy-shell-staging` job in `.github/workflows/main-green.yml` publishes
the shell after each deploy to rapids, built from the commit just deployed
there. The shell calls the API on rapids, so publishing it second means the
shell being served is never newer than the API it calls. It does not touch the
bastion: it builds `packages/shell` and copies the result into the
`staging-commontools-dev` bucket, which is served at
<https://staging.commontools.dev/>. Each build also lands under
`builds/<commit>/` so a page that is already open keeps the exact module graph
it started with.

Two things keep one build's files from landing over another's. The job has a
concurrency group of its own, so two uploads never run at once. And it uploads
only while `main-green` still names the commit it built, so a job that finishes
after the branch has moved on, or is re-run on its own later, publishes
nothing. The run that moved the branch publishes the newer commit's shell once
its own deploy to rapids succeeds.

The CI workflow's `deploy-shell-staging` job builds, checks and publishes the
same way, from its run's own commit, and has neither of those two guards. It
runs only while the variable selects the CI run's jobs, as "Where staging is
deployed from" above describes. `tasks/ci-workflow.test.ts` fails when a step
the two jobs share is changed in one and not the other.

The shell has to be told which API host to talk to, because it is served from a
different origin than the API it calls. The `STAGING_SHELL_API_URL` variable
carries that host, and the build substitutes it into the bundle. It is a
variable rather than a secret: the value ends up in a bundle that anyone can
read, so hiding it from review buys nothing and costs the ability to see what
staging points at. The host it names is the one `deploy-rapids` keeps current.

Publishing is not the same as working, and this job cannot tell the difference
by uploading alone — it makes no request to the API it just configured. So it
checks three things instead. An unset variable fails the job before the build,
because a shell built with no API host falls back to its own origin, and that
origin serves static assets and no API. The built bundle must then contain the
host that was passed in. Finally the scripts are read back out of the bucket
and checked again, so a green job means the objects being served name the host
they should. That last read goes to the bucket rather than to the site's
address, because the CDN may still be serving the previous build.
