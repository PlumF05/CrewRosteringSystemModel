import { createRouter, createWebHashHistory } from 'vue-router'
import MainLayout from '../layouts/MainLayout.vue'

/**
 * 前端路由表：URL → 页面组件的映射，切换时不发任何 HTTP 请求。
 *
 * 选 createWebHashHistory（hash 模式，URL 形如 /#/assistants）而非 history 模式：
 * Tauri 发布版从 tauri:// 协议加载单文件产物，history 模式刷新深层路径会 404，
 * hash 模式对桌面应用最稳。类比：后端只挂一个 /* 兜底，其余路由应用内自分发。
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: MainLayout,
      children: [
        { path: '', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '仪表盘' } },
        { path: 'assistants', name: 'assistants', component: () => import('../views/AssistantsView.vue'), meta: { title: '助理管理' } },
        { path: 'courses', name: 'courses', component: () => import('../views/CoursesView.vue'), meta: { title: '课程表管理' } },
        { path: 'config', name: 'config', component: () => import('../views/ScheduleConfigView.vue'), meta: { title: '排班配置' } },
        { path: 'schedule', name: 'schedule', component: () => import('../views/ScheduleView.vue'), meta: { title: '排班表' } },
      ],
    },
  ],
})

export default router
