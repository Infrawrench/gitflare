/// <reference types="vite/client" />

// `?raw` imports return the file's source as a string. Used by ci/plan-emitter.ts
// to embed @gitflare/ci-config into the sandbox from the same file users import,
// so the two cannot drift.
declare module '*?raw' {
  const source: string
  export default source
}
