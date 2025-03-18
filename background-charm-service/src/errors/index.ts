/**
 * Custom error classes for the Background Charm Service
 */

/**
 * Base error class for all service errors
 */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, ServiceError.prototype);
  }
}

/**
 * Error thrown when a charm execution times out
 */
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

/**
 * Error thrown when authentication fails
 */
export class AuthenticationError extends ServiceError {
  constructor(
    message: string,
    public readonly integrationId?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Error thrown when token refresh fails
 */
export class TokenRefreshError extends AuthenticationError {
  constructor(
    message: string,
    public override readonly integrationId: string,
  ) {
    super(message, integrationId);
    Object.setPrototypeOf(this, TokenRefreshError.prototype);
  }
}

/**
 * Error thrown when a job in the queue fails
 */
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

/**
 * Error thrown when a job times out
 */
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

/**
 * Error thrown when a charm couldn't be found or loaded
 */
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

/**
 * Error thrown when an integration couldn't be loaded or is misconfigured
 */
export class IntegrationError extends ServiceError {
  constructor(
    message: string,
    public readonly integrationId: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, IntegrationError.prototype);
  }
}

/**
 * Error thrown when a worker process fails or crashes
 */
export class WorkerError extends ServiceError {
  constructor(
    message: string,
    public readonly workerId?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, WorkerError.prototype);
  }
}

/**
 * Helper function to format an error for logging
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
