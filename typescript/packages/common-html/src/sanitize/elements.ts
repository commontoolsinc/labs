import { VNode } from "../view.js";

const ALLOWED = [
    // Content Sectioning
    "address",
    "article",
    "aside",
    "footer",
    "header",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hgroup",
    "main",
    "nav",
    "section",
    "search",
    // Text Content
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "hr",
    "li",
    "menu",
    "ol",
    "p",
    "pre",
    "ul",
    // Inline Semantics
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "br",
    "cite",
    "code",
    "data",
    "dfn",
    "em",
    "i",
    "kbd",
    "mark",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "time",
    "u",
    "var",
    "wbr",
    // Demarcating edits
    "del",
    "ins",
    // Table Content
    "caption",
    "col",
    "colgroup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    // Forms
    //
    // Form elements need some heavy handling
    "button",
];

// Common custom elements.
//
// /!\ Unclear if any of these are OS-only and not
// /!\ for userland. Also most likely many of these need
// /!\ to be updated for safety.
const COMMON_ELEMENTS = [
    "common-audio-recorder",
    "common-button",
    "common-charm",
    "common-datatable",
    "common-dict",
    "common-form",
    "common-grid",
    "common-hero-layout",
    "common-hgroup",
    "common-hscroll",
    "common-hstack",
    "common-img",
    "common-input-file",
    "common-media",
    "common-navpanel",
    "common-navstack",
    "common-pill",
    "common-record",
    "common-screen",
    "common-spacer",
    "common-suggestion",
    "common-suggestions",
    "common-system-layout",
    "common-table",
    "common-textarea",
    "common-todo",
    "common-unibox",
    "common-vstack",
    // These elements are in lookslike-high-level
    "common-recipe-link",
    "common-droppable",
    "common-annotation",
    "common-annotation-toggle",
    "common-charm-link",
];

export const sanitize = (node: VNode, strict: boolean): VNode | null => {
    if (!strict) {
        return node.name !== "script" ? node : null;
    }
    if (ALLOWED.includes(node.name)) {
        return node;
    }
    if (COMMON_ELEMENTS.includes(node.name)) {
        return node;
    }
    console.warn(`Filtering the unallowed '${node.name}' node.`);
    return null;
};