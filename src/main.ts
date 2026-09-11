import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import router from "./router";

// 装配顺序：Pinia(状态) → Router(路由) → ElementPlus(组件库) → 挂载
// 类比 Spring：注册各 starter 到容器，最后启动
createApp(App).use(createPinia()).use(router).use(ElementPlus).mount("#app");
