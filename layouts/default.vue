<template>
  <div class="h-screen flex flex-col">
    <header
      class="flex w-full items-center justify-center border-b border-gray-300 bg-white p-4"
    >
      <nuxt-link to="/" class="flex items-center gap-4">
        <span class="text-gray-900">API Mediator</span>
      </nuxt-link>
    </header>

    <main class="flex flex-col p-4 h-full gap-4">
      <slot />
    </main>
  </div>
</template>
