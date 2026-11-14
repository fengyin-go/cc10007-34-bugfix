<template>
  <section class="page" :data-module="meta.key">
    <header class="page-head">
      <div>
        <h2>{{ meta.name }}管理</h2>
        <p class="page-desc">{{ meta.desc }}</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记{{ meta.entity }}</button>
        <button class="btn" type="button" @click="exportRows">导出{{ meta.name }}清单</button>
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
    </p>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>凭据签章</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" class="row-clickable" @click="openDetail(row)">
          <td v-for="column in columns" :key="column" class="cell-clip">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ receiptLabel(row) }}</td>
          <td class="row-actions" @click.stop>
            <button
              v-for="action in actions"
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
          <td :colspan="columns.length + 3" class="empty-state">暂无{{ meta.name }}数据，可先登记{{ meta.entity }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条{{ meta.name }}记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <aside v-if="detail" class="drawer">
      <header class="drawer-head">
        <strong>{{ meta.entity }}详情 · {{ detailItemKey }}</strong>
        <button class="link" type="button" @click="closeDetail">关闭</button>
      </header>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd>{{ detail.row[column] ?? '—' }}</dd>
        </template>
        <dt>当前状态</dt>
        <dd>{{ detail.row.status }}</dd>
      </dl>
      <h3 class="drawer-sub">凭据链（与审计界面同源）</h3>
      <table v-if="detail.receipts.length" class="data-table receipt-table">
        <thead>
          <tr>
            <th>签章</th>
            <th>凭据</th>
            <th>动作</th>
            <th>状态流转</th>
            <th>操作来源</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="receipt in detail.receipts" :key="receipt.receipt_id">
            <td>#{{ receipt.seal_seq }}</td>
            <td>{{ receipt.receipt_id }}<template v-if="receipt.primary">（primary）</template></td>
            <td>{{ receipt.action }}</td>
            <td>{{ receipt.from_status }} → {{ receipt.to_status }}</td>
            <td>{{ receipt.source }}</td>
            <td>{{ receipt.created_at }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">该对象还没有凭据记录</p>
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
  receiptSummaries,
  runAction as applyAction,
} from '@/api/local-service'
import { itemKeyOf } from '@/data/receipts'
import type { AuditReceipt, EntryDetail, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{ moduleKey: string }>()

const meta = moduleMeta(props.moduleKey)
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const receipts = ref<Map<string, AuditReceipt>>(new Map())
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

const detailItemKey = computed(() => (detail.value ? itemKeyOf(meta, detail.value.row) : ''))

function receiptLabel(row: EntryRow): string {
  const receipt = receipts.value.get(itemKeyOf(meta, row))
  return receipt ? `#${receipt.seal_seq} ${receipt.action}` : '—'
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
  infoMessage.value = ''
  infoMessage.value = `${meta.entity}登记入口尚未接入审批流`
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
  reload()
  if (detail.value && Number(detail.value.row.id) === Number(row.id)) {
    openDetail(row)
  }
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
    receipts.value = receiptSummaries(meta.key)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : `${meta.name}列表读取失败`
  }
}

onMounted(reload)
</script>
