/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const lifecycleStages = [
  "procured",
  "in_service",
  "maintenance",
  "retired",
] as const;

type AssetStage = typeof lifecycleStages[number];

type StageCountMap = Record<AssetStage, number>;

interface AssetInput {
  id?: string;
  name?: string;
  owner?: string;
  stage?: string;
}

interface AssetRecord {
  id: string;
  name: string;
  owner: string;
  stage: AssetStage;
}

interface LifecycleBucket {
  stage: AssetStage;
  label: string;
  count: number;
  assets: AssetSnapshot[];
}

interface AssetSnapshot {
  id: string;
  name: string;
  owner: string;
  stageLabel: string;
}

interface AssetLifecycleTrackerArgs {
  assets: Default<AssetInput[], typeof defaultAssets>;
}

interface TransitionEntry {
  sequence: number;
  assetId: string;
  assetName: string;
  from: AssetStage;
  to: AssetStage;
  message: string;
}

interface StageChangeSnapshot {
  asset: AssetRecord;
  from: AssetStage;
  to: AssetStage;
}

const stageLabels: Record<AssetStage, string> = {
  procured: "Procured",
  in_service: "In Service",
  maintenance: "In Maintenance",
  retired: "Retired",
};

const lifecycleStageSet = new Set<AssetStage>(lifecycleStages);

const defaultAssets: AssetRecord[] = [
  {
    id: "SRV-001",
    name: "Build Server",
    owner: "Infrastructure",
    stage: "procured",
  },
  {
    id: "LPT-104",
    name: "Design Laptop",
    owner: "Design",
    stage: "in_service",
  },
  {
    id: "PRJ-205",
    name: "Projector Kit",
    owner: "Facilities",
    stage: "maintenance",
  },
];

const cloneAssets = (entries: readonly AssetRecord[]): AssetRecord[] =>
  entries.map((entry) => ({ ...entry }));

const sanitizeAssetId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed ? trimmed : null;
};

const sanitizeAssetName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
};

const sanitizeOwner = (value: unknown): string => {
  if (typeof value !== "string") return "General";
  const trimmed = value.trim();
  return trimmed ? trimmed : "General";
};

const sanitizeStage = (value: unknown): AssetStage => {
  if (typeof value !== "string") return "procured";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (lifecycleStageSet.has(normalized as AssetStage)) {
    return normalized as AssetStage;
  }
  return "procured";
};

const sanitizeAsset = (value: unknown): AssetRecord | null => {
  const candidate = value as AssetInput | undefined;
  const id = sanitizeAssetId(candidate?.id);
  if (!id) return null;
  const stage = sanitizeStage(candidate?.stage);
  const name = sanitizeAssetName(candidate?.name, `Asset ${id}`);
  const owner = sanitizeOwner(candidate?.owner);
  return { id, stage, name, owner };
};

const compareAssets = (left: AssetRecord, right: AssetRecord): number => {
  const leftIndex = lifecycleStages.indexOf(left.stage);
  const rightIndex = lifecycleStages.indexOf(right.stage);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  const nameCompare = left.name.localeCompare(right.name);
  if (nameCompare !== 0) return nameCompare;
  return left.id.localeCompare(right.id);
};

const sanitizeAssetList = (value: unknown): AssetRecord[] => {
  if (!Array.isArray(value)) {
    return cloneAssets(defaultAssets);
  }
  const seen = new Set<string>();
  const sanitized: AssetRecord[] = [];
  for (const raw of value) {
    const asset = sanitizeAsset(raw);
    if (!asset) continue;
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    sanitized.push(asset);
  }
  if (sanitized.length === 0) {
    return cloneAssets(defaultAssets);
  }
  sanitized.sort(compareAssets);
  return sanitized;
};

const createEmptyCounts = (): StageCountMap => ({
  procured: 0,
  in_service: 0,
  maintenance: 0,
  retired: 0,
});

const nextStage = (stage: AssetStage): AssetStage | null => {
  const index = lifecycleStages.indexOf(stage);
  const next = lifecycleStages[index + 1];
  return next ?? null;
};

const toAssetInputs = (entries: readonly AssetRecord[]): AssetInput[] =>
  entries.map((entry) => ({ ...entry }));

const applyStageChange = (
  entries: AssetRecord[],
  id: string,
  resolve: (asset: AssetRecord) => AssetStage | null,
): { list: AssetRecord[]; change: StageChangeSnapshot | null } => {
  const updated: AssetRecord[] = [];
  let change: StageChangeSnapshot | null = null;
  for (const asset of entries) {
    if (asset.id !== id) {
      updated.push(asset);
      continue;
    }
    const next = resolve(asset);
    if (!next || next === asset.stage) {
      updated.push(asset);
      continue;
    }
    const mutated = { ...asset, stage: next };
    change = { asset: mutated, from: asset.stage, to: next };
    updated.push(mutated);
  }
  if (!change) return { list: entries, change: null };
  return { list: sanitizeAssetList(updated), change };
};

const recordTransition = (
  history: Cell<TransitionEntry[]>,
  asset: AssetRecord,
  from: AssetStage,
  to: AssetStage,
) => {
  if (from === to) return;
  const entries = history.get();
  const log = Array.isArray(entries) ? [...entries] : [];
  const message = `${asset.name} moved from ${stageLabels[from]} to ${
    stageLabels[to]
  }`;
  const entry: TransitionEntry = {
    sequence: log.length + 1,
    assetId: asset.id,
    assetName: asset.name,
    from,
    to,
    message,
  };
  log.push(entry);
  history.set(log);
};

const advanceLifecycle = handler(
  (
    event: { assetId?: string } | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(
      current,
      id,
      (asset) => nextStage(asset.stage),
    );
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

const markMaintenance = handler(
  (
    event: { assetId?: string } | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(current, id, () => "maintenance");
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

const retireAsset = handler(
  (
    event: { assetId?: string } | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(current, id, () => "retired");
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

const restoreAsset = handler(
  (
    event: { assetId?: string } | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(current, id, () => "in_service");
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

export const assetLifecycleTrackerUx = recipe<AssetLifecycleTrackerArgs>(
  "Asset Lifecycle Tracker (UX)",
  ({ assets }) => {
    const transitionLog = cell<TransitionEntry[]>([]);

    const assetsView = lift(sanitizeAssetList)(assets);
    const stageBuckets = lift((entries: AssetRecord[]): LifecycleBucket[] => {
      const buckets = lifecycleStages.map((stage) => ({
        stage,
        label: stageLabels[stage],
        count: 0,
        assets: [] as AssetSnapshot[],
      }));
      const lookup = new Map<AssetStage, LifecycleBucket>();
      for (const bucket of buckets) lookup.set(bucket.stage, bucket);
      for (const asset of entries) {
        const bucket = lookup.get(asset.stage);
        if (!bucket) continue;
        bucket.count += 1;
        bucket.assets.push({
          id: asset.id,
          name: asset.name,
          owner: asset.owner,
          stageLabel: stageLabels[asset.stage],
        });
      }
      return buckets;
    })(assetsView);

    const stageCounts = lift((entries: AssetRecord[]): StageCountMap => {
      const counts = createEmptyCounts();
      for (const asset of entries) {
        counts[asset.stage] += 1;
      }
      return counts;
    })(assetsView);

    const totalAssets = lift((counts: StageCountMap) =>
      lifecycleStages.reduce((sum, stage) => sum + counts[stage], 0)
    )(stageCounts);

    const activeCount = lift((counts: StageCountMap) =>
      counts.procured + counts.in_service + counts.maintenance
    )(stageCounts);

    const lifecycleProgress = lift(
      (input: { active: number; total: number }) => {
        if (input.total === 0) return 0;
        return Math.round((input.active / input.total) * 100);
      },
    )({ active: activeCount, total: totalAssets });

    const lifecycleLabel = str`${activeCount} active of ${totalAssets} assets`;

    const transitionHistory = lift((entries: TransitionEntry[]) =>
      entries.map((entry) => ({
        sequence: entry.sequence,
        assetId: entry.assetId,
        assetName: entry.assetName,
        from: stageLabels[entry.from],
        to: stageLabels[entry.to],
        message: entry.message,
      }))
    )(transitionLog);

    const busiestStage = lift((buckets: LifecycleBucket[]) => {
      let current: { label: string; count: number } = {
        label: "Procured",
        count: 0,
      };
      for (const bucket of buckets) {
        if (bucket.count > current.count) {
          current = { label: bucket.label, count: bucket.count };
        }
      }
      return current;
    })(stageBuckets);

    const name = str`Asset Lifecycle (${totalAssets} assets)`;

    const selectedAssetId = cell<string>("");
    const selectedAction = cell<string>("advance");

    const performAdvance = handler<
      unknown,
      {
        assets: Cell<AssetInput[]>;
        history: Cell<TransitionEntry[]>;
        assetId: Cell<string>;
      }
    >((_event, { assets, history, assetId }) => {
      const id = sanitizeAssetId(assetId.get());
      if (!id) return;
      const current = sanitizeAssetList(assets.get());
      const result = applyStageChange(
        current,
        id,
        (asset) => nextStage(asset.stage),
      );
      if (!result.change) return;
      assets.set(toAssetInputs(result.list));
      recordTransition(
        history,
        result.change.asset,
        result.change.from,
        result.change.to,
      );
    })({ assets, history: transitionLog, assetId: selectedAssetId });

    const performMaintenance = handler<
      unknown,
      {
        assets: Cell<AssetInput[]>;
        history: Cell<TransitionEntry[]>;
        assetId: Cell<string>;
      }
    >((_event, { assets, history, assetId }) => {
      const id = sanitizeAssetId(assetId.get());
      if (!id) return;
      const current = sanitizeAssetList(assets.get());
      const result = applyStageChange(current, id, () => "maintenance");
      if (!result.change) return;
      assets.set(toAssetInputs(result.list));
      recordTransition(
        history,
        result.change.asset,
        result.change.from,
        result.change.to,
      );
    })({ assets, history: transitionLog, assetId: selectedAssetId });

    const performRetire = handler<
      unknown,
      {
        assets: Cell<AssetInput[]>;
        history: Cell<TransitionEntry[]>;
        assetId: Cell<string>;
      }
    >((_event, { assets, history, assetId }) => {
      const id = sanitizeAssetId(assetId.get());
      if (!id) return;
      const current = sanitizeAssetList(assets.get());
      const result = applyStageChange(current, id, () => "retired");
      if (!result.change) return;
      assets.set(toAssetInputs(result.list));
      recordTransition(
        history,
        result.change.asset,
        result.change.from,
        result.change.to,
      );
    })({ assets, history: transitionLog, assetId: selectedAssetId });

    const performRestore = handler<
      unknown,
      {
        assets: Cell<AssetInput[]>;
        history: Cell<TransitionEntry[]>;
        assetId: Cell<string>;
      }
    >((_event, { assets, history, assetId }) => {
      const id = sanitizeAssetId(assetId.get());
      if (!id) return;
      const current = sanitizeAssetList(assets.get());
      const result = applyStageChange(current, id, () => "in_service");
      if (!result.change) return;
      assets.set(toAssetInputs(result.list));
      recordTransition(
        history,
        result.change.asset,
        result.change.from,
        result.change.to,
      );
    })({ assets, history: transitionLog, assetId: selectedAssetId });

    const stageColors: Record<AssetStage, string> = {
      procured: "#3b82f6",
      in_service: "#10b981",
      maintenance: "#f59e0b",
      retired: "#6b7280",
    };

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Asset Lifecycle Tracker
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Manage asset transitions across lifecycle stages
                </h2>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.8rem; color: #475569;">
                    {lifecycleLabel}
                  </span>
                  <strong style="font-size: 1.5rem; color: #0f172a;">
                    {lifecycleProgress}% active
                  </strong>
                </div>

                <div style="
                    position: relative;
                    height: 0.5rem;
                    background: #e2e8f0;
                    border-radius: 0.25rem;
                    overflow: hidden;
                  ">
                  <div
                    style={lift(
                      (pct: number) =>
                        `position: absolute; left: 0; top: 0; bottom: 0; width: ${pct}%; background: linear-gradient(90deg, #10b981, #3b82f6); border-radius: 0.25rem; transition: width 0.2s ease;`,
                    )(lifecycleProgress)}
                  >
                  </div>
                </div>

                <div style="
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.75rem;
                    color: #64748b;
                  ">
                  <span>
                    Busiest stage: {lift((s: { label: string }) => s.label)(
                      busiestStage,
                    )} ({lift((s: { count: number }) => s.count)(
                      busiestStage,
                    )})
                  </span>
                </div>
              </div>
            </div>
          </ct-card>

          <div style="
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
              gap: 1rem;
            ">
            {lift((buckets: LifecycleBucket[]) =>
              buckets.map((bucket) => (
                <ct-card key={bucket.stage}>
                  <div
                    slot="header"
                    style="
                      display: flex;
                      justify-content: space-between;
                      align-items: center;
                    "
                  >
                    <div style="
                        display: flex;
                        align-items: center;
                        gap: 0.5rem;
                      ">
                      <span
                        style={`
                          display: inline-block;
                          width: 0.75rem;
                          height: 0.75rem;
                          border-radius: 50%;
                          background: ${stageColors[bucket.stage]};
                        `}
                      >
                      </span>
                      <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                        {bucket.label}
                      </h3>
                    </div>
                    <span style="
                        font-size: 1.25rem;
                        font-weight: 600;
                        color: #475569;
                      ">
                      {bucket.count}
                    </span>
                  </div>
                  <div
                    slot="content"
                    style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.75rem;
                    "
                  >
                    {bucket.assets.length === 0
                      ? (
                        <p style="
                          margin: 0;
                          font-size: 0.85rem;
                          color: #94a3b8;
                          font-style: italic;
                        ">
                          No assets in this stage
                        </p>
                      )
                      : bucket.assets.map((asset) => (
                        <div
                          key={asset.id}
                          style="
                            background: #f8fafc;
                            border: 1px solid #e2e8f0;
                            border-radius: 0.5rem;
                            padding: 0.75rem;
                          "
                        >
                          <div style="
                              font-weight: 600;
                              color: #0f172a;
                              font-size: 0.95rem;
                            ">
                            {asset.name}
                          </div>
                          <div style="
                              font-size: 0.75rem;
                              color: #64748b;
                              margin-top: 0.15rem;
                            ">
                            {asset.id} • {asset.owner}
                          </div>
                        </div>
                      ))}
                  </div>
                </ct-card>
              ))
            )(stageBuckets)}
          </div>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Perform asset transition
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                <label
                  for="asset-id"
                  style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                >
                  Enter Asset ID to perform transitions
                </label>
                <ct-input
                  id="asset-id"
                  $value={selectedAssetId}
                  placeholder="e.g., SRV-001"
                  aria-label="Enter asset ID"
                >
                </ct-input>
              </div>
              <div style="
                  display: flex;
                  gap: 0.75rem;
                  flex-wrap: wrap;
                ">
                <ct-button onClick={performAdvance}>
                  Advance Stage
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={performMaintenance}
                >
                  Mark Maintenance
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={performRetire}
                >
                  Retire Asset
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={performRestore}
                >
                  Restore Asset
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Transition history
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 400px;
                overflow-y: auto;
              "
            >
              {lift((
                entries: Array<{
                  sequence: number;
                  assetId: string;
                  assetName: string;
                  from: string;
                  to: string;
                  message: string;
                }>,
              ) => {
                if (entries.length === 0) {
                  return (
                    <p style="
                        margin: 0;
                        font-size: 0.85rem;
                        color: #94a3b8;
                        font-style: italic;
                      ">
                      No transitions yet
                    </p>
                  );
                }
                return entries.slice().reverse().map((entry) => (
                  <div
                    key={entry.sequence}
                    style="
                      background: #f8fafc;
                      border-left: 3px solid #3b82f6;
                      border-radius: 0.25rem;
                      padding: 0.75rem;
                      font-size: 0.85rem;
                    "
                  >
                    <div style="color: #0f172a; font-weight: 500;">
                      {entry.message}
                    </div>
                    <div style="
                        color: #64748b;
                        font-size: 0.75rem;
                        margin-top: 0.25rem;
                      ">
                      #{entry.sequence} • {entry.assetId}
                    </div>
                  </div>
                ));
              })(transitionHistory)}
            </div>
          </ct-card>
        </div>
      ),
      assets,
      assetsView,
      stageBuckets,
      stageCounts,
      lifecycleLabel,
      lifecycleProgress,
      transitionHistory,
      busiestStage,
      totalAssets,
      activeCount,
      transitionLog,
    };
  },
);

export default assetLifecycleTrackerUx;
