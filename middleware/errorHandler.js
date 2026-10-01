const ApiError = require('./ApiError');

// Catches any request that didn't match a route at all.
function notFound(req, res, next) {
  next(new ApiError(404, 'Not found.'));
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
    // The first reason is what the person needs to read ("title is too long").
    message = details[0] || 'Validation failed';
  }

  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ${err.path}.`;
  }

  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    // Said plainly (30/9): "X already exists for name" read like an error code.
    message = field === 'name' ? `"${err.keyValue[field]}" already exists - choose another name.` : 'That already exists.';
  }

  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Malformed JSON in request body';
  }
  if (err.type === 'entity.too.large') {
    statusCode = 413;
    message = 'This is too large to send.';
  }

  // 500s: the real reason goes to the server log only - it can contain
  // internals (database messages, code paths) that the client shouldn't see.
  if (statusCode >= 500) {
    console.error('❌ Server error:', err);
    // Our own ApiError(503, '...') messages are written for people - keep them.
    if (!(err instanceof ApiError)) message = 'Something went wrong on the server. Please try again.';
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
