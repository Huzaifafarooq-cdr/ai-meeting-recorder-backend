export class AppError extends Error {
  constructor(status, code, message, { details, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, { details });
export const unauthorized = (code, message) => new AppError(401, code, message);
export const forbidden = (message = 'You do not have access to this resource.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (code, message) => new AppError(409, code, message);
