export interface Logger {
  info(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
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

  info(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.info(message);
  }

  error(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.error(message);
  }

  warn(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.warn(message);
  }

  debug(...args: any[]) {
    const message = [`[${this.prefix}]`, ...args].join(" ");
    this.logMessages.push(message);
    this.logger.debug(message);
  }

  getLogs(): string[] {
    return this.logMessages;
  }
}
