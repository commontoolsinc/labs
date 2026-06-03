import { assertEquals } from "@std/assert";
import { validateBrowserHostCommand } from "../src/tools/browser-host-command-policy.ts";

const LEASE_CDP = "http://host.docker.internal:9362";

const assertAllowed = (
  command: string,
  browserAccessCdpUrl: string | undefined = LEASE_CDP,
) => {
  assertEquals(
    validateBrowserHostCommand(command, { browserAccessCdpUrl }).allowed,
    true,
  );
};

const assertDenied = (
  command: string,
  browserAccessCdpUrl: string | undefined = LEASE_CDP,
) => {
  assertEquals(
    validateBrowserHostCommand(command, { browserAccessCdpUrl }).allowed,
    false,
  );
};

Deno.test("validateBrowserHostCommand allows agent-browser invocations", () => {
  assertAllowed("agent-browser --help", undefined);
  assertAllowed("agent-browser help", undefined);
  assertAllowed(
    'agent-browser --cdp http://host.docker.internal:9362 open "https://example.com/?a=1&b=2"',
  );
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 wait 5000",
  );
  assertAllowed(
    "agent-browser --cdp=http://host.docker.internal:9362 snapshot -i",
  );
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 get title",
  );
  assertAllowed("agent-browser --cdp http://host.docker.internal:9362 get url");
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 get text body",
  );
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 click @e1",
  );
  assertAllowed(
    'agent-browser --cdp http://host.docker.internal:9362 type @e2 "Ada"',
  );
  assertAllowed(
    'agent-browser --cdp http://host.docker.internal:9362 fill @e2 "Ada"',
  );
  assertAllowed(
    'agent-browser --cdp http://host.docker.internal:9362 select @e3 "CA"',
  );
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 check @e4",
  );
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 press Enter",
  );
});

Deno.test("validateBrowserHostCommand allows agent-browser discovery", () => {
  assertEquals(validateBrowserHostCommand("which agent-browser"), {
    allowed: true,
    plan: {
      argv: ["which", "agent-browser"],
      workspacePathArgs: [],
    },
  });
  assertEquals(validateBrowserHostCommand("command -v agent-browser"), {
    allowed: true,
    plan: {
      argv: ["which", "agent-browser"],
      workspacePathArgs: [],
    },
  });
});

Deno.test("validateBrowserHostCommand allows minimal workspace read commands", () => {
  assertAllowed("pwd");
  assertAllowed("ls -lah .");
  assertAllowed("ls src/tools");
  assertAllowed('find . -maxdepth 2 -type f -name "*.ts" -print');
  assertAllowed("find src -maxdepth 3 -type d -print");
});

Deno.test("validateBrowserHostCommand rejects arbitrary shell commands", () => {
  assertDenied("git status");
  assertDenied("cat /etc/passwd");
  assertDenied("env");
  assertDenied("python -c 'print(1)'");
});

Deno.test("validateBrowserHostCommand rejects shell operators and substitutions", () => {
  assertDenied("agent-browser open example.com && agent-browser snapshot");
  assertDenied("agent-browser open $(cat url.txt)");
  assertDenied('agent-browser open "$SECRET_URL"');
  assertDenied("agent-browser open `cat url.txt`");
  assertDenied("agent-browser snapshot > page.txt");
  assertDenied("agent-browser snapshot\nls");
});

Deno.test("validateBrowserHostCommand rejects unquoted shell expansion syntax", () => {
  assertDenied("ls {.,..}");
  assertDenied("ls [.][.]");
  assertDenied("find {.,..} -maxdepth 1 -type d -print");
  assertDenied("find . -maxdepth 2 -type f -name *.ts -print");
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9362 open https://example.com/?a=1",
  );
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9362 click button[aria-label=Close]",
  );
});

Deno.test("validateBrowserHostCommand keeps ls and find within the workspace", () => {
  assertDenied("ls /tmp");
  assertDenied("ls ../secrets");
  assertDenied("ls ~/Desktop");
  assertDenied("find /tmp -maxdepth 1 -type f -print");
  assertDenied("find .. -maxdepth 1 -type f -print");
  assertDenied("find . -type f -print");
  assertDenied("find . -maxdepth 6 -type f -print");
  assertDenied("find . -maxdepth 2 -delete");
  assertDenied("find . -maxdepth 2 -exec cat {} ;");
  assertDenied("ls -R .");
});

Deno.test("validateBrowserHostCommand rejects host-mutating agent-browser setup", () => {
  assertDenied("agent-browser install");
});

Deno.test("validateBrowserHostCommand rejects high-risk agent-browser host surfaces", () => {
  assertDenied("agent-browser eval 'location.href'");
  assertDenied("agent-browser upload '#file' ./secret.txt");
  assertDenied("agent-browser screenshot page.png");
  assertDenied("agent-browser state save ./browser-state.json");
  assertDenied("agent-browser --session demo state load ./browser-state.json");
  assertDenied("agent-browser open file:///etc/passwd");
  assertDenied("agent-browser --cdp 9222 snapshot");
  assertDenied("agent-browser --extension ./extension snapshot");
  assertDenied("agent-browser -p ios snapshot");
  assertDenied("agent-browser -p=ios snapshot");
  assertDenied("agent-browser -pbrowserbase snapshot");
  assertDenied("agent-browser --cdp http://host.docker.internal:9362 cookies");
  assertDenied("agent-browser --cdp http://host.docker.internal:9362 network");
  assertDenied("agent-browser --cdp http://host.docker.internal:9362 har");
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9362 wait --download",
  );
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9362 find role button click Submit",
  );
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9362 click main",
  );
});

Deno.test("validateBrowserHostCommand requires local CDP for page commands", () => {
  assertDenied('agent-browser open "https://example.com"');
  assertDenied("agent-browser snapshot -i");
  assertDenied('agent-browser find role button click "Submit"');
  assertDenied("agent-browser click '@e1'");
  assertDenied("agent-browser get title");
  assertDenied("agent-browser --cdp 9222 snapshot");
  assertDenied("agent-browser --cdp snapshot");
  assertDenied(
    "agent-browser --cdp https://host.docker.internal:9362 snapshot",
  );
  assertDenied("agent-browser --cdp http://example.com:9362 snapshot");
  assertDenied("agent-browser --cdp http://host.docker.internal snapshot");
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9362/json snapshot",
  );
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9362 --cdp http://localhost:9362 snapshot",
  );
});

Deno.test("validateBrowserHostCommand binds page commands to Browser Access lease", () => {
  assertEquals(
    validateBrowserHostCommand(
      "agent-browser --cdp http://host.docker.internal:9362 snapshot -i",
      {
        browserAccessCdpUrl: "http://host.docker.internal:9362",
        browserAccessExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    ).allowed,
    true,
  );
  assertDenied(
    "agent-browser --cdp http://host.docker.internal:9444 snapshot -i",
    "http://host.docker.internal:9362",
  );
  assertEquals(
    validateBrowserHostCommand(
      "agent-browser --cdp http://host.docker.internal:9362 snapshot -i",
    ).allowed,
    false,
  );
});

Deno.test("validateBrowserHostCommand rejects expired Browser Access leases", () => {
  assertEquals(
    validateBrowserHostCommand(
      "agent-browser --cdp http://host.docker.internal:9362 snapshot -i",
      {
        browserAccessCdpUrl: "http://host.docker.internal:9362",
        browserAccessExpiresAt: "2000-01-01T00:00:00.000Z",
      },
    ),
    {
      allowed: false,
      reason: "Browser Access lease has expired",
    },
  );
  assertEquals(
    validateBrowserHostCommand(
      "agent-browser --cdp http://host.docker.internal:9362 snapshot -i",
      {
        browserAccessCdpUrl: "http://host.docker.internal:9362",
        browserAccessExpiresAt: "not-a-timestamp",
      },
    ),
    {
      allowed: false,
      reason: "Browser Access lease expiry is invalid",
    },
  );
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 snapshot -i",
    "http://host.docker.internal:9362",
  );
  assertEquals(
    validateBrowserHostCommand("agent-browser --help", {
      browserAccessExpiresAt: "2000-01-01T00:00:00.000Z",
    }).allowed,
    false,
  );
});
