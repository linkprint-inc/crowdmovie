import { createApp } from "vue";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/live.css";
import "./styles/pages.css";
import "./styles/studio.css";

import App from "./App.vue";
import { router } from "./router";
import { locale } from "./i18n";

document.documentElement.lang = locale.value;

createApp(App).use(router).mount("#app");
