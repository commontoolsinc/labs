const BOLD = "\x1B[1m";
const UNDERLINE = "\x1B[4m";
const ACCENT = "\x1B[36m";
const OFF = "\x1B[0m";

export const help = `
${BOLD}ct${OFF}: Tool for running programs on common fabric.

${BOLD}Usage:${OFF}
  ct [OPTIONS] <INPUT>

${BOLD}Example:${OFF}

  ${ACCENT}ct ./recipe.tsx${OFF}
  Evaluates ${UNDERLINE}./recipe.tsx${OFF}, piping the recipe definition to stdout.
  
  ${ACCENT}ct ./recipe.tsx --no-run${OFF}
  Typechecks ${UNDERLINE}./recipe.tsx${OFF}.
  
  ${ACCENT}ct ./recipe.tsx --no-run --output ./compiled.js --filename charm-abcd.js${OFF}
  Compiles ${UNDERLINE}./recipe.tsx${OFF} into ${UNDERLINE}./compiled.js${OFF}
  on disk for debugging the compilation process. ${UNDERLINE}charm-abcd.js${OFF} is used
  in the compiled file for source maps.

${BOLD}Options:${OFF}
  --help,-h: Display help text.
  --verbose,-v: Verbose filenameput.
  --no-run: Do not execute input. Only type check.
  --no-check: Do not type check input.
  --output,-o=<OUTPATH>: Store the compiled recipe at OUTPATH.
  --filename,-f=<FILENAME>: The filename used when compiling the recipe,
    used in source maps. Uses the value for \`output\` if not provided.
`;
