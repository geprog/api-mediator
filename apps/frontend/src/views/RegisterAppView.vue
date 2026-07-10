<script setup lang="ts">
import RegistrationForm from "../components/registration/RegistrationForm.vue";

/** Registration page (AR-3): hosts the app registration form. */
</script>

<template>
  <main class="register-view">
    <h1>Register an app</h1>
    <RegistrationForm />
  </main>
</template>

<style scoped>
.register-view {
  padding: 1.5rem;
}
</style>
