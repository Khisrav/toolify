/**
 * Lazy Shiki highlighting: `shiki/core` + the JavaScript regex engine (no Oniguruma WASM).
 * Each language grammar is its own chunk, loaded the first time a document uses it.
 * Output carries both GitHub light and dark colours as CSS variables (see markdown.css).
 */
import type { HighlighterCore, LanguageInput } from 'shiki/core'

type LangLoader = () => Promise<{ default: LanguageInput }>

const loaders: Record<string, LangLoader> = {
  bash: () => import('shiki/dist/langs/bash.mjs'),
  c: () => import('shiki/dist/langs/c.mjs'),
  cpp: () => import('shiki/dist/langs/cpp.mjs'),
  csharp: () => import('shiki/dist/langs/csharp.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  dockerfile: () => import('shiki/dist/langs/dockerfile.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  java: () => import('shiki/dist/langs/java.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  kotlin: () => import('shiki/dist/langs/kotlin.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  php: () => import('shiki/dist/langs/php.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  ruby: () => import('shiki/dist/langs/ruby.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  swift: () => import('shiki/dist/langs/swift.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  vue: () => import('shiki/dist/langs/vue.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
}

const aliases: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', shellscript: 'bash', console: 'bash',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', yml: 'yaml', md: 'markdown', 'c++': 'cpp', cs: 'csharp', 'c#': 'csharp',
  kt: 'kotlin', docker: 'dockerfile', patch: 'diff', golang: 'go', htm: 'html', xml: 'html',
}

export function canonicalLang(lang: string): string | null {
  const l = lang.toLowerCase()
  const name = aliases[l] ?? l
  return name in loaders ? name : null
}

export const supportedLanguages = Object.keys(loaders)

let core: Promise<HighlighterCore> | null = null
let ready: HighlighterCore | null = null
const loaded = new Set<string>()
const loading = new Map<string, Promise<void>>()

function getCore(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/dist/themes/github-light.mjs'),
      import('shiki/dist/themes/github-dark.mjs'),
    ])
    const h = await createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
    ready = h
    return h
  })()
  return core
}

/** Load grammars for `langs` (unknown names are ignored). Resolves true if anything new loaded. */
export async function ensureLanguages(langs: readonly string[]): Promise<boolean> {
  const wanted = [...new Set(langs.map(canonicalLang).filter((l): l is string => !!l && !loaded.has(l)))]
  if (!wanted.length) return false
  const h = await getCore()
  await Promise.all(wanted.map((name) => {
    let p = loading.get(name)
    if (!p) {
      p = loaders[name]!().then(async (mod) => {
        await h.loadLanguage(mod.default)
        loaded.add(name)
      })
      loading.set(name, p)
    }
    return p
  }))
  return true
}

/** Synchronous highlight for markdown-it; null when the grammar is not loaded yet. */
export function highlight(code: string, lang: string): string | null {
  const name = canonicalLang(lang)
  if (!ready || !name || !loaded.has(name)) return null
  try {
    return ready.codeToHtml(code, {
      lang: name,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
  }
  catch {
    return null
  }
}
