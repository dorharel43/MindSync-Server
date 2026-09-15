// A predictable error type for "expected" failures (not found, bad input,
// etc.) so route handlers can `throw new ApiError(404, 'Task not found')`
// and the central error handler knows exactly what status/message to send.
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.isApiError = true;
  }
}

module.exports = ApiError;
