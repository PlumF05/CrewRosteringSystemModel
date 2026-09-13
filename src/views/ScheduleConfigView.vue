<script setup lang="ts">
/**
 * 排班配置页（SRS F03，2026-09-11 修订版）：
 * 周期 / 工时上下限 / 同时段人数 / 工作日 / 上班节次 / 排班模式 / 课程占用过滤。
 * 规则持久化于 config 表 key='rules'；读取时经 normalizeRules 兼容旧版配置。
 * T-008 教训落地：进出响应式边界都用纯对象（JSON 深拷贝）。
 */
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { configRepo, operationLogRepo } from '../db/repositories'
import { DEFAULT_RULES, normalizeRules, type SchedulingRules } from '../algorithms/types'

const form = reactive<SchedulingRules>(JSON.parse(JSON.stringify(DEFAULT_RULES)))
const saving = ref(false)

const DAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
]

onMounted(async () => {
  const saved = await configRepo.get<SchedulingRules>('rules')
  Object.assign(form, normalizeRules(saved))
})

function validate(): string | null {
  if (form.weekStart < 1 || form.weekEnd < form.weekStart) return '排班周期不合法（起 ≤ 止，且从第 1 周起）'
  if (form.minSectionsPerAssistant > form.maxSectionsPerAssistant) return '每人最少工时不能大于最多工时'
  if (form.minPerSlot > form.maxPerSlot) return '同时段最少人数不能大于最多人数'
  if (form.workdays.length === 0) return '至少选择一个工作日'
  if (form.workSections.length === 0) return '至少设置一个上班节次区间'
  for (const s of form.workSections) {
    if (s.start < 1 || s.end > 13 || s.end < s.start) return `节次区间不合法：第 ${s.start}~${s.end} 节`
  }
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
        workdays: [...form.workdays].sort((a, b) => a - b),
        workSections: [...form.workSections].sort((a, b) => a.start - b.start),
      }),
    )
    await configRepo.set('rules', rules)
    await operationLogRepo.add('rules.update', {
      weekRange: [rules.weekStart, rules.weekEnd],
      mode: rules.uniformMode ? 'uniform' : 'perWeek',
    })
    ElMessage.success('排班规则已保存')
  } finally {
    saving.value = false
  }
}

function resetDefaults() {
  Object.assign(form, JSON.parse(JSON.stringify(DEFAULT_RULES)))
  ElMessage.info('已恢复默认值（尚未保存）')
}

function addSection() {
  form.workSections.push({ start: 13, end: 13, label: '加时' })
}

function removeSection(idx: number) {
  form.workSections.splice(idx, 1)
}
</script>

<template>
  <el-card>
    <template #header>排班规则</template>
    <el-form label-width="170px" style="max-width: 680px">
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

      <el-form-item label="工作日">
        <el-checkbox-group v-model="form.workdays">
          <el-checkbox v-for="d in DAY_OPTIONS" :key="d.value" :value="d.value">{{ d.label }}</el-checkbox>
        </el-checkbox-group>
      </el-form-item>

      <el-form-item label="上班节次区间">
        <div class="sections">
          <div v-for="(s, i) in form.workSections" :key="i" class="section-row">
            <el-input v-model="s.label" placeholder="名称" style="width: 90px" />
            <span>第</span>
            <el-input-number v-model="s.start" :min="1" :max="13" controls-position="right" style="width: 90px" />
            <span>~</span>
            <el-input-number v-model="s.end" :min="1" :max="13" controls-position="right" style="width: 90px" />
            <span>节</span>
            <el-button
              link
              type="danger"
              :disabled="form.workSections.length <= 1"
              @click="removeSection(i)"
            >
              删除
            </el-button>
          </div>
          <el-button link type="primary" @click="addSection">+ 添加节次区间</el-button>
          <div class="hint">排班只发生在工作日的这些节次内；默认上午 1~4 节、下午 8~11 节</div>
        </div>
      </el-form-item>

      <el-form-item label="排班模式">
        <el-radio-group v-model="form.uniformMode">
          <el-radio :value="false">各周独立排班（按每周课程分别计算）</el-radio>
          <el-radio :value="true">各周排班相同（任一周有课即占用，复制到全部周）</el-radio>
        </el-radio-group>
        <div class="hint">导出使用单周排班表时，建议选"各周排班相同"</div>
      </el-form-item>

      <el-form-item label="课程占用过滤">
        <el-checkbox v-model="form.countTheory">理论课（（本）/（研））计入占用</el-checkbox>
        <el-checkbox v-model="form.countExperiment">实验课（（实））计入占用</el-checkbox>
      </el-form-item>

      <el-form-item label="最少连续值班节数">
        <el-input-number v-model="form.minConsecutiveSections" :min="1" :max="8" /> 节
        <div class="hint">
          大于 1 时，孤立的单节值班不会被安排。例：某助理第 9~10 节有课、最少连续 2 节时，
          第 11 节（其可值班连续段仅剩 1 节）不会排给他
        </div>
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
.sections { width: 100%; }
.section-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
</style>
