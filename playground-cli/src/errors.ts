export class PlaygroundError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends PlaygroundError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 2, options);
  }
}

export class CancelledError extends PlaygroundError {
  constructor(message = "Cancelled") {
    super(message, 130);
  }
}

export class ApiError extends PlaygroundError {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, 1, options);
  }
}
