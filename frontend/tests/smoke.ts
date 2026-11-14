/**
 * 数据层冒烟测试：操作凭证双写、整笔回退、忽略门禁、幂等键、整组送审、列表/详情一致。
 * 运行：npm run test（esbuild 打包后用 node 执行，存储用注入的内存实现）。
 */
import {
  getEntryDetail,
  listEntries,
  reviewAuditEntries,
  runAction,
  verifyAuditRecords,
  verifyLedgerChain,
  resetModule,
} from '@/api/local-service'
import { configureLedgerStorage, loadLedger, snapshotLedger } from '@/data/ledger'
import { serializeRow } from '@/data/receipts'
import { SEED_ROWS } from '@/data/seed'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    passed += 1
    console.log(`  ok - ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL - ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}

function makeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
  }
}

const { storage } = makeStorage()
configureLedgerStorage(storage)

// ---------- 1. 种子账本：审计记录与凭据链对得上 ----------
console.log('1. 种子账本')
const seed = snapshotLedger()
check('种子凭据 3 张', seed.receipts.length === 3)
check('种子签章计数为 3', seed.seal === 3)
const seedVerdicts = verifyAuditRecords()
check(
  '种子审计记录回看核对全部一致',
  [...seedVerdicts.values()].every((v) => v.status === '一致'),
  [...seedVerdicts.values()].map((v) => v.problems),
)
check('凭据链初始校验通过', verifyLedgerChain().length === 0, verifyLedgerChain())

// ---------- 2. ODS 启用同步：业务动作与审计凭据双写 ----------
console.log('2. ODS 启用同步双写')
const auditBefore = listEntries('audit').total
const enable = runAction('ods', 2, '启用同步', { operator: '值班管理员', source: '贴源层建模界面 · 值班管理员' })
check('启用同步成功', enable.ok, enable.message)
check('返回签章凭据', enable.receipt?.receipt_id === 'RCP-000004', enable.receipt)
const odsRow = listEntries('ods').items.find((row) => Number(row.id) === 2)
check('业务行已启用', String(odsRow?.status) === '已启用')
const auditAfter = listEntries('audit')
check('审计库同笔新增一条记录', auditAfter.total === auditBefore + 1)
const newAudit = auditAfter.items.find((row) => String(row['receipt_id'] ?? '') === 'RCP-000004')
check('新审计记录为草稿待送审', String(newAudit?.status) === '草稿')
check('审计记录登记了凭据编号', String(newAudit?.['receipt_id']) === 'RCP-000004')
check('审计记录保留旧字节', String(newAudit?.['变更前值']) === enable.receipt?.before_bytes)
check('审计记录登记来源', String(newAudit?.['操作来源']).includes('贴源层建模'))
check('审计记录登记受影响对象', String(newAudit?.['操作表名']).length > 0)
const verdictAfterEnable = verifyAuditRecords().get(Number(newAudit?.id))
check('新审计记录回看核对一致', verdictAfterEnable?.status === '一致', verdictAfterEnable?.problems)

// CAT 发布条目同样双写
console.log('2b. CAT 发布条目双写')
runAction('catalog', 2, '提交发布', { operator: '值班管理员' })
const publish = runAction('catalog', 2, '发布条目', { operator: '值班管理员' })
check('发布条目成功', publish.ok, publish.message)
const publishAudit = listEntries('audit').items.find((row) => String(row['变更类型']) === '发布条目')
check('发布条目同笔登记审计记录', Boolean(publishAudit))
check(
  '发布条目回看核对一致',
  verifyAuditRecords().get(Number(publishAudit?.id))?.status === '一致',
)

// ---------- 3. 任一失败整笔回退 ----------
console.log('3. 存储故障整笔回退')
const beforeFail = snapshotLedger()
const flaky = {
  getItem: storage.getItem,
  setItem: (_key: string, _value: string): void => {
    throw new Error('模拟存储写失败')
  },
  removeItem: storage.removeItem,
}
configureLedgerStorage(flaky)
const failedAction = runAction('ods', 1, '提交校验', { operator: '值班管理员' })
check('写失败时动作返回失败', !failedAction.ok)
check('失败提示整笔回退', failedAction.message.includes('整笔已回退'), failedAction.message)
configureLedgerStorage(storage)
const afterFail = snapshotLedger()
check('业务行状态未变', String(afterFail.entries.ods.find((r) => Number(r.id) === 1)?.status) === '草稿')
check('凭据链未追加', afterFail.receipts.length === beforeFail.receipts.length)
check('审计库未新增', afterFail.entries.audit.length === beforeFail.entries.audit.length)
check('签章计数未前进', afterFail.seal === beforeFail.seal)

// ---------- 4. 只有送审后的凭据可忽略，且保留旧字节/来源/受影响对象 ----------
console.log('4. 忽略门禁')
const draftAudit = listEntries('audit').items.find((row) => String(row.status) === '草稿')
check('存在草稿审计记录', Boolean(draftAudit))
const draftId = Number(draftAudit?.id)
const ignoreDraft = runAction('audit', draftId, '忽略记录', { operator: '值班管理员' })
check('草稿不能直接忽略', !ignoreDraft.ok)
check('提示需要送审', ignoreDraft.message.includes('送审'), ignoreDraft.message)
check('草稿状态未变', String(listEntries('audit').items.find((r) => Number(r.id) === draftId)?.status) === '草稿')
const beforeBytes = String(draftAudit?.['变更前值'])
const sourceText = String(draftAudit?.['操作来源'])
const affectedText = String(draftAudit?.['操作表名'])
const submit = runAction('audit', draftId, '提交审核', { operator: '值班管理员' })
check('送审成功', submit.ok, submit.message)
const ignore = runAction('audit', draftId, '忽略记录', { operator: '值班管理员' })
check('送审后可忽略', ignore.ok, ignore.message)
const ignored = listEntries('audit').items.find((r) => Number(r.id) === draftId)
check('忽略后状态为已忽略', String(ignored?.status) === '已忽略')
check('忽略保留旧字节', String(ignored?.['变更前值']) === beforeBytes)
check('忽略保留来源', String(ignored?.['操作来源']) === sourceText)
check('忽略保留受影响对象', String(ignored?.['操作表名']) === affectedText)
const ignoreReceipts = getEntryDetail('audit', draftId)?.receipts ?? []
check('忽略动作本身也签章凭据', ignoreReceipts.some((r) => r.action === '忽略记录'))

// ---------- 5. 同一 idempotency_key 只留一份 primary ----------
console.log('5. 幂等键去重')
resetModule('ods') // 重置后 ODS-0002 回到待校验
const receiptsBeforeRetry = snapshotLedger().receipts.length
const auditBeforeRetry = listEntries('audit').total
const retry = runAction('ods', 2, '启用同步', { operator: '值班管理员' })
check('重复动作仍成功', retry.ok, retry.message)
check('命中幂等键去重', retry.deduped === true)
check('沿用既有 primary 凭据', retry.receipt?.receipt_id === enable.receipt?.receipt_id)
check('凭据链未追加重复凭据', snapshotLedger().receipts.length === receiptsBeforeRetry)
check('审计库未重复登记', listEntries('audit').total === auditBeforeRetry)
check('业务行依然流转到已启用', String(listEntries('ods').items.find((r) => Number(r.id) === 2)?.status) === '已启用')
const keyPrimaries = snapshotLedger().receipts.filter(
  (r) => r.idempotency_key === 'ods:2:启用同步:待校验' && r.primary,
)
check('同一幂等键只有一份 primary', keyPrimaries.length === 1)

// ---------- 6. 审阅工作副本：多选集合、逐条成功码、整组一个 root ----------
console.log('6. 整组送审')
const auditMaxBefore = Math.max(...listEntries('audit').items.map((row) => Number(row.id)))
runAction('dwd', 1, '提交审核', { operator: '值班管理员' })
runAction('dws', 1, '提交校验', { operator: '值班管理员' })
const drafts = listEntries('audit').items.filter(
  (row) => Number(row.id) > auditMaxBefore && String(row.status) === '草稿',
)
check('新增两条待送审草稿', drafts.length === 2, drafts.map((r) => r['记录编号']))
const draftIds = drafts.map((row) => Number(row.id))
const receiptsBeforeReview = snapshotLedger().receipts.length
const review = reviewAuditEntries([...draftIds, 999], { operator: '值班管理员' })
check('整组送审成功', review.ok, review.message)
check('逐条返回 item_key 成功码', review.items.length === 3)
check(
  '每条都有 item_key 与成功码',
  review.items.filter((i) => i.code === 'REVIEW_OK').every((i) => /^AUDI-\d{4}$/.test(i.item_key)),
)
check('不存在的条目返回 ITEM_MISSING', review.items.some((i) => i.code === 'ITEM_MISSING' && i.id === 999))
check('整组只签章一张凭据', snapshotLedger().receipts.length === receiptsBeforeReview + 1)
const rootReceipt = snapshotLedger().receipts[snapshotLedger().receipts.length - 1]
check('整组凭据 root 即自身', rootReceipt.root_id === rootReceipt.receipt_id)
check('整组凭据覆盖全部 item_key', draftIds.every((id) => {
  const record = listEntries('audit').items.find((r) => Number(r.id) === id)
  return rootReceipt.item_keys.includes(String(record?.['记录编号']))
}))
check('送审后记录进入审核中', draftIds.every((id) => String(listEntries('audit').items.find((r) => Number(r.id) === id)?.status) === '审核中'))
const reviewAgain = reviewAuditEntries(draftIds, { operator: '值班管理员' })
check('重复送审同一集合被拒绝', !reviewAgain.ok)
check('逐条提示 NOT_REVIEWABLE', reviewAgain.items.every((i) => i.code === 'NOT_REVIEWABLE'))

// ---------- 7. 列表页与详情页同源一致 ----------
console.log('7. 列表/详情一致')
const listRow = listEntries('ods').items.find((row) => Number(row.id) === 2)
const detail = getEntryDetail('ods', 2)
check('详情与列表状态一致', String(detail?.row.status) === String(listRow?.status))
check('详情与列表字节一致', serializeRow(detail!.row) === serializeRow(listRow!))
check('详情带凭据链片段', (detail?.receipts.length ?? 0) > 0)
const auditDetail = getEntryDetail('audit', draftIds[0])
check('审计详情含原始凭据与送审凭据', (auditDetail?.receipts.length ?? 0) >= 2)

// ---------- 8. 全局顺序签章 ----------
console.log('8. 全局顺序签章')
const chain = snapshotLedger().receipts
const seals = chain.map((r) => r.seal_seq)
check('签章严格递增', seals.every((seal, i) => i === 0 || seal > seals[i - 1]), seals)
check('签章计数与链长一致', loadLedger().seal === seals.length)
check('凭据链最终校验通过', verifyLedgerChain().length === 0, verifyLedgerChain())
check(
  '全部审计记录回看核对一致',
  [...verifyAuditRecords().values()].every((v) => v.status === '一致'),
  [...verifyAuditRecords().entries()].filter(([, v]) => v.status !== '一致'),
)

// ---------- 9. 旧版纯业务数据迁移 ----------
console.log('9. 旧版数据迁移')
const legacy = makeStorage()
const legacyEntries = JSON.parse(JSON.stringify(SEED_ROWS)) as Record<string, { id: number; status: string }[]>
legacyEntries.ods[0].status = '已启用'
legacy.storage.setItem('data-layer-studio:entries', JSON.stringify(legacyEntries))
configureLedgerStorage(legacy.storage)
const migrated = snapshotLedger()
check('旧业务行原样接管', String(migrated.entries.ods[0].status) === '已启用')
check('迁移后凭据链为空', migrated.receipts.length === 0)
check('旧键已清理', legacy.storage.getItem('data-layer-studio:entries') === null)
check('迁移账本可继续双写', runAction('ods', 1, '停用同步', { operator: '值班管理员' }).ok)
check('迁移后新动作签章凭据', snapshotLedger().receipts.length === 1)
const migratedVerdicts = verifyAuditRecords()
check(
  '旧记录回看如实显示缺凭据',
  [1, 2, 3].every((id) => migratedVerdicts.get(id)?.status === '缺凭据'),
)
check(
  '迁移后新登记的记录核对一致',
  [...migratedVerdicts.entries()].filter(([id]) => id > 3).every(([, v]) => v.status === '一致'),
)
// 没动过的纯种子旧数据直接换成带凭据链的种子账本
const legacySeed = makeStorage()
legacySeed.storage.setItem('data-layer-studio:entries', JSON.stringify(SEED_ROWS))
configureLedgerStorage(legacySeed.storage)
check('纯种子旧数据迁移出凭据链', snapshotLedger().receipts.length === 3)

console.log(`\n${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}