/** Standalone HTML export: one self-contained file (inline CSS, Shiki colours, no scripts). */
import markdownCss from './markdown.css?raw'

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const pageCss = `
html { background: #ffffff; }
body { margin: 0; }
main { max-width: 52rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
@media (prefers-color-scheme: dark) {
  html { background: #0d1117; color-scheme: dark; }
}
`

/** Dark rules duplicated under prefers-color-scheme, since the export has no `.dark` toggle. */
function darkMediaCss(css: string): string {
  const rules: string[] = []
  for (const m of css.matchAll(/([^{}]*\.md-dark[^{}]*)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(',').map(s => s.trim()).filter(s => s.startsWith('.md-dark')).map(s => s.replace(/^\.md-dark\s*/, ''))
    if (selectors.length) rules.push(`${selectors.join(', ')} {${m[2]}}`)
  }
  return `@media (prefers-color-scheme: dark) {\n${rules.join('\n')}\n}`
}

export function buildHtmlDocument(bodyHtml: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Toolify Markdown Editor">
<title>${escapeHtml(title)}</title>
<style>
${markdownCss}
${darkMediaCss(markdownCss)}
${pageCss}
</style>
</head>
<body>
<main class="md-body">
${bodyHtml}
</main>
</body>
</html>
`
}
