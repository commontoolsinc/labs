// Completed CI run, job, and step timings persisted across dashboard restarts.
// Timings are stable for one workflow attempt and are retained for the widest
// history window the dashboard can display.

import { dashboardCacheFile } from "./history-files.ts";

export const CI_JOB_CACHE_DAYS = 60;

const DAY_MS = 86_400_000;
const STORE_VERSION = 1;

export interface CachedCiJob {
  name: string;
  seconds: number;
}

export interface CachedCiGanttStep {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface CachedCiGanttJob {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: CachedCiGanttStep[];
}

export interface CachedCiGanttRun {
  status: string;
  conclusion: string | null;
  event: string;
  headBranch?: string;
  startedAt: string;
  workflowName?: string;
  jobs: CachedCiGanttJob[];
}

export interface CachedCiRun {
  repo: string;
  workflow: string;
  runId: number;
  runAttempt: number;
  headSha?: string;
  runUrl: string;
  at: number;
  overallSeconds: number;
  jobs: CachedCiJob[];
  gantt: CachedCiGanttRun;
}

export interface CachedCiRunReference {
  runId: number;
  runAttempt: number;
}

export interface CachedCiHistoryRefresh {
  repo: string;
  workflow: string;
  days: number;
  refreshedAt: number;
  successfulRunTimes: number[];
  sampledRuns: CachedCiRunReference[];
  failedRunCount: number;
  failedRunTimes: number[];
  stale: boolean;
}

interface CachedCiHistoryInvalidation {
  repo: string;
  workflow: string;
  days: number;
  invalidatedAt: number;
}

interface StoredCiJobHistory {
  version: number;
  refreshes?: CachedCiHistoryRefresh[];
  invalidations?: CachedCiHistoryInvalidation[];
  runs: CachedCiRun[];
}

const defaultFile = (): string =>
  dashboardCacheFile("fabric-wall-ci-job-history.json");

const runKey = (
  repo: string,
  workflow: string,
  runId: number,
  runAttempt: number,
): string => `${repo}:${workflow}:${runId}:${runAttempt}`;

const sourceKey = (repo: string, workflow: string): string =>
  `${repo}:${workflow}`;

const refreshKey = (repo: string, workflow: string, days: number): string =>
  `${sourceKey(repo, workflow)}:${days}`;

const isCachedJob = (value: unknown): value is CachedCiJob =>
  typeof value === "object" && value !== null &&
  typeof (value as CachedCiJob).name === "string" &&
  Number.isFinite((value as CachedCiJob).seconds) &&
  (value as CachedCiJob).seconds > 0;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isCachedGanttStep = (value: unknown): value is CachedCiGanttStep => {
  if (typeof value !== "object" || value === null) return false;
  const step = value as CachedCiGanttStep;
  return typeof step.name === "string" && Number.isInteger(step.number) &&
    isNullableString(step.conclusion) && isNullableString(step.started_at) &&
    isNullableString(step.completed_at);
};

const isCachedGanttJob = (value: unknown): value is CachedCiGanttJob => {
  if (typeof value !== "object" || value === null) return false;
  const job = value as CachedCiGanttJob;
  return typeof job.name === "string" && typeof job.status === "string" &&
    isNullableString(job.conclusion) && isNullableString(job.started_at) &&
    isNullableString(job.completed_at) && Array.isArray(job.steps) &&
    job.steps.every(isCachedGanttStep);
};

const isCachedGanttRun = (value: unknown): value is CachedCiGanttRun => {
  if (typeof value !== "object" || value === null) return false;
  const run = value as CachedCiGanttRun;
  return typeof run.status === "string" &&
    isNullableString(run.conclusion) && typeof run.event === "string" &&
    (run.headBranch === undefined || typeof run.headBranch === "string") &&
    typeof run.startedAt === "string" &&
    (run.workflowName === undefined || typeof run.workflowName === "string") &&
    Array.isArray(run.jobs) && run.jobs.every(isCachedGanttJob);
};

const isCachedRun = (value: unknown): value is CachedCiRun => {
  if (typeof value !== "object" || value === null) return false;
  const run = value as CachedCiRun;
  return typeof run.repo === "string" && typeof run.workflow === "string" &&
    Number.isInteger(run.runId) && run.runId > 0 &&
    Number.isInteger(run.runAttempt) && run.runAttempt > 0 &&
    (run.headSha === undefined || /^[0-9a-f]{40}$/i.test(run.headSha)) &&
    typeof run.runUrl === "string" && Number.isFinite(run.at) &&
    Number.isFinite(run.overallSeconds) && run.overallSeconds >= 0 &&
    Array.isArray(run.jobs) && run.jobs.every(isCachedJob) &&
    isCachedGanttRun(run.gantt);
};

const isCachedRefresh = (
  value: unknown,
): value is CachedCiHistoryRefresh => {
  if (typeof value !== "object" || value === null) return false;
  const refresh = value as CachedCiHistoryRefresh;
  return typeof refresh.repo === "string" &&
    typeof refresh.workflow === "string" &&
    Number.isInteger(refresh.days) && refresh.days > 0 &&
    Number.isFinite(refresh.refreshedAt) && refresh.refreshedAt >= 0 &&
    Array.isArray(refresh.successfulRunTimes) &&
    refresh.successfulRunTimes.every(Number.isFinite) &&
    Array.isArray(refresh.sampledRuns) &&
    refresh.sampledRuns.every((run) =>
      Number.isInteger(run.runId) && run.runId > 0 &&
      Number.isInteger(run.runAttempt) && run.runAttempt > 0
    ) &&
    Number.isInteger(refresh.failedRunCount) && refresh.failedRunCount >= 0 &&
    Array.isArray(refresh.failedRunTimes) &&
    refresh.failedRunTimes.every(Number.isFinite) &&
    refresh.failedRunTimes.length <= refresh.failedRunCount &&
    typeof refresh.stale === "boolean";
};

const isCachedInvalidation = (
  value: unknown,
): value is CachedCiHistoryInvalidation => {
  if (typeof value !== "object" || value === null) return false;
  const invalidation = value as CachedCiHistoryInvalidation;
  return typeof invalidation.repo === "string" &&
    typeof invalidation.workflow === "string" &&
    Number.isInteger(invalidation.days) && invalidation.days > 0 &&
    Number.isFinite(invalidation.invalidatedAt) &&
    invalidation.invalidatedAt >= 0;
};

interface CiJobHistoryContents {
  refreshes: CachedCiHistoryRefresh[];
  invalidations: CachedCiHistoryInvalidation[];
  futureKeys: string[];
  runs: CachedCiRun[];
}

export class CiJobHistoryStore {
  #file: string | undefined;
  #loadRequest: Promise<void> | null = null;
  #runs = new Map<string, CachedCiRun>();
  #refreshes = new Map<string, CachedCiHistoryRefresh>();
  #invalidations = new Map<string, CachedCiHistoryInvalidation>();
  #futureQuarantines = new Set<string>();
  #write: Promise<void> = Promise.resolve();
  #revision = 0;
  #persistedRevision = 0;
  #sourceRevisions = new Map<string, number>();

  constructor(file?: string) {
    this.#file = file;
  }

  get file(): string {
    return this.#file ??= defaultFile();
  }

  async #read(strict = false): Promise<CiJobHistoryContents> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(this.file));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound || !strict) {
        return { refreshes: [], invalidations: [], futureKeys: [], runs: [] };
      }
      throw error;
    }
    if (typeof parsed !== "object" || parsed === null) {
      if (strict) throw new Error("Invalid CI job history cache.");
      return { refreshes: [], invalidations: [], futureKeys: [], runs: [] };
    }
    const value = parsed as Partial<StoredCiJobHistory>;
    if (value.version !== STORE_VERSION || !Array.isArray(value.runs)) {
      if (strict) throw new Error("Unsupported CI job history cache format.");
      return { refreshes: [], invalidations: [], futureKeys: [], runs: [] };
    }
    if (strict && value.runs.some((run) => !isCachedRun(run))) {
      throw new Error("Invalid CI job history cache entry.");
    }
    if (
      strict && value.refreshes !== undefined &&
      (!Array.isArray(value.refreshes) ||
        value.refreshes.some((refresh) => !isCachedRefresh(refresh)))
    ) {
      throw new Error("Invalid CI job history refresh entry.");
    }
    if (
      strict && value.invalidations !== undefined &&
      (!Array.isArray(value.invalidations) ||
        value.invalidations.some((entry) =>
          !isCachedInvalidation(entry) ||
          (entry.invalidatedAt > Date.now() &&
            !this.#futureQuarantines.has(
              refreshKey(entry.repo, entry.workflow, entry.days),
            ))
        ))
    ) {
      throw new Error("Invalid CI job history refresh invalidation.");
    }
    const rejectedRun = value.runs.some((run) => !isCachedRun(run));
    const rejectedRefresh = value.refreshes !== undefined &&
      (!Array.isArray(value.refreshes) ||
        value.refreshes.some((refresh) => !isCachedRefresh(refresh)));
    const rejectedInvalidation = value.invalidations !== undefined &&
      (!Array.isArray(value.invalidations) ||
        value.invalidations.some((entry) => !isCachedInvalidation(entry)));
    const futureKeys = new Set<string>();
    if (Array.isArray(value.refreshes)) {
      for (const refresh of value.refreshes.filter(isCachedRefresh)) {
        if (refresh.refreshedAt > Date.now()) {
          futureKeys.add(
            refreshKey(refresh.repo, refresh.workflow, refresh.days),
          );
        }
      }
    }
    if (Array.isArray(value.invalidations)) {
      for (
        const invalidation of value.invalidations.filter(
          isCachedInvalidation,
        )
      ) {
        if (invalidation.invalidatedAt > Date.now()) {
          futureKeys.add(refreshKey(
            invalidation.repo,
            invalidation.workflow,
            invalidation.days,
          ));
        }
      }
    }
    const runs = value.runs.filter(isCachedRun);
    const available = new Set(
      runs.map((run) =>
        `${run.repo}:${run.workflow}:${run.runId}:${run.runAttempt}`
      ),
    );
    const eligibleRefreshes = Array.isArray(value.refreshes)
      ? value.refreshes.filter(isCachedRefresh).filter((refresh) =>
        refresh.refreshedAt <= Date.now()
      )
      : [];
    const trustedEligibleRefreshes = eligibleRefreshes.filter((refresh) =>
      !futureKeys.has(refreshKey(refresh.repo, refresh.workflow, refresh.days))
    );
    const refreshes = !rejectedRun && !rejectedRefresh &&
        !rejectedInvalidation
      ? trustedEligibleRefreshes.filter((refresh) =>
        refresh.sampledRuns.every((run) =>
          available.has(
            `${refresh.repo}:${refresh.workflow}:${run.runId}:${run.runAttempt}`,
          )
        )
      )
      : [];
    if (
      strict && refreshes.length !== trustedEligibleRefreshes.length
    ) {
      throw new Error("CI job history refresh references a missing run.");
    }
    return {
      runs,
      refreshes,
      invalidations: Array.isArray(value.invalidations) &&
          !rejectedInvalidation
        ? value.invalidations.filter(isCachedInvalidation).filter((entry) =>
          entry.invalidatedAt <= Date.now()
        )
        : [],
      futureKeys: [...futureKeys],
    };
  }

  #merge(contents: CiJobHistoryContents): void {
    for (const run of contents.runs) {
      if (this.#put(run) === run) this.#bumpSource(run.repo, run.workflow);
    }
    for (const invalidation of contents.invalidations) {
      const key = refreshKey(
        invalidation.repo,
        invalidation.workflow,
        invalidation.days,
      );
      const current = this.#invalidations.get(key);
      if (!current || current.invalidatedAt < invalidation.invalidatedAt) {
        this.#invalidations.set(key, invalidation);
        this.#bumpSource(invalidation.repo, invalidation.workflow);
      }
    }
    for (const refresh of contents.refreshes) {
      const key = refreshKey(refresh.repo, refresh.workflow, refresh.days);
      const current = this.#refreshes.get(key);
      if (!current || current.refreshedAt < refresh.refreshedAt) {
        this.#refreshes.set(key, refresh);
        this.#bumpSource(refresh.repo, refresh.workflow);
      }
    }
    for (const key of contents.futureKeys) {
      if (!this.#futureQuarantines.has(key)) {
        this.#futureQuarantines.add(key);
        this.#revision++;
      }
    }
    this.#invalidateSupersededRefreshes();
  }

  #recordInvalidation(
    repo: string,
    workflow: string,
    days: number,
    invalidatedAt: number,
  ): boolean {
    const key = refreshKey(repo, workflow, days);
    const current = this.#invalidations.get(key);
    if (current && current.invalidatedAt >= invalidatedAt) return false;
    this.#invalidations.set(key, {
      repo,
      workflow,
      days,
      invalidatedAt,
    });
    return true;
  }

  #invalidateSupersededRefreshes(at?: number): boolean {
    let changed = false;
    for (const refresh of this.#refreshes.values()) {
      const superseded = refresh.sampledRuns.some((reference) => {
        const latest = this.latest(
          refresh.repo,
          refresh.workflow,
          reference.runId,
        );
        return latest && latest.runAttempt > reference.runAttempt;
      });
      if (
        superseded && this.#recordInvalidation(
          refresh.repo,
          refresh.workflow,
          refresh.days,
          at ?? refresh.refreshedAt,
        )
      ) changed = true;
    }
    return changed;
  }

  #resolveRefresh(refresh: CachedCiHistoryRefresh): CachedCiRun[] | null {
    const runs: CachedCiRun[] = [];
    for (const reference of refresh.sampledRuns) {
      const run = this.#runs.get(
        runKey(
          refresh.repo,
          refresh.workflow,
          reference.runId,
          reference.runAttempt,
        ),
      );
      if (!run) return null;
      runs.push(run);
    }
    return runs.sort((a, b) => a.at - b.at);
  }

  #dropUnresolvedRefreshes(): boolean {
    let dropped = false;
    for (const [key, refresh] of this.#refreshes) {
      if (!this.#resolveRefresh(refresh)) {
        this.#refreshes.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  load(): Promise<void> {
    if (!this.#loadRequest) {
      this.#loadRequest = (async () => {
        this.#merge(await this.#read());
      })();
    }
    return this.#loadRequest;
  }

  get(
    repo: string,
    workflow: string,
    runId: number,
    runAttempt: number,
  ): CachedCiRun | undefined {
    return this.#runs.get(runKey(repo, workflow, runId, runAttempt));
  }

  setHeadSha(
    repo: string,
    workflow: string,
    runId: number,
    runAttempt: number,
    headSha: string,
  ): CachedCiRun | undefined {
    const key = runKey(repo, workflow, runId, runAttempt);
    const current = this.#runs.get(key);
    if (!current) return undefined;
    const normalized = headSha.toLowerCase();
    if (current.headSha === normalized) return current;
    const updated = { ...current, headSha: normalized };
    this.#runs.set(key, updated);
    this.#revision++;
    this.#bumpSource(repo, workflow);
    return updated;
  }

  latest(
    repo: string,
    workflow: string,
    runId: number,
  ): CachedCiRun | undefined {
    let latest: CachedCiRun | undefined;
    for (const run of this.#runs.values()) {
      if (
        run.repo === repo && run.workflow === workflow && run.runId === runId
      ) {
        if (!latest || run.runAttempt > latest.runAttempt) latest = run;
      }
    }
    return latest;
  }

  refresh(
    repo: string,
    workflow: string,
    days: number,
  ): CachedCiHistoryRefresh | undefined {
    const refresh = this.#refreshes.get(refreshKey(repo, workflow, days));
    if (!refresh || !this.#resolveRefresh(refresh)) return undefined;
    return {
      ...refresh,
      successfulRunTimes: [...refresh.successfulRunTimes],
      sampledRuns: refresh.sampledRuns.map((run) => ({ ...run })),
      failedRunTimes: [...refresh.failedRunTimes],
    };
  }

  freshRefresh(
    repo: string,
    workflow: string,
    days: number,
  ): CachedCiHistoryRefresh | undefined {
    const refresh = this.refresh(repo, workflow, days);
    const invalidation = this.#invalidations.get(
      refreshKey(repo, workflow, days),
    );
    return refresh && refresh.refreshedAt <= Date.now() &&
        (!invalidation || refresh.refreshedAt > invalidation.invalidatedAt)
      ? refresh
      : undefined;
  }

  refreshedRuns(
    repo: string,
    workflow: string,
    days: number,
  ): CachedCiRun[] | null {
    const refresh = this.#refreshes.get(refreshKey(repo, workflow, days));
    return refresh ? this.#resolveRefresh(refresh) : null;
  }

  markRefreshed(
    repo: string,
    workflow: string,
    days: number,
    refreshedAt: number,
    successfulRunTimes: number[],
    sampledRuns: CachedCiRunReference[],
    failedRunCount: number,
    failedRunTimes: number[],
    stale: boolean,
  ): void {
    if (!Number.isFinite(refreshedAt) || refreshedAt < 0) return;
    if (!Number.isInteger(failedRunCount) || failedRunCount < 0) {
      throw new Error("CI job history refresh has an invalid failure count.");
    }
    const key = refreshKey(repo, workflow, days);
    const current = this.#refreshes.get(key);
    if (current && current.refreshedAt > refreshedAt) return;
    this.#refreshes.set(key, {
      repo,
      workflow,
      days,
      refreshedAt,
      successfulRunTimes: successfulRunTimes.filter(Number.isFinite).sort(
        (a, b) => a - b,
      ),
      sampledRuns: sampledRuns.map((run) => ({ ...run })),
      failedRunCount,
      failedRunTimes: failedRunTimes.filter(Number.isFinite).sort(
        (a, b) => a - b,
      ),
      stale,
    });
    if (!this.#resolveRefresh(this.#refreshes.get(key)!)) {
      this.#refreshes.delete(key);
      throw new Error("CI job history refresh contains an uncached run.");
    }
    this.#revision++;
  }

  restoreRefresh(
    repo: string,
    workflow: string,
    days: number,
    refresh: CachedCiHistoryRefresh | undefined,
  ): void {
    const key = refreshKey(repo, workflow, days);
    if (refresh && this.#resolveRefresh(refresh)) {
      this.#refreshes.set(key, refresh);
    } else this.#refreshes.delete(key);
    this.#revision++;
  }

  invalidateRefresh(repo: string, workflow: string, days: number): void {
    if (!this.#recordInvalidation(repo, workflow, days, Date.now())) return;
    this.#revision++;
    this.#bumpSource(repo, workflow);
  }

  quarantineFutureRefresh(
    repo: string,
    workflow: string,
    days: number,
    now = Date.now(),
  ): boolean {
    const key = refreshKey(repo, workflow, days);
    let changed = this.#futureQuarantines.has(key);
    const refresh = this.#refreshes.get(key);
    if (refresh && refresh.refreshedAt > now) {
      this.#refreshes.delete(key);
      changed = true;
    }
    const invalidation = this.#invalidations.get(key);
    if (invalidation && invalidation.invalidatedAt > now) {
      this.#invalidations.delete(key);
      changed = true;
    }
    if (changed && !this.#futureQuarantines.has(key)) this.#revision++;
    if (changed) this.#futureQuarantines.add(key);
    return changed;
  }

  get dirty(): boolean {
    return this.#revision > this.#persistedRevision;
  }

  get revision(): number {
    return this.#revision;
  }

  revisionFor(repo: string, workflow: string): number {
    return this.#sourceRevisions.get(sourceKey(repo, workflow)) ?? 0;
  }

  #bumpSource(repo: string, workflow: string): void {
    const key = sourceKey(repo, workflow);
    this.#sourceRevisions.set(key, (this.#sourceRevisions.get(key) ?? 0) + 1);
  }

  #prune(now: number): void {
    const cutoff = now - CI_JOB_CACHE_DAYS * DAY_MS;
    let pruned = false;
    const prunedSources = new Set<string>();
    for (const [key, run] of this.#runs) {
      if (run.at < cutoff) {
        this.#runs.delete(key);
        pruned = true;
        prunedSources.add(sourceKey(run.repo, run.workflow));
      }
    }
    if (this.#dropUnresolvedRefreshes()) pruned = true;
    if (!pruned) return;
    this.#revision++;
    for (const key of prunedSources) {
      this.#sourceRevisions.set(
        key,
        (this.#sourceRevisions.get(key) ?? 0) + 1,
      );
    }
  }

  #put(run: CachedCiRun): CachedCiRun {
    const key = runKey(run.repo, run.workflow, run.runId, run.runAttempt);
    const current = this.#runs.get(key);
    if (current) return current;
    this.#runs.set(key, run);
    return run;
  }

  set(run: CachedCiRun): CachedCiRun {
    const stored = this.#put(run);
    if (stored === run) {
      this.#invalidateSupersededRefreshes(Date.now());
      this.#revision++;
      this.#bumpSource(run.repo, run.workflow);
    }
    return this.latest(run.repo, run.workflow, run.runId) ?? stored;
  }

  replace(run: CachedCiRun): CachedCiRun {
    const key = runKey(run.repo, run.workflow, run.runId, run.runAttempt);
    this.#runs.set(key, run);
    this.#invalidateSupersededRefreshes(Date.now());
    this.#revision++;
    this.#bumpSource(run.repo, run.workflow);
    return this.latest(run.repo, run.workflow, run.runId) ?? run;
  }

  list(repo: string, workflow: string, cutoff = -Infinity): CachedCiRun[] {
    const latest = new Map<number, CachedCiRun>();
    for (const run of this.#runs.values()) {
      if (
        run.repo !== repo || run.workflow !== workflow || run.at < cutoff
      ) continue;
      const current = latest.get(run.runId);
      if (!current || current.runAttempt < run.runAttempt) {
        latest.set(run.runId, run);
      }
    }
    return [...latest.values()].sort((a, b) => a.at - b.at);
  }

  async save(now = Date.now()): Promise<void> {
    this.#prune(now);
    if (!this.dirty) return;
    const write = async () => {
      if (!this.dirty) return;
      const lock = await Deno.open(`${this.file}.lock`, {
        create: true,
        write: true,
      });
      let locked = false;
      try {
        await lock.lock(true);
        locked = true;
        this.#merge(await this.#read(true));
        this.#prune(now);

        const revision = this.#revision;
        const value: StoredCiJobHistory = {
          version: STORE_VERSION,
          invalidations: [...this.#invalidations.values()].sort((a, b) =>
            refreshKey(a.repo, a.workflow, a.days).localeCompare(
              refreshKey(b.repo, b.workflow, b.days),
            )
          ),
          refreshes: [...this.#refreshes.values()].sort((a, b) =>
            refreshKey(a.repo, a.workflow, a.days).localeCompare(
              refreshKey(b.repo, b.workflow, b.days),
            )
          ),
          runs: [...this.#runs.values()].sort((a, b) => a.at - b.at),
        };
        const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
        try {
          await Deno.writeTextFile(temporary, JSON.stringify(value));
          await Deno.rename(temporary, this.file);
        } catch (error) {
          try {
            await Deno.remove(temporary);
          } catch {
            // Ignore cleanup when no temporary file remains.
          }
          throw error;
        }
        this.#persistedRevision = Math.max(
          this.#persistedRevision,
          revision,
        );
        this.#futureQuarantines.clear();
      } finally {
        if (locked) await lock.unlock();
        lock.close();
      }
    };
    this.#write = this.#write.then(write, write);
    await this.#write;
  }
}
