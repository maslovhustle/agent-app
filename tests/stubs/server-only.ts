/**
 * Test stub for the `server-only` marker package.
 *
 * The real package throws on import unless it is resolved under the
 * `react-server` condition, which is how Next — and `pnpm mcp` / `pnpm evals`
 * via `tsx --conditions=react-server` — load it. Vitest cannot simply set that
 * condition globally: `react` and `react-dom` declare it too, so every future
 * component test would silently resolve React's server build, where `useState`
 * does not exist and the error points nowhere near the cause.
 *
 * Aliasing this one package is the narrow version of that fix.
 */
export {};
