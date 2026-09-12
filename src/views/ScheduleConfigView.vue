<script setup lang="ts">
/**
 * 排班配置页（SRS F03）：工时上下限、同时段人数、排班周期、启用时段。
 * 规则持久化于 config 表 key='rules'，排班页读取后传给算法。
 *
 * T-008 教训落地：进出响应式边界都要纯对象——读取用 JSON 深拷贝，保存也用。
 */
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { configRepo, operationLogRepo } from '../db/repositories'
import { DEFAULT_RULES, DEFAULT_SLOT_TEMPLATES, type SchedulingRules } from '../algorithms/types'

const form = reactive<SchedulingRules>(JSON.parse(JSON.stringify(DEFAULT_RULES)))
const enabledKeys = ref<string[]>(DEFAULT_SLOT_TEMPLATES.map((t) => t.key))
const saving = ref(false)

onMounted(async () => {
  const saved = await configRepo.get<SchedulingRules>('rules')
  if (saved) {
    Object.assign(form, saved)
    enabledKeys.value = saved.slotTemplates.map((t) => t.key)
  }
})

function validate(): string | null {
  if (form.weekStart < 1 || form.weekEnd < form.weekStart) return '排班周期不合法（起 ≤ 止，且从第 1 周起）'
  if (form.minSectionsPerAssistant > form.maxSectionsPerAssistant) return '每人最少工时不能大于最多工时'
  if (form.minPerSlot > form.maxPerSlot) return '同时段最少人数不能大于最多人数'
  if (enabledKeys.value.length === 0) return '至少启用一个时段'
  return null
}

async function save() {
  const err = validate()
  if (err) return ElMessage.error(err)
  saving.value = true
  try {
    const rules: SchedulingRules = JSON.parse(
      JSON.stringify({
        ...form,
        slotTemplates: DEFAULT_SLOT_TEMPLATES.filter((t) => enabledKeys.value.includes(t.key)),
      }),
    )
    await configRepo.set('rules', rules)
    await operationLogRepo.add('rules.update', { weekRange: [rules.weekStart, rules.weekEnd] })
    ElMessage.success('排班规则已保存')
  } finally {
    saving.value = false
  }
}

function resetDefaults() {
  Object.assign(form, JSON.parse(JSON.stringify(DEFAULT_RULES)))
  enabledKeys.value = DEFAULT_SLOT_TEMPLATES.map((t) => t.key)
  ElMessage.info('已恢复默认值（尚未保存）')
}
</script>

<template>
  <el-card>
    <template #header>排班规则</template>
    <el-form label-width="160px" style="max-width: 640px">
      <el-form-item label="排班周期">
        <el-input-number v-model="form.weekStart" :min="1" :max="30" /> 周
        <span class="sep">至</span>
        <el-input-number v-model="form.weekEnd" :min="1" :max="30" /> 周
      </el-form-item>
      <el-form-item label="每人最少值班节数">
        <el-input-number v-model="form.minSectionsPerAssistant" :min="0" :max="40" /> 节
      </el-form-item>
      <el-form-item label="每人最多值班节数">
        <el-input-number v-model="form.maxSectionsPerAssistant" :min="1" :max="60" /> 节
      </el-form-item>
      <el-form-item label="同时段最少人数">
        <el-input-number v-model="form.minPerSlot" :min="0" :max="10" /> 人
      </el-form-item>
      <el-form-item label="同时段最多人数">
        <el-input-number v-model="form.maxPerSlot" :min="1" :max="10" /> 人
      </el-form-item>
      <el-form-item label="启用时段">
        <el-checkbox-group v-model="enabledKeys">
          <el-checkbox v-for="t in DEFAULT_SLOT_TEMPLATES" :key="t.key" :value="t.key">
            {{ t.label }}（{{ t.sectionStart }}~{{ t.sectionEnd }} 节）
          </el-checkbox>
        </el-checkbox-group>
        <div class="hint">中课 / 晚课时段暂不支持排班（非数字节次）</div>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存规则</el-button>
        <el-button @click="resetDefaults">恢复默认</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<style scoped>
.sep { margin: 0 10px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; width: 100%; }
</style>
