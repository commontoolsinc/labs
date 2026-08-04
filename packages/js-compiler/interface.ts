import { type RawSourceMap } from "source-map-js";

export interface Source {
  name: string;
  contents: string;
}

// A program's entry point with a resolver to
// resolve other sources used in the program.
export interface ProgramResolver {
  main(): Promise<Source>;
  resolveSource(identifier: string): Promise<Source | undefined>;
}

// An entry point and its sources for a program.
export interface Program {
  main: string;
  files: Source[];
}

// A ready-to-execute string of JavaScript,
// with optional metadata.
export interface JsScript {
  js: string;
  sourceMap?: SourceMap;
  filename?: string;
}

export interface SourceMap extends RawSourceMap {}
