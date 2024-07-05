<template>
  <UFormGroup label="Base URL where the API is running">
    <UInput v-model="baseUrl" icon="i-heroicons-envelope" />
  </UFormGroup>
  <UButton @click="open" :loading="uploading">
    Select OpenAPI specification
  </UButton>
  <UButton @click="addApi" :disabled="!baseUrl && (files || []).length === 1"
    >Add</UButton
  >
  <UButton @click="backToHome">Cancel</UButton>
</template>

<script setup lang="ts">
import { useFileDialog } from '@vueuse/core';

const baseUrl = ref('');

const { open, files } = useFileDialog({
  accept: 'yaml, yml, json',
  multiple: false,
});

const uploading = ref(false);

async function addApi() {
  if (!files.value || files.value.length !== 1 || !baseUrl.value) {
    return;
  }

  uploading.value = true;

  const reader = new FileReader();
  reader.addEventListener(
    'load',
    async () => {
      // this will then display a text file
      const payload = {
        baseUrl: baseUrl.value,
        openApiSpec: reader.result,
      };
      try {
        await $fetch('/api/api/add', {
          method: 'POST',
          body: payload,
        });

        useToast().add({ title: 'Upload successful', color: 'green' });
      } catch (error) {
        useToast().add({ title: 'Upload failed', color: 'red' });
        console.error(error);
      }
      uploading.value = false;
      await backToHome();
    },
    false,
  );

  reader.readAsText(files.value[0]);
}

async function backToHome() {
  await useRouter().push('/');
}
</script>
