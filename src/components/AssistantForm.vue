<script setup lang="ts">
/**
 * 助理表单弹窗（新增/编辑复用同一表单——editing 有值为编辑模式）。
 *
 * 关键点：
 * 1. v-model 控制显隐：显式 defineProps/defineEmits 实现"父子组件契约"；
 * 2. watch(assistant) 在打开瞬间把父组件传入的行数据深拷贝进本地表单——
 *    不直接改父数据（单向数据流），取消编辑也不会污染列表；
 * 3. 校验分两层：同步规则（rules：必填/正则）+ 异步查重（学号唯一，查数据库）。
 */
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { assistantRepo, configRepo, operationLogRepo } from '../db/repositories'
import type { Assistant, Identity } from '../db/schema'
import { IDENTITY_OPTIONS } from '../utils/dict'
import { normalizeRules, type SchedulingRules } from '../algorithms/types'

const props = defineProps<{ modelValue: boolean; assistant: Assistant | null }>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>()

const visible = ref(props.modelValue)
watch(() => props.modelValue, (v) => (visible.value = v))
watch(visible, (v) => emit('update:modelValue', v))

const formRef = ref<FormInstance>()
const saving = ref(false)

/** 全局默认值班节数（用于开关开启时的预填与界面提示） */
const globalSections = ref({ min: 0, max: 0 })
onMounted(async () => {
  const saved = normalizeRules(await configRepo.get<SchedulingRules>('rules'))
  globalSections.value = { min: saved.minSectionsPerAssistant, max: saved.maxSectionsPerAssistant }
})

const form = reactive({
  id: undefined as number | undefined,
  name: '',
  studentNo: '',
  identity: 'undergrad' as Identity,
  phone: '',
  qq: '',
  className: '',
  /** 个性化值班节数（2026-09-13 增补）：关闭 = 跟随全局默认 */
  customSections: false,
  customMinSections: undefined as number | undefined,
  customMaxSections: undefined as number | undefined,
})

/**
 * 在"弹窗打开"时机重置/填充表单，而不是 watch(assistant)：
 * 连续两次新增时 assistant 一直是 null，prop watch 不触发，表单会残留上次数据
 * （GUI 走查实测踩坑，已记入排查手册 T-006）。
 */
watch(visible, (v) => {
  if (!v) return
  const a = props.assistant
  form.id = a?.id
  form.name = a?.name ?? ''
  form.studentNo = a?.studentNo ?? ''
  form.identity = a?.identity ?? 'undergrad'
  form.phone = a?.phone ?? ''
  form.qq = a?.qq ?? ''
  form.className = a?.className ?? ''
  // 个性化值班节数：有任一覆盖值即视为开启
  form.customSections = a?.customMinSections !== undefined || a?.customMaxSections !== undefined
  form.customMinSections = a?.customMinSections
  form.customMaxSections = a?.customMaxSections
  formRef.value?.clearValidate()
})

// 开启"单独设置"但尚未填值时，用全局默认预填，用户在其基础上微调即可
watch(
  () => form.customSections,
  (on) => {
    if (on && form.customMinSections === undefined && form.customMaxSections === undefined) {
      form.customMinSections = globalSections.value.min
      form.customMaxSections = globalSections.value.max
    }
  },
)

/** 异步校验器：学号唯一性（排除自身；新增时 editing 为 null 全表查重） */
const validateStudentNoUnique = async (_rule: unknown, value: string, callback: (err?: Error) => void) => {
  if (!value) return callback()
  const dup = await assistantRepo.findByStudentNo(value)
  if (dup && dup.id !== form.id) return callback(new Error('该学号已存在'))
  callback()
}

/** 个性化值班节数：开启时必须成对填写且 最少 ≤ 最多 */
const validateCustomSections = (
  _rule: unknown,
  _value: unknown,
  callback: (err?: Error) => void,
) => {
  if (
    form.customSections &&
    form.customMinSections !== undefined &&
    form.customMaxSections !== undefined &&
    form.customMinSections > form.customMaxSections
  ) {
    return callback(new Error('最少值班节数不能大于最多值班节数'))
  }
  callback()
}

const rules: FormRules = {
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  studentNo: [
    { required: true, message: '请输入学号', trigger: 'blur' },
    { validator: validateStudentNoUnique, trigger: 'blur' },
  ],
  identity: [{ required: true, message: '请选择身份类型', trigger: 'change' }],
  phone: [
    {
      // 可填但填了必须合法：手机号正则（SRS 5.3 格式校验要求）
      pattern: /^1[3-9]\d{9}$/,
      message: '手机号格式不正确（11 位，1 开头）',
      trigger: 'blur',
    },
  ],
  customMinSections: [{ validator: validateCustomSections, trigger: 'change' }],
  customMaxSections: [{ validator: validateCustomSections, trigger: 'change' }],
}

async function handleSave() {
  // validate() 不通过时抛出校验错误对象，用 try/catch 吞掉即可（界面已红字提示）
  try {
    await formRef.value?.validate()
  } catch (e) {
    console.error("[form] validate 未通过", e)
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      studentNo: form.studentNo.trim(),
      identity: form.identity,
      phone: form.phone.trim() || undefined,
      qq: form.qq.trim() || undefined,
      className: form.className.trim() || undefined,
      // 关闭"单独设置"时显式传 undefined → 仓储层会删除旧覆盖值（不再残留生效）
      customMinSections: form.customSections ? form.customMinSections : undefined,
      customMaxSections: form.customSections ? form.customMaxSections : undefined,
    }
    if (form.id === undefined) {
      await assistantRepo.add(payload)
      await operationLogRepo.add('assistant.add', { studentNo: payload.studentNo, name: payload.name })
      ElMessage.success('新增成功')
    } else {
      await assistantRepo.update(form.id, payload)
      await operationLogRepo.add('assistant.update', { studentNo: payload.studentNo, name: payload.name })
      ElMessage.success('已保存')
    }
    visible.value = false
    emit('saved')
  } catch (e) {
    // 仓储层抛出的业务错误（如并发窗口内学号撞车）在这里兜底展示
    console.error("[form] 保存异常", e)
    ElMessage.error(e instanceof Error ? e.message : "保存失败")
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="form.id === undefined ? '新增助理' : '编辑助理'"
    width="520px"
    :close-on-click-modal="false"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
      <el-form-item label="姓名" prop="name">
        <el-input v-model="form.name" placeholder="真实姓名" maxlength="20" />
      </el-form-item>
      <el-form-item label="学号" prop="studentNo">
        <el-input v-model="form.studentNo" placeholder="学院统一学号" maxlength="20" />
      </el-form-item>
      <el-form-item label="身份类型" prop="identity">
        <el-radio-group v-model="form.identity">
          <el-radio v-for="opt in IDENTITY_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="联系电话" prop="phone">
        <el-input v-model="form.phone" placeholder="选填，11 位手机号" maxlength="11" />
      </el-form-item>
      <el-form-item label="QQ" prop="qq">
        <el-input v-model="form.qq" placeholder="选填" maxlength="15" />
      </el-form-item>
      <el-form-item label="班级" prop="className">
        <el-input v-model="form.className" placeholder="选填，如 软件2401" maxlength="30" />
      </el-form-item>

      <el-divider content-position="left">个性化值班节数（可选）</el-divider>
      <el-form-item label="单独设置">
        <el-switch v-model="form.customSections" />
        <span class="hint-inline">开启后该助理的值班节数不再跟随全局默认</span>
      </el-form-item>
      <template v-if="form.customSections">
        <el-form-item label="最少节数" prop="customMinSections">
          <el-input-number v-model="form.customMinSections" :min="0" :max="40" />
          <span class="hint-inline">全局默认 {{ globalSections.min }} 节</span>
        </el-form-item>
        <el-form-item label="最多节数" prop="customMaxSections">
          <el-input-number v-model="form.customMaxSections" :min="1" :max="60" />
          <span class="hint-inline">全局默认 {{ globalSections.max }} 节</span>
        </el-form-item>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.hint-inline {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
