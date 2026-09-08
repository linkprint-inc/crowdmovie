/* The quick-start modal is the only identity entry point site-wide (spec §2.5),
   so its open state lives here rather than inside any one page. */
import { ref } from "vue";

export const authModalOpen = ref(false);

export function openAuth(): void {
  authModalOpen.value = true;
}

export function closeAuth(): void {
  authModalOpen.value = false;
}
