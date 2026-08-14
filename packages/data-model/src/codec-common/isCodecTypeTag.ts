/**
 * Syntax of a codec type tag: a type name, `@`, and a version number. The name
 * starts with a letter and continues with letters and digits; the version is a
 * positive integer with no leading zero.
 */
const CODEC_TYPE_TAG_SYNTAX = /^[A-Za-z][A-Za-z0-9]*@[1-9][0-9]*$/;

/**
 * Indicates whether `value` is a string whose syntax is that of a codec type
 * tag, as the members of `CODEC_TYPE_TAGS` are.
 *
 * This is the whole of what such a tag is structurally, and says nothing about
 * whether any codec claims it. That second question belongs to a registry, and
 * the two together are what separate an `UnknownValue` -- a tag naming a type
 * nothing here knows -- from a malformation, which names nothing at all. The
 * meta-tags in `CODEC_META_TAGS` are deliberately outside this syntax, each
 * being a structural marker its format handles itself rather than a type
 * anything can encode.
 */
export function isCodecTypeTag(value: unknown): value is string {
  return (typeof value === "string") && CODEC_TYPE_TAG_SYNTAX.test(value);
}
