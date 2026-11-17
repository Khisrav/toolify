<template>
  <NuxtLink
    to="/privacy"
    class="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-coarse:min-h-11 pointer-coarse:items-center"
    aria-label="Private, on-device processing. Read the privacy details"
  >
    <UBadge color="success" variant="subtle" icon="i-lucide-shield-check" label="Private · on-device" class="max-sm:[&>[data-slot=label]]:hidden" />
  </NuxtLink>
</template>
