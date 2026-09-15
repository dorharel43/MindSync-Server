const ApiError = require('./ApiError');

// Catches any request that didn't match a route at all.
function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// Single place that turns *any* error thrown/forwarded anywhere in the app
// into a consistent JSON shape: { error: { message, status, details? } }.
// Must be registered LAST, after all routes.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Something went wrong on the server';
  let details;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    details = Object.values(err.errors).map((e) => e.message);
    message = 'Validation failed';
  }

  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ${err.path}: "${err.value}"`;
  }

  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = field ? `"${err.keyValue[field]}" already exists for ${field}` : 'Duplicate value';
  }

  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Malformed JSON in request body';
  }

  if (statusCode >= 500) {
    console.error('❌ Server error:', err);
  }

  res.status(statusCode).json({
    error: {
      message,
      status: statusCode,
      ...(details ? { details } : {}),
    },
  });
}

module.exports = { notFound, errorHandler };
