import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs-extra';
import path from 'path';
import {glob} from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const outputPath = path.resolve(__dirname, 'src', 'virtualTypeDefs.js');

const modules = [
  '@commontools/common-html',
  '@commontools/common-builder',
  '@commontools/common-runner',
  '@commontools/common-propagator',
];

// Collect lib.d.ts from TypeScript
const tsLibDir = path.join(
  path.dirname(path.dirname(new URL(await import.meta.resolve('typescript')).pathname)),
  'lib/'
);
const tsLibPath = path.join(
  tsLibDir,
  'lib.es2015.d.ts'
);
console.log('tsLibPath', tsLibPath);
const libDts = fs.readFileSync(tsLibPath, 'utf-8');

// Collect module .d.ts files
const moduleTypeDefs = {};

modules.forEach(async (module) => {
  let dtsPath;
  if (module.startsWith('@commontools/')) {
    dtsPath = path.resolve(__dirname, '..', module.replace('@commontools/', ''), 'lib');
  } else if (module.startsWith('../') || module.startsWith('./')) {
    dtsPath = path.resolve(__dirname, module.replace('.js', '.d.ts'));
  }

  glob.sync('*.d.ts', { cwd: dtsPath }).forEach((file) => {
    console.log('file', file);
    moduleTypeDefs[`node_modules/${module}/${file}`] = fs.readFileSync(path.join(dtsPath, file), 'utf-8');
  });

});

const libFiles = glob.sync('lib.*.d.ts', { cwd: tsLibDir });
libFiles.forEach((libFile) => {
  const content = fs.readFileSync(path.join(tsLibDir, libFile), 'utf-8');
  moduleTypeDefs[libFile] = content;
});

// Corrected data.d.ts
moduleTypeDefs['../data.d.ts'] = `
export type Recipe = {
  // Define the properties of Recipe here
  name: string;
  // ... other properties
};

export function launch(recipe: Recipe, props: any): void;
`;

// Add this new entry for the JavaScript file
moduleTypeDefs['../data.js'] = `
// This file can be empty or contain any necessary JavaScript code
`;

// Combine all type definitions
const virtualTypeDefs = {
  'lib.es2015.d.ts': libDts,
  ...moduleTypeDefs,
};

// Generate the virtualTypeDefs.js file
const fileContent = `export const virtualTypeDefs = ${JSON.stringify(virtualTypeDefs, null, 2)};`;

fs.ensureDirSync(path.dirname(outputPath));
fs.writeFileSync(outputPath, fileContent, 'utf-8');

console.log('Bundled type definitions successfully.');