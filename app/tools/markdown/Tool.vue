<script setup lang="ts">
import type { ToolMeta } from '~/tools/meta'
import MarkdownEditor from './MarkdownEditor.vue'

defineProps<{ meta: ToolMeta }>()
</script>

<template>
  <MarkdownEditor :meta="meta" />
</template>
