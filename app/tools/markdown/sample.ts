/** First-run document: shows what the editor supports. */
export const sampleDocument = `# Welcome to the Markdown editor

Write on the left, see the result on the right. Everything stays **on your device**: the draft is saved in this browser only.

## Formatting

You can use **bold**, _italic_, ~~strikethrough~~, \`inline code\` and [links](#tables).

> Tip: select text and press **Ctrl B**, **Ctrl I** or **Ctrl K**.

## Lists

- Bullets
  - and nested bullets
1. Numbered
2. Lists

- [x] Task lists
- [ ] with checkboxes

## Code

\`\`\`ts
function greet(name: string): string {
  return \`Hello, \${name}!\`
}
\`\`\`

## Tables

| Feature | Supported |
| --- | :---: |
| GFM tables | ✓ |
| Syntax highlighting | ✓ |
| HTML / PDF export | ✓ |

---

Use **File** to open a \`.md\` file, save it back, export a self-contained HTML page, or print to PDF.
`
