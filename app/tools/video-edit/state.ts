/** One id per page load; the worker sweeps OPFS temp files left by earlier sessions. */
export const videoSession = Math.random().toString(36).slice(2, 10)
