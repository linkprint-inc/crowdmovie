import { onMounted, ref, type Ref } from "vue";
import { ApiError } from "./api";
import { translateError } from "../i18n";

/**
 * One-shot page data with the three states every page needs: loading, loaded,
 * and "the endpoint is not built yet". A 404 sets `missing` rather than
 * `error`, so a page whose API has not shipped renders an empty state instead
 * of shouting about a failure the reader cannot act on.
 */
export function useResource<T>(
  loader: () => Promise<T>,
  options: { immediate?: boolean } = {},
): {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  missing: Ref<boolean>;
  error: Ref<string>;
  reload: () => Promise<void>;
} {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(true);
  const missing = ref(false);
  const error = ref("");

  async function reload(): Promise<void> {
    loading.value = true;
    error.value = "";
    missing.value = false;
    try {
      data.value = await loader();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.notImplemented) missing.value = true;
      else error.value = translateError(err.code, err.message);
    } finally {
      loading.value = false;
    }
  }

  if (options.immediate !== false) onMounted(reload);
  return { data, loading, missing, error, reload };
}
