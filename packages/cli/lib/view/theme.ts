/**
 * Colour theme for the `cf view` pager. A dark-background palette (One Dark
 * lineage) mapping each {@link TokenClass} to an ANSI {@link Style}, plus the
 * chrome styles (status bar, selection, search, overlay) and the rainbow
 * bracket cycle used to make nesting depth legible.
 */
import { hex, type Rgb, type Style } from "./ansi.ts";
import type { Line, TokenClass } from "./model.ts";

const C = {
  fg: hex("#abb2bf"),
  fgDim: hex("#5c6370"),
  red: hex("#e06c75"),
  green: hex("#98c379"),
  yellow: hex("#e5c07b"),
  blue: hex("#61afef"),
  purple: hex("#c678dd"),
  cyan: hex("#56b6c2"),
  orange: hex("#d19a66"),
  comment: hex("#6b727f"),
  selectionBg: hex("#2c323c"),
  schemaBg: hex("#23282f"),
  closureBg: hex("#262a30"),
  statusBg: hex("#3e4451"),
  overlayBg: hex("#21252b"),
  dark: hex("#1b1f24"),
  black: hex("#282c34"),
} as const;

const TOKEN_STYLES: Record<TokenClass, Style> = {
  plain: { fg: C.fg },
  whitespace: {},
  keyword: { fg: C.purple },
  controlKeyword: { fg: C.purple, italic: true },
  storageKeyword: { fg: C.purple },
  operator: { fg: C.cyan },
  punctuation: { fg: C.fg, dim: true },
  bracket: { fg: C.fg }, // overridden per-depth by bracketStyle()
  string: { fg: C.green },
  template: { fg: C.green },
  number: { fg: C.orange },
  boolean: { fg: C.orange },
  regex: { fg: C.green },
  comment: { fg: C.comment, italic: true },
  docComment: { fg: C.comment, italic: true },
  sectionHeader: { fg: C.yellow, bold: true, underline: true },
  typeName: { fg: C.yellow },
  typeKeyword: { fg: C.yellow },
  interfaceName: { fg: C.yellow, bold: true },
  functionName: { fg: C.blue, bold: true },
  callName: { fg: C.blue },
  builderCall: { fg: C.red, bold: true },
  cfHelper: { fg: C.cyan, italic: true },
  schemaKey: { fg: C.orange },
  propertyName: { fg: C.red },
  parameter: { fg: C.orange, italic: true },
  binding: { fg: C.fg },
  identifier: { fg: C.fg },
  diffAdd: { fg: C.green, bold: true },
  diffDel: { fg: C.red, bold: true },
  diffHunk: { fg: C.cyan, bold: true },
  diffMeta: { fg: C.comment },
};

/** Full-row background tints for diff lines (syntax colours stay on top). */
const LINE_BGS: Record<NonNullable<Line["bg"]>, Rgb> = {
  add: hex("#22312a"),
  del: hex("#392b2d"),
};

export function lineBg(bg: NonNullable<Line["bg"]>): Rgb {
  return LINE_BGS[bg];
}

/** Rainbow cycle for bracket pairs, indexed by nesting depth. */
const BRACKET_COLORS: readonly Rgb[] = [
  C.yellow,
  C.purple,
  C.cyan,
  C.green,
  C.blue,
  C.orange,
];

export function styleFor(cls: TokenClass): Style {
  return TOKEN_STYLES[cls];
}

export function bracketStyle(depth: number): Style {
  const color = BRACKET_COLORS[
    ((depth % BRACKET_COLORS.length) + BRACKET_COLORS.length) %
    BRACKET_COLORS.length
  ];
  return { fg: color, bold: true };
}

/** Chrome styles for interactive UI elements. */
export const ui = {
  /** Faint background tint marking a JSON-schema object-literal region. */
  schemaRegionBg: C.schemaBg,
  /** Faint background tint marking a closure (arrow/function-expression) body. */
  closureRegionBg: C.closureBg,
  /** Background of the line range belonging to the selected structure node. */
  selectionBg: C.selectionBg,
  /** The vertical guide bar drawn beside a selected node. */
  guide: { fg: C.blue, bold: true } as Style,
  statusBar: { fg: C.fg, bg: C.statusBg } as Style,
  statusKey: { fg: C.yellow, bg: C.statusBg, bold: true } as Style,
  statusDim: { fg: C.comment, bg: C.statusBg } as Style,
  /** The notice region above the status bar (e.g. the files a save would
   * write), tinted to read as a callout rather than ordinary content. */
  noticeBar: { fg: C.yellow, bg: C.statusBg } as Style,
  lineNumber: { fg: C.fgDim } as Style,
  lineNumberCurrent: { fg: C.yellow } as Style,
  searchMatch: { fg: C.black, bg: C.yellow } as Style,
  searchCurrent: { fg: C.black, bg: C.orange, bold: true } as Style,
  overlayBg: C.overlayBg,
  overlayBorder: { fg: C.blue, bold: true } as Style,
  overlayTitle: { fg: C.yellow, bold: true } as Style,
  scrollbarTrack: { fg: C.fgDim } as Style,
  scrollbarThumb: { fg: C.blue } as Style,
};
