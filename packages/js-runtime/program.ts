import { ProgramResolver, Source } from "./interface.ts";

export class InMemoryProgram implements ProgramResolver {
  private modules: Record<string, string>;
  private _main: string;
  constructor(main: string, modules: Record<string, string>) {
    this.modules = modules;
    this._main = main;
  }

  main(): Source {
    const main = this.modules[this._main];
    if (!main) {
      throw new Error(`${this._main} not in modules.`);
    }
    return { name: this._main, contents: main };
  }

  resolveSource(identifier: string): Promise<Source | undefined> {
    const contents = this.modules[identifier];
    if (!contents) return Promise.resolve(undefined);
    return Promise.resolve({ contents, name: identifier });
  }
}
