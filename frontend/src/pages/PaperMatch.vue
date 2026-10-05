<script setup lang="ts">
/**
 * /papers 补纸选配与染色比对
 * 按复染后的实测 ΔE 排序候选补纸并记录染色配方；复染登记回填实测色差与复染日期。
 * 达标状态、综合评分、排序、统计与导出均按末次复染实测值重算；
 * 同一书叶同一种纸复染两回仍不达标则撤出候选推荐，提示修复师更换纸种。
 * 消费 Paper、Leaf；复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<DamageTag>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshRight } from '@element-plus/icons-vue'
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
  MAX_REDYE_TIMES,
  PAPER_TYPE_LABEL,
  PAPER_TYPE_OPTIONS,
  createEmptyPaperDraft,
  deltaELevel,
  effectiveDeltaE,
  isCandidateRetired,
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
        candidateScore({ ...b, deltaE: effectiveDeltaE(b) }, leafPattern(b.leafId)) -
        candidateScore({ ...a, deltaE: effectiveDeltaE(a) }, leafPattern(a.leafId))
      )
    }
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
    redye: list.filter((paper) => needRedye(effectiveDeltaE(paper))).length,
    redyeRegistered: list.reduce((sum, paper) => sum + redyeCount(paper), 0),
    retired: list.filter((paper) => isCandidateRetired(paper)).length,
    coveredLeaves: new Set(list.map((paper) => paper.leafId)).size,
    matchRate:
      list.length === 0
        ? 0
        : Math.round(
            (list.filter((paper) => !needRedye(effectiveDeltaE(paper))).length / list.length) * 100
          )
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
    redyes: [...paper.redyes]
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

/* ----------------------------- 复染登记 ----------------------------- */
const redyeDialog = ref(false)
const redyeTarget = ref<Paper | null>(null)
const redyeForm = reactive({ deltaE: 1, date: todayText() })

/** 复染回次（1 起）：第 1 回 = 首次复染，第 2 回 = 末次复染 */
const redyeRound = computed(() => (redyeTarget.value ? redyeCount(redyeTarget.value) + 1 : 1))

/** 复染对话框中的复染前实测色差 */
const redyeCurrentDeltaE = computed(() =>
  redyeTarget.value ? effectiveDeltaE(redyeTarget.value) : 0
)
const redyeCurrentOver = computed(() => needRedye(redyeCurrentDeltaE.value))

/** 已达标或两回仍超阈值的记录不能再登记复染 */
function canRegisterRedye(paper: Paper): boolean {
  if (isCandidateRetired(paper)) return false
  if (!needRedye(effectiveDeltaE(paper))) return false
  return redyeCount(paper) < MAX_REDYE_TIMES
}

function redyeDisabledReason(paper: Paper): string {
  if (isCandidateRetired(paper)) return '复染两回仍不达标，已撤出候选，请更换纸种'
  if (!needRedye(effectiveDeltaE(paper))) return '当前实测色差已达标，无需复染'
  return ''
}

function openRedye(paper: Paper): void {
  if (!canRegisterRedye(paper)) {
    ElMessage.warning(redyeDisabledReason(paper))
    return
  }
  redyeTarget.value = paper
  redyeForm.deltaE = Number(Math.max(0, effectiveDeltaE(paper) - 1).toFixed(2))
  redyeForm.date = todayText()
  redyeDialog.value = true
}

const redyePreview = computed(() =>
  redyeTarget.value ? recipeConcentration(redyeTarget.value.paperType, redyeForm.deltaE, 1) : null
)

async function submitRedye(): Promise<void> {
  const target = redyeTarget.value
  if (!target) return
  if (!redyeForm.date) {
    ElMessage.warning('请填写复染日期')
    return
  }
  if (redyeForm.deltaE < 0) {
    ElMessage.warning('实测色差不能为负')
    return
  }
  const record: RedyeRecord = {
    deltaE: Math.round(redyeForm.deltaE * 100) / 100,
    date: redyeForm.date
  }
  await paperTable.update(target.id, { redyes: [...target.redyes, record] })
  redyeDialog.value = false

  // 记好即按新色差重算：第 2 回复染仍超阈值 → 撤出候选，提示修复师换纸种
  const merged: Paper = { ...target, redyes: [...target.redyes, record] }
  if (redyeCount(merged) >= MAX_REDYE_TIMES && needRedye(effectiveDeltaE(merged))) {
    await ElMessageBox.alert(
      `${leafLabel(target.leafId)}的${PAPER_TYPE_LABEL[target.paperType]}已复染 ${MAX_REDYE_TIMES} 回，实测 ΔE 仍为 ${effectiveDeltaE(
        merged
      )}（阈值 ${DELTA_E_THRESHOLD}）。该纸种已从候选推荐中撤下，请改用其他纸种。`,
      '复染两回仍不达标，请更换纸种',
      { type: 'warning', confirmButtonText: '知道了' }
    )
  } else if (needRedye(effectiveDeltaE(merged))) {
    ElMessage.warning(`第 ${redyeCount(merged)} 回复染已登记，ΔE ${effectiveDeltaE(merged)} 仍超阈值，可再复染一次`)
  } else {
    ElMessage.success(`第 ${redyeCount(merged)} 回复染已登记，实测 ΔE ${effectiveDeltaE(merged)} 达标`)
  }
  redyeTarget.value = null
}

/* ----------------------------- 候选推荐 ----------------------------- */
const candidateLeafId = ref('')
const candidateLeafPattern = computed(() =>
  candidateLeafId.value ? leafPattern(candidateLeafId.value) : '二指帘纹'
)
const candidates = computed(() => {
  if (!candidateLeafId.value) return []
  const leaf = leafStore.leafById(candidateLeafId.value)
  if (!leaf) return []
  const patterns = ['二指帘纹', '三指帘纹', '细帘纹']
  return PAPER_TYPE_OPTIONS.map((option) => {
    const paper = paperTable.rows.value.find(
      (item) => item.leafId === leaf.id && item.paperType === option.value
    )
    const deltaE = paper ? effectiveDeltaE(paper) : deltaEForLeaf(leaf.damageType, option.value)
    const laidPattern = paper ? paper.laidPattern : patterns[leaf.leafNo % patterns.length]
    const thicknessMm = paper ? paper.thicknessMm : 0.06
    const retired = paper ? isCandidateRetired(paper) : false
    return {
      type: option.value,
      label: PAPER_TYPE_LABEL[option.value],
      deltaE,
      laidPattern,
      thicknessMm,
      score: candidateScore({ deltaE, laidPattern, thicknessMm }, candidateLeafPattern.value),
      hasRecord: Boolean(paper),
      retired,
      paperId: paper?.id ?? ''
    }
  })
    // 同一书叶同一种纸复染两回仍不达标 → 撤出候选推荐
    .filter((item) => !item.retired)
    .sort((a, b) => b.score - a.score)
})

/** 被撤下的纸种（用于提示修复师换纸种） */
const retiredCandidates = computed(() => {
  if (!candidateLeafId.value) return []
  return paperTable.rows.value
    .filter((paper) => paper.leafId === candidateLeafId.value && isCandidateRetired(paper))
    .map((paper) => PAPER_TYPE_LABEL[paper.paperType])
})

async function selectCandidate(type: PaperType, deltaE: number, laidPatternValue: string, thicknessMm: number): Promise<void> {
  if (!candidateLeafId.value) return
  const existing = paperTable.rows.value.find(
    (item) => item.leafId === candidateLeafId.value && item.paperType === type
  )
  if (existing) {
    // 已有登记（含复染记录）时只更新帘纹、厚度与配方；实测色差由复染登记维护，不在此覆盖
    await paperTable.update(existing.id, {
      laidPattern: laidPatternValue,
      thicknessMm,
      dyeRecipe: DEFAULT_DYE_RECIPE[type]
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
      redyes: []
    }
    await paperTable.create(payload, 'paper')
    ElMessage.success(`已采用${PAPER_TYPE_LABEL[type]}候选补纸`)
  }
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
          按复染后的实测 ΔE 升序排列候选补纸（阈值 {{ DELTA_E_THRESHOLD }}）；复染登记回填实测色差与日期，达标状态与综合评分按末次复染重算。同一纸种复染两回仍不达标将撤出候选。
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
      <StatBadge label="仍需复染" :value="stat.redye" suffix="条" tone="danger" />
      <StatBadge label="复染登记" :value="stat.redyeRegistered" suffix="回" tone="warning" />
      <StatBadge label="已撤换纸种" :value="stat.retired" suffix="种" tone="danger" />
      <StatBadge label="覆盖书叶" :value="stat.coveredLeaves" suffix="叶" tone="info" />
      <StatBadge label="ΔE 达标率" :value="`${stat.matchRate}%`" :percent="stat.matchRate" tone="success" />
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
            <el-table-column label="ΔE（实测）" width="190" sortable :sort-method="(a: Paper, b: Paper) => effectiveDeltaE(a) - effectiveDeltaE(b)">
              <template #default="{ row }">
                <div>
                  <strong>{{ effectiveDeltaE(row) }}</strong>
                  <el-tag :style="{ color: deltaTag(effectiveDeltaE(row)).color, borderColor: `${deltaTag(effectiveDeltaE(row)).color}66` }" effect="plain" size="small" round style="margin-left: 4px">
                    {{ deltaTag(effectiveDeltaE(row)).label }}
                  </el-tag>
                </div>
                <div class="gb-muted">
                  初始估值 {{ row.deltaE }}
                  <template v-if="redyeCount(row) > 0">
                    · 已复染 {{ redyeCount(row) }} 回
                    <el-tag v-if="isCandidateRetired(row)" type="danger" effect="plain" size="small" round>已撤下</el-tag>
                  </template>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="综合评分" width="100">
              <template #default="{ row }">{{ candidateScore({ ...row, deltaE: effectiveDeltaE(row) }, leafPattern(row.leafId)) }}</template>
            </el-table-column>
            <el-table-column label="染色 / 复染" min-width="220">
              <template #default="{ row }">
                <el-tag v-if="needRedye(effectiveDeltaE(row))" type="danger" effect="plain" size="small" round>需重新染色</el-tag>
                <el-tag v-else-if="redyeCount(row) > 0" type="success" effect="plain" size="small" round>复染达标</el-tag>
                <div v-if="redyeCount(row) > 0" class="gb-muted">
                  末次复染 {{ row.redyes[redyeCount(row) - 1].date }} · 实测 ΔE {{ effectiveDeltaE(row) }}
                </div>
                <div class="gb-muted">{{ row.dyeRecipe }}</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230">
              <template #default="{ row }">
                <el-button
                  size="small"
                  text
                  type="warning"
                  :icon="RefreshRight"
                  :disabled="!canRegisterRedye(row)"
                  :title="redyeDisabledReason(row)"
                  @click="openRedye(row)"
                >
                  复染登记
                </el-button>
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
            v-if="candidateLeafId && candidates.length === 0"
            title="候选纸种均已撤下"
            description="各纸种复染两回后实测色差仍超阈值，请更换纸种后重新选配。"
            size="small"
          />
          <EmptyPanel
            v-else-if="candidates.length === 0"
            title="选择书叶后生成候选"
            description="将按复染后实测 ΔE、帘纹匹配度与厚度接近度综合评分排序。"
            size="small"
          />
          <el-alert
            v-if="retiredCandidates.length > 0"
            type="warning"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            :title="`${retiredCandidates.join('、')}复染两回仍不达标，已撤出候选，请改用其他纸种`"
          />
          <div v-else-if="candidates.length > 0" style="display: flex; flex-direction: column; gap: 10px">
            <div v-for="item in candidates" :key="item.type">
              <div class="gb-paper-swatch" :style="{ background: PAPER_BASE_COLOR[item.type] }" />
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px">
                <div>
                  <strong>{{ item.label }}</strong>
                  <span class="gb-muted"> · 评分 {{ item.score }}</span>
                </div>
                <el-tag :type="needRedye(item.deltaE) ? 'danger' : 'success'" effect="plain" size="small" round>
                  {{ item.hasRecord ? '实测' : '估算' }} ΔE {{ item.deltaE }}
                </el-tag>
              </div>
              <div class="gb-muted">
                帘纹 {{ item.laidPattern }}（匹配 {{ laidPatternMatch(item.laidPattern, candidateLeafPattern) }}%）· 厚度
                {{ item.thicknessMm }}mm · {{ item.hasRecord ? '已有登记' : '尚无登记（按基准色估算）' }}
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
        <el-form-item label="初始色差 ΔE">
          <el-input-number v-model="form.deltaE" :min="0" :max="20" :step="0.1" :precision="1" />
          <el-tag
            style="margin-left: 8px"
            :style="{ color: deltaTag(form.deltaE).color, borderColor: `${deltaTag(form.deltaE).color}66` }"
            effect="plain"
            round
          >
            {{ deltaTag(form.deltaE).label }}
          </el-tag>
          <div class="gb-muted">染色前估值；复染后的实测色差请通过「复染登记」回填，达标判定以末次复染为准。</div>
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

    <el-dialog v-model="redyeDialog" title="复染登记" width="560px">
      <div v-if="redyeTarget" class="gb-muted" style="margin-bottom: 12px">
        {{ leafLabel(redyeTarget.leafId) }} · {{ PAPER_TYPE_LABEL[redyeTarget.paperType] }} ·
        第 {{ redyeRound }} 回复染（至多 {{ MAX_REDYE_TIMES }} 回）
      </div>
      <el-form label-width="120px">
        <el-form-item label="复染前 ΔE">
          <span class="gb-muted">{{ redyeCurrentDeltaE }}（{{ redyeCurrentOver ? '超阈值' : '已达标' }}）</span>
        </el-form-item>
        <el-form-item label="复染后实测 ΔE" required>
          <el-input-number v-model="redyeForm.deltaE" :min="0" :max="20" :step="0.1" :precision="2" />
          <el-tag
            style="margin-left: 8px"
            :style="{ color: deltaTag(redyeForm.deltaE).color, borderColor: `${deltaTag(redyeForm.deltaE).color}66` }"
            effect="plain"
            round
          >
            {{ deltaTag(redyeForm.deltaE).label }}
          </el-tag>
          <div v-if="redyePreview" class="gb-muted">{{ redyePreview.note }}</div>
        </el-form-item>
        <el-form-item label="复染日期" required>
          <el-date-picker v-model="redyeForm.date" type="date" value-format="YYYY-MM-DD" placeholder="选择复染日期" style="width: 200px" />
        </el-form-item>
      </el-form>

      <div v-if="redyeTarget && redyeCount(redyeTarget) > 0" style="margin-top: 4px">
        <div class="gb-muted" style="margin-bottom: 4px">历次复染：</div>
        <el-tag
          v-for="(record, index) in redyeTarget.redyes"
          :key="index"
          style="margin-right: 8px"
          :type="needRedye(record.deltaE) ? 'danger' : 'success'"
          effect="plain"
        >
          第 {{ index + 1 }} 回 · {{ record.date }} · ΔE {{ record.deltaE }}
        </el-tag>
      </div>

      <el-alert
        v-if="redyeRound >= MAX_REDYE_TIMES"
        type="warning"
        show-icon
        :closable="false"
        style="margin-top: 12px"
        title="本回为最后一次复染：若实测色差仍超阈值，该纸种将从候选推荐中撤下，请改用其他纸种。"
      />
      <template #footer>
        <el-button @click="redyeDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRedye">登记并按新色差重算</el-button>
      </template>
    </el-dialog>
  </div>
</template>
