// Recursive descent parser for shell syntax

import type {
  Program,
  ConnectedPipeline,
  Pipeline,
  Command,
  SimpleCommand,
  Assignment,
  IfClause,
  ForClause,
  WhileClause,
  Subshell,
  BraceGroup,
  CompoundCommand,
  Redirection,
  Word,
  WordPart,
} from "./ast.ts";
import { tokenize, type Token, type TokenType } from "./lexer.ts";

export class Parser {
  private pos = 0;

  constructor(
    private tokens: Token[],
    private input: string,
  ) {}

  parse(): Program {
    const program = this.parseProgram();
    // Post-process to parse command substitutions
    this.parseCommandSubstitutions(program);
    return program;
  }

  // Recursively parse command substitutions in the AST
  private parseCommandSubstitutions(node: any): void {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) {
        this.parseCommandSubstitutions(item);
      }
      return;
    }

    // Parse command substitution word parts
    if (node.type === "CommandSubstitution" && node.command && !node.body) {
      try {
        node.body = parse(node.command);
      } catch (e) {
        // If parsing fails, leave body undefined
        // The interpreter will handle this error
      }
    }

    // Recurse into all object properties
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        this.parseCommandSubstitutions(node[key]);
      }
    }
  }

  // program := pipeline (('&&' | '||' | ';' | '&') pipeline)*
  private parseProgram(): Program {
    const body: ConnectedPipeline[] = [];

    // Skip leading newlines
    this.skipNewlines();

    while (!this.atEnd() && !this.check("Fi") && !this.check("Done") && !this.check("Elif") && !this.check("Else") && !this.check("Then") && !this.check("Do") && !this.check("RParen") && !this.check("RBrace")) {
      const pipeline = this.parsePipeline();

      let connector: "&&" | "||" | ";" | "&" | undefined;

      // Check for connectors
      if (this.match("And")) {
        connector = "&&";
      } else if (this.match("Or")) {
        connector = "||";
      } else if (this.match("Semi")) {
        connector = ";";
      } else if (this.match("Amp")) {
        connector = "&";
      } else if (this.match("Newline")) {
        connector = ";"; // Newline acts as separator
      }

      body.push({ pipeline, connector });

      // Skip any additional newlines
      this.skipNewlines();

      // If no connector was found and we're not at a terminator, we're done
      if (!connector && !this.atEnd()) {
        break;
      }
    }

    return { type: "Program", body };
  }

  // pipeline := ['!'] command ('|' command)*
  private parsePipeline(): Pipeline {
    const negated = this.match("Bang");

    const commands: Command[] = [];
    commands.push(this.parseCommand());

    while (this.match("Pipe")) {
      this.skipNewlines(); // Allow newlines after pipe
      commands.push(this.parseCommand());
    }

    return { type: "Pipeline", commands, negated };
  }

  // command := simple_command | compound_command | assignment
  private parseCommand(): Command {
    // Check for compound commands
    if (this.check("If")) {
      return this.parseIfClause();
    }
    if (this.check("For")) {
      return this.parseForClause();
    }
    if (this.check("While")) {
      return this.parseWhileClause();
    }
    if (this.check("LParen")) {
      return this.parseSubshell();
    }
    if (this.check("LBrace")) {
      return this.parseBraceGroup();
    }

    // Check for assignment or simple command
    return this.parseSimpleCommandOrAssignment();
  }

  // Parse either a simple command or a standalone assignment
  private parseSimpleCommandOrAssignment(): Command {
    const assignments: Assignment[] = [];
    const words: Word[] = [];
    const redirections: Redirection[] = [];

    // Collect assignments and words
    while (!this.atEnd() && this.check("Word", "Assignment")) {
      if (this.check("Assignment")) {
        const token = this.advance();
        const word = token.word!;

        // Extract name from the word
        const name = this.extractAssignmentName(word);
        const value = this.extractAssignmentValue(word);

        // Parse any redirections after the assignment
        const assignRedirs = this.parseRedirections();

        assignments.push({
          type: "Assignment",
          name,
          value,
          redirections: assignRedirs,
        });
      } else {
        break; // Stop at first non-assignment word
      }
    }

    // If we have assignments but no command words following, return the first assignment
    // (In real bash, multiple assignments would all be executed, but for simplicity we handle one)
    if (assignments.length > 0 && !this.check("Word")) {
      return assignments[0];
    }

    // Collect command words and redirections
    while (
      !this.atEnd() &&
      !this.isCommandTerminator() &&
      (this.check("Word") || this.isRedirection())
    ) {
      if (this.isRedirection()) {
        redirections.push(this.parseRedirection());
      } else if (this.check("Word")) {
        const token = this.advance();
        words.push(token.word!);
      }
    }

    // Build simple command
    const name = words.length > 0 ? words[0] : null;
    const args = words.slice(1);

    return {
      type: "SimpleCommand",
      name,
      args,
      redirections,
    };
  }

  // if_clause := 'if' program 'then' program ('elif' program 'then' program)* ('else' program)? 'fi'
  private parseIfClause(): IfClause {
    this.expect("If");
    this.skipNewlines();

    const condition = this.parseProgram();

    this.skipNewlines();
    this.expect("Then");
    this.skipNewlines();

    const then = this.parseProgram();

    const elifs: { condition: Program; then: Program }[] = [];
    while (this.match("Elif")) {
      this.skipNewlines();
      const elifCondition = this.parseProgram();
      this.skipNewlines();
      this.expect("Then");
      this.skipNewlines();
      const elifThen = this.parseProgram();
      elifs.push({ condition: elifCondition, then: elifThen });
    }

    let else_: Program | undefined;
    if (this.match("Else")) {
      this.skipNewlines();
      else_ = this.parseProgram();
    }

    this.skipNewlines();
    this.expect("Fi");

    const redirections = this.parseRedirections();

    return {
      type: "IfClause",
      condition,
      then,
      elifs,
      else_,
      redirections,
    };
  }

  // for_clause := 'for' WORD 'in' word* (';'|'\n') 'do' program 'done'
  private parseForClause(): ForClause {
    this.expect("For");

    const varToken = this.expect("Word");
    const variable = this.extractLiteralValue(varToken.word!);

    if (!variable) {
      throw this.error("Expected variable name in for loop");
    }

    this.skipNewlines();
    this.expect("In");
    this.skipNewlines();

    const words: Word[] = [];
    while (this.check("Word")) {
      const token = this.advance();
      words.push(token.word!);
    }

    // Expect separator (semicolon or newline)
    if (!this.match("Semi")) {
      this.skipNewlines();
    }

    this.skipNewlines();
    this.expect("Do");
    this.skipNewlines();

    const body = this.parseProgram();

    this.skipNewlines();
    this.expect("Done");

    const redirections = this.parseRedirections();

    return {
      type: "ForClause",
      variable,
      words,
      body,
      redirections,
    };
  }

  // while_clause := 'while' program 'do' program 'done'
  private parseWhileClause(): WhileClause {
    this.expect("While");
    this.skipNewlines();

    const condition = this.parseProgram();

    this.skipNewlines();
    this.expect("Do");
    this.skipNewlines();

    const body = this.parseProgram();

    this.skipNewlines();
    this.expect("Done");

    const redirections = this.parseRedirections();

    return {
      type: "WhileClause",
      condition,
      body,
      redirections,
    };
  }

  // subshell := '(' program ')'
  private parseSubshell(): Subshell {
    this.expect("LParen");
    this.skipNewlines();

    const body = this.parseProgram();

    this.skipNewlines();
    this.expect("RParen");

    const redirections = this.parseRedirections();

    return {
      type: "Subshell",
      body,
      redirections,
    };
  }

  // brace_group := '{' program '}'
  private parseBraceGroup(): BraceGroup {
    this.expect("LBrace");
    this.skipNewlines();

    const body = this.parseProgram();

    this.skipNewlines();
    this.expect("RBrace");

    const redirections = this.parseRedirections();

    return {
      type: "BraceGroup",
      body,
      redirections,
    };
  }

  // Parse redirections
  private parseRedirections(): Redirection[] {
    const redirections: Redirection[] = [];

    while (this.isRedirection()) {
      redirections.push(this.parseRedirection());
    }

    return redirections;
  }

  private parseRedirection(): Redirection {
    let op: Redirection["op"];
    let fd: number | undefined;

    if (this.match("Less")) {
      op = "<";
    } else if (this.match("Great")) {
      op = ">";
    } else if (this.match("DGreat")) {
      op = ">>";
    } else if (this.match("DLess")) {
      op = "<<";
    } else if (this.match("GreatAmp")) {
      op = "&>";
    } else if (this.match("TwoGreat")) {
      op = "2>";
      fd = 2;
    } else if (this.match("TwoDGreat")) {
      op = "2>>";
      fd = 2;
    } else {
      throw this.error("Expected redirection operator");
    }

    // Get the target word
    const targetToken = this.expect("Word");
    const target = targetToken.word!;

    return {
      type: "Redirection",
      op,
      target,
      fd,
    };
  }

  // Helper: extract assignment name from word
  private extractAssignmentName(word: Word): string {
    let name = "";
    for (const part of word.parts) {
      if (part.type === "Literal") {
        for (const ch of part.value) {
          if (ch === "=") break;
          name += ch;
        }
        if (part.value.includes("=")) break;
      }
    }
    return name;
  }

  // Helper: extract assignment value from word (everything after =)
  private extractAssignmentValue(word: Word): Word {
    const parts: WordPart[] = [];
    let foundEq = false;

    for (const part of word.parts) {
      if (part.type === "Literal") {
        const eqIndex = part.value.indexOf("=");
        if (eqIndex !== -1 && !foundEq) {
          foundEq = true;
          const afterEq = part.value.substring(eqIndex + 1);
          if (afterEq) {
            parts.push({ type: "Literal" as const, value: afterEq });
          }
        } else if (foundEq) {
          parts.push(part);
        }
      } else if (foundEq) {
        parts.push(part);
      }
    }

    return { type: "Word", parts };
  }

  // Helper: extract literal value if word is a simple literal
  private extractLiteralValue(word: Word): string | null {
    // All parts must be Literal (handles per-character tokenization)
    let result = "";
    for (const part of word.parts) {
      if (part.type !== "Literal") return null;
      result += part.value;
    }
    return result || null;
  }

  // Token navigation helpers
  private check(...types: TokenType[]): boolean {
    if (this.atEnd()) return false;
    return types.includes(this.peek().type);
  }

  private match(...types: TokenType[]): boolean {
    if (this.check(...types)) {
      this.advance();
      return true;
    }
    return false;
  }

  private advance(): Token {
    if (!this.atEnd()) this.pos++;
    return this.previous();
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private previous(): Token {
    return this.tokens[this.pos - 1];
  }

  private atEnd(): boolean {
    return this.peek().type === "EOF";
  }

  private expect(type: TokenType): Token {
    if (this.check(type)) {
      return this.advance();
    }
    throw this.error(`Expected ${type}, got ${this.peek().type}`);
  }

  private skipNewlines(): void {
    while (this.match("Newline")) {
      // Skip
    }
  }

  private isCommandTerminator(): boolean {
    return this.check(
      "Semi",
      "And",
      "Or",
      "Amp",
      "Pipe",
      "Newline",
      "EOF",
      "RParen",
      "RBrace",
      "Then",
      "Do",
      "Done",
      "Elif",
      "Else",
      "Fi",
    );
  }

  private isRedirection(): boolean {
    return this.check(
      "Less",
      "Great",
      "DGreat",
      "DLess",
      "GreatAmp",
      "LessAmp",
      "TwoGreat",
      "TwoDGreat",
    );
  }

  private error(message: string): Error {
    const token = this.peek();
    return new Error(
      `Parser error at ${token.position.line}:${token.position.column}: ${message}`,
    );
  }
}

export function parse(input: string): Program {
  const tokens = tokenize(input);
  return new Parser(tokens, input).parse();
}
