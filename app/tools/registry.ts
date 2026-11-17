/**
 * Lazy loaders for each tool's workspace component. Only `available` tools have one.
 * Each import becomes its own chunk, so a tool's heavy dependencies load only on its page.
 */
import type { Component } from 'vue'

type Loader = () => Promise<{ default: Component }>

export const toolLoaders: Record<string, Loader> = {
  'image-studio': () => import('./image-studio/Tool.vue'),
}
