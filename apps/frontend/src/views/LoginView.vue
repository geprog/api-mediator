<script setup lang="ts">
import Button from "primevue/button";
import Message from "primevue/message";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useAuthStore } from "../stores/auth.js";

/**
 * Operator login (OA follow-up). Collects the HTTP Basic credential and hands it to
 * the auth store, which installs it and resolves the role via `GET /api/session`.
 * On success it navigates to the originally-requested route (the `redirect` query
 * set by the auth guard) or the proposals list. The password is never bound to
 * anything durable — the store keeps only the derived header in memory.
 */
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref<string>("");
const password = ref<string>("");
const submitting = ref<boolean>(false);

async function submit(): Promise<void> {
  submitting.value = true;
  try {
    const ok = await auth.logIn(username.value, password.value);
    if (ok) {
      const redirect = route.query["redirect"];
      const target = typeof redirect === "string" && redirect !== "" ? redirect : "/proposals";
      await router.push(target);
    }
  } finally {
    submitting.value = false;
  }
}

function onSubmit(): void {
  void submit();
}
</script>

<template>
  <main class="login">
    <form class="login__form" data-testid="login-form" @submit.prevent="onSubmit">
      <h1>Sign in</h1>
      <p class="login__hint">
        The operator API requires an authenticated identity. Use your local account (operator or
        viewer).
      </p>

      <label class="login__field">
        Username
        <input
          v-model="username"
          type="text"
          autocomplete="username"
          data-testid="login-username"
        />
      </label>

      <label class="login__field">
        Password
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          data-testid="login-password"
        />
      </label>

      <Message v-if="auth.loginError !== null" severity="error" data-testid="login-error">
        {{ auth.loginError }}
      </Message>

      <Button
        type="submit"
        label="Sign in"
        :disabled="submitting || username === '' || password === ''"
        data-testid="login-submit"
      />
    </form>
  </main>
</template>

<style scoped>
.login {
  display: flex;
  justify-content: center;
  padding: 3rem 1.5rem;
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  max-width: 22rem;
}

.login__hint {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}

.login__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
</style>
