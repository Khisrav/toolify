import { availableTools } from './meta'

/** Routes to prerender (consumed by nuxt.config). */
export const toolRoutes = availableTools.map(t => `/tools/${t.slug}`)
