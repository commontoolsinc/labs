export class PrefixedLogger {
  private logger: any;
  private prefix: string;
  private logMessages: string[] = [];

  constructor(logger: any = console, prefix: string) {
    this.logger = logger;
    this.prefix = prefix;
    this.info = this.info.bind(this);
    this.error = this.error.bind(this);
    this.warn = this.warn.bind(this);
    this.debug = this.debug.bind(this);
  }

  info(message: string) {
    const prefixedMessage = `[${this.prefix}] ${message}`;
    this.logMessages.push(prefixedMessage);
    this.logger.info(prefixedMessage);
  }

  error(message: string, error?: any) {
    const prefixedMessage = `[${this.prefix}] ${message}`;
    this.logMessages.push(
      error ? `${prefixedMessage} ${error}` : prefixedMessage,
    );
    this.logger.error(prefixedMessage, error);
  }

  warn(message: string) {
    const prefixedMessage = `[${this.prefix}] ${message}`;
    this.logMessages.push(prefixedMessage);
    this.logger.warn(prefixedMessage);
  }

  debug(message: string) {
    const prefixedMessage = `[${this.prefix}] ${message}`;
    this.logMessages.push(prefixedMessage);
    this.logger.debug(prefixedMessage);
  }

  getLogs(): string[] {
    return this.logMessages;
  }
}
