// Shell lexer/tokenizer

import type { Word, WordPart } from "./ast.ts";

export type TokenType =
  | "Word"
  | "Assignment" // VAR=value detected at lex time
  | "Pipe" // |
  | "And" // &&
  | "Or" // ||
  | "Semi" // ;
  | "Amp" // &
  | "LParen" // (
  | "RParen" // )
  | "LBrace" // {
  | "RBrace" // }
  | "Less" // <
  | "Great" // >
  | "DGreat" // >>
  | "DLess" // <<
  | "GreatAmp" // &>
  | "LessAmp" // <&
  | "TwoGreat" // 2>
  | "TwoDGreat" // 2>>
  | "If"
  | "Then"
  | "Elif"
  | "Else"
  | "Fi"
  | "For"
  | "In"
  | "Do"
  | "Done"
  | "While"
  | "Bang" // !
  | "Newline"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  word?: Word; // parsed word structure (for Word and Assignment tokens)
  position: { line: number; column: number };
}

const KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
]);

export function tokenize(input: string): Token[] {
  const lexer = new Lexer(input);
  return lexer.tokenize();
}

class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;
  private tokens: Token[] = [];
  private atCommandStart = true; // track if we're at the start of a command for assignment detection

  constructor(private input: string) {}

  tokenize(): Token[] {
    while (!this.isAtEnd()) {
      this.skipWhitespace();
      if (this.isAtEnd()) break;

      const start = this.getPosition();

      // Skip comments
      if (this.peek() === "#") {
        this.skipComment();
        continue;
      }

      // Newline
      if (this.peek() === "\n") {
        this.advance();
        this.tokens.push({ type: "Newline", value: "\n", position: start });
        this.atCommandStart = true;
        continue;
      }

      // Operators (check multi-char first)
      const op = this.readOperator();
      if (op) {
        this.tokens.push(op);
        // After these operators, we're at command start
        if (
          ["Semi", "And", "Or", "Amp", "Pipe", "Newline", "LParen"].includes(
            op.type,
          )
        ) {
          this.atCommandStart = true;
        }
        continue;
      }

      // Words (includes keywords, assignments, and regular words)
      const word = this.readWord();
      if (word) {
        this.tokens.push(word);
        // After a word, we're not at command start unless it's an assignment
        this.atCommandStart = word.type === "Assignment";
        continue;
      }

      // If we get here, we have an unexpected character
      throw this.error(`Unexpected character: '${this.peek()}'`);
    }

    this.tokens.push({
      type: "EOF",
      value: "",
      position: this.getPosition(),
    });

    return this.tokens;
  }

  private readOperator(): Token | null {
    const start = this.getPosition();
    const ch = this.peek();

    // Two-character operators (check first)
    if (ch === "&" && this.peek(1) === "&") {
      this.advance();
      this.advance();
      return { type: "And", value: "&&", position: start };
    }
    if (ch === "|" && this.peek(1) === "|") {
      this.advance();
      this.advance();
      return { type: "Or", value: "||", position: start };
    }
    if (ch === ">" && this.peek(1) === ">") {
      this.advance();
      this.advance();
      return { type: "DGreat", value: ">>", position: start };
    }
    if (ch === "<" && this.peek(1) === "<") {
      this.advance();
      this.advance();
      return { type: "DLess", value: "<<", position: start };
    }
    if (ch === "&" && this.peek(1) === ">") {
      this.advance();
      this.advance();
      return { type: "GreatAmp", value: "&>", position: start };
    }
    if (ch === "<" && this.peek(1) === "&") {
      this.advance();
      this.advance();
      return { type: "LessAmp", value: "<&", position: start };
    }
    // 2> and 2>>
    if (ch === "2" && this.peek(1) === ">") {
      this.advance();
      this.advance();
      if (this.peek() === ">") {
        this.advance();
        return { type: "TwoDGreat", value: "2>>", position: start };
      }
      return { type: "TwoGreat", value: "2>", position: start };
    }

    // Single-character operators
    switch (ch) {
      case "|":
        this.advance();
        return { type: "Pipe", value: "|", position: start };
      case "&":
        this.advance();
        return { type: "Amp", value: "&", position: start };
      case ";":
        this.advance();
        return { type: "Semi", value: ";", position: start };
      case "(":
        this.advance();
        return { type: "LParen", value: "(", position: start };
      case ")":
        this.advance();
        return { type: "RParen", value: ")", position: start };
      case "{":
        this.advance();
        return { type: "LBrace", value: "{", position: start };
      case "}":
        this.advance();
        return { type: "RBrace", value: "}", position: start };
      case "<":
        this.advance();
        return { type: "Less", value: "<", position: start };
      case ">":
        this.advance();
        return { type: "Great", value: ">", position: start };
    }

    return null;
  }

  private readWord(): Token | null {
    const start = this.getPosition();
    const parts: WordPart[] = [];
    let rawValue = "";

    while (!this.isAtEnd() && !this.isWordBoundary()) {
      const ch = this.peek();

      if (ch === "'") {
        // Single-quoted string
        const sq = this.readSingleQuoted();
        parts.push(sq);
        rawValue += "'" +
          (sq as { type: "SingleQuoted"; value: string }).value + "'";
      } else if (ch === '"') {
        // Double-quoted string
        const dq = this.readDoubleQuoted();
        parts.push(dq);
        rawValue += '"...';
      } else if (ch === "\\") {
        // Backslash escape
        this.advance();
        if (!this.isAtEnd()) {
          const escaped = this.advance();
          parts.push({ type: "Literal", value: escaped });
          rawValue += escaped;
        }
      } else if (ch === "$") {
        // Expansion
        const exp = this.readExpansion();
        parts.push(exp);
        rawValue += "$...";
      } else if (ch === "*" || ch === "?" || ch === "[") {
        // Glob pattern
        const glob = this.readGlobPattern();
        parts.push(glob);
        rawValue += (glob as { type: "Glob"; pattern: string }).pattern;
      } else {
        // Literal characters - accumulate consecutive literals
        let lit = "";
        while (!this.isAtEnd() && !this.isWordBoundary()) {
          const c = this.peek();
          if (
            c === "'" || c === '"' || c === "\\" || c === "$" || c === "*" ||
            c === "?" || c === "["
          ) break;
          lit += this.advance();
        }
        if (lit) {
          parts.push({ type: "Literal", value: lit });
          rawValue += lit;
        }
      }
    }

    if (parts.length === 0) return null;

    const word: Word = { type: "Word", parts };

    // Check if this is an assignment (NAME=value at command start)
    if (this.atCommandStart && this.isAssignment(parts)) {
      const eqIndex = rawValue.indexOf("=");
      const _name = rawValue.substring(0, eqIndex);
      return {
        type: "Assignment",
        value: rawValue,
        word,
        position: start,
      };
    }

    // Check if this is a keyword
    const literalValue = this.extractLiteralValue(parts);
    if (literalValue && KEYWORDS.has(literalValue)) {
      const keywordType = this.keywordToTokenType(literalValue);
      return {
        type: keywordType,
        value: literalValue,
        position: start,
      };
    }

    // Check for bang (!)
    if (literalValue === "!") {
      return { type: "Bang", value: "!", position: start };
    }

    // Regular word
    return {
      type: "Word",
      value: rawValue,
      word,
      position: start,
    };
  }

  private isAssignment(parts: WordPart[]): boolean {
    // Assignment is NAME=... where NAME is [a-zA-Z_][a-zA-Z0-9_]*
    // We need to find the = in the literal parts
    let foundName = false;
    let foundEq = false;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type === "Literal") {
        const value = part.value;
        for (let j = 0; j < value.length; j++) {
          const ch = value[j];
          if (!foundEq) {
            if (ch === "=") {
              foundEq = true;
              if (!foundName) return false; // = without name
            } else if (j === 0 && i === 0) {
              // First character must be letter or underscore
              if (!/[a-zA-Z_]/.test(ch)) return false;
              foundName = true;
            } else if (!foundEq) {
              // Subsequent characters must be alphanumeric or underscore
              if (!/[a-zA-Z0-9_]/.test(ch)) return false;
              foundName = true;
            }
          }
        }
      } else {
        // Non-literal parts before = means not an assignment
        if (!foundEq) return false;
      }
    }

    return foundEq && foundName;
  }

  private extractLiteralValue(parts: WordPart[]): string | null {
    // All parts must be Literal (handles per-character tokenization)
    let result = "";
    for (const part of parts) {
      if (part.type !== "Literal") return null;
      result += part.value;
    }
    return result || null;
  }

  private keywordToTokenType(keyword: string): TokenType {
    switch (keyword) {
      case "if":
        return "If";
      case "then":
        return "Then";
      case "elif":
        return "Elif";
      case "else":
        return "Else";
      case "fi":
        return "Fi";
      case "for":
        return "For";
      case "in":
        return "In";
      case "do":
        return "Do";
      case "done":
        return "Done";
      case "while":
        return "While";
      default:
        return "Word";
    }
  }

  private readSingleQuoted(): WordPart {
    this.advance(); // consume opening '
    let value = "";
    while (!this.isAtEnd() && this.peek() !== "'") {
      value += this.advance();
    }
    if (this.peek() === "'") {
      this.advance(); // consume closing '
    } else {
      throw this.error("Unterminated single-quoted string");
    }
    return { type: "SingleQuoted", value };
  }

  private readDoubleQuoted(): WordPart {
    this.advance(); // consume opening "
    const parts: WordPart[] = [];

    while (!this.isAtEnd() && this.peek() !== '"') {
      const ch = this.peek();

      if (ch === "\\") {
        // Backslash escaping in double quotes
        this.advance();
        if (!this.isAtEnd()) {
          const next = this.peek();
          // Only these characters can be escaped in double quotes
          if (
            next === "$" || next === '"' || next === "\\" || next === "`" ||
            next === "\n"
          ) {
            this.advance();
            parts.push({ type: "Literal", value: next === "\n" ? "" : next });
          } else {
            // Not a valid escape, keep the backslash
            parts.push({ type: "Literal", value: "\\" });
          }
        }
      } else if (ch === "$") {
        // Expansion inside double quotes
        const exp = this.readExpansion();
        parts.push(exp);
      } else if (ch === "`") {
        // Backtick command substitution (legacy)
        const cmd = this.readBacktick();
        parts.push(cmd);
      } else {
        // Literal characters - accumulate consecutive
        let lit = "";
        while (
          !this.isAtEnd() && this.peek() !== '"' && this.peek() !== "\\" &&
          this.peek() !== "$" && this.peek() !== "`"
        ) {
          lit += this.advance();
        }
        if (lit) parts.push({ type: "Literal", value: lit });
      }
    }

    if (this.peek() === '"') {
      this.advance(); // consume closing "
    } else {
      throw this.error("Unterminated double-quoted string");
    }

    return { type: "DoubleQuoted", parts };
  }

  private readExpansion(): WordPart {
    this.advance(); // consume $

    if (this.isAtEnd()) {
      return { type: "Literal", value: "$" };
    }

    const ch = this.peek();

    // $((arithmetic))
    if (ch === "(" && this.peek(1) === "(") {
      return this.readArithmeticExpansion();
    }

    // $(command)
    if (ch === "(") {
      return this.readCommandSubstitution();
    }

    // ${var} or ${var:-default} etc.
    if (ch === "{") {
      return this.readBracedExpansion();
    }

    // $VAR (simple variable)
    if (this.isVarNameStart(ch)) {
      let name = "";
      while (!this.isAtEnd() && this.isVarNameChar(this.peek())) {
        name += this.advance();
      }
      return { type: "VariableExpansion", name };
    }

    // Special variables: $?, $!, $$, $0-$9, etc.
    if (
      ch === "?" || ch === "!" || ch === "$" || ch === "#" || ch === "*" ||
      ch === "@" || ch === "-" || /[0-9]/.test(ch)
    ) {
      const name = this.advance();
      return { type: "VariableExpansion", name };
    }

    // Just a literal $
    return { type: "Literal", value: "$" };
  }

  private readBracedExpansion(): WordPart {
    this.advance(); // consume {
    let name = "";

    while (!this.isAtEnd() && this.isVarNameChar(this.peek())) {
      name += this.advance();
    }

    if (name === "") {
      throw this.error("Invalid variable name in ${...}");
    }

    // Check for operators: :-, :=, :+, :?
    let op: string | undefined;
    let arg: Word | undefined;

    if (!this.isAtEnd() && this.peek() === ":") {
      this.advance();
      if (!this.isAtEnd()) {
        const opChar = this.peek();
        if (
          opChar === "-" || opChar === "=" || opChar === "+" || opChar === "?"
        ) {
          this.advance();
          op = ":" + opChar;

          // Read the argument
          const argParts: WordPart[] = [];
          while (!this.isAtEnd() && this.peek() !== "}") {
            if (this.peek() === "$") {
              argParts.push(this.readExpansion());
            } else {
              let lit = "";
              while (
                !this.isAtEnd() && this.peek() !== "}" && this.peek() !== "$"
              ) {
                lit += this.advance();
              }
              if (lit) argParts.push({ type: "Literal", value: lit });
            }
          }
          if (argParts.length > 0) {
            arg = { type: "Word", parts: argParts };
          }
        }
      }
    }

    if (this.peek() === "}") {
      this.advance(); // consume }
    } else {
      throw this.error("Unterminated ${...}");
    }

    return { type: "VariableExpansion", name, op, arg };
  }

  private readCommandSubstitution(): WordPart {
    this.advance(); // consume (
    let depth = 1;
    let code = "";

    while (!this.isAtEnd() && depth > 0) {
      const ch = this.peek();
      if (ch === "(") {
        depth++;
        code += this.advance();
      } else if (ch === ")") {
        depth--;
        if (depth > 0) {
          code += this.advance();
        } else {
          this.advance(); // consume closing )
        }
      } else if (ch === "\\") {
        code += this.advance();
        if (!this.isAtEnd()) {
          code += this.advance();
        }
      } else if (ch === "'" || ch === '"') {
        // Handle quotes to avoid counting parens inside them
        const quote = ch;
        code += this.advance();
        while (!this.isAtEnd() && this.peek() !== quote) {
          if (this.peek() === "\\") {
            code += this.advance();
            if (!this.isAtEnd()) {
              code += this.advance();
            }
          } else {
            code += this.advance();
          }
        }
        if (this.peek() === quote) {
          code += this.advance();
        }
      } else {
        code += this.advance();
      }
    }

    if (depth !== 0) {
      throw this.error("Unterminated $(...)");
    }

    // Store raw command; parser will recursively parse it later
    return { type: "CommandSubstitution", command: code };
  }

  private readBacktick(): WordPart {
    this.advance(); // consume `
    let code = "";

    while (!this.isAtEnd() && this.peek() !== "`") {
      if (this.peek() === "\\") {
        this.advance();
        if (!this.isAtEnd()) {
          const next = this.peek();
          if (next === "`" || next === "\\" || next === "$") {
            code += this.advance();
          } else {
            code += "\\" + this.advance();
          }
        }
      } else {
        code += this.advance();
      }
    }

    if (this.peek() === "`") {
      this.advance(); // consume closing `
    } else {
      throw this.error("Unterminated backtick command substitution");
    }

    // Store raw command; parser will recursively parse it later
    return { type: "CommandSubstitution", command: code };
  }

  private readArithmeticExpansion(): WordPart {
    this.advance(); // consume first (
    this.advance(); // consume second (
    let depth = 2;
    let expression = "";

    while (!this.isAtEnd() && depth > 0) {
      const ch = this.peek();
      if (ch === "(") {
        depth++;
        expression += this.advance();
      } else if (ch === ")") {
        depth--;
        if (depth > 1) {
          expression += this.advance();
        } else if (depth === 1) {
          this.advance(); // consume first )
          if (this.peek() === ")") {
            this.advance(); // consume second )
            depth = 0;
          } else {
            throw this.error("Expected )) to close arithmetic expansion");
          }
        }
      } else {
        expression += this.advance();
      }
    }

    if (depth !== 0) {
      throw this.error("Unterminated arithmetic expansion");
    }

    return { type: "ArithmeticExpansion", expression };
  }

  private readGlobPattern(): WordPart {
    let pattern = "";
    while (!this.isAtEnd() && !this.isWordBoundary()) {
      const ch = this.peek();
      if (ch === "*" || ch === "?" || ch === "[") {
        pattern += this.advance();
        if (ch === "[") {
          // Read until ]
          while (!this.isAtEnd() && this.peek() !== "]") {
            pattern += this.advance();
          }
          if (this.peek() === "]") {
            pattern += this.advance();
          }
        }
      } else if (this.isGlobChar(ch)) {
        pattern += this.advance();
      } else {
        break;
      }
    }
    return { type: "Glob", pattern };
  }

  private isGlobChar(ch: string): boolean {
    return /[a-zA-Z0-9_\-./]/.test(ch);
  }

  private isVarNameStart(ch: string): boolean {
    return /[a-zA-Z_]/.test(ch);
  }

  private isVarNameChar(ch: string): boolean {
    return /[a-zA-Z0-9_]/.test(ch);
  }

  private isWordBoundary(): boolean {
    if (this.isAtEnd()) return true;
    const ch = this.peek();
    return (
      /\s/.test(ch) ||
      ch === "|" ||
      ch === "&" ||
      ch === ";" ||
      ch === "(" ||
      ch === ")" ||
      ch === "{" ||
      ch === "}" ||
      ch === "<" ||
      ch === ">" ||
      ch === "\n"
    );
  }

  private skipWhitespace(): void {
    while (!this.isAtEnd() && /[ \t\r]/.test(this.peek())) {
      this.advance();
    }
  }

  private skipComment(): void {
    while (!this.isAtEnd() && this.peek() !== "\n") {
      this.advance();
    }
  }

  private peek(offset = 0): string {
    const pos = this.pos + offset;
    if (pos >= this.input.length) return "";
    return this.input[pos];
  }

  private advance(): string {
    const ch = this.input[this.pos++];
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private isAtEnd(): boolean {
    return this.pos >= this.input.length;
  }

  private getPosition(): { line: number; column: number } {
    return { line: this.line, column: this.column };
  }

  private error(message: string): Error {
    return new Error(`Lexer error at ${this.line}:${this.column}: ${message}`);
  }
}
