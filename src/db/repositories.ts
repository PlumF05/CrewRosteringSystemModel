/**
 * 仓储层（Repository Pattern）。
 *
 * 职责边界：UI / 算法层只 import 这里暴露的 repo，永远不直接操作 Dexie 表。
 * 好处（软件工程：关注点分离 / 依赖倒置）：
 * 1. 业务语义（如"学号不能重复"）收敛在一处；
 * 2. 将来更换存储方案（如阶段三接后端 API）只改这一层；
 * 3. 单元测试可以针对 repo 独立进行。
 */
import { db } from './database'
import type {
  Assistant,
  ConfigEntry,
  Course,
  DutySchedule,
  DutySource,
  DutyStatus,
  OperationLog,
  ScheduleSnapshot,
} from './schema'

export class DuplicateStudentNoError extends Error {
  constructor(public studentNo: string) {
    super(`学号已存在：${studentNo}`)
    this.name = 'DuplicateStudentNoError'
  }
}

export class DuplicateDutyError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'DuplicateDutyError'
  }
}

export const now = (): string => new Date().toISOString()

type NewAssistant = Omit<Assistant, 'id' | 'createdAt' | 'updatedAt'>

export const assistantRepo = {
  /** 新增助理；学号重复抛 DuplicateStudentNoError（唯一索引兜底 + 主动查重给友好错误） */
  async add(a: NewAssistant): Promise<number> {
    const dup = await db.assistant.where('studentNo').equals(a.studentNo).count()
    if (dup > 0) throw new DuplicateStudentNoError(a.studentNo)
    const ts = now()
    return db.assistant.add({ ...a, createdAt: ts, updatedAt: ts })
  },

  async update(id: number, patch: Partial<NewAssistant>): Promise<number> {
    if (patch.studentNo !== undefined) {
      const clash = await db.assistant
        .where('studentNo')
        .equals(patch.studentNo)
        .filter((x) => x.id !== id)
        .count()
      if (clash > 0) throw new DuplicateStudentNoError(patch.studentNo)
    }
    return db.assistant.update(id, { ...patch, updatedAt: now() })
  },

  async remove(id: number): Promise<void> {
    await db.transaction('rw', db.assistant, db.course, async () => {
      // 级联清理：助理删除后其课程表失去归属，一并删除（一致性约束）
      await db.course.where('assistantId').equals(id).delete()
      await db.assistant.delete(id)
    })
  },

  get(id: number): Promise<Assistant | undefined> {
    return db.assistant.get(id)
  },

  list(): Promise<Assistant[]> {
    return db.assistant.orderBy('name').toArray()
  },

  count(): Promise<number> {
    return db.assistant.count()
  },
}

type NewCourse = Omit<Course, 'id'>

export const courseRepo = {
  /** 整体替换某助理的课程表（导入语义：一个文件 = 该生课程的最终状态） */
  async replaceForAssistant(assistantId: number, courses: NewCourse[]): Promise<number> {
    return db.transaction('rw', db.course, async () => {
      await db.course.where('assistantId').equals(assistantId).delete()
      return db.course.bulkAdd(courses.map((c) => ({ ...c, assistantId })))
    })
  },

  listByAssistant(assistantId: number): Promise<Course[]> {
    return db.course.where('assistantId').equals(assistantId).toArray()
  },

  all(): Promise<Course[]> {
    return db.course.toArray()
  },

  count(): Promise<number> {
    return db.course.count()
  },
}

type NewDuty = Omit<DutySchedule, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'source'> & {
  status?: DutyStatus
  source?: DutySource
}

export const dutyScheduleRepo = {
  /** 新增排班。同一 (周, 天, 时段, 助理) 重复将抛 DuplicateDutyError（复合唯一索引兜底） */
  async add(d: NewDuty): Promise<number> {
    const ts = now()
    try {
      return await db.duty_schedule.add({
        status: 'normal',
        source: 'auto',
        ...d,
        createdAt: ts,
        updatedAt: ts,
      } as DutySchedule)
    } catch (e) {
      throw toDutyError(e, d)
    }
  },

  async update(id: number, patch: Partial<DutySchedule>): Promise<number> {
    return db.duty_schedule.update(id, { ...patch, updatedAt: now() })
  },

  async remove(id: number): Promise<void> {
    await db.duty_schedule.delete(id)
  },

  /** 某周完整排班（周视图渲染的数据源） */
  listByWeek(weekNo: number): Promise<DutySchedule[]> {
    return db.duty_schedule.where('weekNo').equals(weekNo).toArray()
  },

  all(): Promise<DutySchedule[]> {
    return db.duty_schedule.toArray()
  },

  /** 手动调整记录（重新排班时需要保留的部分，F08） */
  listManual(): Promise<DutySchedule[]> {
    return db.duty_schedule.where('source').equals('manual').toArray()
  },

  /** 清空某周排班（全量重排前调用） */
  async clearWeek(weekNo: number): Promise<void> {
    await db.duty_schedule.where('weekNo').equals(weekNo).delete()
  },
}

type NewSnapshot = Omit<ScheduleSnapshot, 'id' | 'createdAt'>

export const scheduleSnapshotRepo = {
  /** 保存快照：对传入数组做深拷贝，保证后续对原数据的修改不影响快照（撤销栈正确性关键） */
  async save(label: string, data: DutySchedule[]): Promise<number> {
    const copy: DutySchedule[] = structuredClone(data)
    return db.schedule_snapshot.add({ label, data: copy, createdAt: now() })
  },

  latest(): Promise<ScheduleSnapshot | undefined> {
    return db.schedule_snapshot.orderBy('id').last()
  },

  get(id: number): Promise<ScheduleSnapshot | undefined> {
    return db.schedule_snapshot.get(id)
  },
}

export const configRepo = {
  async get<T>(key: string): Promise<T | undefined> {
    const entry: ConfigEntry | undefined = await db.config.get(key)
    return entry?.value as T | undefined
  },
  async set(key: string, value: unknown): Promise<void> {
    await db.config.put({ key, value })
  },
}

export const operationLogRepo = {
  add(action: string, detail?: unknown): Promise<number> {
    return db.operation_log.add({ operatedAt: now(), action, detail })
  },
  /** 最近 n 条（新在前），仪表盘与追溯用 */
  async recent(n: number): Promise<OperationLog[]> {
    const coll = db.operation_log.orderBy('id').reverse()
    return coll.limit(n).toArray()
  },
}

function toDutyError(e: unknown, d: NewDuty): Error {
  if (e instanceof Error && e.name === 'ConstraintError') {
    return new DuplicateDutyError(
      `重复排班：第${d.weekNo}周 星期${d.dayOfWeek} 时段${d.timeSlot} 助理#${d.assistantId}`,
    )
  }
  return e as Error
}
