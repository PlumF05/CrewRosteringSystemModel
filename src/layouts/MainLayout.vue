<script setup lang="ts">
import { useRoute } from 'vue-router'
import { Odometer, User, Reading, Setting, Calendar } from '@element-plus/icons-vue'

// 布局组件：左侧固定菜单 + 右侧内容区。menu 的 router 模式开启后，
// el-menu-item 的 index 直接作为路由路径使用
const route = useRoute()
</script>

<template>
  <el-container class="layout">
    <el-aside width="200px" class="aside">
      <div class="brand">行政办助理排班系统</div>
      <el-menu router :default-active="route.path" class="menu">
        <el-menu-item index="/"><el-icon><Odometer /></el-icon><span>仪表盘</span></el-menu-item>
        <el-menu-item index="/assistants"><el-icon><User /></el-icon><span>助理管理</span></el-menu-item>
        <el-menu-item index="/courses"><el-icon><Reading /></el-icon><span>课程表管理</span></el-menu-item>
        <el-menu-item index="/config"><el-icon><Setting /></el-icon><span>排班配置</span></el-menu-item>
        <el-menu-item index="/schedule"><el-icon><Calendar /></el-icon><span>排班表</span></el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="main">
      <el-page-header :content="route.meta.title as string" class="page-head" v-if="route.path !== '/'" />
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.layout { height: 100vh; }
.aside { border-right: 1px solid var(--el-border-color-light); }
.brand {
  font-weight: 600; font-size: 15px; padding: 18px 16px;
  color: var(--el-color-primary); letter-spacing: 0.5px;
}
.menu { border-right: none; }
.main { background: var(--el-fill-color-lighter); }
.page-head { margin-bottom: 14px; }
</style>
