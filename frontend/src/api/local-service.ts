import { commitLedger, snapshotLedger } from '@/data/ledger'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  buildIdempotencyKey,
  itemKeyOf,
  latestReceiptForItem,
  objectFieldOf,
  receiptsForAuditEntry,
  receiptsForItem,
  serializeRow,
  stampReceipt,
  validateChain,
  verifyAuditEntry,
} from '@/data/receipts'
import { buildSeedLedger } from '@/data/seed'
import type {
  ActionContext,
  ActionResult,
  AuditReceipt,
  EntryDetail,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  ReceiptVerification,
  ReviewItemResult,
  ReviewResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 动作源状态门禁：只有从列出的状态出发才允许执行。
// 关键一条：只有送审（审核中）后的审计凭据才能忽略，草稿不能直接盖章「忽略」。
const ACTION_GUARDS: Record<string, string[]> = {
  'audit:提交审核': ['草稿'],
  'audit:归档记录': ['审核中'],
  'audit:忽略记录': ['审核中'],
}

// 忽略时必须保留的字段：旧字节、操作来源、受影响对象，缺一个就整笔回退。
const IGNORE_REQUIRED_FIELDS = ['变更前值', '操作来源', '操作表名']

/** 业务校验失败：和存储故障一样会让整笔提交回退，只是提示语不同。 */
class ActionAbort extends Error {}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(snapshotLedger().entries[key] ?? [], filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 业务动作 + 审计凭据双写：同一次 commitLedger 里既改业务行、又签章凭据，
 * 业务模块还会同笔登记一条审计记录（草稿）。任何一步失败，整笔回退。
 */
export function runAction(key: string, id: number, action: string, context: ActionContext = {}): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  try {
    let result: ActionResult = { ok: false, message: '动作未执行' }
    commitLedger((draft) => {
      const rows = draft.entries[key] ?? []
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        throw new ActionAbort(`没有找到编号为 ${id} 的${meta.entity}`)
      }
      const before = rows[index]
      const current = String(before.status)
      if (current === target) {
        throw new ActionAbort(`${meta.entity}已经是「${target}」，不用重复操作`)
      }
      const guard = ACTION_GUARDS[`${key}:${action}`]
      if (guard && !guard.includes(current)) {
        throw new ActionAbort(`只有送审（${guard.join('、')}）后的${meta.entity}才能${action}，当前状态「${current}」`)
      }
      if (key === 'audit' && action === '忽略记录') {
        // 忽略必须保留旧字节、来源与受影响对象，缺失即整笔回退
        const missing = IGNORE_REQUIRED_FIELDS.filter((field) => !String(before[field] ?? '').trim())
        if (missing.length > 0) {
          throw new ActionAbort(`忽略失败：${meta.entity}缺少${missing.join('、')}，旧字节、来源与受影响对象必须保留，整笔已回退`)
        }
      }
      const lastStatus = meta.statuses[meta.statuses.length - 1]
      const updated: EntryRow = {
        ...before,
        status: target,
        pending: target !== lastStatus,
        abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
      }
      const operator = context.operator?.trim() || '值班管理员'
      const source = context.source?.trim() || `${meta.name}界面`
      const itemKey = itemKeyOf(meta, before)
      const affected = String(before[objectFieldOf(meta)] ?? itemKey)
      const { receipt, deduped } = stampReceipt(draft, {
        idempotency_key: buildIdempotencyKey(key, id, action, current),
        root_id: '',
        module_key: key,
        module_name: meta.name,
        action,
        item_key: itemKey,
        item_keys: [itemKey],
        from_status: current,
        to_status: target,
        before_bytes: serializeRow(before),
        after_bytes: serializeRow(updated),
        source,
        operator,
        affected,
        created_at: new Date().toISOString(),
      })
      rows[index] = updated
      draft.entries[key] = rows
      if (!deduped && key !== 'audit') {
        // 审计凭据双写的另一半：审计库同笔新增一条审计记录（草稿，待送审）。
        // 审计模块自身的流转只留凭据，不再递归登记审计记录。
        draft.auditSeq += 1
        const auditRows = draft.entries.audit ?? []
        auditRows.push({
          id: draft.auditSeq,
          status: '草稿',
          pending: true,
          abnormal: false,
          记录编号: `AUDI-${String(draft.auditSeq).padStart(4, '0')}`,
          操作表名: affected,
          变更类型: action,
          变更前值: receipt.before_bytes,
          变更后值: receipt.after_bytes,
          操作时间: receipt.created_at,
          操作来源: source,
          回滚脚本: `-- 凭据 ${receipt.receipt_id}\nUPDATE ${key} SET status='${current}' WHERE id=${id};`,
          receipt_id: receipt.receipt_id,
          seal_seq: receipt.seal_seq,
          idempotency_key: receipt.idempotency_key,
          root_id: receipt.root_id,
          module_key: key,
          item_key: itemKey,
        })
        draft.entries.audit = auditRows
      }
      result = {
        ok: true,
        message: deduped
          ? `${meta.entity}已${action}，当前状态「${target}」（命中幂等键，沿用既有凭据 ${receipt.receipt_id}）`
          : `${meta.entity}已${action}，当前状态「${target}」，凭据 ${receipt.receipt_id}（签章 #${receipt.seal_seq}）`,
        receipt,
        deduped,
      }
    })
    return result
  } catch (error) {
    if (error instanceof ActionAbort) {
      return { ok: false, message: error.message }
    }
    return {
      ok: false,
      message: `${meta.entity}${action}失败，整笔已回退：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 审阅工作副本：以多选集合确定范围，逐条返回 item_key 成功码；
 * 通过的记录整组一次提交，只签章一个 root 凭据。
 */
export function reviewAuditEntries(ids: number[], context: ActionContext = {}): ReviewResult {
  const meta = moduleMeta('audit')
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) {
    return { ok: false, root_receipt_id: null, items: [], message: '审阅范围为空：请先勾选要送审的审计记录' }
  }
  const results = new Map<number, ReviewItemResult>()
  try {
    let rootReceiptId: string | null = null
    commitLedger((draft) => {
      const rows = draft.entries.audit ?? []
      const passing: { row: EntryRow; index: number }[] = []
      for (const id of uniqueIds) {
        const index = rows.findIndex((row) => Number(row.id) === id)
        if (index < 0) {
          results.set(id, { id, item_key: '—', code: 'ITEM_MISSING', message: `没有找到编号为 ${id} 的${meta.entity}` })
          continue
        }
        const row = rows[index]
        const itemKey = String(row['记录编号'] ?? id)
        if (String(row.status) !== '草稿') {
          results.set(id, {
            id,
            item_key: itemKey,
            code: 'NOT_REVIEWABLE',
            message: `${itemKey} 当前状态「${String(row.status)}」，只有草稿可送审`,
          })
          continue
        }
        passing.push({ row, index })
      }
      if (passing.length === 0) {
        throw new ActionAbort('选中的记录都不在草稿态，没有可送审的内容')
      }
      const operator = context.operator?.trim() || '值班管理员'
      const source = context.source?.trim() || `${meta.name}界面`
      const now = new Date().toISOString()
      const itemKeys = passing.map(({ row }) => String(row['记录编号']))
      const updatedRows = passing.map(({ row }) => ({
        ...row,
        status: '审核中',
        pending: true,
        abnormal: false,
      }))
      // 整组提交只保留一个 root：一组送审只签章一张凭据，root 即其自身
      const { receipt } = stampReceipt(draft, {
        idempotency_key: `audit:review:${[...uniqueIds].sort((a, b) => a - b).join(',')}`,
        root_id: '',
        module_key: 'audit',
        module_name: meta.name,
        action: '提交审核',
        item_key: itemKeys[0],
        item_keys: itemKeys,
        from_status: '草稿',
        to_status: '审核中',
        before_bytes: JSON.stringify(passing.map(({ row }) => serializeRow(row))),
        after_bytes: JSON.stringify(updatedRows.map((row) => serializeRow(row))),
        source,
        operator,
        affected: itemKeys.join('、'),
        created_at: now,
      })
      for (let i = 0; i < passing.length; i += 1) {
        const { row, index } = passing[i]
        rows[index] = { ...updatedRows[i], review_root_id: receipt.root_id }
        results.set(Number(row.id), {
          id: Number(row.id),
          item_key: String(row['记录编号']),
          code: 'REVIEW_OK',
          message: `${String(row['记录编号'])} 已送审，归入整组凭据 ${receipt.receipt_id}`,
        })
      }
      draft.entries.audit = rows
      rootReceiptId = receipt.receipt_id
    })
    const items = uniqueIds.map((id) => results.get(id) as ReviewItemResult)
    const okCount = items.filter((item) => item.code === 'REVIEW_OK').length
    return {
      ok: true,
      root_receipt_id: rootReceiptId,
      items,
      message: `已送审 ${okCount} 条审计记录，整组凭据 ${rootReceiptId}（只保留一个 root）`,
    }
  } catch (error) {
    const items = uniqueIds
      .map((id) => results.get(id))
      .filter((item): item is ReviewItemResult => Boolean(item))
    return {
      ok: false,
      root_receipt_id: null,
      items,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 详情读取：和列表页读同一个账本快照，对象值与凭据链片段来自同一份数据。 */
export function getEntryDetail(key: string, id: number): EntryDetail | null {
  const state = snapshotLedger()
  const row = (state.entries[key] ?? []).find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  const receipts =
    key === 'audit'
      ? receiptsForAuditEntry(state.receipts, row)
      : receiptsForItem(state.receipts, key, itemKeyOf(moduleMeta(key), row))
  return { row, receipts }
}

/** 业务列表的凭据签章列：item_key → 最近一次凭据，一次快照算完。 */
export function receiptSummaries(key: string): Map<string, AuditReceipt> {
  const state = snapshotLedger()
  const meta = moduleMeta(key)
  const summaries = new Map<string, AuditReceipt>()
  for (const row of state.entries[key] ?? []) {
    const itemKey = itemKeyOf(meta, row)
    const receipt = latestReceiptForItem(state.receipts, key, itemKey)
    if (receipt) {
      summaries.set(itemKey, receipt)
    }
  }
  return summaries
}

/** 回看核对：以变更审计记录为主对象，逐条核对其审计凭据。 */
export function verifyAuditRecords(): Map<number, ReceiptVerification> {
  const state = snapshotLedger()
  const verdicts = new Map<number, ReceiptVerification>()
  for (const row of state.entries.audit ?? []) {
    verdicts.set(Number(row.id), verifyAuditEntry(state.receipts, row))
  }
  return verdicts
}

/** 凭据链完整性校验（全局顺序签章、root、幂等键唯一 primary）。 */
export function verifyLedgerChain(): string[] {
  return validateChain(snapshotLedger())
}

export function resetModule(key: string): PageResult {
  const meta = moduleMeta(key)
  commitLedger((draft) => {
    draft.entries[key] = clone(buildSeedLedger().entries[key] ?? [])
    stampReceipt(draft, {
      idempotency_key: `${key}:reset:${draft.seal + 1}`,
      root_id: '',
      module_key: key,
      module_name: meta.name,
      action: '重置数据',
      item_key: '*',
      item_keys: ['*'],
      from_status: '—',
      to_status: '—',
      before_bytes: '[]',
      after_bytes: JSON.stringify((draft.entries[key] ?? []).map((row) => serializeRow(row))),
      source: `${meta.name}界面`,
      operator: '值班管理员',
      affected: meta.entity,
      created_at: new Date().toISOString(),
    })
  })
  return listEntries(key)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of snapshotLedger().entries[key] ?? []) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const entries = snapshotLedger().entries
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const rows = entries[meta.key] ?? []
    return {
      name: meta.name,
      created: rows.length,
      pending: rows.filter((row) => row.pending).length,
      abnormal: rows.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
