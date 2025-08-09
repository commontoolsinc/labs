#!/usr/bin/env -S deno run -A

// new-storage:list-spaces
// Lists space sqlite files under SPACES_DIR or ./.spaces

const envDir = Deno.env.get("SPACES_DIR");
const base = envDir ? new URL(envDir) : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
await Deno.mkdir(base, { recursive: true }).catch(() => {});

for await (const entry of Deno.readDir(base)) {
  if (entry.isFile && entry.name.endsWith('.sqlite')) {
    const space = entry.name.replace(/\.sqlite$/, '');
    console.log(space);
  }
}

