import { Command } from "../interface.ts";

const BOLD = "\x1B[1m";
const UNDERLINE = "\x1B[4m";
const ACCENT = "\x1B[36m";
const OFF = "\x1B[0m";

export const helpText = `
${BOLD}ct${OFF}: Tool for running programs on common fabric.

${BOLD}Usage:${OFF}
  ct [OPTIONS] <COMMAND>

${BOLD}Commands:${OFF}

  ${ACCENT}run <INPUT>${OFF}: Executes recipe ${UNDERLINE}<INPUT>${OFF} 
  ${ACCENT}init${OFF}: Initializes an environment for evaluating recipes
    in external tools.
  ${ACCENT}help${OFF}: Displays this help message.

${BOLD}Example:${OFF}
  
  ${ACCENT}ct init${OFF}
  Writes type definitions and configuration to PWD.

  ${ACCENT}ct run ./recipe.tsx${OFF}
  Evaluates ${UNDERLINE}./recipe.tsx${OFF}, piping the recipe definition to stdout.
  
  ${ACCENT}ct run ./recipe.tsx --no-run${OFF}
  Typechecks ${UNDERLINE}./recipe.tsx${OFF}.

  ${ACCENT}ct run ./recipe.tsx --no-run --output ./compiled.js --filename charm-abcd.js${OFF}
  Compiles ${UNDERLINE}./recipe.tsx${OFF} into ${UNDERLINE}./compiled.js${OFF} on disk for
  debugging the compilation process. ${UNDERLINE}charm-abcd.js${OFF} is used
  in the compiled file for source maps.

${BOLD}Options:${OFF}

  --help,-h: Display help text.
  --verbose,-v: Verbose filenameput.
  --no-run: (run only) Do not execute input. Only type check.
  --no-check: (run only) Do not type check input.
  --output,-o=<OUTPATH>: (run only) Store the compiled recipe at OUTPATH.
  --filename,-f=<FILENAME>: (run only) The filename used when compiling
    the recipe, used in source maps. Uses the value for \`output\`
    if not provided.
`;

export function help(_command: Command) {
  return helpText;
}
