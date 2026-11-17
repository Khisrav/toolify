<script setup lang="ts">
import type { ToolMeta } from '~/tools/meta'
import ImageStudio from './ImageStudio.vue'

defineProps<{ meta: ToolMeta }>()
</script>

<template>
  <ImageStudio :meta="meta" />
</template>
