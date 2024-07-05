// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },
  telemetry: false,
  modules: ['@nuxt/ui'],
  css: ['v-network-graph/lib/style.css'],

  runtimeConfig: {
    dataPath: './data',
  },

  colorMode: {
    preference: 'light',
  },

  typescript: {
    strict: true,
  },

  nitro: {
    storage: {
      fs: {
        driver: 'fs',
        base: './.data/storage',
      },
    },
  },

  app: {
    head: {
      title: 'API Mediator',
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1',
    },
  },

  compatibilityDate: '2024-07-05',
});