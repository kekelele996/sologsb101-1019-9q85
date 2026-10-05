/**
 * 补纸（Paper）数据模型
 * 为书叶选配的补纸：纸种、帘纹、厚度、色差 ΔE、染色配方与复染登记。
 */

/** 纸种：竹纸 / 皮纸 / 宣纸 */
export type PaperType = 'bamboo' | 'bark' | 'xuan';

/** 单次复染登记：复染后回填的实测色差与复染日期 */
export interface RedyeRecord {
  /** 第几回复染，从 1 开始 */
  round: number;
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
  /** 与原叶的色差 ΔE（初次选配时的估值） */
  deltaE: number;
  /** 染色配方（v2 迁移时按纸种回填默认值） */
  dyeRecipe: string;
  /** 复染登记：每回复染后实测的色差与日期，按复染顺序追加（v3 新增，迁移回填空数组） */
  redyeHistory: RedyeRecord[];
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

/** 同一书叶同一种纸允许的复染次数：复染满该次数仍不达标则撤出候选推荐，提示更换纸种 */
export const MAX_REDYE_ROUNDS = 2;

export function deltaELevel(deltaE: number): { label: string; color: string } {
  if (deltaE <= 1) return { label: '几乎一致', color: '#1e8449' };
  if (deltaE <= DELTA_E_THRESHOLD) return { label: '可接受', color: '#3a6ea5' };
  if (deltaE <= 5) return { label: '需重新染色', color: '#d68910' };
  return { label: '色差过大', color: '#b03a2e' };
}

/** 已复染次数 */
export function redyeCount(paper: { redyeHistory?: RedyeRecord[] }): number {
  return paper.redyeHistory?.length ?? 0;
}

/** 当前生效色差 ΔE：复染后以最近一次实测值为准，未复染则用初次估值 */
export function effectiveDeltaE(paper: { deltaE: number; redyeHistory?: RedyeRecord[] }): number {
  const history = paper.redyeHistory ?? [];
  return history.length > 0 ? history[history.length - 1]!.deltaE : paper.deltaE;
}

/** 最近一次复染登记（无则 null） */
export function latestRedye(paper: { redyeHistory?: RedyeRecord[] }): RedyeRecord | null {
  const history = paper.redyeHistory ?? [];
  return history.length > 0 ? history[history.length - 1]! : null;
}

/** ΔE 是否达标（以复染后的实测色差为准） */
export function isDeltaEQualified(paper: { deltaE: number; redyeHistory?: RedyeRecord[] }): boolean {
  return effectiveDeltaE(paper) <= DELTA_E_THRESHOLD;
}

/**
 * 是否撤出候选推荐：
 * 同一书叶同一种纸复染两回（实测色差）仍不达标，提示修复师更换纸种。
 */
export function isPaperRetired(paper: { deltaE: number; redyeHistory?: RedyeRecord[] }): boolean {
  return redyeCount(paper) >= MAX_REDYE_ROUNDS && !isDeltaEQualified(paper);
}

/** 今天的日期（YYYY-MM-DD，本地时区） */
export function todayText(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function createEmptyPaperDraft(leafId: string): PaperDraft {
  return {
    leafId,
    paperType: 'bamboo',
    laidPattern: '二指帘纹',
    thicknessMm: 0.06,
    deltaE: 1.5,
    dyeRecipe: DEFAULT_DYE_RECIPE.bamboo,
    redyeHistory: []
  };
}
