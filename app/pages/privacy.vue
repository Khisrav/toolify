<script setup lang="ts">
useSeoMeta({ title: 'Privacy · Toolify' })
</script>

<template>
  <UContainer class="max-w-2xl py-8">
    <article class="prose max-w-none">
      <h1>Privacy</h1>
      <p>
        Toolify is designed so that your files never leave your device. This page explains what that means in practice and how you can check it yourself.
      </p>

      <h2>Your files stay on your device</h2>
      <p>
        Every tool runs in your browser. Files are read, converted, compressed and resized locally using WebAssembly and Web Workers, which keep the work off the main page. Nothing you open or create is uploaded to a server.
      </p>

      <h2>No accounts, cookies, analytics or trackers</h2>
      <p>
        Toolify does not ask you to sign up or sign in. It sets no cookies and includes no analytics, advertising or tracking code.
      </p>

      <h2>Works offline after the first load</h2>
      <p>
        Once the app has loaded, it is cached by your browser and keeps working without a connection. Processing engines are also cached on the device the first time they are needed.
      </p>

      <h2>Network access is blocked</h2>
      <p>
        A Content Security Policy (<code>connect-src 'self'</code>) limits the page to talking only to this site. Even if something tried to send your data elsewhere, the browser would refuse the request.
      </p>

      <h2>Settings stay in this browser</h2>
      <p>
        Your preferences are saved in the browser’s local storage. They are not synced to any account or server, and they stay on this device. You can reset them at any time on the <NuxtLink to="/settings">settings page</NuxtLink>.
      </p>

      <h2>Engines are cached on the device</h2>
      <p>
        Processing engines are stored in the browser’s cache so they load quickly next time. You can clear them from the settings page at any time.
      </p>

      <h2>Check it yourself</h2>
      <p>You do not need to take our word for any of this. Try either of these:</p>
      <ol>
        <li>
          Open your browser’s developer tools, go to the <strong>Network</strong> tab, and convert a file. You will see no uploads of your file, only the app’s own resources.
        </li>
        <li>
          Turn off your internet connection, or switch your device to airplane mode, and then convert a file. The tool should keep working.
        </li>
      </ol>
    </article>
  </UContainer>
</template>
