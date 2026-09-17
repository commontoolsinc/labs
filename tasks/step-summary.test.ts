import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  appendSummary,
  cutToRoom,
  fit,
  say,
  SUMMARY_LIMIT,
} from "./step-summary.ts";

const ENCODER = new TextEncoder();

/** How many bytes a piece of text takes in the summary file. */
function bytes(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * Runs `body` with the job summary pointed at a file of its own, and
 * returns what the file holds afterwards.
 */
async function withSummary(body: () => void): Promise<string> {
  const at = await Deno.makeTempFile({ prefix: "step-summary-" });
  const before = Deno.env.get("GITHUB_STEP_SUMMARY");
  Deno.env.set("GITHUB_STEP_SUMMARY", at);
  try {
    body();
    return await Deno.readTextFile(at);
  } finally {
    if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
    else Deno.env.set("GITHUB_STEP_SUMMARY", before);
    await Deno.remove(at);
  }
}

/** A text of `count` numbered lines, each `width` characters wide. */
function lines(count: number, width = 40): string {
  const rows: string[] = [];
  for (let at = 0; at < count; at++) {
    rows.push(`${at}`.padEnd(width, "-"));
  }
  return `${rows.join("\n")}\n`;
}

describe("step-summary", () => {
  describe("fit()", () => {
    it("returns the text unchanged where it fits", () => {
      const text = lines(4);
      expect(fit(text, SUMMARY_LIMIT)).toBe(text);
    });

    it("returns the text unchanged where it is exactly the room given", () => {
      const text = lines(4);
      expect(fit(text, bytes(text))).toBe(text);
    });

    it("returns less than the whole text one byte short of room", () => {
      const text = lines(4);
      expect(fit(text, bytes(text) - 1)).not.toBe(text);
    });

    it("returns at most the room it was given", () => {
      const text = lines(1000);
      for (const room of [0, 1, 46, 200, 1000, bytes(text) - 1]) {
        expect(bytes(fit(text, room))).toBeLessThanOrEqual(room);
      }
    });

    it("returns whole lines, never half of one", () => {
      const text = lines(1000);
      const kept = fit(text, 500).split("\n").slice(0, -2);
      expect(kept.length).toBeGreaterThan(0);
      for (const line of kept) expect(text).toContain(`${line}\n`);
    });

    it("keeps a character whose bytes straddle the bound whole", () => {
      // Each line is one three-byte character, so a cut counted in bytes
      // rather than in lines would land inside one of them.
      const text = `${Array(100).fill("☃").join("\n")}\n`;
      expect(fit(text, 50)).not.toContain("�");
    });

    it("says that it cut, where it cut", () => {
      expect(fit(lines(1000), 500)).toContain("the rest of this is in");
    });

    it("says nothing about cutting where it did not cut", () => {
      expect(fit(lines(4), SUMMARY_LIMIT)).not.toContain("the rest of this");
    });

    it("returns nothing where not even the line saying so fits", () => {
      expect(fit(lines(1000), 5)).toBe("");
    });

    it("returns nothing where the room holds no whole line", () => {
      // What a summary already at the bound has room for. Saying it was
      // cut, over and over and with nothing between, says nothing.
      const text = lines(1000);
      const marker = fit(text, 500).split("\n").at(-2)!;
      expect(fit(text, bytes(`${marker}\n`) + 10)).toBe("");
    });
  });

  describe("appendSummary()", () => {
    it("appends to the file the environment names", async () => {
      const held = await withSummary(() => {
        appendSummary("first\n");
        appendSummary("second\n");
      });
      expect(held).toBe("first\nsecond\n");
    });

    it("leaves the file inside the bound where the text is past it", async () => {
      const held = await withSummary(() => {
        appendSummary(lines(SUMMARY_LIMIT / 10));
      });
      expect(bytes(held)).toBeLessThanOrEqual(SUMMARY_LIMIT);
      expect(held).toContain("the rest of this is in");
    });

    it("counts what the file already holds, not one write alone", async () => {
      const half = lines(SUMMARY_LIMIT / 80);
      expect(bytes(half)).toBeLessThan(SUMMARY_LIMIT);
      const held = await withSummary(() => {
        for (let at = 0; at < 3; at++) appendSummary(half);
      });
      expect(bytes(held)).toBeLessThanOrEqual(SUMMARY_LIMIT);
    });

    it("creates the file where the write is what first makes it", async () => {
      const directory = await Deno.makeTempDir({ prefix: "step-summary-" });
      const at = `${directory}/summary.md`;
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", at);
      try {
        appendSummary("first\n");
        expect(await Deno.readTextFile(at)).toBe("first\n");
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("throws where the path names something it cannot measure", async () => {
      // Anything but a file that is not there yet is a summary this
      // cannot keep inside the bound, and a job summary quietly not
      // written is what the bound exists to prevent.
      const file = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", `${file}/below`);
      try {
        expect(() => appendSummary("nowhere\n")).toThrow();
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(file);
      }
    });

    it("writes nothing where no summary file is named", async () => {
      // A run outside a GitHub job, which is every local run, and a
      // runner that named the variable and left it empty. The file the
      // variable named a moment ago stays as it was, so a writer that
      // held on to a path rather than reading the variable is caught.
      const at = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      try {
        Deno.env.set("GITHUB_STEP_SUMMARY", at);
        Deno.env.delete("GITHUB_STEP_SUMMARY");
        appendSummary("nowhere\n");
        Deno.env.set("GITHUB_STEP_SUMMARY", "");
        appendSummary("nowhere\n");
        expect(await Deno.readTextFile(at)).toBe("");
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(at);
      }
    });
  });

  describe("cutToRoom()", () => {
    it("returns what fits, and a status of zero", () => {
      expect(cutToRoom(["--room", "500"], lines(1000))).toEqual({
        out: fit(lines(1000), 500),
        code: 0,
      });
    });

    it("returns the whole text where the room holds it", () => {
      const text = lines(4);
      expect(cutToRoom(["--room", "999999"], text).out).toBe(text);
    });

    it("returns a usage line and a status of two for bad arguments", () => {
      for (const args of [[], ["--room"], ["--room", "x"], ["--room", "-1"]]) {
        const { out, code } = cutToRoom(args, lines(4));
        expect(code).toBe(2);
        expect(out).toContain("usage: step-summary.ts");
      }
    });

    it("reads its text from standard input and writes what fits", async () => {
      const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "tasks/step-summary.ts", "--room", "200"],
        cwd: new URL("..", import.meta.url).pathname,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = command.stdin.getWriter();
      await writer.write(ENCODER.encode(lines(1000)));
      await writer.close();
      const { code, stdout } = await command.output();
      expect(code).toBe(0);
      const out = new TextDecoder().decode(stdout);
      expect(out).toBe(fit(lines(1000), 200));
      expect(bytes(out)).toBeLessThanOrEqual(200);
    });
  });

  describe("say()", () => {
    it("writes the lines to the summary as well as to the output", async () => {
      const said: string[] = [];
      const log = console.log;
      console.log = (...parts: unknown[]) => said.push(parts.join(" "));
      let held: string;
      try {
        held = await withSummary(() => say(["one", "two"]));
      } finally {
        console.log = log;
      }
      expect(held).toBe("one\ntwo\n");
      expect(said).toEqual(["one\ntwo\n"]);
    });
  });
});
