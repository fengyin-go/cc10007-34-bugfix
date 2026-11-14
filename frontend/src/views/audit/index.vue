<template>
  <section class="page" data-module="audit">
    <header class="page-head">
      <div>
        <h2>变更审计管理</h2>
        <p class="page-desc">维护变更审计记录的输入、执行约束与结果记录，为数据变更追溯提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记审计记录</button>
        <button class="btn" type="button" @click="exportRows">导出变更审计清单</button>
        <button class="btn" type="button" :disabled="!selected.length" @click="reviewSelected">
          批量送审（{{ selected.length }}）
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item" :class="chainProblems.length ? 'badge-err' : 'badge-ok'">
        凭据链：{{ chainProblems.length ? chainProblems.join('；') : '签章连续、幂等键唯一、root 齐全' }}
      </span>
    </p>

    <div v-if="reviewResult" class="review-panel">
      <p class="review-title">
        {{ reviewResult.message }}
        <template v-if="reviewResult.root_receipt_id">（root：{{ reviewResult.root_receipt_id }}）</template>
      </p>
      <ul class="review-items">
        <li v-for="item in reviewResult.items" :key="item.id">
          <span class="item-key">{{ item.item_key }}</span>
          <span class="badge" :class="item.code === 'REVIEW_OK' ? 'badge-ok' : 'badge-err'">{{ item.code }}</span>
          <span>{{ item.message }}</span>
        </li>
      </ul>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th class="check-col">
            <input
              type="checkbox"
              :checked="allSelected"
              title="多选集合确定审阅范围"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>凭据核对</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" class="row-clickable" @click="openDetail(row)">
          <td class="check-col" @click.stop>
            <input v-model="selected" type="checkbox" :value="Number(row.id)" />
          </td>
          <td v-for="column in columns" :key="column" class="cell-clip">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span class="badge" :class="verdictClass(row)">{{ verdictLabel(row) }}</span>
          </td>
          <td class="row-actions" @click.stop>
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无变更审计数据，可先登记审计记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条变更审计记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <aside v-if="detail" class="drawer">
      <header class="drawer-head">
        <strong>审计记录详情 · {{ String(detail.row['记录编号'] ?? '') }}</strong>
        <button class="link" type="button" @click="closeDetail">关闭</button>
      </header>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd class="cell-clip">{{ detail.row[column] ?? '—' }}</dd>
        </template>
        <dt>当前状态</dt>
        <dd>{{ detail.row.status }}</dd>
        <dt>凭据核对</dt>
        <dd>
          <span class="badge" :class="verdictClass(detail.row)">{{ verdictLabel(detail.row) }}</span>
        </dd>
      </dl>
      <template v-if="verdictOf(detail.row)?.problems.length">
        <h3 class="drawer-sub">核对问题</h3>
        <ul class="problem-list">
          <li v-for="problem in verdictOf(detail.row)?.problems" :key="problem">{{ problem }}</li>
        </ul>
      </template>
      <h3 class="drawer-sub">凭据链（与业务界面同源）</h3>
      <table v-if="detail.receipts.length" class="data-table receipt-table">
        <thead>
          <tr>
            <th>签章</th>
            <th>凭据</th>
            <th>动作</th>
            <th>状态流转</th>
            <th>受影响对象</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="receipt in detail.receipts" :key="receipt.receipt_id">
            <td>#{{ receipt.seal_seq }}</td>
            <td>
              {{ receipt.receipt_id }}
              <template v-if="receipt.primary">（primary）</template>
              <template v-if="receipt.root_id !== receipt.receipt_id">· root {{ receipt.root_id }}</template>
            </td>
            <td>{{ receipt.action }}</td>
            <td>{{ receipt.from_status }} → {{ receipt.to_status }}</td>
            <td>{{ receipt.affected }}</td>
            <td>{{ receipt.created_at }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">该记录还没有凭据</p>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntryDetail,
  listEntries,
  moduleMeta,
  reviewAuditEntries,
  runAction as applyAction,
  verifyAuditRecords,
  verifyLedgerChain,
} from '@/api/local-service'
import type { EntryDetail, EntryRow, ReceiptVerification, ReviewResult } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('audit')
const columns = meta.fields
const statuses = meta.statuses

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selected = ref<number[]>([])
const reviewResult = ref<ReviewResult | null>(null)
const verdicts = ref<Map<number, ReceiptVerification>>(new Map())
const chainProblems = ref<string[]>([])
const detail = ref<EntryDetail | null>(null)

const stats = computed(() =>
  meta.metrics.map((label) => {
    const status = statuses.find((item) => label.includes(item))
    const value = status
      ? rows.value.filter((row) => String(row.status) === status).length
      : rows.value.length
    return { label, value }
  }),
)

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const allSelected = computed(() => rows.value.length > 0 && selected.value.length === rows.value.length)

// 动作按状态放行：只有送审（审核中）后的凭据可忽略；草稿只能送审。
function actionsFor(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '草稿') return ['提交审核']
  if (status === '审核中') return ['归档记录', '忽略记录']
  return []
}

function verdictOf(row: EntryRow): ReceiptVerification | null {
  return verdicts.value.get(Number(row.id)) ?? null
}

function verdictLabel(row: EntryRow): string {
  const verdict = verdictOf(row)
  if (!verdict) return '—'
  return verdict.receipt ? `${verdict.status} #${verdict.receipt.seal_seq}` : verdict.status
}

function verdictClass(row: EntryRow): string {
  const verdict = verdictOf(row)
  if (!verdict) return ''
  if (verdict.status === '一致') return 'badge-ok'
  if (verdict.status === '缺凭据') return 'badge-warn'
  return 'badge-err'
}

function toggleAll() {
  selected.value = allSelected.value ? [] : rows.value.map((row) => Number(row.id))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  infoMessage.value = '审计记录由业务动作双写自动生成，也保留手工登记入口（尚未接入审批流）'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, {
    operator: session.operator,
    source: `${meta.name}界面 · ${session.operator}`,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reviewResult.value = null
  reload()
  if (detail.value && Number(detail.value.row.id) === Number(row.id)) {
    openDetail(row)
  }
}

function reviewSelected() {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = reviewAuditEntries(selected.value, {
    operator: session.operator,
    source: `${meta.name}界面 · ${session.operator}`,
  })
  reviewResult.value = result
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  selected.value = []
  reload()
}

function openDetail(row: EntryRow) {
  const payload = getEntryDetail(meta.key, Number(row.id))
  if (payload) {
    detail.value = payload
  }
}

function closeDetail() {
  detail.value = null
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    verdicts.value = verifyAuditRecords()
    chainProblems.value = verifyLedgerChain()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '变更审计列表读取失败'
  }
}

onMounted(reload)
</script>
