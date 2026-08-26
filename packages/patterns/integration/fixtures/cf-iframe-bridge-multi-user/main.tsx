/// <cts-enable />
// Browser-integration fixture for cf-iframe's real CellHandle bridge. The
// surrounding pattern exposes scoped cells as sibling readouts while the
// sandboxed guest performs every mutation through the bridge.
import {
  action,
  cfSqlite,
  computed,
  type Default,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  sqliteDatabase,
  type SqliteDb,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";

export type TextCell = Writable<string | Default<"">>;
export type RevisionCell = Writable<number | Default<0>>;

export interface BridgeFixtureInput {
  shared?: PerSpace<TextCell>;
  user?: PerUser<TextCell>;
  session?: PerSession<TextCell>;
  command?: PerSession<TextCell>;
  status?: PerSession<TextCell>;
  databaseRows?: PerSession<TextCell>;
  userDatabaseRows?: PerSession<TextCell>;
  sessionDatabaseRows?: PerSession<TextCell>;
  reloadRevision?: PerSession<RevisionCell>;
}

interface IframeContextInput {
  shared: TextCell;
  user: TextCell;
  session: TextCell;
  command: TextCell;
  status: TextCell;
  databaseRows: TextCell;
  userDatabaseRows: TextCell;
  sessionDatabaseRows: TextCell;
  database: SqliteDb;
  userDatabase: SqliteDb;
  sessionDatabase: SqliteDb;
}

export interface IframeContextOutput extends IframeContextInput {}

export interface BridgeFixtureOutput {
  [UI]: VNode;
}

const IframeContext = pattern<IframeContextInput, IframeContextOutput>(
  (state) => state,
);

// This deliberately uses the bridge wire protocol directly. The guest helper
// and React hooks have their own focused tests; this fixture pins the browser
// product boundary without requiring a module server inside the opaque guest.
const GUEST_HTML = `<!doctype html>
<html>
<body>
<div id="guest-state">connecting</div>
<script>
(() => {
  const marker = ["fvr1"];
  const encode = (value) => [marker, value];
  const decode = (value) => value[1];
  let port;
  let nextRequestId = 0;
  let nextSubscriptionId = 0;
  let lastCommandId = "";
  const pending = new Map();
  const subscriptions = new Map();
  const queued = [];

  const send = (message) => {
    if (port) port.postMessage(encode(message));
    else queued.push(message);
  };

  const request = (operation, fields = {}) => {
    const id = nextRequestId++;
    const message = {
      protocol: "common-fabric-bridge",
      version: 1,
      type: "request",
      id,
      operation,
      ...fields,
    };
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send(message);
    return result;
  };

  const write = (resource, value) =>
    request("write", { resource, value });
  const call = (resource, method, value) =>
    request("call", { resource, method, value });
  const subscribe = async (resource, listener) => {
    const subscription = "guest-" + nextSubscriptionId++;
    subscriptions.set(subscription, listener);
    await request("subscribe", { resource, subscription });
  };

  const databaseRows = {
    database: "databaseRows",
    userDatabase: "userDatabaseRows",
    sessionDatabase: "sessionDatabaseRows",
  };

  const refreshRows = async (database) => {
    let result;
    try {
      result = await call(database, "query", {
        sql: "SELECT value FROM bridge_items ORDER BY id",
      });
    } catch (error) {
      throw new Error(database + ": " + error.message);
    }
    await write(
      databaseRows[database],
      result.rows.map((row) => row.value).join(","),
    );
  };

  const handleCommand = async (raw) => {
    if (!raw) return;
    const command = JSON.parse(raw);
    if (!command.id || command.id === lastCommandId) return;
    lastCommandId = command.id;
    try {
      await write("command", "");
      if (command.operation === "write") {
        await write(command.resource, command.value);
      } else if (command.operation === "sqlite-insert") {
        const database = command.database || "database";
        await call(database, "exec", {
          sql: "INSERT INTO bridge_items (value) VALUES (?)",
          params: [command.value],
        });
      } else if (command.operation === "sqlite-query") {
        await refreshRows(command.database || "database");
      } else if (command.operation === "clear-database-rows") {
        await Promise.all(
          Object.values(databaseRows).map((resource) => write(resource, "")),
        );
      } else {
        throw new Error("Unknown command: " + command.operation);
      }
      await write("status", "done:" + command.id);
    } catch (error) {
      await write("status", "error:" + command.id + ":" + error.message);
    }
  };

  const accept = (message) => {
    if (
      !message || message.protocol !== "common-fabric-bridge" ||
      message.version !== 1
    ) return;
    if (message.type === "event") {
      subscriptions.get(message.subscription)?.(message.value);
      return;
    }
    if (message.type !== "response") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error.message));
  };

  globalThis.addEventListener("message", async (event) => {
    if (
      port || event.data !== "common-iframe-sandbox:port" ||
      !event.ports[0] || event.source !== globalThis.parent.parent
    ) return;
    port = event.ports[0];
    port.onmessage = (portEvent) => accept(decode(portEvent.data));
    port.start();
    for (const message of queued.splice(0)) send(message);

    try {
      await subscribe("command", (value) => void handleCommand(value));
      for (const database of Object.keys(databaseRows)) {
        await subscribe(database, () => void refreshRows(database));
      }
      await Promise.all(Object.keys(databaseRows).map(refreshRows));
      await write("status", "ready");
      document.querySelector("#guest-state").textContent = "ready";
    } catch (error) {
      document.querySelector("#guest-state").textContent = error.message;
      globalThis.parent.postMessage({
        type: "error",
        data: {
          description: error.message,
          source: "cf-iframe multi-user fixture",
          lineno: 0,
          colno: 0,
          stacktrace: error.stack || String(error),
        },
      }, "*");
    }
  });
})();
</script>
</body>
</html>`;

export default pattern<BridgeFixtureInput, BridgeFixtureOutput>((state) => {
  const { table } = cfSqlite;
  const tables = {
    bridge_items: table({
      id: "integer primary key",
      value: "text",
    }),
  };
  const database = sqliteDatabase({ tables });
  const userDatabase: PerUser<SqliteDb> = sqliteDatabase({ tables });
  const sessionDatabase: PerSession<SqliteDb> = sqliteDatabase(
    { tables },
  );
  const context = IframeContext({
    shared: state.shared,
    user: state.user,
    session: state.session,
    command: state.command,
    status: state.status,
    databaseRows: state.databaseRows,
    userDatabaseRows: state.userDatabaseRows,
    sessionDatabaseRows: state.sessionDatabaseRows,
    database,
    userDatabase,
    sessionDatabase,
  });
  const source = computed(() =>
    GUEST_HTML + '<span hidden data-reload="' + state.reloadRevision.get() +
    '"></span>'
  );
  const reloadGuest = action(() => {
    state.status.set("reloading");
    state.reloadRevision.set(state.reloadRevision.get() + 1);
  });

  return {
    [UI]: (
      <div style={{ padding: "16px", display: "grid", gap: "8px" }}>
        <div id="bridge-shared">{context.shared}</div>
        <div id="bridge-user">{context.user}</div>
        <div id="bridge-session">{context.session}</div>
        <div id="bridge-database-rows">{context.databaseRows}</div>
        <div id="bridge-user-database-rows">{context.userDatabaseRows}</div>
        <div id="bridge-session-database-rows">
          {context.sessionDatabaseRows}
        </div>
        <div id="bridge-status">{context.status}</div>
        <cf-input id="bridge-command" $value={context.command} />
        <cf-button id="bridge-reload" onClick={reloadGuest}>
          Reload guest
        </cf-button>
        <div style={{ height: "120px" }}>
          <cf-iframe
            src={source}
            $context={context}
            resourceKinds={{
              database: "sqlite",
              userDatabase: "sqlite",
              sessionDatabase: "sqlite",
            }}
          />
        </div>
      </div>
    ),
  };
});
