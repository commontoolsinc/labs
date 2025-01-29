export interface Logger {
  // deno-lint-ignore no-explicit-any
  info(...args: any[]): void;
  // deno-lint-ignore no-explicit-any
  error(...args: any[]): void;
  // deno-lint-ignore no-explicit-any
  warn(...args: any[]): void;
  // deno-lint-ignore no-explicit-any
  debug(...args: any[]): void;
}

export class PrefixedLogger implements Logger {
  private logger: Logger;
  private prefix: string;
  private logMessages: string[] = [];

  constructor(logger: Logger = console, prefix: string) {
    this.logger = logger;
    this.prefix = prefix;
    this.info = this.info.bind(this);
    this.error = this.error.bind(this);
    this.warn = this.warn.bind(this);
    this.debug = this.debug.bind(this);
  }

  // deno-lint-ignore no-explicit-any
  info(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.info(message);
  }

  // deno-lint-ignore no-explicit-any
  error(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.error(message);
  }

  // deno-lint-ignore no-explicit-any
  warn(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.warn(message);
  }

  // deno-lint-ignore no-explicit-any
  debug(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.debug(message);
  }

  getLogs(): string[] {
    return this.logMessages;
  }
}
