#!/usr/bin/env -S deno run --allow-sys --allow-env --allow-read --allow-ffi --allow-net --allow-write --allow-run

import { startTestRunner } from "@web/test-runner";

startTestRunner();
