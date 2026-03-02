export interface CfcDebugCounters {
  cfcRelevantTx: number;
  cfcPreparedTx: number;
  cfcGateRejects: number;
  cfcOutboxFlushes: number;
}

const counters: CfcDebugCounters = {
  cfcRelevantTx: 0,
  cfcPreparedTx: 0,
  cfcGateRejects: 0,
  cfcOutboxFlushes: 0,
};

export function getCfcDebugCounters(): CfcDebugCounters {
  return { ...counters };
}

export function resetCfcDebugCounters(): void {
  counters.cfcRelevantTx = 0;
  counters.cfcPreparedTx = 0;
  counters.cfcGateRejects = 0;
  counters.cfcOutboxFlushes = 0;
}

export function recordCfcRelevantTx(): void {
  counters.cfcRelevantTx++;
}

export function recordCfcPreparedTx(): void {
  counters.cfcPreparedTx++;
}

export function recordCfcGateReject(): void {
  counters.cfcGateRejects++;
}

export function recordCfcOutboxFlush(): void {
  counters.cfcOutboxFlushes++;
}
