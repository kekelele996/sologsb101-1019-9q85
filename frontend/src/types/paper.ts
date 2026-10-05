/**
 * 补纸（Paper）数据模型
 * 为书叶选配的补纸：纸种、帘纹、厚度、色差 ΔE 与染色配方。
 */

/** 纸种：竹纸 / 皮纸 / 宣纸 */
export type PaperType = 'bamboo' | 'bark' | 'xuan';

/** 一次复染登记：复染后的实测色差与复染日期 */
export interface RedyeRecord {
  /** 复染后实测色差 ΔE */
  deltaE: number;
  /** 复染日期（YYYY-MM-DD） */
  date: string;
}

export interface Paper {
  id: string;
  /** 关联书叶 id */
  leafId: string;
  /** 纸种 */
  paperType: PaperType;
  /** 帘纹，如「二指帘纹」 */
  laidPattern: string;
  /** 厚度 mm */
  thicknessMm: number;
  /** 染色前与原叶的色差估值 ΔE（复染后以 redyes 末次实测值为准） */
  deltaE: number;
  /** 染色配方（v2 迁移时按纸种回填默认值） */
  dyeRecipe: string;
  /** 复染登记：按时间顺序记录每回复染后的实测色差与日期（v3 起） */
  redyes: RedyeRecord[];
  createdAt: number;
  updatedAt: number;
}

export type PaperDraft = Omit<Paper, 'id' | 'createdAt' | 'updatedAt'>;

export const PAPER_TYPE_LABEL: Record<PaperType, string> = {
  bamboo: '竹纸',
  bark: '皮纸',
  xuan: '宣纸',
};

export const PAPER_TYPE_OPTIONS: ReadonlyArray<{ value: PaperType; label: string }> = [
  { value: 'bamboo', label: '竹纸' },
  { value: 'bark', label: '皮纸' },
  { value: 'xuan', label: '宣纸' },
];

/** 各纸种的默认染色配方，db v1→v2 迁移按纸种回填 */
export const DEFAULT_DYE_RECIPE: Record<PaperType, string> = {
  bamboo: '橡碗子 12g/L + 少量墨汁调灰，水温 60℃ 浸染 8 分钟',
  bark: '黄檗 8g/L + 栀子 3g/L，水温 70℃ 浸染 6 分钟',
  xuan: '藤黄 5g/L + 赭石 2g/L，常温浸染 10 分钟',
};

export const LAID_PATTERN_OPTIONS: readonly string[] = [
  '二指帘纹',
  '三指帘纹',
  '细帘纹',
  '无帘纹',
];

/** ΔE 阈值：超过需重新染色 */
export const DELTA_E_THRESHOLD = 2.5;

/** 同一书叶同一种纸允许复染的最多次数；两回复染仍不达标则撤出候选推荐 */
export const MAX_REDYE_TIMES = 2;

/**
 * 生效色差 ΔE：有复染登记时取末次复染实测值，否则取染色前估值。
 * 达标判定、综合评分、列表排序、统计徽标与导出台账一律以此为准。
 */
export function effectiveDeltaE(paper: Pick<Paper, 'deltaE' | 'redyes'>): number {
  const last = paper.redyes?.[paper.redyes.length - 1];
  return last ? last.deltaE : paper.deltaE;
}

/** 已登记的复染次数 */
export function redyeCount(paper: Pick<Paper, 'redyes'>): number {
  return paper.redyes?.length ?? 0;
}

/**
 * 该纸种是否已从候选推荐撤下：
 * 同一书叶同一种纸复染满 MAX_REDYE_TIMES 回、末次实测色差仍超阈值。
 */
export function isCandidateRetired(paper: Pick<Paper, 'deltaE' | 'redyes'>): boolean {
  if (redyeCount(paper) < MAX_REDYE_TIMES) return false;
  return effectiveDeltaE(paper) > DELTA_E_THRESHOLD;
}

export function deltaELevel(deltaE: number): { label: string; color: string } {
  if (deltaE <= 1) return { label: '几乎一致', color: '#1e8449' };
  if (deltaE <= DELTA_E_THRESHOLD) return { label: '可接受', color: '#3a6ea5' };
  if (deltaE <= 5) return { label: '需重新染色', color: '#d68910' };
  return { label: '色差过大', color: '#b03a2e' };
}

export function createEmptyPaperDraft(leafId: string): PaperDraft {
  return {
    leafId,
    paperType: 'bamboo',
    laidPattern: '二指帘纹',
    thicknessMm: 0.06,
    deltaE: 1.5,
    dyeRecipe: DEFAULT_DYE_RECIPE.bamboo,
    redyes: [],
  };
}

/** YYYY-MM-DD 格式的今天日期，供复染登记默认值 */
export function todayText(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
