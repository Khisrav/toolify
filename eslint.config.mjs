// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  { ignores: ['.output/**', 'node_modules/**', 'public/**'] },
  // Each tool module's entry component is named Tool.vue by convention (loaded via the registry).
  { files: ['app/tools/*/Tool.vue'], rules: { 'vue/multi-word-component-names': 'off' } },
)
