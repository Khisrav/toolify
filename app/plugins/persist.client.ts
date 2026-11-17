import { createPersistedState } from 'pinia-plugin-persistedstate'

/** Registered manually: @pinia-plugin-persistedstate/nuxt pins an incompatible @pinia/nuxt. */
export default defineNuxtPlugin(({ $pinia }) => {
  ;($pinia as import('pinia').Pinia).use(createPersistedState({
    storage: {
      getItem: (k) => {
        try {
          return localStorage.getItem(k)
        }
        catch {
          return null
        }
      },
      setItem: (k, v) => {
        try {
          localStorage.setItem(k, v)
        }
        catch { /* private mode / quota: settings just won't persist */ }
      },
    },
  }))
})
