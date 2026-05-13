import { assertEquals } from "@std/assert";
import { validateBrowserHostCommand } from "../src/tools/browser-host-command-policy.ts";

const assertAllowed = (command: string) => {
  assertEquals(validateBrowserHostCommand(command).allowed, true);
};

const assertDenied = (command: string) => {
  assertEquals(validateBrowserHostCommand(command).allowed, false);
};

Deno.test("validateBrowserHostCommand allows agent-browser invocations", () => {
  assertAllowed("agent-browser --help");
  assertAllowed("agent-browser help");
  assertAllowed(
    'agent-browser --cdp http://host.docker.internal:9362 open "https://example.com/?a=1&b=2"',
  );
  assertAllowed(
    'agent-browser --cdp http://127.0.0.1:9362 find role button click "Submit"',
  );
  assertAllowed(
    `agent-browser --cdp=http://localhost:9362 click 'button[aria-label="Close"]'`,
  );
  assertAllowed(
    "agent-browser --cdp http://host.docker.internal:9362 wait 5000",
  );
  assertAllowed(
    "agent-browser --cdp=http://host.docker.internal:9362 snapshot -i",
  );
  assertAllowed("agent-browser --cdp http://127.0.0.1:9362 get title");
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
