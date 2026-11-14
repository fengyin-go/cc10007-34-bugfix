import { normalizePrimaries, validateChain } from './receipts'
import { SEED_ROWS, buildSeedLedger } from './seed'
import type { EntryRow, LedgerState } from './types'

// 账本存储：业务行与凭据链放在同一个键里，一次 setItem 整体落库。
// 这就是「操作凭证双写」的物理基础——业务动作和审计凭据同笔提交，任一失败整笔回退。
const LEDGER_KEY = 'data-layer-studio:ledger'
const LEGACY_ENTRIES_KEY = 'data-layer-studio:entries'

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// 非浏览器环境（如冒烟测试）下的内存存储
const memoryBackend = new Map<string, string>()
const memoryStorage: StorageLike = {
  getItem: (key) => memoryBackend.get(key) ?? null,
  setItem: (key, value) => void memoryBackend.set(key, value),
  removeItem: (key) => void memoryBackend.delete(key),
}

let customStorage: StorageLike | null = null
let cache: LedgerState | null = null

function backend(): StorageLike {
  if (customStorage) return customStorage
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  return memoryStorage
}

/** 注入存储实现（测试用）；传 null 恢复默认。 */
export function configureLedgerStorage(storage: StorageLike | null): void {
  customStorage = storage
  cache = null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeLedger(parsed: Partial<LedgerState>): LedgerState {
  const receipts = Array.isArray(parsed.receipts) ? parsed.receipts : []
  const entries = (parsed.entries ?? {}) as Record<string, EntryRow[]>
  // 签章计数至少要盖过链上已有的最大签章，否则后续提交无法保持严格递增
  const maxSeal = receipts.reduce((max, receipt) => Math.max(max, Number(receipt.seal_seq) || 0), 0)
  // 审计编号计数至少要盖过现有审计记录的最大 id
  const maxAuditId = (entries.audit ?? []).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  return {
    entries,
    receipts,
    seal: Math.max(Number(parsed.seal ?? 0), maxSeal),
    auditSeq: Math.max(Number(parsed.auditSeq ?? 0), maxAuditId),
  }
}

/** 从旧版纯业务数据迁移：业务行原样接管，凭据链从空开始（旧记录回看时如实显示缺凭据）。 */
function migrateLegacy(): LedgerState | null {
  const raw = backend().getItem(LEGACY_ENTRIES_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    backend().removeItem(LEGACY_ENTRIES_KEY)
    // 没动过的纯种子数据直接换成带凭据链的种子账本
    if (JSON.stringify(parsed) === JSON.stringify(SEED_ROWS)) {
      return buildSeedLedger()
    }
    const auditRows = parsed.audit ?? []
    const auditSeq = auditRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
    return { entries: parsed, receipts: [], seal: 0, auditSeq }
  } catch {
    return null
  }
}

function persist(state: LedgerState): void {
  // 唯一的落盘点：业务行 + 凭据链 + 计数器一次写入；setItem 抛错时 cache 不动，整笔回退。
  backend().setItem(LEDGER_KEY, JSON.stringify(state))
}

function readLedger(): LedgerState {
  const raw = backend().getItem(LEDGER_KEY)
  if (raw) {
    try {
      return normalizeLedger(JSON.parse(raw) as Partial<LedgerState>)
    } catch {
      // 数据损坏时重新播种
    }
  }
  const state = migrateLegacy() ?? buildSeedLedger()
  persist(state)
  return state
}

/** 当前账本（内部引用，仅供提交路径使用）。 */
export function loadLedger(): LedgerState {
  if (cache === null) {
    cache = readLedger()
  }
  return cache
}

/** 账本快照：深拷贝，列表页/详情页/导出都读它，保证同一时刻看到的是同一份数据。 */
export function snapshotLedger(): LedgerState {
  return clone(loadLedger())
}

/**
 * 整笔提交：在草稿上执行变更，凭据链校验通过后一次性落库。
 * mutate 抛错、链校验不通过、或 setItem 失败，都会让整笔变更（业务行 + 凭据）一起回退。
 */
export function commitLedger(mutate: (draft: LedgerState) => void): LedgerState {
  const draft = clone(loadLedger())
  mutate(draft)
  normalizePrimaries(draft)
  const problems = validateChain(draft)
  if (problems.length > 0) {
    throw new Error(`凭据链校验失败，整笔回退：${problems.join('；')}`)
  }
  persist(draft)
  cache = draft
  return draft
}

export function ledgerStorageKey(): string {
  return LEDGER_KEY
}

// 跨标签页 freshness：别的标签页写账本后，本页丢掉缓存，下次读取直接拿最新提交，
// 避免列表页残留旧对象、详情页值对不上。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === LEDGER_KEY) {
      cache = null
    }
  })
}
