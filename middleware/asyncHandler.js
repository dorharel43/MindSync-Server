// Wraps an async route handler so any thrown/rejected error is forwarded
// to Express's error-handling middleware instead of crashing the process
// or hanging the request. Use this on every async route:
//
//   router.get('/', asyncHandler(async (req, res) => { ... }));
//
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
