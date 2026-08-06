/**
 * Content sniffing for the code browser.
 *
 * Deliberately matches git's own heuristics rather than doing anything cleverer:
 * users expect a file to be treated the same way `git diff` treats it.
 */

/**
 * Git's rule: a NUL byte in the first 8000 bytes means binary. It is not a
 * perfect test, but agreeing with git matters more than being right about an
 * exotic encoding — a file git shows as text should render here too.
 */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const window = Math.min(bytes.length, 8000)
  for (let i = 0; i < window; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSON',
  md: 'Markdown',
  markdown: 'Markdown',
  rs: 'Rust',
  go: 'Go',
  py: 'Python',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  fish: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  proto: 'Protocol Buffers',
  dockerfile: 'Dockerfile',
  lua: 'Lua',
  ex: 'Elixir',
  exs: 'Elixir',
  zig: 'Zig',
  hs: 'Haskell',
  scala: 'Scala',
  dart: 'Dart',
  vue: 'Vue',
  svelte: 'Svelte',
}

// Files whose whole name identifies them; extensions would miss these.
const BY_FILENAME: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  'cargo.lock': 'TOML',
  'go.mod': 'Go Module',
  'go.sum': 'Go Checksums',
  '.gitignore': 'Ignore List',
  '.gitattributes': 'Git Attributes',
  license: 'Text',
}

export function detectLanguage(path: string): string {
  const filename = (path.split('/').pop() ?? '').toLowerCase()

  const byName = BY_FILENAME[filename]
  if (byName) return byName

  const dot = filename.lastIndexOf('.')
  // A leading dot is the start of a dotfile name, not an extension separator.
  if (dot <= 0) return ''
  return BY_EXTENSION[filename.slice(dot + 1)] ?? ''
}
