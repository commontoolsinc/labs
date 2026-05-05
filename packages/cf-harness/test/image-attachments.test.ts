import { assertEquals } from "@std/assert";
import { isRelativePathWithinWorkspace } from "../src/image-attachments.ts";

Deno.test("isRelativePathWithinWorkspace rejects escaped and absolute relative results", () => {
  const cases: Array<[string, boolean]> = [
    ["", true],
    ["capture.png", true],
    ["captures/example.png", true],
    ["..capture.png", true],
    ["..", false],
    ["../capture.png", false],
    ["..\\capture.png", false],
    ["/tmp/capture.png", false],
    ["C:\\captures\\example.png", false],
    ["D:/captures/example.png", false],
    ["\\\\server\\share\\capture.png", false],
  ];

  for (const [relativePath, expected] of cases) {
    assertEquals(isRelativePathWithinWorkspace(relativePath), expected);
  }
});
