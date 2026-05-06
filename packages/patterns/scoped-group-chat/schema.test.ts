import { assertEquals } from "@std/assert";

Deno.test("scoped group chat pattern schema generates scoped input cells", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "cf",
      "check",
      "packages/patterns/scoped-group-chat/main.tsx",
      "--pattern-json",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  assertEquals(output.code, 0);

  const stdout = new TextDecoder().decode(output.stdout);
  const jsonStart = stdout.indexOf("{");
  const pattern = JSON.parse(stdout.slice(jsonStart));
  const properties = pattern.argumentSchema.properties;

  assertEquals(properties.name.asCell, [{ kind: "cell", scope: "user" }]);
  assertEquals(properties.selectedRoom.asCell, [
    { kind: "cell", scope: "session" },
  ]);
  assertEquals(properties.conversation.asCell, [
    { kind: "cell", scope: "space" },
  ]);
  assertEquals(properties.draft.asCell, [{ kind: "cell", scope: "user" }]);
});
