<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { InfoFilled, Odometer, User, Reading, Setting, Calendar, QuestionFilled } from '@element-plus/icons-vue'
import HelpDrawer from '../components/HelpDrawer.vue'
import { APP_META } from '../meta'

// 布局组件：左侧固定菜单 + 右侧内容区。menu 的 router 模式开启后，
// el-menu-item 的 index 直接作为路由路径使用。
// 顶部右侧的"使用帮助"按钮全局可见，点击打开侧边帮助面板（关闭后回到原界面）。
// 侧栏底部为版本 / 作者 / 仓库等元信息入口（"关于系统"）。
const route = useRoute()
const helpVisible = ref(false)
const aboutVisible = ref(false)
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
      <div class="aside-footer">
        <el-button link size="small" @click="aboutVisible = true">
          <el-icon style="margin-right: 4px"><InfoFilled /></el-icon>
          关于系统（{{ APP_META.version }}）
        </el-button>
      </div>
    </el-aside>
    <el-main class="main">
      <div class="page-header">
        <div class="page-title">{{ route.meta.title }}</div>
        <el-button :icon="QuestionFilled" @click="helpVisible = true">使用帮助</el-button>
      </div>
      <router-view />
    </el-main>
  </el-container>

  <HelpDrawer v-model="helpVisible" />

  <el-dialog v-model="aboutVisible" title="关于系统" width="440px" :append-to-body="true">
    <div class="about">
      <div class="about-name">
        {{ APP_META.name }}（{{ APP_META.shortName }}）
        <el-tag size="small" class="about-version">{{ APP_META.version }}</el-tag>
      </div>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="版本">{{ APP_META.version }}</el-descriptions-item>
        <el-descriptions-item label="作者">{{ APP_META.author }}</el-descriptions-item>
        <el-descriptions-item label="GitHub">
          <a
            v-if="APP_META.repository"
            :href="APP_META.repository"
            target="_blank"
            rel="noopener"
          >{{ APP_META.repository }}</a>
          <span v-else class="about-muted">待填写（占位）</span>
        </el-descriptions-item>
        <el-descriptions-item label="简介">{{ APP_META.description }}</el-descriptions-item>
        <el-descriptions-item label="运行环境">Windows 10+（WebView2）· 数据仅存本机</el-descriptions-item>
      </el-descriptions>
    </div>
    <template #footer>
      <el-button type="primary" @click="aboutVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.layout { height: 100vh; }
.aside {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--el-border-color-light);
}
.brand {
  font-weight: 600; font-size: 15px; padding: 18px 16px;
  color: var(--el-color-primary); letter-spacing: 0.5px;
}
.menu { flex: 1; border-right: none; }
.aside-footer {
  padding: 10px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.main { background: var(--el-fill-color-lighter); }
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.page-title {
  font-size: 17px;
  font-weight: 600;
}
.about-name {
  font-weight: 600;
  margin-bottom: 10px;
}
.about-version { margin-left: 6px; }
.about-muted { color: var(--el-text-color-secondary); }
</style>
