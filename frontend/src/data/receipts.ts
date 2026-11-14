import type { AuditReceipt, EntryRow, LedgerState, ModuleMeta, ReceiptVerification } from './types'

// 凭据链：所有业务动作与审计流转的签章记录，只增不改。
// 业务界面和审计界面都从这条链上读取结果，保证两边看到的是同一份事实。

/** 稳定序列化：键排序后输出，同一行任何时候得到的字节都一致，忽略/回看靠它对账。 */
export function serializeRow(row: EntryRow): string {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(row).sort()) {
    sorted[key] = row[key]
  }
  return JSON.stringify(sorted)
}

/** 业务对象主键：各模块的第一个字段（编号）。 */
export function itemKeyOf(meta: ModuleMeta, row: EntryRow): string {
  return String(row[meta.fields[0]] ?? row.id)
}

/** 受影响对象字段：优先取「表名」，其次「名称」，都没有就退回第二个字段。 */
export function objectFieldOf(meta: ModuleMeta): string {
  return (
    meta.fields.find((field) => field.includes('表名')) ??
    meta.fields.find((field) => field.includes('名称')) ??
    meta.fields[1] ??
    meta.fields[0]
  )
}

/** 幂等键：模块 + 对象 + 动作 + 起始状态，同一次逻辑动作的指纹。 */
export function buildIdempotencyKey(moduleKey: string, id: number, action: string, fromStatus: string): string {
  return `${moduleKey}:${id}:${action}:${fromStatus}`
}

export type ReceiptSpec = Omit<AuditReceipt, 'receipt_id' | 'seal_seq' | 'primary'>

/**
 * 签章入库：给凭据分配全局顺序签章并追加到链上。
 * 同一 idempotency_key 只保留一份 primary：命中时直接返回既有凭据，不再追加。
 */
export function stampReceipt(
  state: LedgerState,
  spec: ReceiptSpec,
): { receipt: AuditReceipt; deduped: boolean } {
  const existing = state.receipts.find(
    (receipt) => receipt.idempotency_key === spec.idempotency_key && receipt.primary,
  )
  if (existing) {
    return { receipt: existing, deduped: true }
  }
  state.seal += 1
  const receipt: AuditReceipt = {
    ...spec,
    seal_seq: state.seal,
    receipt_id: `RCP-${String(state.seal).padStart(6, '0')}`,
    primary: true,
    // 整组提交只保留一个 root：单笔凭据的 root 即自身
    root_id: spec.root_id || `RCP-${String(state.seal).padStart(6, '0')}`,
  }
  state.receipts.push(receipt)
  return { receipt, deduped: false }
}

/** 防御性归一：同一幂等键若出现多份 primary，只留链上第一份。 */
export function normalizePrimaries(state: LedgerState): void {
  const seen = new Set<string>()
  for (const receipt of state.receipts) {
    if (!receipt.primary) continue
    if (seen.has(receipt.idempotency_key)) {
      receipt.primary = false
    } else {
      seen.add(receipt.idempotency_key)
    }
  }
}

/** 凭据链完整性校验：签章严格递增、root 齐全、同一幂等键只有一份 primary。 */
export function validateChain(state: LedgerState): string[] {
  const problems: string[] = []
  let lastSeal = 0
  const primaryByKey = new Map<string, string>()
  for (const receipt of state.receipts) {
    if (receipt.seal_seq <= lastSeal) {
      problems.push(`凭据 ${receipt.receipt_id} 的签章 ${receipt.seal_seq} 未严格递增`)
    }
    lastSeal = receipt.seal_seq
    if (!receipt.root_id) {
      problems.push(`凭据 ${receipt.receipt_id} 缺少 root 归属`)
    }
    if (receipt.primary) {
      const existing = primaryByKey.get(receipt.idempotency_key)
      if (existing) {
        problems.push(`幂等键 ${receipt.idempotency_key} 存在多份 primary（${existing}、${receipt.receipt_id}）`)
      } else {
        primaryByKey.set(receipt.idempotency_key, receipt.receipt_id)
      }
    }
  }
  return problems
}

/** 业务对象的凭据链片段（按签章升序）。 */
export function receiptsForItem(chain: AuditReceipt[], moduleKey: string, itemKey: string): AuditReceipt[] {
  return chain.filter((receipt) => receipt.module_key === moduleKey && receipt.item_keys.includes(itemKey))
}

/** 业务对象最近一次凭据。 */
export function latestReceiptForItem(
  chain: AuditReceipt[],
  moduleKey: string,
  itemKey: string,
): AuditReceipt | null {
  const matched = receiptsForItem(chain, moduleKey, itemKey)
  return matched.length ? matched[matched.length - 1] : null
}

/**
 * 审计记录的凭据链片段：既包含登记该记录的那张原始凭据（receipt_id），
 * 也包含这条记录后续送审/归档/忽略留下的全部凭据（按记录编号归集）。
 */
export function receiptsForAuditEntry(chain: AuditReceipt[], row: EntryRow): AuditReceipt[] {
  const receiptId = String(row['receipt_id'] ?? '')
  const recordKey = String(row['记录编号'] ?? '')
  return chain.filter(
    (receipt) =>
      (receiptId !== '' && receipt.receipt_id === receiptId) ||
      (recordKey !== '' && receipt.module_key === 'audit' && receipt.item_keys.includes(recordKey)),
  )
}

/**
 * 回看核对：以变更审计记录为主对象，核对其审计凭据。
 * 凭据要在链上、签章与幂等键对得上、旧字节/新字节/来源/受影响对象一致。
 */
export function verifyAuditEntry(chain: AuditReceipt[], row: EntryRow): ReceiptVerification {
  const receiptId = String(row['receipt_id'] ?? '')
  if (!receiptId) {
    return { status: '缺凭据', receipt: null, problems: ['审计记录没有登记凭据编号'] }
  }
  const receipt = chain.find((item) => item.receipt_id === receiptId) ?? null
  if (!receipt) {
    return { status: '缺凭据', receipt: null, problems: [`凭据 ${receiptId} 不在凭据链上`] }
  }
  const problems: string[] = []
  if (receipt.seal_seq !== Number(row['seal_seq'])) {
    problems.push(`签章对不上：记录为 ${String(row['seal_seq'] ?? '—')}，凭据为 ${receipt.seal_seq}`)
  }
  if (receipt.idempotency_key !== String(row['idempotency_key'] ?? '')) {
    problems.push('幂等键与凭据不一致')
  }
  if (receipt.before_bytes !== String(row['变更前值'] ?? '')) {
    problems.push('旧字节（变更前值）与凭据不一致')
  }
  if (receipt.after_bytes !== String(row['变更后值'] ?? '')) {
    problems.push('新字节（变更后值）与凭据不一致')
  }
  if (receipt.affected !== String(row['操作表名'] ?? '')) {
    problems.push('受影响对象（操作表名）与凭据不一致')
  }
  if (receipt.source !== String(row['操作来源'] ?? '')) {
    problems.push('操作来源与凭据不一致')
  }
  if (!receipt.primary) {
    problems.push(`凭据 ${receipt.receipt_id} 不是幂等键 ${receipt.idempotency_key} 的 primary`)
  }
  return { status: problems.length ? '凭据不符' : '一致', receipt, problems }
}
