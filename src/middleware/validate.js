import mongoose from 'mongoose';
import { notFound } from '../lib/AppError.js';

export const validate =
  ({ body, query } = {}) =>
  (req, _res, next) => {
    try {
      if (body) req.body = body.parse(req.body ?? {});
      if (query) req.validatedQuery = query.parse(req.query ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };

export function validId(paramName = 'id', what = 'Recording') {
  return (req, _res, next) => (mongoose.isValidObjectId(req.params[paramName]) ? next() : next(notFound(what)));
}
