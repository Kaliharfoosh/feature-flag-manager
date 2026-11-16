// Where the API lives.
// Vercel and local dev: empty, so calls go to /api/... on the same address (no CORS needed).
// Floci (S3 website): the API Gateway URL, set at build time with VITE_API_BASE.
export const API_BASE = import.meta.env.VITE_API_BASE ?? ''

// Send the login cookie. Same address: 'same-origin'. API on another address: 'include'
// (the API only accepts this from origins listed in its CORS_ORIGINS).
export const CREDENTIALS = API_BASE ? 'include' : 'same-origin'
