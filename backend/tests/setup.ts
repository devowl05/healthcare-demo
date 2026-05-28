/**
 * Bun-test preload. Ensures `NODE_ENV=test` BEFORE any module imports
 * `../src/env.ts` so the test-mode defaults kick in and required secrets
 * (DATABASE_URL etc.) don't need to be set in the shell.
 */
process.env.NODE_ENV = "test";
