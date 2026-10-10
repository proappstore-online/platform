/** @type {import('lint-staged').Config} */
module.exports = {
  'web/src/**/*.{ts,tsx}': () => ['pnpm typecheck', 'pnpm test'],
  'web/**/*.json': () => ['pnpm test'],
};
