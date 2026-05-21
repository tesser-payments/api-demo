// Run in each test worker. Suppress Vite's "Sourcemap for ... points to a
// source file outside its package" warnings emitted when loading
// @tesser-payments/types (whose published sourcemaps reference a /src/
// path absent from the package). Upstream issue; zero signal locally.
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("Sourcemap for ")) return;
  _origWarn(...args);
};
