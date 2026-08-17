import { assertEquals } from "@std/assert";
import {
  CodexAppServerDriver,
  codexServerRequestPolicy,
  codexTurnExecutionPolicy,
  resolveCodexAppServerLaunch,
} from "../../src/drivers/codex-app-server.ts";

Deno.test("Codex unrestricted turn policy requires explicit opt-in", () => {
  const source = {
    id: "codex:default",
    driver: "codex-app-server" as const,
    enabled: true,
  };
  assertEquals(codexTurnExecutionPolicy(source), {});
  assertEquals(
    codexTurnExecutionPolicy({
      ...source,
      allowDangerFullAccess: true,
    }),
    {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  );
});

Deno.test("Codex server approval requests fail closed without a user surface", () => {
  assertEquals(
    codexServerRequestPolicy("item/commandExecution/requestApproval"),
    { decision: "decline" },
  );
  assertEquals(
    codexServerRequestPolicy("item/fileChange/requestApproval"),
    { decision: "decline" },
  );
});

const FAKE_SERVER = String.raw`#!/usr/bin/env python3
import json, os, sys
if os.environ.get("FAKE_CODEX_ENV_LOG"):
    with open(os.environ["FAKE_CODEX_ENV_LOG"], "w") as log:
        json.dump({
            "sourceToken": os.environ.get("AGENTS_CONNECTOR_SOURCE_TOKEN"),
            "codexHome": os.environ.get("CODEX_HOME"),
        }, log)
if sys.argv[1:] == ["app-server", "daemon", "start"]:
    with open(os.environ["FAKE_CODEX_LOG"], "a") as log:
        log.write("daemon start\n")
    sys.exit(0)
if sys.argv[1:] == ["app-server", "proxy"]:
    with open(os.environ["FAKE_CODEX_LOG"], "a") as log:
        log.write("proxy\n")
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if "id" not in msg:
        continue
    result = {}
    if method == "initialize":
        result = {"serverInfo": {"name": "fake-codex", "version": "1"}}
    elif method == "thread/list":
        if msg.get("params", {}).get("archived"):
            result = {"data": [{"id": "archived-1", "name": "Old", "archived": True, "status": {"type": "idle"}}], "nextCursor": None}
        else:
            result = {"data": [{"id": "thread-1", "name": "Current", "cwd": "/tmp/project", "status": {"type": "active", "activeFlags": []}}], "nextCursor": None}
    elif method == "thread/read":
        tid = msg["params"]["threadId"]
        result = {"thread": {"id": tid, "name": "Current", "status": {"type": "active", "activeFlags": []}, "turns": [{"id": "turn-1", "items": [{"id": "item-1", "type": "userMessage", "content": [{"type": "text", "text": "hello"}]}]}]}}
    elif method == "thread/name/set":
        result = {}
    elif method == "thread/resume":
        result = {}
    elif method == "turn/start":
        # Reuse the pending client request id deliberately. A JSON-RPC client
        # must classify this by method before id, answer it, and keep waiting
        # for the actual turn/start response.
        print(json.dumps({
            "id": msg["id"],
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": msg["params"]["threadId"], "turnId": "turn-approval", "itemId": "item-command", "startedAtMs": 1},
        }), flush=True)
        approval = json.loads(sys.stdin.readline())
        with open(os.environ["FAKE_CODEX_LOG"], "a") as log:
            log.write(json.dumps(approval) + "\n")
        result = {"turn": {"id": "turn-approval"}}
    print(json.dumps({"id": msg["id"], "result": result}), flush=True)
    if method == "turn/start":
        print(json.dumps({"method": "turn/completed", "params": {"threadId": msg["params"]["threadId"], "turn": {"id": "turn-approval", "status": "completed"}}}), flush=True)
`;

const BLOCKED_BOOTSTRAP_SERVER = String.raw`#!/usr/bin/env python3
import os, signal, sys

if sys.argv[1:] != ["app-server", "daemon", "start"]:
    sys.exit(2)

exit_reason = "released"

def stop(_signum, _frame):
    global exit_reason
    exit_reason = "aborted"
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
try:
    with open(os.environ["FAKE_CODEX_BOOTSTRAP_READY"], "w") as ready:
        ready.write("ready\n")
    with open(os.environ["FAKE_CODEX_BOOTSTRAP_PID"], "w") as marker:
        marker.write(str(os.getpid()) + "\n")
    with open(os.environ["FAKE_CODEX_BOOTSTRAP_RELEASE"], "r") as release:
        release.read(1)
finally:
    marker = os.environ["FAKE_CODEX_BOOTSTRAP_EXIT"]
    pending_marker = marker + ".pending"
    with open(pending_marker, "w") as exited:
        exited.write(exit_reason + "\n")
    os.replace(pending_marker, marker)
`;

Deno.test("Codex launch modes distinguish private stdio and shared proxies", () => {
  const source = {
    id: "codex:default",
    driver: "codex-app-server" as const,
    enabled: true,
  };
  assertEquals(
    resolveCodexAppServerLaunch(source, {
      CODEX_BIN: "/opt/codex",
    }),
    {
      command: ["/opt/codex", "app-server", "--listen", "stdio://"],
    },
  );
  assertEquals(
    resolveCodexAppServerLaunch({
      ...source,
      codexTransport: "managed",
    }, { CODEX_BIN: "/opt/codex" }),
    {
      bootstrapCommand: [
        "/opt/codex",
        "app-server",
        "daemon",
        "start",
      ],
      command: ["/opt/codex", "app-server", "proxy"],
    },
  );
  assertEquals(
    resolveCodexAppServerLaunch({
      ...source,
      codexTransport: "proxy",
      codexSocket: "/run/codex.sock",
    }, { CODEX_BIN: "/opt/codex" }),
    {
      command: [
        "/opt/codex",
        "app-server",
        "proxy",
        "--sock",
        "/run/codex.sock",
      ],
    },
  );
  assertEquals(
    resolveCodexAppServerLaunch({
      ...source,
      command: ["ssh", "devbox", "codex app-server proxy"],
    }, {}),
    {
      command: ["ssh", "devbox", "codex app-server proxy"],
    },
  );
});

Deno.test("managed Codex mode starts the daemon before opening its proxy", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/fake-codex`;
  const log = `${dir}/launch.log`;
  await Deno.writeTextFile(server, FAKE_SERVER);
  await Deno.chmod(server, 0o755);
  const driver = new CodexAppServerDriver({
    id: "codex:managed",
    driver: "codex-app-server",
    enabled: true,
    codexTransport: "managed",
    codexBin: server,
    env: { FAKE_CODEX_LOG: log },
  });
  try {
    await driver.start();
    assertEquals((await driver.listSessions()).sessions.length, 1);
    assertEquals(await Deno.readTextFile(log), "daemon start\nproxy\n");
  } finally {
    await driver.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("managed Codex bootstrap observes owner abort", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/blocked-codex`;
  const readyFifo = `${dir}/bootstrap-ready`;
  const pidFifo = `${dir}/bootstrap-pid`;
  const releaseFifo = `${dir}/bootstrap-release`;
  const exitMarker = `${dir}/bootstrap-exit`;
  await Deno.writeTextFile(server, BLOCKED_BOOTSTRAP_SERVER);
  await Deno.chmod(server, 0o755);
  const fifo = await new Deno.Command("mkfifo", {
    args: [readyFifo, pidFifo, releaseFifo],
  }).output();
  assertEquals(fifo.success, true);

  const bootstrapEnv = {
    FAKE_CODEX_BOOTSTRAP_READY: readyFifo,
    FAKE_CODEX_BOOTSTRAP_PID: pidFifo,
    FAKE_CODEX_BOOTSTRAP_RELEASE: releaseFifo,
    FAKE_CODEX_BOOTSTRAP_EXIT: exitMarker,
  };
  const readyObserver = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys; print(open(sys.argv[1]).read(), end='')",
      readyFifo,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const ready = new Response(readyObserver.stdout).text();
  const pidObserver = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys; print(open(sys.argv[1]).read(), end='')",
      pidFifo,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const childPid = new Response(pidObserver.stdout).text();
  const controller = new AbortController();
  const driver = new CodexAppServerDriver({
    id: "codex:managed-abort",
    driver: "codex-app-server",
    enabled: true,
    codexTransport: "managed",
    codexBin: server,
    env: bootstrapEnv,
  });
  const started = driver.start(controller.signal);
  const startOutcome = started.then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );
  let bootstrapPid: number | undefined;
  let releaseWriter: Deno.ChildProcess | undefined;
  const startReleaseWriter = () => {
    releaseWriter ??= new Deno.Command("python3", {
      args: [
        "-c",
        "import sys; open(sys.argv[1], 'w').write('release\\n')",
        releaseFifo,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
  };
  try {
    const bootstrap = await Promise.race([
      Promise.all([ready, childPid]).then(([value, pid]) => ({
        kind: "ready" as const,
        value,
        pid,
      })),
      startOutcome.then((outcome) => ({
        kind: "settled" as const,
        outcome,
      })),
    ]);
    if (bootstrap.kind === "settled") {
      throw new Error(
        `managed bootstrap settled before readiness: ${
          String(
            bootstrap.outcome.ok ? "completed" : bootstrap.outcome.error,
          )
        }`,
      );
    }
    bootstrapPid = Number(bootstrap.pid.trim());
    assertEquals(Number.isInteger(bootstrapPid), true);
    Deno.kill(bootstrapPid, "SIGSTOP");
    assertEquals(bootstrap.value, "ready\n");
    assertEquals((await readyObserver.status).success, true);
    assertEquals((await pidObserver.status).success, true);
    controller.abort();
    startReleaseWriter();
    Deno.kill(bootstrapPid, "SIGCONT");
    const outcome = await startOutcome;
    assertEquals(outcome.ok, false);
    if (outcome.ok) throw new Error("managed bootstrap completed after abort");
    assertEquals((outcome.error as Error).name, "AbortError");
    assertEquals(await Deno.readTextFile(exitMarker), "aborted\n");
  } finally {
    controller.abort();
    if (bootstrapPid !== undefined) {
      startReleaseWriter();
      try {
        Deno.kill(bootstrapPid, "SIGCONT");
      } catch {
        // The process has exited.
      }
    }
    await startOutcome;
    await driver.stop();
    try {
      readyObserver.kill("SIGTERM");
    } catch {
      // The process has exited.
    }
    await readyObserver.status.catch(() => undefined);
    try {
      pidObserver.kill("SIGTERM");
    } catch {
      // The process has exited.
    }
    await pidObserver.status.catch(() => undefined);
    if (releaseWriter) {
      try {
        releaseWriter.kill("SIGTERM");
      } catch {
        // The process has exited.
      }
      await releaseWriter.status.catch(() => undefined);
    }
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex sources keep child environments isolated", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/fake-codex`;
  const firstLog = `${dir}/first-env.json`;
  const secondLog = `${dir}/second-env.json`;
  const sourceToken = "AGENTS_CONNECTOR_SOURCE_TOKEN";
  const parentToken = Deno.env.get(sourceToken) ?? null;
  const parentCodexHome = Deno.env.get("CODEX_HOME") ?? null;
  await Deno.writeTextFile(server, FAKE_SERVER);
  await Deno.chmod(server, 0o755);

  const first = new CodexAppServerDriver({
    id: "codex:first",
    driver: "codex-app-server",
    enabled: true,
    command: [server],
    codexHome: `${dir}/first-home`,
    env: {
      FAKE_CODEX_ENV_LOG: firstLog,
      [sourceToken]: "first-source",
    },
  });
  const second = new CodexAppServerDriver({
    id: "codex:second",
    driver: "codex-app-server",
    enabled: true,
    command: [server],
    env: { FAKE_CODEX_ENV_LOG: secondLog },
  });
  try {
    await first.start();
    await first.stop();
    assertEquals(Deno.env.get(sourceToken) ?? null, parentToken);
    assertEquals(Deno.env.get("CODEX_HOME") ?? null, parentCodexHome);

    await second.start();
    assertEquals(JSON.parse(await Deno.readTextFile(firstLog)), {
      sourceToken: "first-source",
      codexHome: `${dir}/first-home`,
    });
    assertEquals(JSON.parse(await Deno.readTextFile(secondLog)), {
      sourceToken: parentToken,
      codexHome: parentCodexHome,
    });
  } finally {
    await first.stop();
    await second.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex driver enumerates persisted active and archived threads", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/fake-codex`;
  await Deno.writeTextFile(server, FAKE_SERVER);
  await Deno.chmod(server, 0o755);

  const driver = new CodexAppServerDriver({
    id: "codex:default",
    driver: "codex-app-server",
    enabled: true,
    command: [server],
  });
  await driver.start();
  try {
    const first = await driver.listSessions();
    assertEquals(first.sessions.map((session) => session.nativeSessionId), [
      "thread-1",
    ]);
    assertEquals(first.sessions[0].archived, false);
    assertEquals(first.sessions[0].active, true);
    assertEquals(first.nextCursor, "archived:");

    const archived = await driver.listSessions(first.nextCursor);
    assertEquals(archived.sessions.map((session) => session.nativeSessionId), [
      "archived-1",
    ]);
    assertEquals(archived.sessions[0].archived, true);
    assertEquals(archived.sessions[0].active, false);
    assertEquals(archived.nextCursor, undefined);

    const snapshot = await driver.readSession("thread-1");
    assertEquals(snapshot.complete, true);
    assertEquals(snapshot.summary.active, true);
    assertEquals(snapshot.events.length, 1);
    assertEquals(snapshot.normalizedMessages[0].textPreview, "hello");
    assertEquals(
      (await driver.renameSession("thread-1", "Renamed")).status,
      "succeeded",
    );
  } finally {
    await driver.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex driver declines colliding numeric approval requests without hanging", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/fake-codex`;
  const log = `${dir}/approval.log`;
  await Deno.writeTextFile(server, FAKE_SERVER);
  await Deno.chmod(server, 0o755);

  const driver = new CodexAppServerDriver({
    id: "codex:default",
    driver: "codex-app-server",
    enabled: true,
    command: [server],
    env: { FAKE_CODEX_LOG: log },
  });
  await driver.start();
  try {
    let cancellationReadyCalls = 0;
    let sessionActiveCalls = 0;
    assertEquals(
      (await driver.prompt("thread-1", { text: "run a command" }, {
        onCancellationReady: () => {
          cancellationReadyCalls++;
        },
        onSessionActive: () => {
          sessionActiveCalls++;
          return Promise.resolve();
        },
      })).status,
      "succeeded",
    );
    assertEquals(cancellationReadyCalls, 1);
    assertEquals(sessionActiveCalls, 1);
    const approval = JSON.parse(await Deno.readTextFile(log));
    assertEquals(approval.result, { decision: "decline" });
    assertEquals(typeof approval.id, "number");
  } finally {
    await driver.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
