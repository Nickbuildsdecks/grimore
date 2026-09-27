import type { Request, Response, NextFunction } from 'express';
import type pino from 'pino';
import { ZodError } from 'zod';
import type { ApiErrorCode } from '@grimore/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    /** Typed to the shared union, so a mistyped code fails the build instead of reaching a client. */
    public code: ApiErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Uniform error envelope: { error: { code, message, details? } } — the @grimore/shared ApiError shape. */
export function errorHandler(log: pino.Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: 'VALIDATION' satisfies ApiErrorCode, message: 'Invalid request', details: err.flatten().fieldErrors },
      });
      return;
    }
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    log.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL' satisfies ApiErrorCode, message: 'Internal server error' } });
  };
}

/** Wrap async handlers so rejections reach the error handler. */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
