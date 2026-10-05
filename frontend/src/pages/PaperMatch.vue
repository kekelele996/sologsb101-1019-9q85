<script setup lang="ts">
/**
 * /papers 补纸选配与染色比对
 * 按 ΔE 排序候选补纸并记录染色配方；ΔE 超阈值时提示重新染色。
 * 消费 Paper、Leaf；复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<DamageTag>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import DamageTag from '@/components/common/DamageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import {
  DEFAULT_DYE_RECIPE,
  DELTA_E_THRESHOLD,
  LAID_PATTERN_OPTIONS,
  MAX_REDYE_ROUNDS,
  PAPER_TYPE_LABEL,
  PAPER_TYPE_OPTIONS,
  createEmptyPaperDraft,
  deltaELevel,
  effectiveDeltaE,
  isDeltaEQualified,
  isPaperRetired,
  latestRedye,
  redyeCount,
  todayText,
  type Paper,
  type PaperDraft,
  type PaperType,
  type RedyeRecord
} from '@/types/paper'
import { DAMAGE_TYPE_LABEL } from '@/types/leaf'
import {
  PAPER_BASE_COLOR,
  candidateScore,
  deltaEForLeaf,
  laidPatternMatch,
  needRedye,
  recipeConcentration
} from '@/utils/paperColor'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const FILTER_KEYS = ['paperType', 'laidPattern'] as const
const url = useFilterQuery(FILTER_KEYS)
const sortBy = ref<'deltaE' | 'thickness' | 'score'>('deltaE')

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  paperType: url.values.value.paperType ?? [],
  laidPattern: url.values.value.laidPattern ?? []
}))

const filterSelects = [
  { key: 'paperType', label: '纸种', options: PAPER_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  { key: 'laidPattern', label: '帘纹', options: LAID_PATTERN_OPTIONS.map((item) => ({ label: item, value: item })) }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    paperType: (next.paperType as string[]) ?? [],
    laidPattern: (next.laidPattern as string[]) ?? []
  })
}

function leafLabel(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '书叶已删除'
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${leaf.leafNo} 叶`
}

function leafPattern(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '二指帘纹'
  return leaf.damageType === 'stain' ? '细帘纹' : '二指帘纹'
}

const rows = computed(() => {
  const keyword = url.keyword.value.trim()
  const types = url.values.value.paperType ?? []
  const patterns = url.values.value.laidPattern ?? []
  const list = paperTable.rows.value.filter((paper) => {
    if (keyword.length > 0) {
      const haystack = `${leafLabel(paper.leafId)}${paper.dyeRecipe}${paper.thicknessMm}`
      if (!haystack.includes(keyword)) return false
    }
    if (types.length > 0 && !types.includes(paper.paperType)) return false
    if (patterns.length > 0 && !patterns.includes(paper.laidPattern)) return false
    return true
  })
  return [...list].sort((a, b) => {
    if (sortBy.value === 'thickness') return a.thicknessMm - b.thicknessMm
    if (sortBy.value === 'score') {
      return (
        candidateScore(b, leafPattern(b.leafId)) - candidateScore(a, leafPattern(a.leafId))
      )
    }
    // ΔE 排序以复染后的实测色差为准
    return effectiveDeltaE(a) - effectiveDeltaE(b)
  })
})

const stat = computed(() => {
  const list = paperTable.rows.value
  const averageDeltaE =
    list.length === 0
      ? 0
      : Math.round(
          (list.reduce((sum, paper) => sum + effectiveDeltaE(paper), 0) / list.length) * 100
        ) / 100
  return {
    total: list.length,
    averageDeltaE,
    redye: list.filter((paper) => !isDeltaEQualified(paper)).length,
    coveredLeaves: new Set(list.map((paper) => paper.leafId)).size,
    matchRate:
      list.length === 0
        ? 0
        : Math.round((list.filter((paper) => isDeltaEQualified(paper)).length / list.length) * 100),
    redyed: list.filter((paper) => redyeCount(paper) > 0).length,
    retired: list.filter((paper) => isPaperRetired(paper)).length
  }
})

/* ----------------------------- 补纸表单 ----------------------------- */
const dialog = ref(false)
const editing = ref<Paper | null>(null)
const form = reactive<PaperDraft>(createEmptyPaperDraft(''))
const leafOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).flatMap((volume) =>
      leafStore.leavesOfVolume(volume.id).map((leaf) => ({
        value: leaf.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册 · 第 ${leaf.leafNo} 叶 · ${DAMAGE_TYPE_LABEL[leaf.damageType]}`
      }))
    )
  )
)

function openCreate(): void {
  const firstLeaf = leafOptions.value[0]
  if (!firstLeaf) {
    ElMessage.warning('请先登记书叶')
    return
  }
  editing.value = null
  Object.assign(form, createEmptyPaperDraft(firstLeaf.value))
  dialog.value = true
}

function openEdit(paper: Paper): void {
  editing.value = paper
  Object.assign(form, {
    leafId: paper.leafId,
    paperType: paper.paperType,
    laidPattern: paper.laidPattern,
    thicknessMm: paper.thicknessMm,
    deltaE: paper.deltaE,
    dyeRecipe: paper.dyeRecipe,
    redyeHistory: paper.redyeHistory ?? []
  })
  dialog.value = true
}

// 纸种变化时带出默认染色配方
watch(
  () => form.paperType,
  (type: PaperType) => {
    const recipe = DEFAULT_DYE_RECIPE[type]
    if (!form.dyeRecipe || Object.values(DEFAULT_DYE_RECIPE).includes(form.dyeRecipe)) {
      form.dyeRecipe = recipe
    }
  }
)

const recipePreview = computed(() => recipeConcentration(form.paperType, form.deltaE, 1))
const formMatch = computed(() => laidPatternMatch(form.laidPattern, '二指帘纹'))

async function submit(): Promise<void> {
  if (!form.leafId) {
    ElMessage.warning('请选择关联书叶')
    return
  }
  if (editing.value) {
    // 复染登记由「复染登记」对话框单独维护，编辑时带回原值避免覆盖
    await paperTable.update(editing.value.id, { ...form })
    ElMessage.success('已更新补纸记录')
  } else {
    await paperTable.create({ ...form }, 'paper')
    ElMessage.success(needRedye(form.deltaE) ? '已新增补纸，色差超阈值需重新染色' : '已新增补纸记录')
  }
  dialog.value = false
}

async function remove(paper: Paper): Promise<void> {
  try {
    await ElMessageBox.confirm('将删除该补纸选配记录。', '删除补纸', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await paperTable.remove(paper.id)
  ElMessage.success('已删除')
}

/* ----------------------------- 候选推荐 ----------------------------- */
const candidateLeafId = ref('')
const candidates = computed(() => {
  if (!candidateLeafId.value) return []
  const leaf = leafStore.leafById(candidateLeafId.value)
  if (!leaf) return []
  const patterns = ['二指帘纹', '三指帘纹', '细帘纹']
  return PAPER_TYPE_OPTIONS.flatMap((option) => {
    const paper = paperTable.rows.value.find(
      (item) => item.leafId === leaf.id && item.paperType === option.value
    )
    // 同一书叶同一种纸复染两回仍不达标：撤出候选推荐，提示修复师换纸种
    if (paper && isPaperRetired(paper)) return []
    const deltaE = paper ? effectiveDeltaE(paper) : deltaEForLeaf(leaf.damageType, option.value)
    const laidPattern = paper ? paper.laidPattern : patterns[leaf.leafNo % patterns.length]
    const thicknessMm = paper ? paper.thicknessMm : 0.06
    return [{
      type: option.value,
      label: PAPER_TYPE_LABEL[option.value],
      deltaE,
      laidPattern,
      thicknessMm,
      score: candidateScore({ deltaE, laidPattern, thicknessMm }, '二指帘纹'),
      hasRecord: Boolean(paper),
      paperId: paper?.id ?? '',
      redyed: paper ? redyeCount(paper) : 0,
      lastRedye: paper ? latestRedye(paper) : null
    }]
  }).sort((a, b) => b.score - a.score)
})

/** 当前选中书叶上已被撤出候选的纸种（复染两回仍不达标） */
const retiredTypes = computed(() => {
  if (!candidateLeafId.value) return []
  return paperTable.rows.value
    .filter((paper) => paper.leafId === candidateLeafId.value && isPaperRetired(paper))
    .map((paper) => ({
      type: paper.paperType,
      label: PAPER_TYPE_LABEL[paper.paperType],
      last: latestRedye(paper),
      count: redyeCount(paper)
    }))
})

const candidateLeafPattern = computed(() =>
  candidateLeafId.value ? leafPattern(candidateLeafId.value) : '二指帘纹'
)

async function selectCandidate(type: PaperType, deltaE: number, laidPatternValue: string, thicknessMm: number): Promise<void> {
  if (!candidateLeafId.value) return
  const existing = paperTable.rows.value.find(
    (item) => item.leafId === candidateLeafId.value && item.paperType === type
  )
  if (existing) {
    // 已有登记：只更新采用状态相关字段，保留初测估值与复染登记不被候选估算值覆盖
    await paperTable.update(existing.id, {
      laidPattern: laidPatternValue,
      thicknessMm
    })
    ElMessage.success(`已更新${PAPER_TYPE_LABEL[type]}候选`)
  } else {
    const payload: PaperDraft = {
      leafId: candidateLeafId.value,
      paperType: type,
      laidPattern: laidPatternValue,
      thicknessMm,
      deltaE,
      dyeRecipe: DEFAULT_DYE_RECIPE[type],
      redyeHistory: []
    }
    await paperTable.create(payload, 'paper')
    ElMessage.success(`已采用${PAPER_TYPE_LABEL[type]}候选补纸`)
  }
}

/* ----------------------------- 复染登记 ----------------------------- */
const redyeDialog = ref(false)
const redyeTarget = ref<Paper | null>(null)
const redyeForm = reactive<{ deltaE: number; date: string }>({ deltaE: 2, date: todayText() })

function openRedye(paper: Paper): void {
  if (isPaperRetired(paper)) {
    ElMessage.warning(
      `${PAPER_TYPE_LABEL[paper.paperType]}已复染 ${MAX_REDYE_ROUNDS} 回仍不达标，请更换纸种，不再登记复染`
    )
    return
  }
  redyeTarget.value = paper
  redyeForm.deltaE = Math.max(0, Math.round((effectiveDeltaE(paper) - 1) * 10) / 10)
  redyeForm.date = todayText()
  redyeDialog.value = true
}

const redyeNextRound = computed(() => (redyeTarget.value ? redyeCount(redyeTarget.value) + 1 : 1))
const redyeBeforeDeltaE = computed(() => (redyeTarget.value ? effectiveDeltaE(redyeTarget.value) : 0))

async function submitRedye(): Promise<void> {
  const target = redyeTarget.value
  if (!target) return
  if (!redyeForm.date) {
    ElMessage.warning('请填写复染日期')
    return
  }
  const record: RedyeRecord = {
    round: redyeNextRound.value,
    deltaE: redyeForm.deltaE,
    date: redyeForm.date
  }
  const history = [...(target.redyeHistory ?? []), record]
  await paperTable.update(target.id, { redyeHistory: history })

  // 记好复染实测色差后，按新色差重算达标状态与综合评分
  if (record.deltaE <= DELTA_E_THRESHOLD) {
    ElMessage.success(`第 ${record.round} 回复染后实测 ΔE ${record.deltaE}，已达标，评分已重算`)
  } else if (history.length >= MAX_REDYE_ROUNDS) {
    ElMessage.warning(
      `${PAPER_TYPE_LABEL[target.paperType]}复染 ${MAX_REDYE_ROUNDS} 回实测 ΔE 仍为 ${record.deltaE}，不达标：已从候选推荐撤出，请更换纸种`
    )
  } else {
    ElMessage.warning(`第 ${record.round} 回复染后实测 ΔE ${record.deltaE} 仍超阈值，请再次复染`)
  }
  redyeDialog.value = false
}

function deltaTag(deltaE: number): { label: string; color: string } {
  return deltaELevel(deltaE)
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>补纸选配与染色比对</h2>
        <p>
          按复染后的实测 ΔE 排列候选补纸（阈值 {{ DELTA_E_THRESHOLD }}）；复染登记回填实测色差与日期，自动重算达标状态与综合评分，复染两回仍不达标则撤出候选。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-select v-model="sortBy" style="width: 160px">
          <el-option label="按 ΔE 升序" value="deltaE" />
          <el-option label="按厚度升序" value="thickness" />
          <el-option label="按综合评分" value="score" />
        </el-select>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增补纸</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="补纸记录" :value="stat.total" suffix="条" tone="primary" />
      <StatBadge label="平均实测 ΔE" :value="stat.averageDeltaE" tone="warning" />
      <StatBadge label="仍不达标" :value="stat.redye" suffix="条" tone="danger" />
      <StatBadge label="ΔE 达标率" :value="`${stat.matchRate}%`" :percent="stat.matchRate" tone="success" />
      <StatBadge label="已复染" :value="stat.redyed" suffix="条" tone="info" />
      <StatBadge label="撤出候选(换纸种)" :value="stat.retired" suffix="种" tone="danger" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索书叶 / 配方 / 厚度…"
      @change="handleFilterChange"
      @reset="url.reset()"
    />

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :xs="24" :xl="16">
        <el-card shadow="never">
          <EmptyPanel
            v-if="rows.length === 0"
            :title="paperTable.rows.value.length === 0 ? '还没有补纸选配记录' : '当前条件下没有记录'"
            :description="
              paperTable.rows.value.length === 0
                ? '为破损书叶选配补纸，记录纸种、帘纹、厚度、色差与染色配方。'
                : '试着调整纸种或帘纹筛选条件。'
            "
            action-text="新增补纸"
            secondary-text="重置筛选"
            size="small"
            @action="openCreate"
            @secondary="url.reset()"
          />
          <el-table v-else :data="rows" size="small" border>
            <el-table-column label="关联书叶" min-width="200">
              <template #default="{ row }">
                <div>{{ leafLabel(row.leafId) }}</div>
                <div class="gb-muted">
                  <DamageTag v-if="leafStore.leafById(row.leafId)" :type="leafStore.leafById(row.leafId)!.damageType" size="small" />
                </div>
              </template>
            </el-table-column>
            <el-table-column label="纸种" width="90">
              <template #default="{ row }">{{ PAPER_TYPE_LABEL[row.paperType as PaperType] }}</template>
            </el-table-column>
            <el-table-column label="帘纹" width="150">
              <template #default="{ row }">
                {{ row.laidPattern }}
                <el-tag size="small" effect="plain" round>{{ laidPatternMatch(row.laidPattern, leafPattern(row.leafId)) }}%</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="thicknessMm" label="厚度(mm)" width="100" />
            <el-table-column label="色差 ΔE（实测）" width="180">
              <template #default="{ row }">
                <div>
                  {{ effectiveDeltaE(row) }}
                  <el-tag :style="{ color: deltaTag(effectiveDeltaE(row)).color, borderColor: `${deltaTag(effectiveDeltaE(row)).color}66` }" effect="plain" size="small" round>
                    {{ deltaTag(effectiveDeltaE(row)).label }}
                  </el-tag>
                </div>
                <div class="gb-muted">
                  初测估值 {{ row.deltaE }}<template v-if="redyeCount(row) > 0"> · 复染 {{ redyeCount(row) }} 回 · 最近 {{ latestRedye(row)?.date }}</template>
                </div>
                <el-tag v-if="isPaperRetired(row)" type="danger" effect="dark" size="small" round style="margin-top: 2px">
                  复染两回不达标 · 已撤出候选
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="综合评分" width="100">
              <template #default="{ row }">{{ candidateScore(row, leafPattern(row.leafId)) }}</template>
            </el-table-column>
            <el-table-column label="复染登记" min-width="190">
              <template #default="{ row }">
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :disabled="isPaperRetired(row)"
                  @click="openRedye(row)"
                >
                  {{ redyeCount(row) > 0 ? `登记第 ${redyeCount(row) + 1} 回复染` : '复染登记' }}
                </el-button>
                <el-tooltip
                  v-if="(row.redyeHistory ?? []).length > 0"
                  placement="top"
                  effect="light"
                >
                  <template #content>
                    <div v-for="item in row.redyeHistory" :key="item.round">
                      第 {{ item.round }} 回 · {{ item.date }} · 实测 ΔE {{ item.deltaE }}
                    </div>
                  </template>
                  <el-link type="info" :underline="false" style="margin-left: 6px; font-size: 12px">复染记录</el-link>
                </el-tooltip>
                <div v-else class="gb-muted">尚未复染</div>
              </template>
            </el-table-column>
            <el-table-column label="染色配方" min-width="200">
              <template #default="{ row }">
                <el-tag v-if="!isDeltaEQualified(row)" type="danger" effect="plain" size="small" round>需重新染色</el-tag>
                <el-tag v-else-if="redyeCount(row) > 0" type="success" effect="plain" size="small" round>复染已达标</el-tag>
                <div class="gb-muted">{{ row.dyeRecipe }}</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="8">
        <el-card shadow="never">
          <template #header>候选补纸推荐</template>
          <el-select v-model="candidateLeafId" placeholder="选择需要配纸的书叶" style="width: 100%; margin-bottom: 10px">
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>

          <EmptyPanel
            v-if="candidates.length === 0 && retiredTypes.length === 0"
            title="选择书叶后生成候选"
            description="将按复染后实测 ΔE、帘纹匹配度与厚度接近度综合评分排序。"
            size="small"
          />
          <el-alert
            v-if="retiredTypes.length > 0"
            type="warning"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            title="下列纸种复染两回仍不达标，已撤出候选，请修复师更换纸种"
          >
            <div v-for="item in retiredTypes" :key="item.type">
              {{ item.label }}：最近实测 ΔE {{ item.last?.deltaE }}（{{ item.last?.date }}），共复染 {{ item.count }} 回
            </div>
          </el-alert>
          <EmptyPanel
            v-if="candidates.length === 0 && retiredTypes.length > 0"
            title="候选纸种已全部撤出"
            description="该书叶各纸种复染两回后实测色差均不达标，请考虑更换纸种后重新选配。"
            size="small"
          />
          <div v-else style="display: flex; flex-direction: column; gap: 10px">
            <div v-for="item in candidates" :key="item.type">
              <div class="gb-paper-swatch" :style="{ background: PAPER_BASE_COLOR[item.type] }" />
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px">
                <div>
                  <strong>{{ item.label }}</strong>
                  <span class="gb-muted"> · 评分 {{ item.score }}</span>
                </div>
                <el-tag :type="needRedye(item.deltaE) ? 'danger' : 'success'" effect="plain" size="small" round>
                  ΔE {{ item.deltaE }}
                </el-tag>
              </div>
              <div class="gb-muted">
                帘纹 {{ item.laidPattern }}（匹配 {{ laidPatternMatch(item.laidPattern, candidateLeafPattern) }}%）· 厚度
                {{ item.thicknessMm }}mm · {{ item.hasRecord ? '已有登记' : '尚无登记（按基准色估算）' }}
              </div>
              <div v-if="item.redyed > 0" class="gb-muted">
                已复染 {{ item.redyed }} 回，最近 {{ item.lastRedye?.date }} 实测 ΔE {{ item.lastRedye?.deltaE }}
              </div>
              <el-button
                size="small"
                style="margin-top: 6px"
                @click="selectCandidate(item.type, item.deltaE, item.laidPattern, item.thicknessMm)"
              >
                {{ item.hasRecord ? '更新为采用' : '采用该候选' }}
              </el-button>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialog" :title="editing ? '编辑补纸记录' : '新增补纸记录'" width="620px">
      <el-form label-width="110px">
        <el-form-item label="关联书叶" required>
          <el-select v-model="form.leafId" style="width: 100%" filterable>
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="form.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="帘纹">
          <el-select v-model="form.laidPattern" style="width: 100%">
            <el-option v-for="item in LAID_PATTERN_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
          <span class="gb-muted">与目标帘纹匹配度 {{ formMatch }}%</span>
        </el-form-item>
        <el-form-item label="厚度(mm)">
          <el-input-number v-model="form.thicknessMm" :min="0.01" :max="0.5" :step="0.01" :precision="2" />
        </el-form-item>
        <el-form-item label="色差 ΔE">
          <el-input-number v-model="form.deltaE" :min="0" :max="20" :step="0.1" :precision="1" />
          <el-tag
            style="margin-left: 8px"
            :style="{ color: deltaTag(form.deltaE).color, borderColor: `${deltaTag(form.deltaE).color}66` }"
            effect="plain"
            round
          >
            {{ deltaTag(form.deltaE).label }}
          </el-tag>
        </el-form-item>
        <el-form-item label="染色配方">
          <el-input v-model="form.dyeRecipe" type="textarea" :rows="2" />
          <span class="gb-muted">{{ recipePreview.note }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="redyeDialog" title="复染登记" width="520px">
      <div v-if="redyeTarget" class="gb-muted" style="margin-bottom: 12px">
        {{ leafLabel(redyeTarget.leafId) }} · {{ PAPER_TYPE_LABEL[redyeTarget.paperType] }} ·
        复染前 ΔE {{ redyeBeforeDeltaE }}（{{ redyeCount(redyeTarget) > 0 ? '上一回复染实测' : '初次选配估值' }}）
      </div>
      <el-form label-width="130px">
        <el-form-item label="复染回次">
          <el-tag effect="plain" round>第 {{ redyeNextRound }} 回</el-tag>
        </el-form-item>
        <el-form-item label="复染日期" required>
          <el-input v-model="redyeForm.date" type="date" />
        </el-form-item>
        <el-form-item label="复染后实测 ΔE" required>
          <el-input-number v-model="redyeForm.deltaE" :min="0" :max="20" :step="0.1" :precision="1" />
          <el-tag
            v-if="redyeTarget"
            style="margin-left: 8px"
            :style="{ color: deltaTag(redyeForm.deltaE).color, borderColor: `${deltaTag(redyeForm.deltaE).color}66` }"
            effect="plain"
            round
          >
            {{ deltaTag(redyeForm.deltaE).label }}
          </el-tag>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="redyeNextRound >= MAX_REDYE_ROUNDS"
        type="warning"
        show-icon
        :closable="false"
        title="这是该纸种第 2 回复染；若实测色差仍超阈值，该纸种将自动撤出候选推荐，请修复师更换纸种。"
      />
      <el-alert
        v-else
        type="info"
        show-icon
        :closable="false"
        title="保存后按复染后实测色差重新判定达标状态并重算综合评分，列表排序、统计与导出台账同步更新。"
      />
      <template #footer>
        <el-button @click="redyeDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRedye">保存复染记录</el-button>
      </template>
    </el-dialog>
  </div>
</template>
