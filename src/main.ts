import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";
import "./assets/theme.css";

// 装配顺序：Pinia(状态) → Router(路由) → 挂载
// 类比 Spring：注册各 starter 到容器，最后启动
//
// Element Plus 不在这里全局注册（S6/按需引入）：unplugin-auto-import /
// unplugin-vue-components 按 Vite 配置对模板中的 el-* 组件与 ElMessage 等
// API 做逐组件注入（含样式），全局 use 反而会把整个组件库打进入口 chunk。
// 全局视觉主题统一在 assets/theme.css 用 Element 的 CSS 变量覆盖。
createApp(App).use(createPinia()).use(router).mount("#app");
