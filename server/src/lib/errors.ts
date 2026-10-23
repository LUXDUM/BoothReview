/** 統一JSONエラー: { "error": { "code": string, "message": string } } */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "ALREADY_REPORTED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_REPORTED: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra?: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, extra?: Record<string, unknown> | undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.extra = extra;
  }
}

export const Errors = {
  validation: (message: string) => new AppError("VALIDATION_ERROR", message),
  unauthorized: (message = "admin token required") =>
    new AppError("UNAUTHORIZED", message),
  forbidden: (message = "you can only modify your own review") =>
    new AppError("FORBIDDEN", message),
  notFound: (message = "review not found") => new AppError("NOT_FOUND", message),
  conflict: (message = "conflict") => new AppError("CONFLICT", message),
  alreadyReported: () =>
    new AppError("ALREADY_REPORTED", "you have already reported this review"),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError("RATE_LIMITED", "too many requests, please retry later", {
      retryAfterSeconds,
    }),
  internal: (message = "internal server error") =>
    new AppError("INTERNAL_ERROR", message),
};

export function errorBody(code: ErrorCode, message: string, extra?: Record<string, unknown>) {
  return { error: { code, message, ...(extra ?? {}) } };
}
