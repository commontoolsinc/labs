import { ProgramResolver, Source } from "./interface.ts";

export class InMemoryProgram implements ProgramResolver {
  private modules: Record<string, string>;
  private entryName: string;
  constructor(entryName: string, modules: Record<string, string>) {
    this.modules = modules;
    this.entryName = entryName;
  }

  entry(): Source {
    const entry = this.modules[this.entryName];
    if (!entry) {
      throw new Error(`${this.entryName} not in modules.`);
    }
    return { name: this.entryName, contents: entry };
  }

  resolveSource(identifier: string): Promise<Source | undefined> {
    const contents = this.modules[identifier];
    if (!contents) return Promise.resolve(undefined);
    return Promise.resolve({ contents, name: identifier });
  }
}
