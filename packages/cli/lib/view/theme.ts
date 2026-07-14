/**
 * Colour theme for the `cf view` pager: a modern dark scheme. Light-grey text on
 * a near-black editor surface, with a One-Dark-inspired accent palette — purple
 * keywords, green strings, amber types, blue functions, orange numbers, grey
 * comments — and a slightly lighter surface for the status bar and dialogs. Each
 * {@link TokenClass} maps to an ANSI {@link Style}; the chrome styles (status
 * bar, selection, search, overlay) and the rainbow bracket cycle round it out.
 * The general aesthetic (double-line dialog frames, drop shadows, green buttons)
 * is unchanged — only the colours differ.
 */
import { hex, type Rgb, type Style } from "./ansi.ts";
import type { Line, TokenClass } from "./model.ts";

const C = {
  // Surfaces, darkest to lightest.
  editorBg: hex("#14161b"), // the main content background
  schemaBg: hex("#191c24"), // a JSON-schema region, tinted
  closureBg: hex("#171a21"), // a closure body, tinted
  selectionBg: hex("#2b313d"), // the selected node's line range
  panel: hex("#24272f"), // status bar and dialog panels (elevated)
  panelHi: hex("#343a45"), // the highlighted line inside a card
  shadow: hex("#0a0b0e"), // the drop shadow, darker than any surface
  // Text.
  fg: hex("#abb2bf"), // default text
  fgBright: hex("#e6e6e6"), // titles, the current file, emphasis
  fgDim: hex("#5c6370"), // comments, punctuation, muted labels
  ink: hex("#1b1e24"), // dark text drawn on a bright accent (buttons, search)
  // Accents.
  red: hex("#e06c75"),
  green: hex("#98c379"),
  yellow: hex("#e5c07b"),
  orange: hex("#d19a66"),
  blue: hex("#61afef"),
  purple: hex("#c678dd"),
  cyan: hex("#56b6c2"),
  white: hex("#ffffff"),
  // Full-row diff tints.
  addBg: hex("#172a18"),
  delBg: hex("#331c22"),
  // The green button face.
  button: hex("#4b9e5f"),
} as const;

const TOKEN_STYLES: Record<TokenClass, Style> = {
  plain: { fg: C.fg },
  whitespace: {},
  keyword: { fg: C.purple, bold: true },
  controlKeyword: { fg: C.purple, bold: true },
  storageKeyword: { fg: C.purple, bold: true },
  operator: { fg: C.cyan },
  punctuation: { fg: C.fgDim },
  bracket: { fg: C.fg }, // overridden per-depth by bracketStyle()
  string: { fg: C.green },
  template: { fg: C.green },
  number: { fg: C.orange },
  boolean: { fg: C.orange },
  regex: { fg: C.cyan },
  comment: { fg: C.fgDim },
  docComment: { fg: C.fgDim },
  sectionHeader: { fg: C.fgBright, bold: true, underline: true },
  typeName: { fg: C.yellow },
  typeKeyword: { fg: C.yellow },
  interfaceName: { fg: C.yellow, bold: true },
  functionName: { fg: C.blue, bold: true },
  callName: { fg: C.blue },
  builderCall: { fg: C.purple, bold: true },
  cfHelper: { fg: C.cyan },
  schemaKey: { fg: C.red },
  propertyName: { fg: C.red },
  parameter: { fg: C.fg },
  binding: { fg: C.fg },
  identifier: { fg: C.fg },
  diffAdd: { fg: C.green, bold: true },
  diffDel: { fg: C.red, bold: true },
  diffHunk: { fg: C.cyan, bold: true },
  diffMeta: { fg: C.fgDim },
};

/** Full-row background tints for diff lines (syntax colours stay on top). */
const LINE_BGS: Record<NonNullable<Line["bg"]>, Rgb> = {
  add: C.addBg,
  del: C.delBg,
};

export function lineBg(bg: NonNullable<Line["bg"]>): Rgb {
  return LINE_BGS[bg];
}

/** Rainbow cycle for bracket pairs, indexed by nesting depth. */
const BRACKET_COLORS: readonly Rgb[] = [
  C.yellow,
  C.cyan,
  C.purple,
  C.green,
  C.blue,
  C.orange,
];

export function styleFor(cls: TokenClass): Style {
  return TOKEN_STYLES[cls];
}

/** Token colours for content shown inside a dialog. A dialog is a slightly
 * lighter panel than the editor, so the same light-on-dark accents read well;
 * only the key column (builderCall) differs, drawn red to match the status bar's
 * shortcut keys rather than the editor's builder-call purple. */
const DIALOG_TOKEN_STYLES: Record<TokenClass, Style> = {
  plain: { fg: C.fg },
  whitespace: {},
  keyword: { fg: C.purple, bold: true },
  controlKeyword: { fg: C.purple, bold: true },
  storageKeyword: { fg: C.purple, bold: true },
  operator: { fg: C.cyan },
  punctuation: { fg: C.fgDim },
  bracket: { fg: C.fg },
  string: { fg: C.green },
  template: { fg: C.green },
  number: { fg: C.orange },
  boolean: { fg: C.orange },
  regex: { fg: C.cyan },
  comment: { fg: C.fgDim },
  docComment: { fg: C.fgDim },
  sectionHeader: { fg: C.fgBright, bold: true, underline: true },
  typeName: { fg: C.yellow },
  typeKeyword: { fg: C.yellow },
  interfaceName: { fg: C.yellow, bold: true },
  functionName: { fg: C.blue, bold: true },
  callName: { fg: C.blue },
  builderCall: { fg: C.red, bold: true },
  cfHelper: { fg: C.cyan },
  schemaKey: { fg: C.red },
  propertyName: { fg: C.red },
  parameter: { fg: C.fg },
  binding: { fg: C.fg },
  identifier: { fg: C.fg },
  diffAdd: { fg: C.green, bold: true },
  diffDel: { fg: C.red, bold: true },
  diffHunk: { fg: C.cyan, bold: true },
  diffMeta: { fg: C.fgDim },
};

/** The dialog-palette style for a token class (bracket depth is ignored: a
 * dialog draws every bracket in the default colour rather than rainbow). */
export function dialogStyleFor(cls: TokenClass): Style {
  return DIALOG_TOKEN_STYLES[cls];
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
  /** The editor background painted behind every content cell. */
  editorBg: C.editorBg,
  /** Faint background tint marking a JSON-schema object-literal region. */
  schemaRegionBg: C.schemaBg,
  /** Faint background tint marking a closure (arrow/function-expression) body. */
  closureRegionBg: C.closureBg,
  /** Background of the line range belonging to the selected structure node. */
  selectionBg: C.selectionBg,
  /** The vertical guide bar drawn beside a selected node. */
  guide: { fg: C.cyan, bold: true, bg: C.editorBg } as Style,
  statusBar: { fg: C.fg, bg: C.panel } as Style,
  statusKey: { fg: C.red, bg: C.panel, bold: true } as Style,
  /** The current file name on the status bar. */
  statusFile: { fg: C.fgBright, bg: C.panel, bold: true } as Style,
  statusDim: { fg: C.fgDim, bg: C.panel } as Style,
  /** The notice region above the status bar (e.g. the files a save would
   * write), tinted to read as a callout rather than ordinary content. */
  noticeBar: { fg: C.ink, bg: C.cyan } as Style,
  lineNumber: { fg: C.fgDim, bg: C.editorBg } as Style,
  lineNumberCurrent: { fg: C.yellow, bg: C.editorBg } as Style,
  searchMatch: { fg: C.ink, bg: C.cyan } as Style,
  searchCurrent: { fg: C.ink, bg: C.yellow, bold: true } as Style,
  /** A dialog is a panel a shade lighter than the editor, with a bright frame
   * and a drop shadow, distinct from the content behind it. */
  overlayBg: C.panel,
  overlayBorder: { fg: C.white, bold: true } as Style,
  /** Border of an overlay that shows source (an editor window). */
  overlaySourceBorder: { fg: C.cyan, bold: true } as Style,
  /** The highlighted (selected) reference line inside a card. */
  overlayHighlightBg: C.panelHi,
  /** The drop shadow cast to the right of and below a dialog: the content behind
   * shows through, darkened. */
  overlayShadow: { fg: C.fgDim, bg: C.shadow } as Style,
  overlayTitle: { fg: C.fgBright, bold: true } as Style,
  /** Body text inside a modal prompt dialog. */
  dialogText: { fg: C.fg } as Style,
  /** A Turbo Vision push-button: dark text on a green face. */
  button: { fg: C.ink, bg: C.button } as Style,
  /** The default (Enter) button, drawn in bright white so it stands out. */
  buttonDefault: { fg: C.white, bg: C.button, bold: true } as Style,
  /** The highlighted shortcut letter on a button face. */
  buttonKey: { fg: C.yellow, bg: C.button, bold: true } as Style,
  /** The drop shadow cast below and right of a button, painted with half-block
   * glyphs so it reads as a thin edge rather than a full cell. */
  buttonShadow: { fg: C.shadow } as Style,
  scrollbarTrack: { fg: C.fgDim } as Style,
  scrollbarThumb: { fg: C.cyan } as Style,
};
