/**
 * Selecting the {@link Language} for a file, and composing the diff view's
 * semantic layer from the languages a diff touches.
 *
 * Selection is "first matcher wins": each language answers {@link
 * Language.matches} for itself, so there is no central table mapping extensions
 * to behaviour. The TypeScript language is the catch-all (it matches every file)
 * and so must come last; the more specific languages precede it.
 */
import type { Language, Semantics, SemanticsOptions } from "./language.ts";
import type { DiffMaps } from "../diffdoc.ts";
import { typeScriptLanguage } from "./typescript/language.ts";
import { markdownLanguage } from "./markdown/language.ts";
import { jsonLanguage } from "./json/language.ts";

/**
 * Every language the pager knows, most specific first, built on first use. The
 * catch-all (TypeScript) is last so a file no other language claims resolves.
 *
 * The list is lazy so this module's top level never reads the concrete language
 * singletons: they and this module form an import cycle (a language's semantic
 * layer resolves external files back through {@link languageForFile}), and
 * building the array eagerly would read a singleton that a cycle-first load had
 * not yet initialised. By first use every module has finished evaluating.
 */
let languages: readonly Language[] | undefined;
function allLanguages(): readonly Language[] {
  return languages ??= [markdownLanguage, jsonLanguage, typeScriptLanguage];
}

/** The language for `fileName` — the first that claims it (TypeScript always
 * does, as the catch-all, so this never returns undefined). */
export function languageForFile(fileName: string | undefined): Language {
  for (const language of allLanguages()) {
    if (language.matches(fileName)) return language;
  }
  return typeScriptLanguage;
}

/** The distinct languages a set of files resolves to, in first-seen order. */
export function distinctLanguages(
  fileNames: readonly (string | undefined)[],
): Language[] {
  const seen = new Set<string>();
  const out: Language[] = [];
  for (const name of fileNames) {
    const language = languageForFile(name);
    if (!seen.has(language.id)) {
      seen.add(language.id);
      out.push(language);
    }
  }
  return out;
}

/**
 * The semantic service for a diff view, from the languages the diff touches. A
 * diff spans potentially many files of different languages; the service is the
 * first language present that offers one, scoped to just its own files (so a
 * TypeScript program is not seeded with the diff's Markdown or JSON files).
 * Only TypeScript offers one today, so this resolves to it whenever the diff
 * includes a TypeScript file and to nothing otherwise. When a second semantic
 * language appears this becomes a per-file composite; the per-language slot the
 * pager dispatches through is already here.
 */
export function diffSemanticsFor(
  languages: readonly Language[],
  diffText: string,
  maps: DiffMaps,
  options: SemanticsOptions,
): Semantics | undefined {
  for (const language of languages) {
    if (!language.createDiffSemantics) continue;
    const rootFiles = maps.rootFiles.filter((path) =>
      languageForFile(path) === language
    );
    if (rootFiles.length === 0) continue;
    const semantics = language.createDiffSemantics(
      diffText,
      { ...maps, rootFiles },
      options,
    );
    if (semantics) return semantics;
  }
  return undefined;
}
