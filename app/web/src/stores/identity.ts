/*
 * Who the browser is. Identity is carried entirely by the cm_guest /
 * cm_session cookies, so this store only mirrors what GET /api/identity says
 * and never holds a token of its own.
 */
import { computed, reactive } from "vue";
import { ApiError, api, type IdentityState } from "../lib/api";

interface State {
  state: IdentityState;
  username: string | null;
  loaded: boolean;
  /** True while a claim / register / login request is in flight. */
  busy: boolean;
}

export const identity = reactive<State>({
  state: "anonymous",
  username: null,
  loaded: false,
  busy: false,
});

export const isAnonymous = computed(() => identity.state === "anonymous");
export const isGuest = computed(() => identity.state === "guest");
export const isAccount = computed(() => identity.state === "account");
/** Guests and accounts can both write; anonymous browsers cannot. */
export const canWrite = computed(() => identity.state !== "anonymous");

function apply(state: IdentityState, username: string | null): void {
  identity.state = state;
  identity.username = username;
}

export async function loadIdentity(): Promise<void> {
  try {
    const me = await api.identity();
    apply(me.state, me.username ?? null);
  } catch (err) {
    // A banned identity gets 403 on every endpoint including this one, so the
    // browser cannot read its own state; treat that as anonymous and let the
    // first write surface the ban message.
    if (!(err instanceof ApiError)) throw err;
    apply("anonymous", null);
  } finally {
    identity.loaded = true;
  }
}

export async function claimGuest(username: string): Promise<void> {
  identity.busy = true;
  try {
    const res = await api.claimGuest(username);
    apply("guest", res.username);
  } finally {
    identity.busy = false;
  }
}

export async function registerAccount(input: {
  username?: string;
  email: string;
  password: string;
}): Promise<void> {
  identity.busy = true;
  try {
    const res = await api.register(input);
    apply("account", res.username);
  } finally {
    identity.busy = false;
  }
}

export async function login(identifier: string, password: string): Promise<void> {
  identity.busy = true;
  try {
    const res = await api.login(identifier, password);
    apply("account", res.username);
  } finally {
    identity.busy = false;
  }
}

export async function logout(): Promise<void> {
  identity.busy = true;
  try {
    await api.logout();
  } catch (err) {
    // 401 just means there was no session to end; anything else still leaves
    // the browser without a usable session, so fall through either way.
    if (!(err instanceof ApiError)) throw err;
  } finally {
    identity.busy = false;
  }
  // Logging out clears cm_session but leaves any cm_guest cookie in place, so
  // re-read rather than assuming the browser is now anonymous.
  await loadIdentity();
}
