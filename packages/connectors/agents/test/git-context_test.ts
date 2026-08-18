import { assertEquals } from "@std/assert";
import {
  type GitCommandRunner,
  GitContextResolver,
} from "../src/git-context.ts";
import type { NativeSessionSnapshot } from "../src/types.ts";

function result(stdout: string, code = 0) {
  return { code, stdout };
}

Deno.test("git context refreshes the repo and branch for every observation", async () => {
  const calls: string[][] = [];
  let observation = 0;
  const runner: GitCommandRunner = (args) => {
    calls.push(args);
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      observation++;
      return Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(
        result(observation === 1 ? "feature/sessions\n" : "main\n"),
      );
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(
        result(
          observation === 1
            ? "git@github.com:common/project.git\n"
            : "git@github.com:common/renamed-project.git\n",
        ),
      );
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner);

  const first = await resolver.resolve("/repo/worktree");
  const second = await resolver.resolve("/repo/worktree");

  assertEquals(first, {
    gitRepo: "git@github.com:common/project.git",
    gitBranch: "feature/sessions",
    gitWorktreeRoot: "/repo",
  });
  assertEquals(second, {
    gitRepo: "git@github.com:common/renamed-project.git",
    gitBranch: "main",
    gitWorktreeRoot: "/repo",
  });
  assertEquals(calls.length, 6);
});

Deno.test("git context deduplicates directories and roots within one observation", async () => {
  const calls: string[] = [];
  const runner: GitCommandRunner = (args) => {
    const command = args.slice(2).join(" ");
    calls.push(`${args[1]}:${command}`);
    if (command === "rev-parse --show-toplevel") {
      return Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(result("main\n"));
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(result("git@github.com:common/project.git\n"));
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner);
  const observation = resolver.beginObservation();

  const contexts = await Promise.all([
    observation.resolve("/repo/first"),
    observation.resolve("/repo/first"),
    observation.resolve("/repo/second"),
  ]);

  assertEquals(contexts[0], contexts[1]);
  assertEquals(contexts[1], contexts[2]);
  assertEquals(
    calls.filter((call) => call.endsWith("rev-parse --show-toplevel")).length,
    2,
  );
  assertEquals(
    calls.filter((call) => call.endsWith("branch --show-current")).length,
    1,
  );
  assertEquals(
    calls.filter((call) => call.endsWith("remote get-url upstream")).length,
    1,
  );

  await resolver.beginObservation().resolve("/repo/first");
  assertEquals(
    calls.filter((call) => call.endsWith("rev-parse --show-toplevel")).length,
    3,
  );
  assertEquals(
    calls.filter((call) => call.endsWith("branch --show-current")).length,
    2,
  );
});

Deno.test("git context falls back to origin and enriches a session snapshot", async () => {
  const runner: GitCommandRunner = (args) => {
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      return Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(result("main\n"));
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(result("", 2));
    }
    if (command === "remote get-url origin") {
      return Promise.resolve(result("https://github.com/common/project.git\n"));
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner);
  const snapshot: NativeSessionSnapshot = {
    summary: {
      nativeSessionId: "session-1",
      title: "Test",
      cwd: "/repo/subdir",
      gitRepo: null,
      gitBranch: null,
      gitWorktreeRoot: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      active: null,
      raw: {},
    },
    events: [],
    normalizedMessages: [],
    complete: true,
  };

  const enriched = await resolver.enrich(snapshot);

  assertEquals(
    enriched.summary.gitRepo,
    "https://github.com/common/project.git",
  );
  assertEquals(enriched.summary.gitBranch, "main");
  assertEquals(enriched.summary.gitWorktreeRoot, "/repo");
});

Deno.test("git context returns null fields outside a repository", async () => {
  const resolver = new GitContextResolver(() =>
    Promise.resolve(result("", 128))
  );

  assertEquals(await resolver.resolve("/tmp/not-a-repo"), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
  });
  assertEquals(await resolver.resolve(null), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
  });
});

Deno.test("git context observes a repository created after an earlier lookup", async () => {
  let lookup = 0;
  const runner: GitCommandRunner = (args) => {
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      lookup++;
      return lookup === 1
        ? Promise.resolve(result("", 128))
        : Promise.resolve(result("/repo\n"));
    }
    if (command === "branch --show-current") {
      return Promise.resolve(result("main\n"));
    }
    if (command === "remote get-url upstream") {
      return Promise.resolve(result("git@github.com:common/project.git\n"));
    }
    return Promise.resolve(result("", 1));
  };
  const resolver = new GitContextResolver(runner);

  assertEquals(await resolver.resolve("/repo"), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
  });
  assertEquals(await resolver.resolve("/repo"), {
    gitRepo: "git@github.com:common/project.git",
    gitBranch: "main",
    gitWorktreeRoot: "/repo",
  });
});

Deno.test("git context degrades when spawning git fails", async () => {
  const resolver = new GitContextResolver(() =>
    Promise.reject(new Deno.errors.NotFound("git"))
  );

  assertEquals(await resolver.resolve("/repo"), {
    gitRepo: null,
    gitBranch: null,
    gitWorktreeRoot: null,
  });
});
