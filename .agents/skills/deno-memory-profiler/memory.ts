#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write

// Deno Memory Profiler — V8 Inspector CDP client
// Zero dependencies. Single file. JSON output to stdout, status to stderr.

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface GlobalOpts {
  host: string;
  port: number;
}

function parseGlobalOpts(args: string[]): { opts: GlobalOpts; rest: string[] } {
  let host = "127.0.0.1";
  let port = 9229;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--port=")) {
      port = Number(a.split("=")[1]);
    } else if (a === "--port") {
      port = Number(args[++i]);
    } else if (a.startsWith("--host=")) {
      host = a.split("=")[1];
    } else if (a === "--host") {
      host = args[++i];
    } else {
      rest.push(a);
    }
  }
  return { opts: { host, port }, rest };
}

// ---------------------------------------------------------------------------
// CDP Client
// ---------------------------------------------------------------------------

type CDPEventHandler = (params: Record<string, unknown>) => void;

class CDPClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Map<string, CDPEventHandler[]>();
  private openPromise!: Promise<void>;

  static async connect(host: string, port: number): Promise<CDPClient> {
    // Discover websocket URL
    const listUrl = `http://${host}:${port}/json/list`;
    let resp: Response;
    try {
      resp = await fetch(listUrl);
    } catch (e) {
      throw new Error(
        `Cannot reach inspector at ${listUrl}. Is the process running with --inspect? (${e})`,
      );
    }
    const targets = (await resp.json()) as Array<{
      webSocketDebuggerUrl?: string;
    }>;
    if (!targets.length || !targets[0].webSocketDebuggerUrl) {
      throw new Error("No debuggable targets found at " + listUrl);
    }
    const wsUrl = targets[0].webSocketDebuggerUrl;
    const client = new CDPClient();
    await client._connect(wsUrl);
    return client;
  }

  private _connect(wsUrl: string): Promise<void> {
    this.ws = new WebSocket(wsUrl);
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) =>
        reject(new Error("WebSocket error: " + String(e)));
    });

    this.ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(
              new Error(`CDP error: ${msg.error.message} (${msg.error.code})`),
            );
          } else {
            p.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        // CDP event
        const handlers = this.eventHandlers.get(msg.method);
        if (handlers) {
          for (const h of handlers) h(msg.params ?? {});
        }
      }
    };

    return this.openPromise;
  }

  on(method: string, handler: CDPEventHandler): void {
    const list = this.eventHandlers.get(method) ?? [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  disconnect(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdUsage(client: CDPClient, args: string[]) {
  const doGC = args.includes("--gc");

  if (doGC) {
    await client.send("HeapProfiler.collectGarbage");
  }

  const result = (await client.send("Runtime.getHeapUsage")) as {
    usedSize: number;
    totalSize: number;
  };

  const usagePercent =
    result.totalSize > 0
      ? Math.round((result.usedSize / result.totalSize) * 10000) / 100
      : 0;

  console.log(
    JSON.stringify(
      {
        usedSize: result.usedSize,
        totalSize: result.totalSize,
        usagePercent,
      },
      null,
      2,
    ),
  );
}

async function cmdEval(client: CDPClient, args: string[]) {
  const expression = args.join(" ");
  if (!expression) {
    throw new Error("Usage: eval <expression>");
  }

  const result = (await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    generatePreview: true,
  })) as {
    result: { type: string; value?: unknown; description?: string };
    exceptionDetails?: { text: string };
  };

  if (result.exceptionDetails) {
    throw new Error("Evaluation error: " + result.exceptionDetails.text);
  }

  console.log(JSON.stringify(result.result.value ?? result.result, null, 2));
}

async function cmdSample(client: CDPClient, args: string[]) {
  let duration = 5;
  let interval = 32768;
  let top = 30;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--duration=")) duration = Number(a.split("=")[1]);
    else if (a === "--duration") duration = Number(args[++i]);
    else if (a.startsWith("--interval=")) interval = Number(a.split("=")[1]);
    else if (a === "--interval") interval = Number(args[++i]);
    else if (a.startsWith("--top=")) top = Number(a.split("=")[1]);
    else if (a === "--top") top = Number(args[++i]);
  }

  await client.send("HeapProfiler.startSampling", {
    samplingInterval: interval,
  });

  console.error(`Sampling for ${duration}s...`);
  await new Promise((r) => setTimeout(r, duration * 1000));

  const result = (await client.send("HeapProfiler.stopSampling")) as {
    profile: SamplingProfile;
  };

  interface SamplingNode {
    callFrame: {
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    };
    selfSize: number;
    children: SamplingNode[];
  }

  interface SamplingProfile {
    head: SamplingNode;
  }

  // Flatten the allocation tree
  interface AllocationSite {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
    selfSize: number;
    selfCount: number;
  }

  const sites = new Map<string, AllocationSite>();
  let totalAllocatedBytes = 0;

  function walk(node: SamplingNode) {
    if (node.selfSize > 0) {
      const key = `${node.callFrame.functionName}:${node.callFrame.url}:${node.callFrame.lineNumber}:${node.callFrame.columnNumber}`;
      const existing = sites.get(key);
      if (existing) {
        existing.selfSize += node.selfSize;
        existing.selfCount += 1;
      } else {
        sites.set(key, {
          functionName: node.callFrame.functionName || "(anonymous)",
          url: node.callFrame.url,
          lineNumber: node.callFrame.lineNumber,
          columnNumber: node.callFrame.columnNumber,
          selfSize: node.selfSize,
          selfCount: 1,
        });
      }
      totalAllocatedBytes += node.selfSize;
    }
    for (const child of node.children) walk(child);
  }

  walk(result.profile.head);

  const sorted = [...sites.values()].sort((a, b) => b.selfSize - a.selfSize);
  const topSites = sorted.slice(0, top);

  console.log(
    JSON.stringify(
      {
        totalAllocatedBytes,
        sampleDurationSeconds: duration,
        samplingInterval: interval,
        topAllocationSites: topSites,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

interface HeapSnapshotData {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: unknown[][];
      edge_fields: string[];
      edge_types: unknown[][];
    };
    node_count: number;
    edge_count: number;
  };
  nodes: number[];
  edges: number[];
  strings: string[];
}

interface ConstructorStats {
  name: string;
  count: number;
  totalShallowSize: number;
}

function parseSnapshotSummary(data: HeapSnapshotData) {
  const meta = data.snapshot.meta;
  const nodeFields = meta.node_fields;
  const nodeFieldCount = nodeFields.length;
  const nodeTypeNames = meta.node_types[0] as string[];

  const typeIdx = nodeFields.indexOf("type");
  const nameIdx = nodeFields.indexOf("name");
  const selfSizeIdx = nodeFields.indexOf("self_size");

  const constructors = new Map<string, { count: number; totalShallowSize: number }>();
  let totalSize = 0;
  const nodeCount = data.nodes.length / nodeFieldCount;

  for (let i = 0; i < data.nodes.length; i += nodeFieldCount) {
    const nodeType = nodeTypeNames[data.nodes[i + typeIdx]];
    const nameStrIdx = data.nodes[i + nameIdx];
    const selfSize = data.nodes[i + selfSizeIdx];
    totalSize += selfSize;

    // Group by constructor name for object nodes
    if (nodeType === "object" || nodeType === "closure" || nodeType === "regexp") {
      const name = data.strings[nameStrIdx] || "(unknown)";
      const entry = constructors.get(name);
      if (entry) {
        entry.count++;
        entry.totalShallowSize += selfSize;
      } else {
        constructors.set(name, { count: 1, totalShallowSize: selfSize });
      }
    }
  }

  // String duplicate analysis
  const stringCounts = new Map<string, number>();
  // Iterate nodes to find string nodes and their values
  for (let i = 0; i < data.nodes.length; i += nodeFieldCount) {
    const nodeType = nodeTypeNames[data.nodes[i + typeIdx]];
    if (
      nodeType === "string" ||
      nodeType === "concatenated string" ||
      nodeType === "sliced string"
    ) {
      const nameStrIdx = data.nodes[i + nameIdx];
      const str = data.strings[nameStrIdx];
      if (str) {
        stringCounts.set(str, (stringCounts.get(str) ?? 0) + 1);
      }
    }
  }
  const duplicateStrings = [...stringCounts.entries()]
    .filter(([, count]) => count > 50)
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({
      value: value.length > 100 ? value.slice(0, 100) + "..." : value,
      count,
    }));

  const constructorList: ConstructorStats[] = [...constructors.entries()].map(
    ([name, s]) => ({
      name,
      count: s.count,
      totalShallowSize: s.totalShallowSize,
    }),
  );

  const bySize = [...constructorList].sort(
    (a, b) => b.totalShallowSize - a.totalShallowSize,
  );
  const byCount = [...constructorList].sort((a, b) => b.count - a.count);

  const edgeCount = data.edges.length / meta.edge_fields.length;

  return {
    totalSize,
    nodeCount,
    edgeCount,
    topByShallowSize: bySize.slice(0, 20),
    topByInstanceCount: byCount.slice(0, 10),
    duplicateStrings,
    // For diff: full constructor map
    _constructorMap: Object.fromEntries(
      constructorList.map((c) => [c.name, { count: c.count, totalShallowSize: c.totalShallowSize }]),
    ),
  };
}

async function takeSnapshot(client: CDPClient): Promise<HeapSnapshotData> {
  const chunks: string[] = [];

  client.on("HeapProfiler.addHeapSnapshotChunk", (params) => {
    chunks.push(params.chunk as string);
  });

  console.error("Taking heap snapshot...");
  await client.send("HeapProfiler.takeHeapSnapshot", {
    reportProgress: false,
  });

  // Small delay to ensure all chunks arrive
  await new Promise((r) => setTimeout(r, 200));

  const raw = chunks.join("");
  console.error(`Snapshot received (${(raw.length / 1024 / 1024).toFixed(1)} MB). Parsing...`);

  return JSON.parse(raw) as HeapSnapshotData;
}

async function cmdSnapshot(client: CDPClient, _args: string[]) {
  const data = await takeSnapshot(client);
  const summary = parseSnapshotSummary(data);

  console.log(
    JSON.stringify(
      {
        totalSize: summary.totalSize,
        nodeCount: summary.nodeCount,
        edgeCount: summary.edgeCount,
        topByShallowSize: summary.topByShallowSize,
        topByInstanceCount: summary.topByInstanceCount,
        duplicateStrings: summary.duplicateStrings,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

async function cmdDiff(client: CDPClient, args: string[], port: number) {
  const subcommand = args[0];
  if (!subcommand || (subcommand !== "baseline" && subcommand !== "compare")) {
    throw new Error("Usage: diff baseline | diff compare");
  }

  const baselineFile = `/tmp/memory-baseline-${port}.json`;

  if (subcommand === "baseline") {
    const data = await takeSnapshot(client);
    const summary = parseSnapshotSummary(data);

    const baseline = {
      totalSize: summary.totalSize,
      nodeCount: summary.nodeCount,
      edgeCount: summary.edgeCount,
      constructors: summary._constructorMap,
      timestamp: new Date().toISOString(),
    };

    await Deno.writeTextFile(baselineFile, JSON.stringify(baseline));

    console.log(
      JSON.stringify(
        {
          status: "baseline_saved",
          file: baselineFile,
          totalSize: summary.totalSize,
          nodeCount: summary.nodeCount,
          topByShallowSize: summary.topByShallowSize.slice(0, 10),
        },
        null,
        2,
      ),
    );
  } else {
    // compare
    let baselineText: string;
    try {
      baselineText = await Deno.readTextFile(baselineFile);
    } catch {
      throw new Error(
        `No baseline found at ${baselineFile}. Run 'diff baseline' first.`,
      );
    }

    const baseline = JSON.parse(baselineText) as {
      totalSize: number;
      nodeCount: number;
      constructors: Record<string, { count: number; totalShallowSize: number }>;
      timestamp: string;
    };

    const data = await takeSnapshot(client);
    const summary = parseSnapshotSummary(data);
    const current = summary._constructorMap;

    // Total heap growth
    const heapGrowth = summary.totalSize - baseline.totalSize;
    const heapGrowthPercent =
      baseline.totalSize > 0
        ? Math.round((heapGrowth / baseline.totalSize) * 10000) / 100
        : 0;

    // New constructors
    const newConstructors: ConstructorStats[] = [];
    for (const [name, stats] of Object.entries(current)) {
      if (!(name in baseline.constructors)) {
        newConstructors.push({ name, ...stats });
      }
    }
    newConstructors.sort((a, b) => b.totalShallowSize - a.totalShallowSize);

    // Disappeared constructors
    const disappeared: string[] = [];
    for (const name of Object.keys(baseline.constructors)) {
      if (!(name in current)) {
        disappeared.push(name);
      }
    }

    // Increased instance count
    interface ConstructorDelta {
      name: string;
      baselineCount: number;
      currentCount: number;
      deltaCount: number;
      baselineSize: number;
      currentSize: number;
      deltaSize: number;
    }

    const increasedCount: ConstructorDelta[] = [];
    const increasedSize: ConstructorDelta[] = [];

    for (const [name, cur] of Object.entries(current)) {
      const base = baseline.constructors[name];
      if (!base) continue;

      const deltaCount = cur.count - base.count;
      const deltaSize = cur.totalShallowSize - base.totalShallowSize;
      const entry: ConstructorDelta = {
        name,
        baselineCount: base.count,
        currentCount: cur.count,
        deltaCount,
        baselineSize: base.totalShallowSize,
        currentSize: cur.totalShallowSize,
        deltaSize,
      };

      if (deltaCount > 0) increasedCount.push(entry);
      if (deltaSize > 0) increasedSize.push(entry);
    }

    increasedCount.sort((a, b) => b.deltaCount - a.deltaCount);
    increasedSize.sort((a, b) => b.deltaSize - a.deltaSize);

    console.log(
      JSON.stringify(
        {
          baselineTimestamp: baseline.timestamp,
          compareTimestamp: new Date().toISOString(),
          totalHeapGrowth: {
            bytes: heapGrowth,
            percent: heapGrowthPercent,
            baselineSize: baseline.totalSize,
            currentSize: summary.totalSize,
          },
          newConstructors: newConstructors.slice(0, 20),
          increasedByCount: increasedCount.slice(0, 20),
          increasedBySize: increasedSize.slice(0, 20),
          disappearedConstructors: disappeared,
        },
        null,
        2,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rawArgs = Deno.args;

  if (rawArgs.length === 0) {
    console.error(
      `Usage: memory.ts <command> [options]

Commands:
  usage [--gc]                      Show heap usage
  eval <expression>                 Evaluate expression in target
  sample --duration <s> [--top N]   Allocation sampling
  snapshot                          Full heap snapshot summary
  diff baseline                     Save baseline snapshot
  diff compare                      Compare against baseline

Global options:
  --host <host>   Inspector host (default: 127.0.0.1)
  --port <port>   Inspector port (default: 9229)`,
    );
    Deno.exit(1);
  }

  const { opts, rest } = parseGlobalOpts(rawArgs);
  const command = rest[0];
  const cmdArgs = rest.slice(1);

  let client: CDPClient;
  try {
    client = await CDPClient.connect(opts.host, opts.port);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    Deno.exit(1);
  }

  try {
    switch (command) {
      case "usage":
        await cmdUsage(client, cmdArgs);
        break;
      case "eval":
        await cmdEval(client, cmdArgs);
        break;
      case "sample":
        await cmdSample(client, cmdArgs);
        break;
      case "snapshot":
        await cmdSnapshot(client, cmdArgs);
        break;
      case "diff":
        await cmdDiff(client, cmdArgs, opts.port);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        Deno.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    Deno.exit(1);
  } finally {
    client.disconnect();
  }
}

main();
