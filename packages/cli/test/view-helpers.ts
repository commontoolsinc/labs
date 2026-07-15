/**
 * Shared fixtures and helpers for the `cf view` test suites. Not a test file
 * itself (the test task globs `*.test.ts`), just an import.
 */
import { parseDocument } from "../lib/view/parse.ts";
import type { ViewState } from "../lib/view/render.ts";
import type { Rgb } from "../lib/view/ansi.ts";

export { parseDocument };

/** The `48;2;r;g;b` background run for a colour, as it appears in an SGR escape;
 * lets a test assert on a theme colour without hard-coding its hex. */
export function bgCode(rgb: Rgb): string {
  return `48;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

/** The `38;2;r;g;b` foreground run for a colour. */
export function fgCode(rgb: Rgb): string {
  return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

/** The visible text of a modal prompt dialog — its title, body lines and button
 * labels joined — so a test can assert on the prompt with a single `includes`.
 * Empty string when no dialog is up. */
export function promptText(v: ViewState): string {
  const d = v.dialog;
  if (!d) return "";
  return [d.title, ...d.body, ...d.buttons.map((b) => b.label)].join(" ");
}

/**
 * A small but representative transformed blob: two sections, synthetic helpers,
 * a hoisted lift with JSON schemas + a closure, a pattern, a template literal,
 * a type alias and an interface.
 */
export const SAMPLE = `// transformed: /index.ts
const define = undefined;

// transformed: /app.ts
import { __cfHelpers } from "commonfabric";
import { pattern, lift } from "commonfabric";
const __cfLift_1 = __cfHelpers.lift<{
    token: string;
}, string>({
    type: "object",
    properties: {
        token: {
            type: "string"
        }
    },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ token }) => {
    return \`url:\${token}\`;
});
export const myPattern = pattern((input) => {
    const t = input.key("token");
    return { url: __cfLift_1({ token: t }) };
}, {
    type: "object"
} as const satisfies __cfHelpers.JSONSchema);
type Foo = {
    a: number;
    b: string;
};
interface Bar {
    x: number;
}
`;

/** Encode a string to bytes for the key decoder. */
export function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Raw byte array helper. */
export function raw(...nums: number[]): Uint8Array {
  return new Uint8Array(nums);
}
