import type { NextFunction, Request, Response } from 'express';

import { ApiError } from '../errors.js';
import { verifySession, getSessionFromAuthorization } from './sessionService.js';

export function requireSession(role: 'finance' | 'insurer', scopeToRequest = false) {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = getSessionFromAuthorization(req.headers.authorization) ?? (req as any).session;
    if (!session) {
      return next(new ApiError('SESSION_EXPIRED', 'Session expired or missing.'));
    }

    if (session.user.role !== role) {
      return next(new ApiError('NOT_AUTHORISED', 'You are not authorised for this action.'));
    }

    let requestNo: string | undefined;
    if (scopeToRequest) {
      requestNo = typeof req.params.requestNo === 'string' ? req.params.requestNo : Array.isArray(req.params.requestNo) ? req.params.requestNo[0] : undefined;
      if (requestNo && session.requestNo && session.requestNo !== requestNo) {
        return next(new ApiError('NOT_AUTHORISED', 'This session is scoped to a different request.'));
      }
    }

    try {
      const verified = verifySession(session.token, requestNo);
      (req as any).session = verified;
      return next();
    } catch (error) {
      return next(new ApiError('SESSION_EXPIRED', 'Session expired or invalid.'));
    }
  };
}
