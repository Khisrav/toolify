<script setup lang="ts">
import type { ToolMeta } from '~/tools/meta'
import type { QuickAction } from '~/tools/_video-engine/video'
import VideoQuick from './VideoQuick.vue'

const props = defineProps<{ meta: ToolMeta }>()
// The compressor card opens the same workspace with "Compress" preselected.
const initialAction: QuickAction | undefined = props.meta.slug === 'video-optimize' ? 'compress' : undefined
</script>

<template>
  <VideoQuick :meta="meta" :initial-action="initialAction" />
</template>
