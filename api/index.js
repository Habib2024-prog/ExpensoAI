import app from '../server.js';

// Vercel wraps this exported Express app as a serverless function.
// All /api/* routes (and any non-static path) land here via vercel.json rewrites.
export default app;
