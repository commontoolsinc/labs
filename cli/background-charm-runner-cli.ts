#!/usr/bin/env -S deno run -A
// CLI entry point for the Background Charm Runner
import { parse } from "@std/cli/parse-args";
import "./background-charm-runner.ts";

console.log("Background Charm Runner CLI is launching the background-charm-runner.ts script...");