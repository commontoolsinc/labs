// AST node type definitions for the shell parser

export type Node =
  | Program
  | Pipeline
  | SimpleCommand
  | Assignment
  | IfClause
  | ForClause
  | WhileClause
  | Subshell
  | BraceGroup;

export interface Program {
  type: "Program";
  body: ConnectedPipeline[];
}

export interface ConnectedPipeline {
  pipeline: Pipeline;
  connector?: "&&" | "||" | ";" | "&"; // connector AFTER this pipeline
}

export interface Pipeline {
  type: "Pipeline";
  commands: Command[]; // connected by |
  negated?: boolean; // ! prefix
}

export type Command = SimpleCommand | Assignment | CompoundCommand;

export type CompoundCommand =
  | IfClause
  | ForClause
  | WhileClause
  | Subshell
  | BraceGroup;

export interface SimpleCommand {
  type: "SimpleCommand";
  name: Word | null; // null for assignments-only
  args: Word[];
  redirections: Redirection[];
}

export interface Assignment {
  type: "Assignment";
  name: string;
  value: Word;
  redirections: Redirection[];
}

export interface IfClause {
  type: "IfClause";
  condition: Program;
  then: Program;
  elifs: { condition: Program; then: Program }[];
  else_?: Program;
  redirections: Redirection[];
}

export interface ForClause {
  type: "ForClause";
  variable: string;
  words: Word[];
  body: Program;
  redirections: Redirection[];
}

export interface WhileClause {
  type: "WhileClause";
  condition: Program;
  body: Program;
  redirections: Redirection[];
}

export interface Subshell {
  type: "Subshell";
  body: Program;
  redirections: Redirection[];
}

export interface BraceGroup {
  type: "BraceGroup";
  body: Program;
  redirections: Redirection[];
}

export interface Redirection {
  type: "Redirection";
  op: "<" | ">" | ">>" | "2>" | "2>>" | "&>" | "<<";
  target: Word; // filename or heredoc delimiter
  fd?: number;
}

// A Word is a sequence of parts that get concatenated after expansion
export interface Word {
  type: "Word";
  parts: WordPart[];
}

export type WordPart =
  | { type: "Literal"; value: string }
  | { type: "SingleQuoted"; value: string }
  | { type: "DoubleQuoted"; parts: WordPart[] }
  | { type: "VariableExpansion"; name: string; op?: string; arg?: Word } // $VAR, ${VAR:-default}
  | { type: "CommandSubstitution"; command: string; body?: Program } // $(cmd) - command is raw, body parsed later
  | { type: "ArithmeticExpansion"; expression: string } // $((expr))
  | { type: "Glob"; pattern: string }; // *, ?, [...]
