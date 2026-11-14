/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

/** 审计凭据：业务动作落库时同笔写入的凭据链节点，只增不改。 */
export type AuditReceipt = {
  receipt_id: string
  /** 全局顺序签章：整条凭据链上严格递增的序号，并发动作靠它定序。 */
  seal_seq: number
  /** 幂等键：同一次业务动作的指纹，链上只允许存在一份 primary。 */
  idempotency_key: string
  primary: boolean
  /** 整组提交只保留一个 root：单笔凭据的 root 即自身。 */
  root_id: string
  module_key: string
  module_name: string
  action: string
  /** 受影响对象的主键（各模块的编号字段）。 */
  item_key: string
  /** 整组提交时覆盖的全部对象；单笔时只有一项。 */
  item_keys: string[]
  from_status: string
  to_status: string
  /** 旧字节：动作前业务行的序列化内容，忽略/回看时都靠它对账。 */
  before_bytes: string
  after_bytes: string
  /** 操作来源（业务界面）与操作人。 */
  source: string
  operator: string
  /** 受影响对象（表名/数据集名）。 */
  affected: string
  created_at: string
}

/** 账本状态：业务行 + 凭据链 + 计数器，一次 setItem 整体落库，保证双写同笔提交。 */
export type LedgerState = {
  entries: Record<string, EntryRow[]>
  receipts: AuditReceipt[]
  /** 全局顺序签章计数器 */
  seal: number
  /** 审计记录编号计数器 */
  auditSeq: number
}

export type ReceiptVerification = {
  status: '一致' | '缺凭据' | '凭据不符'
  receipt: AuditReceipt | null
  problems: string[]
}

export type ReviewItemResult = {
  id: number
  item_key: string
  code: string
  message: string
}

export type ReviewResult = {
  ok: boolean
  root_receipt_id: string | null
  items: ReviewItemResult[]
  message: string
}

export type ActionContext = {
  operator?: string
  source?: string
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 同笔提交的审计凭据；命中幂等键去重时返回已存在的 primary。 */
  receipt?: AuditReceipt
  deduped?: boolean
}

export type EntryDetail = {
  row: EntryRow
  receipts: AuditReceipt[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
