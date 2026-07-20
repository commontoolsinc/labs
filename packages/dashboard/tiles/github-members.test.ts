// github users: GitHub and the history file are replaced with in-memory
// stand-ins. The tests cover pagination, both organization rosters, retained
// history, and the gray states for unavailable data.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { REPO } from "../config.ts";
import type { Ctx } from "../types.ts";
import { createGithubMembers, organizationUserIds } from "./github-members.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 1);
const ORG = REPO.split("/")[0];

let clock = T0;

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (key) => env[key],
  };
}

const users = (...ids: number[]) => ids.map((id) => ({ id }));

interface Call {
  url: string;
  authorization: string | null;
}

interface Wire {
  calls: Call[];
  reads: string[];
  writes: { path: string; data: string }[];
  renames: { from: string; to: string }[];
  logged: string[];
}

interface Options {
  reply(url: URL): unknown | Response | Error;
  read?: () => Promise<string>;
  write?: () => Promise<void>;
}

async function withWire(
  options: Options,
  body: (wire: Wire) => Promise<void>,
): Promise<void> {
  const real = {
    fetch: globalThis.fetch,
    readTextFile: Deno.readTextFile,
    writeTextFile: Deno.writeTextFile,
    rename: Deno.rename,
    now: Date.now,
    error: console.error,
  };
  const wire: Wire = {
    calls: [],
    reads: [],
    writes: [],
    renames: [],
    logged: [],
  };

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    wire.calls.push({
      url: url.href,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const reply = options.reply(url);
    if (reply instanceof Error) return Promise.reject(reply);
    if (reply instanceof Response) return Promise.resolve(reply);
    return Promise.resolve(Response.json(reply));
  }) as typeof fetch;
  Deno.readTextFile = ((path: string | URL) => {
    wire.reads.push(String(path));
    return options.read
      ? options.read()
      : Promise.reject(new Deno.errors.NotFound("no history file"));
  }) as typeof Deno.readTextFile;
  Deno.writeTextFile = ((path: string | URL, data: string | Uint8Array) => {
    wire.writes.push({ path: String(path), data: String(data) });
    return options.write ? options.write() : Promise.resolve();
  }) as typeof Deno.writeTextFile;
  Deno.rename = ((from: string | URL, to: string | URL) => {
    wire.renames.push({ from: String(from), to: String(to) });
    return Promise.resolve();
  }) as typeof Deno.rename;
  Date.now = () => clock;
  console.error = (...args: unknown[]) => {
    wire.logged.push(args.map(String).join(" "));
  };

  try {
    await body(wire);
  } finally {
    globalThis.fetch = real.fetch;
    Deno.readTextFile = real.readTextFile;
    Deno.writeTextFile = real.writeTextFile;
    Deno.rename = real.rename;
    Date.now = real.now;
    console.error = real.error;
  }
}

Deno.test("github users: organization rosters read every page and deduplicate ids", async () => {
  await withWire({
    reply: (url) => {
      const page = url.searchParams.get("page");
      if (page === "1") {
        return Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
      }
      if (page === "2") return users(100, 101);
      throw new Error(`unexpected request ${url}`);
    },
  }, async (wire) => {
    const ids = await organizationUserIds(ORG, "members", "secret");
    assertEquals(ids.size, 101);
    assert(ids.has(1));
    assert(ids.has(101));
    assertEquals(
      wire.calls.map((call) =>
        new URL(call.url).pathname + new URL(call.url).search
      ),
      [
        `/orgs/${ORG}/members?per_page=100&page=1`,
        `/orgs/${ORG}/members?per_page=100&page=2`,
      ],
    );
    assertEquals(wire.calls.map((call) => call.authorization), [
      "Bearer secret",
      "Bearer secret",
    ]);
  });
});

Deno.test("github users: transitional overlap counts once and draws retained history", async () => {
  clock = T0;
  const persisted = [
    { t: T0 - 90 * DAY, members: 8, collaborators: 2 },
    { t: T0 - 2 * DAY, members: 11, collaborators: 1 },
    { t: T0 - DAY, team: 2, employees: 10 },
    null,
    "bad point",
  ];
  await withWire({
    reply: (url) =>
      url.pathname.endsWith("/outside_collaborators")
        ? users(12, 13)
        : users(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
    read: () => Promise.resolve(JSON.stringify(persisted)),
  }, async (wire) => {
    const view = await createGithubMembers().collect(
      ctx({ GH_TOKEN: "token" }),
    );

    assertEquals(view.label, "github users");
    assertEquals(view.status, "good");
    assertEquals(view.value, "13");
    assertEquals(view.duration, 2 * DAY);
    assertEquals(view.href, `https://github.com/orgs/${ORG}/people`);
    assertEquals(view.hint, "people ↗");
    assertStringIncludes(view.extra ?? "", "<svg");
    assertStringIncludes(view.extra ?? "", "members ·");
    assertStringIncludes(view.extra ?? "", "collaborators");
    assertStringIncludes(view.extra ?? "", "background:#58a6ff");
    assertStringIncludes(view.extra ?? "", "background:#a371f7");

    assertEquals(wire.calls.length, 2);
    assertEquals(
      new Set(wire.calls.map((call) => new URL(call.url).pathname)),
      new Set([
        `/orgs/${ORG}/members`,
        `/orgs/${ORG}/outside_collaborators`,
      ]),
    );
    assertEquals(wire.reads, [
      Deno.env.get("GITHUB_MEMBERS_HISTORY_FILE") ??
        `${
          Deno.env.get("TMPDIR") ?? "/tmp"
        }/fabric-wall-github-members-${ORG.toLowerCase()}-history.json`,
    ]);
    assertEquals(JSON.parse(wire.writes[0].data), [
      { t: T0 - 2 * DAY, members: 11, collaborators: 1 },
      { t: T0, members: 12, collaborators: 2 },
    ]);
    assertEquals(wire.writes[0].path, `${wire.reads[0]}.tmp`);
    assertEquals(wire.renames, [{
      from: `${wire.reads[0]}.tmp`,
      to: wire.reads[0],
    }]);
  });
});

Deno.test("github users: a new history window shows both counts without a chart", async () => {
  clock = T0 + 90 * DAY;
  await withWire({
    reply: (url) =>
      url.pathname.endsWith("/outside_collaborators")
        ? users(13)
        : users(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
  }, async (wire) => {
    const view = await createGithubMembers().collect(
      ctx({ GITHUB_TOKEN: "token" }),
    );

    assertEquals(view.status, "good");
    assertEquals(view.value, "13");
    assertEquals(view.duration, 0);
    assert(!(view.extra ?? "").includes("<svg"));
    assertStringIncludes(view.extra ?? "", "members 12 ·");
    assertStringIncludes(view.extra ?? "", "collaborators 1");
    assertEquals(wire.reads.length, 1);
    assertEquals(JSON.parse(wire.writes[0].data), [
      { t: clock, members: 12, collaborators: 1 },
    ]);
  });
});

Deno.test("github users: a history write failure does not hide the current count", async () => {
  clock = T0 + 90 * DAY + HOUR;
  await withWire({
    reply: (url) =>
      url.pathname.endsWith("/outside_collaborators") ? users(3) : users(1, 2),
    read: () =>
      Promise.resolve(JSON.stringify([{
        t: clock - HOUR,
        members: 1,
        collaborators: 1,
      }])),
    write: () => Promise.reject(new Error("disk is full")),
  }, async (wire) => {
    const view = await createGithubMembers().collect(
      ctx({ GH_TOKEN: "token" }),
    );

    assertEquals(view.status, "good");
    assertEquals(view.value, "3");
    assertEquals(view.duration, HOUR);
    assertEquals(wire.logged, [
      "github users: could not persist history: disk is full",
    ]);
    assertEquals(wire.renames, []);
  });
});

Deno.test("github users: unavailable or malformed organization data stays gray", async () => {
  const cases: {
    reply(url: URL): unknown | Response;
    sub: string;
    log: string;
  }[] = [
    {
      reply: (url) =>
        url.pathname.endsWith("/members")
          ? new Response("forbidden", { status: 403 })
          : [],
      sub: "auth failed",
      log:
        `github users: could not read organization users: GitHub API orgs/${ORG}/members?per_page=100&page=1 failed: HTTP 403`,
    },
    {
      reply: (url) =>
        url.pathname.endsWith("/outside_collaborators")
          ? new Response("rate limit exceeded", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          })
          : [],
      sub: "rate-limited",
      log:
        `github users: could not read organization users: GitHub API orgs/${ORG}/outside_collaborators?per_page=100&page=1 failed: HTTP 403 (rate-limited)`,
    },
    {
      reply: (url) =>
        url.pathname.endsWith("/outside_collaborators") ? { users: [] } : [],
      sub: "temporarily unavailable",
      log:
        `github users: could not read organization users: GitHub outside collaborators returned invalid user data`,
    },
  ];

  for (const testCase of cases) {
    await withWire({ reply: testCase.reply }, async (wire) => {
      const view = await createGithubMembers().collect(
        ctx({ GH_TOKEN: "token" }),
      );
      assertEquals(view.status, "unknown");
      assertEquals(view.value, "—");
      assertEquals(view.sub, testCase.sub);
      assertEquals(wire.writes, []);
      assertEquals(wire.logged, [testCase.log]);
    });
  }
});
