import { assertEquals } from "@std/assert";
import { validateBrowserHostCommand } from "../src/tools/browser-host-command-policy.ts";

const assertAllowed = (command: string) => {
  assertEquals(validateBrowserHostCommand(command), { allowed: true });
};

const assertDenied = (command: string) => {
  assertEquals(validateBrowserHostCommand(command).allowed, false);
};

Deno.test("validateBrowserHostCommand allows agent-browser invocations", () => {
  assertAllowed("agent-browser --help");
  assertAllowed('agent-browser open "https://example.com/?a=1&b=2"');
  assertAllowed('agent-browser find role button click "Submit"');
});

Deno.test("validateBrowserHostCommand allows agent-browser discovery", () => {
  assertAllowed("which agent-browser");
  assertAllowed("command -v agent-browser");
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
