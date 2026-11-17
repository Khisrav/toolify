export default defineAppConfig({
  ui: {
    colors: { primary: 'indigo', neutral: 'zinc' },
    // Touch targets: md (32-36px) on fine pointers, >=44px on coarse pointers.
    button: {
      slots: { base: 'pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-default' },
    },
    input: { slots: { base: 'pointer-coarse:min-h-11' } },
    select: { slots: { base: 'pointer-coarse:min-h-11' } },
    tabs: { slots: { trigger: 'pointer-coarse:min-h-11' } },
    navigationMenu: { slots: { link: 'pointer-coarse:min-h-11' } },
    slider: { slots: { thumb: 'size-5 pointer-coarse:size-7' } },
  },
})
