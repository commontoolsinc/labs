// Parser tests

import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parse } from "../src/parser/parser.ts";
import type { Program, SimpleCommand, Pipeline, Assignment, Word } from "../src/parser/ast.ts";

Deno.test("parse simple command", () => {
  const result = parse("echo hello world");

  assertEquals(result.type, "Program");
  assertEquals(result.body.length, 1);

  const pipeline = result.body[0].pipeline;
  assertEquals(pipeline.type, "Pipeline");
  assertEquals(pipeline.commands.length, 1);

  const cmd = pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.type, "SimpleCommand");
  assertEquals(cmd.name?.parts[0], { type: "Literal", value: "echo" });
  assertEquals(cmd.args.length, 2);
  assertEquals(cmd.args[0].parts[0], { type: "Literal", value: "hello" });
  assertEquals(cmd.args[1].parts[0], { type: "Literal", value: "world" });
});

Deno.test("parse pipe", () => {
  const result = parse("cat file | grep pattern | wc -l");

  assertEquals(result.body.length, 1);
  const pipeline = result.body[0].pipeline;
  assertEquals(pipeline.commands.length, 3);

  const cmd1 = pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd1.name?.parts[0], { type: "Literal", value: "cat" });
  assertEquals(cmd1.args[0].parts[0], { type: "Literal", value: "file" });

  const cmd2 = pipeline.commands[1] as SimpleCommand;
  assertEquals(cmd2.name?.parts[0], { type: "Literal", value: "grep" });
  assertEquals(cmd2.args[0].parts[0], { type: "Literal", value: "pattern" });

  const cmd3 = pipeline.commands[2] as SimpleCommand;
  assertEquals(cmd3.name?.parts[0], { type: "Literal", value: "wc" });
  assertEquals(cmd3.args[0].parts[0], { type: "Literal", value: "-l" });
});

Deno.test("parse output redirection", () => {
  const result = parse("echo hi > file.txt");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.redirections.length, 1);
  assertEquals(cmd.redirections[0].op, ">");
  assertEquals(cmd.redirections[0].target.parts[0], { type: "Literal", value: "file.txt" });
});

Deno.test("parse input redirection", () => {
  const result = parse("cat < input.txt");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.redirections.length, 1);
  assertEquals(cmd.redirections[0].op, "<");
  assertEquals(cmd.redirections[0].target.parts[0], { type: "Literal", value: "input.txt" });
});

Deno.test("parse append redirection", () => {
  const result = parse("cmd >> log");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.redirections.length, 1);
  assertEquals(cmd.redirections[0].op, ">>");
});

Deno.test("parse stderr redirection", () => {
  const result = parse("cmd 2> error.log");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.redirections.length, 1);
  assertEquals(cmd.redirections[0].op, "2>");
  assertEquals(cmd.redirections[0].fd, 2);
});

Deno.test("parse variable expansion", () => {
  const result = parse("echo $HOME");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args[0].parts[0], {
    type: "VariableExpansion",
    name: "HOME",
  });
});

Deno.test("parse braced variable expansion with default", () => {
  const result = parse("echo ${VAR:-default}");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "VariableExpansion");
  if (part.type === "VariableExpansion") {
    assertEquals(part.name, "VAR");
    assertEquals(part.op, ":-");
    assertEquals(part.arg?.parts[0], { type: "Literal", value: "default" });
  }
});

Deno.test("parse command substitution", () => {
  const result = parse("echo $(date)");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args[0].parts[0].type, "CommandSubstitution");
});

Deno.test("parse nested command substitution", () => {
  const result = parse("echo $(echo $(whoami))");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args[0].parts[0].type, "CommandSubstitution");
});

Deno.test("parse assignment", () => {
  const result = parse("FOO=bar");

  const cmd = result.body[0].pipeline.commands[0] as Assignment;
  assertEquals(cmd.type, "Assignment");
  assertEquals(cmd.name, "FOO");
  assertEquals(cmd.value.parts[0], { type: "Literal", value: "bar" });
});

Deno.test("parse assignment with variable expansion", () => {
  const result = parse('FOO="hello $WORLD"');

  const cmd = result.body[0].pipeline.commands[0] as Assignment;
  assertEquals(cmd.type, "Assignment");
  assertEquals(cmd.name, "FOO");
  assertEquals(cmd.value.parts[0].type, "DoubleQuoted");
});

Deno.test("parse if clause", () => {
  const result = parse("if grep -q foo file; then echo found; fi");

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "IfClause");
  if (cmd.type === "IfClause") {
    assertEquals(cmd.condition.body.length, 1);
    assertEquals(cmd.then.body.length, 1);
    assertEquals(cmd.elifs.length, 0);
    assertEquals(cmd.else_, undefined);
  }
});

Deno.test("parse if-elif-else clause", () => {
  const result = parse(`if test -f file; then
    echo regular
  elif test -d file; then
    echo directory
  else
    echo other
  fi`);

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "IfClause");
  if (cmd.type === "IfClause") {
    assertEquals(cmd.elifs.length, 1);
    assertEquals(cmd.else_?.body.length, 1);
  }
});

Deno.test("parse for loop", () => {
  const result = parse("for f in *.txt; do echo $f; done");

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "ForClause");
  if (cmd.type === "ForClause") {
    assertEquals(cmd.variable, "f");
    assertEquals(cmd.words.length, 1);
    assertEquals(cmd.words[0].parts[0], { type: "Glob", pattern: "*.txt" });
    assertEquals(cmd.body.body.length, 1);
  }
});

Deno.test("parse for loop with newline separator", () => {
  const result = parse(`for f in a b c
  do
    echo $f
  done`);

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "ForClause");
  if (cmd.type === "ForClause") {
    assertEquals(cmd.variable, "f");
    assertEquals(cmd.words.length, 3);
  }
});

Deno.test("parse while loop", () => {
  const result = parse("while read line; do echo $line; done");

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "WhileClause");
  if (cmd.type === "WhileClause") {
    assertEquals(cmd.condition.body.length, 1);
    assertEquals(cmd.body.body.length, 1);
  }
});

Deno.test("parse while loop with redirection", () => {
  const result = parse("while read line; do echo $line; done < file");

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "WhileClause");
  if (cmd.type === "WhileClause") {
    assertEquals(cmd.redirections.length, 1);
    assertEquals(cmd.redirections[0].op, "<");
  }
});

Deno.test("parse pipeline with AND connector", () => {
  const result = parse("cmd1 && cmd2");

  assertEquals(result.body.length, 2);
  assertEquals(result.body[0].connector, "&&");
});

Deno.test("parse pipeline with OR connector", () => {
  const result = parse("cmd1 || cmd2");

  assertEquals(result.body.length, 2);
  assertEquals(result.body[0].connector, "||");
});

Deno.test("parse complex connectors", () => {
  const result = parse("cmd1 && cmd2 || cmd3");

  assertEquals(result.body.length, 3);
  assertEquals(result.body[0].connector, "&&");
  assertEquals(result.body[1].connector, "||");
});

Deno.test("parse subshell", () => {
  const result = parse("(cd /tmp && ls)");

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "Subshell");
  if (cmd.type === "Subshell") {
    assertEquals(cmd.body.body.length, 2);
    assertEquals(cmd.body.body[0].connector, "&&");
  }
});

Deno.test("parse brace group", () => {
  const result = parse("{ echo a; echo b; }");

  const cmd = result.body[0].pipeline.commands[0];
  assertEquals(cmd.type, "BraceGroup");
  if (cmd.type === "BraceGroup") {
    assertEquals(cmd.body.body.length, 2);
  }
});

Deno.test("parse single quotes", () => {
  const result = parse("echo 'literal $VAR'");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args[0].parts[0], {
    type: "SingleQuoted",
    value: "literal $VAR",
  });
});

Deno.test("parse double quotes with expansion", () => {
  const result = parse('echo "expanded $VAR"');

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "DoubleQuoted");
  if (part.type === "DoubleQuoted") {
    assertEquals(part.parts.length, 2);
    assertEquals(part.parts[0], { type: "Literal", value: "expanded " });
    assertEquals(part.parts[1].type, "VariableExpansion");
  }
});

Deno.test("parse here-document", () => {
  const result = parse("cat <<EOF\nhello\nEOF");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.redirections.length, 1);
  assertEquals(cmd.redirections[0].op, "<<");
  assertEquals(cmd.redirections[0].target.parts[0], { type: "Literal", value: "EOF" });
});

Deno.test("parse semicolon separator", () => {
  const result = parse("echo a; echo b");

  assertEquals(result.body.length, 2);
  assertEquals(result.body[0].connector, ";");
});

Deno.test("parse newline separator", () => {
  const result = parse("echo a\necho b");

  assertEquals(result.body.length, 2);
  assertEquals(result.body[0].connector, ";");
});

Deno.test("parse background job", () => {
  const result = parse("sleep 10 &");

  assertEquals(result.body[0].connector, "&");
});

Deno.test("parse negated pipeline", () => {
  const result = parse("! grep -q pattern file");

  const pipeline = result.body[0].pipeline;
  assertEquals(pipeline.negated, true);
});

Deno.test("parse negated pipeline with pipe", () => {
  const result = parse("! cat file | grep pattern");

  const pipeline = result.body[0].pipeline;
  assertEquals(pipeline.negated, true);
  assertEquals(pipeline.commands.length, 2);
});

Deno.test("parse arithmetic expansion", () => {
  const result = parse("echo $((1 + 2))");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "ArithmeticExpansion");
  if (part.type === "ArithmeticExpansion") {
    assertEquals(part.expression, "1 + 2");
  }
});

Deno.test("parse complex real-world command", () => {
  const result = parse(
    `curl -s https://api.com/data | jq '.results[]' | while read item; do echo "$item"; done`,
  );

  assertEquals(result.body.length, 1);
  const pipeline = result.body[0].pipeline;
  assertEquals(pipeline.commands.length, 3);

  // First command: curl
  const curlCmd = pipeline.commands[0] as SimpleCommand;
  assertEquals(curlCmd.name?.parts[0], { type: "Literal", value: "curl" });

  // Second command: jq
  const jqCmd = pipeline.commands[1] as SimpleCommand;
  assertEquals(jqCmd.name?.parts[0], { type: "Literal", value: "jq" });

  // Third command: while loop
  const whileCmd = pipeline.commands[2];
  assertEquals(whileCmd.type, "WhileClause");
});

Deno.test("parse multiple redirections", () => {
  const result = parse("cmd < input > output 2> error");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.redirections.length, 3);
  assertEquals(cmd.redirections[0].op, "<");
  assertEquals(cmd.redirections[1].op, ">");
  assertEquals(cmd.redirections[2].op, "2>");
});

Deno.test("parse empty command", () => {
  const result = parse("");

  assertEquals(result.type, "Program");
  assertEquals(result.body.length, 0);
});

Deno.test("parse command with trailing semicolon", () => {
  const result = parse("echo hello;");

  assertEquals(result.body.length, 1);
  assertEquals(result.body[0].connector, ";");
});

Deno.test("parse multiple newlines between commands", () => {
  const result = parse("echo a\n\n\necho b");

  assertEquals(result.body.length, 2);
});

Deno.test("parse comments", () => {
  const result = parse("echo hello # this is a comment\necho world");

  assertEquals(result.body.length, 2);
  const cmd1 = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd1.args.length, 1); // Only "hello", comment is ignored
});

Deno.test("parse backslash escaping", () => {
  const result = parse("echo hello\\ world");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args.length, 1);
  assertEquals(cmd.args[0].parts.length, 3);
  assertEquals(cmd.args[0].parts[0], { type: "Literal", value: "hello" });
  assertEquals(cmd.args[0].parts[1], { type: "Literal", value: " " });
  assertEquals(cmd.args[0].parts[2], { type: "Literal", value: "world" });
});

Deno.test("parse glob patterns", () => {
  const result = parse("ls *.txt");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args[0].parts[0].type, "Glob");
  if (cmd.args[0].parts[0].type === "Glob") {
    assertEquals(cmd.args[0].parts[0].pattern, "*.txt");
  }
});

Deno.test("parse character class glob", () => {
  const result = parse("ls [a-z]*.txt");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args[0].parts[0].type, "Glob");
});

Deno.test("error on unmatched single quote", () => {
  assertThrows(
    () => parse("echo 'hello"),
    Error,
    "Unterminated single-quoted string",
  );
});

Deno.test("error on unmatched double quote", () => {
  assertThrows(
    () => parse('echo "hello'),
    Error,
    "Unterminated double-quoted string",
  );
});

Deno.test("error on missing fi", () => {
  assertThrows(
    () => parse("if true; then echo hi"),
    Error,
    "Expected Fi",
  );
});

Deno.test("error on missing done", () => {
  assertThrows(
    () => parse("for i in 1 2 3; do echo $i"),
    Error,
    "Expected Done",
  );
});

Deno.test("error on unmatched parenthesis", () => {
  assertThrows(
    () => parse("(echo hello"),
    Error,
    "Expected RParen",
  );
});

Deno.test("error on unmatched brace", () => {
  assertThrows(
    () => parse("{ echo hello"),
    Error,
    "Expected RBrace",
  );
});

Deno.test("parse variable expansion with special variables", () => {
  const result = parse("echo $? $$ $! $0 $1");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args.length, 5);

  for (let i = 0; i < 5; i++) {
    assertEquals(cmd.args[i].parts[0].type, "VariableExpansion");
  }
});

Deno.test("parse braced expansion with assign operator", () => {
  const result = parse("echo ${VAR:=default}");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "VariableExpansion");
  if (part.type === "VariableExpansion") {
    assertEquals(part.name, "VAR");
    assertEquals(part.op, ":=");
  }
});

Deno.test("parse braced expansion with plus operator", () => {
  const result = parse("echo ${VAR:+value}");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "VariableExpansion");
  if (part.type === "VariableExpansion") {
    assertEquals(part.name, "VAR");
    assertEquals(part.op, ":+");
  }
});

Deno.test("parse braced expansion with error operator", () => {
  const result = parse("echo ${VAR:?error message}");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "VariableExpansion");
  if (part.type === "VariableExpansion") {
    assertEquals(part.name, "VAR");
    assertEquals(part.op, ":?");
  }
});

Deno.test("parse command with &> redirection", () => {
  const result = parse("cmd &> output.txt");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.redirections[0].op, "&>");
});

Deno.test("parse mixed word parts", () => {
  const result = parse('echo hello"$USER"world');

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  assertEquals(cmd.args[0].parts.length, 3);
  assertEquals(cmd.args[0].parts[0], { type: "Literal", value: "hello" });
  assertEquals(cmd.args[0].parts[1].type, "DoubleQuoted");
  assertEquals(cmd.args[0].parts[2], { type: "Literal", value: "world" });
});

Deno.test("parse escaped characters in double quotes", () => {
  const result = parse('echo "hello \\"world\\""');

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "DoubleQuoted");
  if (part.type === "DoubleQuoted") {
    assertEquals(part.parts.length, 3);
    assertEquals(part.parts[0], { type: "Literal", value: "hello " });
    assertEquals(part.parts[1], { type: "Literal", value: '"' });
    assertEquals(part.parts[2], { type: "Literal", value: "world" });
  }
});

Deno.test("parse nested arithmetic in expansion", () => {
  const result = parse("echo $(( (1 + 2) * 3 ))");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "ArithmeticExpansion");
  if (part.type === "ArithmeticExpansion") {
    assertEquals(part.expression, " (1 + 2) * 3 ");
  }
});

Deno.test("parse simple brace variable", () => {
  const result = parse("echo ${VAR}");

  const cmd = result.body[0].pipeline.commands[0] as SimpleCommand;
  const part = cmd.args[0].parts[0];
  assertEquals(part.type, "VariableExpansion");
  if (part.type === "VariableExpansion") {
    assertEquals(part.name, "VAR");
    assertEquals(part.op, undefined);
  }
});
