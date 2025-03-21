export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, ServiceError.prototype);
  }
}

export class CharmTimeoutError extends ServiceError {
  constructor(
    message: string,
    public readonly spaceId: string,
    public readonly charmId: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    Object.setPrototypeOf(this, CharmTimeoutError.prototype);
  }
}

export class AuthenticationError extends ServiceError {
  constructor(
    message: string,
    public readonly integrationId?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

export class TokenRefreshError extends AuthenticationError {
  constructor(
    message: string,
    public override readonly integrationId: string,
  ) {
    super(message, integrationId);
    Object.setPrototypeOf(this, TokenRefreshError.prototype);
  }
}

export class JobError extends ServiceError {
  constructor(
    message: string,
    public readonly jobId: string,
    public readonly jobType: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, JobError.prototype);
  }
}

export class JobTimeoutError extends JobError {
  constructor(
    message: string,
    jobId: string,
    jobType: string,
    public readonly timeoutMs: number,
  ) {
    super(message, jobId, jobType);
    Object.setPrototypeOf(this, JobTimeoutError.prototype);
  }
}

export class CharmNotFoundError extends ServiceError {
  constructor(
    message: string,
    public readonly spaceId: string,
    public readonly charmId: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, CharmNotFoundError.prototype);
  }
}

export class WorkerError extends ServiceError {
  constructor(
    message: string,
    public readonly workerId?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, WorkerError.prototype);
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
