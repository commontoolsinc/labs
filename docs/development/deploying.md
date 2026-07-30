# Deploying a commit

A commit reaches a host by way of the bastion. The deploy jobs in CI open an
SSH connection to the bastion and run one command there, `/opt/cf/deploy.sh`,
passing the environment to deploy and the commit to deploy to it. That script
does the rest: it deploys the binaries that CI already built and uploaded for
that commit.

Three jobs do this:

| Job | Workflow | Environment passed | Trigger |
| --- | --- | --- | --- |
| `deploy-toolshed` | `.github/workflows/deno.yml` | `DEPLOYMENT_ENVIRONMENT` variable | every push to `main` |
| `deploy-rapids` | `.github/workflows/deno.yml` | `rapids`, written out in the step | every push to `main` |
| `deploy-estuary` | `.github/workflows/deploy-production.yml` | `DEPLOYMENT_ENVIRONMENT` variable | manual dispatch, naming the ref to deploy |

Two of those read the environment name from a repository variable rather than
naming it. The value differs between them, because each job declares a
different GitHub environment, and a variable of the same name is defined in
each.

Each of the two staging jobs waits on `attest-binaries`, because the script
deploys binaries rather than building them. There is nothing for it to deploy
until that job has uploaded the artifacts for the commit. The production job
downloads those same artifacts itself, and fails with a message naming the
commit if they are not there.

## The wrapper is owned by another repository

`/opt/cf/deploy.sh` is not in this repository. The
[infra repository](https://github.com/commontoolsinc/infra) generates it, in
`ansible/playbooks/bastion.yml`, and writes it to the bastion when that
playbook runs. Nothing here reads it, imports it, or tests it against the real
thing.

The script validates what it is given, and it takes exactly two arguments: an
environment name it recognizes, and a 40-character commit SHA. Given anything
else — an extra argument, an unknown environment, a revision that is not a
full SHA — it prints its usage and exits with status 1, and the deploy job
fails without deploying anything.

This is the seam to be careful about. The staging deploy jobs run only on
`main`, so a deploy step that no longer matches the script cannot fail on the
pull request that introduces it. It fails on the first push to `main`
afterwards, and then on every push after that until someone fixes it. The
`Deploy steps call the bastion wrapper the way it accepts` case in
[`tasks/ci-workflow.test.ts`](../../tasks/ci-workflow.test.ts) reads the
`script:` line out of each deploy step and checks it against that contract, so
a mismatch fails on the pull request instead.

Changing the argument list therefore takes a change in each repository, in
order: land the infra change, apply the bastion playbook so the host has the
new script, then change the call sites here.
