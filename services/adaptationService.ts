/**
 * 烁皓改编大纲流水线 —— shuohao-skills（novel-outline）工作流的前端移植。
 *
 * 流程：小说 → 分卷摘要（两层 map-reduce 第一层）→ 骨架快版（砍线/合人/排爽点）
 *   → 质量门(skeleton) → **用户拍板** → 分批写分集（每批 ≤ 10 集）
 *   → 质量门(full) + 自动修复循环 → 资产清单（代码汇总，不让模型写）。
 *
 * 「先拍板再细化」是流程门：skeletonApproved 为假时，本服务拒绝生成任何分集。
 */

import {
  AdaptationOutline,
  OutlineBeat,
  OutlineCharacter,
  OutlineEpisode,
  OutlineGateResult,
  OutlineParams,
  OutlineScene,
  OutlineProp,
  OutlineThresholds,
  OutlineAssetRow,
} from '../types';
import { chatCompletion, parseJsonWithRecovery, retryOperation } from './ai/apiCore';
import { runOutlineGates, outlineGatesPassed, OUTLINE_CHAPTER_RE, outlineThresholdsOf, primarySceneCap } from './shuohaoGates';

/** 与技能同款：卷上限 60，超过明确报 truncated，不静默截断 */
const MAX_VOLUMES = 60;
export const MAX_EPISODES_PER_BATCH = 10;

/** 角色分档的资产量折算（与技能 TIER_ASSET_SPEC 同款） */
export const TIER_ASSET_SPEC: Record<string, string> = {
  lead: '全套角色设定图 + 逐镜一致性核对',
  support: '半身参考图，关键戏核对',
  functional: '提示词直出，松散一致即可',
};

export interface OutlineProgress {
  (msg: string, pct?: number): void;
}

/* ------------------------------------------------------------------ */
/* chunk — 按章节分卷                                                   */
/* ------------------------------------------------------------------ */

export interface NovelVolume {
  index: number;
  title: string;
  text: string;
}

/**
 * 章节标题分卷（每卷 N 章），识别不出章节就按字数切。
 * 上限 60 卷，超了抛错——不静默截断。
 */
export function splitVolumes(novel: string, perVolume = 15): NovelVolume[] {
  const text = (novel || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return [];
  const chapters: { title: string; body: string }[] = [];
  const re = new RegExp(OUTLINE_CHAPTER_RE.source, 'gm');
  let match: RegExpExecArray | null;
  const marks: { start: number; title: string }[] = [];
  while ((match = re.exec(text)) !== null) {
    marks.push({ start: match.index, title: match[0].trim() });
  }
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].start;
      const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
      chapters.push({ title: marks[i].title, body: text.slice(start, end) });
    }
  } else {
    // 按字数切（每片约 1.2 万字）
    const size = 12000;
    for (let i = 0; i < text.length; i += size) {
      chapters.push({ title: `片段 ${Math.floor(i / size) + 1}`, body: text.slice(i, i + size) });
    }
  }

  const volumes: NovelVolume[] = [];
  for (let i = 0; i < chapters.length; i += perVolume) {
    const group = chapters.slice(i, i + perVolume);
    volumes.push({
      index: volumes.length + 1,
      title: group[0]!.title,
      text: group.map((c) => `${c.title}\n${c.body}`).join('\n'),
    });
  }
  if (volumes.length > MAX_VOLUMES) {
    throw new Error(`小说分卷达到 ${volumes.length} 卷，超过上限 ${MAX_VOLUMES} 卷。请减少每卷章数或缩小原著范围（truncated，未静默截断）。`);
  }
  return volumes;
}

/* ------------------------------------------------------------------ */
/* LLM 基础                                                           */
/* ------------------------------------------------------------------ */

const askJson = async (prompt: string, model: string, temperature: number, abort?: AbortSignal): Promise<any> => {
  const raw = await retryOperation(
    () => chatCompletion(prompt, model || 'gpt-5.2', temperature, 16384, 'json_object', 600000, abort),
    2
  );
  return parseJsonWithRecovery<any>(raw);
};

const stripFences = (s: string): string => s.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();

/* ------------------------------------------------------------------ */
/* 分卷摘要                                                            */
/* ------------------------------------------------------------------ */

export async function summarizeVolumes(
  volumes: NovelVolume[],
  model: string,
  onProgress?: OutlineProgress,
  abort?: AbortSignal
): Promise<string[]> {
  const summaries: string[] = [];
  for (const vol of volumes) {
    onProgress?.(`正在摘要第 ${vol.index}/${volumes.length} 卷（${vol.title}）…`, (vol.index - 1) / volumes.length);
    const prompt = [
      '你在为一部 AI 短剧的改编大纲做素材准备。下面是一卷小说原文，请输出一份「改编向中间摘要」，≤ 600 字，纯文本，不要分点套话。',
      '必须覆盖：',
      '1) 出场人物与关系（含称呼、身份）；',
      '2) 关键事件按因果顺序（谁对谁做了什么、结局如何）；',
      '3) 有爽点潜力的场面（打脸/揭破/反转/逆袭/身份揭晓…），注明涉及人物；',
      '4) 明显与主线无关、可砍的支线；',
      '5) 反复出现的地点（可能成为主场景）。',
      '',
      `【第 ${vol.index} 卷 · ${vol.title}】`,
      vol.text.slice(0, 30000),
    ].join('\n');
    const out = await retryOperation(
      () => chatCompletion(prompt, model || 'gpt-5.2', 0.3, 4096, undefined, 600000, abort),
      2
    );
    summaries.push(stripFences(out));
  }
  return summaries;
}

/* ------------------------------------------------------------------ */
/* 骨架（砍线 / 合人 / 排爽点）——拍板前                                */
/* ------------------------------------------------------------------ */

const skeletonSchemaText = `{
  "adaptation": {
    "core": "一句话核心",
    "keep": [{ "what": "保留什么", "why": "为什么", "evidence": "原文逐字片段" }],
    "cut":  [{ "what": "砍掉什么", "why": "为什么" }],
    "merge": [{ "what": "谁合并成谁", "why": "为什么" }],
    "risks": [{ "what": "改编风险", "plan": "对策" }],
    "cutNote": "砍线结论句：这意味着全剧终点是……",
    "mergeNote": "合人补注：主角组入选理由"
  },
  "characters": [{ "id": "C01", "name": "姓名（功能性角色用称呼标签如「急诊医生」）", "role": "定位一句话", "tier": "lead|support|functional", "arc": "人物弧（functional 可省）", "from": ["原著对应谁", "合并：谁"] }],
  "scenes": [{ "id": "S01", "name": "场景名", "primary": true, "reusePlan": "仅出现一次的场景必填规避方案" }],
  "props": [{ "id": "P01", "name": "道具名", "function": "这件物件在戏里承载什么", "beatIds": ["B01"] }],
  "beats": [{ "id": "B01", "type": "打脸/揭破/反转…", "weight": "major|minor", "episode": 1, "setup": "铺垫", "payoff": "兑现" }]
}`;

export async function generateSkeleton(
  summaries: string[],
  params: OutlineParams,
  model: string,
  onProgress?: OutlineProgress,
  abort?: AbortSignal,
  maxFixRounds = 2
): Promise<{ adaptation: AdaptationOutline; gates: OutlineGateResult[] }> {
  const th = outlineThresholdsOf({ params } as AdaptationOutline);
  const material = summaries.join('\n\n').slice(0, 120000);
  const basePrompt = [
    '你是短剧改编总编剧。根据下面的小说素材摘要与改编参数，产出「改编骨架快版」——只出骨架，不写分集梗概。',
    '骨架包括：改编说明（砍线/合人/排爽点）、人物表（分档）、场景表、叙事道具表、爽点表。',
    '',
    `改编参数：总集数 ${params.episodes}；单集约 ${params.minutesPerEpisode} 分钟；题材：${params.genre}；改编方式：${params.adaptMode}。`,
    params.preferences.length ? `用户点名要保：${params.preferences.join('、')}。` : '',
    '',
    '硬规则（违反任何一条都会被确定性校验拦截）：',
    `- 人物三档：主角组(tier=lead) 1–${th.maxLeads} 人（男女主+主反派，arc 必填）；重要配角(support) ≤ ${th.maxSupport}（arc 必填）；功能性角色(functional) ≤ ${th.maxFunctional}（占脸不占名，name 用称呼标签，arc 可省）。无名背景人不进表。`,
    `- 主场景(primary=true) ≤ ${primarySceneCap(params.episodes)} 个；全剧只出现一次的场景必须写 reusePlan（复用哪个环境资产、换什么时段天气改出来）。`,
    `- 叙事道具 ≤ ${th.maxProps} 件：只收有特写、跨集出现、承载剧情的；每件的 function 必填；beatIds 指向真实存在的爽点 id。`,
    `- 爽点：相邻爽点集号间隔 ≤ ${th.maxBeatGap}；第一个爽点必须落在第 ${th.maxBeatGap} 集或更早；最后一个爽点距最后一集不能 ≥ ${th.maxBeatGap}；至少一个 major，且最早的 major 不能落在最后一集。episode 用 1..${params.episodes}。`,
    `- keep 至少 1 条且必须带 evidence（原文逐字片段，禁止凭书名脑补）；改编方式不是「忠实」时 cut 不能为空。`,
    '- from 数组记录改动来源：原著对应谁、合并了谁；纯原创写 ["原创"]。',
    '',
    `只输出 JSON（不要 markdown 围栏、不要解释），结构：${skeletonSchemaText}`,
    '',
    '【小说素材摘要（分卷汇总）】',
    material,
  ].filter(Boolean).join('\n');

  let current: Partial<AdaptationOutline> = {};
  let gates: OutlineGateResult[] = [];
  for (let round = 0; round <= maxFixRounds; round++) {
    if (round === 0) {
      onProgress?.('正在出骨架快版（砍线 / 合人 / 排爽点）…', 0.15);
    } else {
      const failed = gates.filter((g) => !g.ok).map((g) => `【${g.label}】${g.detail || '未过'}`).join('；');
      onProgress?.(`骨架质量门未过，第 ${round} 次自动修复…（${failed}）`, 0.15 + round * 0.05);
    }
    const prompt = round === 0
      ? basePrompt
      : [
          basePrompt,
          '',
          '【你上一版的骨架 JSON】',
          JSON.stringify({ adaptation: current.adaptation, characters: current.characters, scenes: current.scenes, props: current.props, beats: current.beats }),
          '',
          '【确定性质量门检查结果——以下门未过，必须逐条修复后重新输出完整 JSON】',
          failed(gates),
        ].join('\n');
    const data = await askJson(prompt, model, round === 0 ? 0.4 : 0.2, abort);
    current = {
      ...current,
      adaptation: data.adaptation ?? null,
      characters: Array.isArray(data.characters) ? data.characters : [],
      scenes: Array.isArray(data.scenes) ? data.scenes : [],
      props: Array.isArray(data.props) ? data.props : undefined,
      beats: Array.isArray(data.beats) ? data.beats : [],
      episodes: [],
    };
    gates = runOutlineGates(current as AdaptationOutline, 'skeleton');
    if (outlineGatesPassed(gates)) break;
  }
  const result: AdaptationOutline = {
    ...(current as AdaptationOutline),
    skeletonApproved: false,
  };
  return { adaptation: result, gates };
}

const failed = (gates: OutlineGateResult[]): string =>
  gates.filter((g) => !g.ok).map((g) => `【${g.label}】${g.detail || '未过'}`).join('\n') || '（全部通过）';

/* ------------------------------------------------------------------ */
/* 分集梗概 — 分批写（每批 ≤ 10 集），写完过 full 门 + 自动修复         */
/* ------------------------------------------------------------------ */

const episodesSchemaText = `{
  "episodes": [{
    "ep": 1,
    "synopsis": "本集梗概（叙述体，≤120 字，禁止任何引号对白）",
    "hook": "【开场钩子】第 1 拍就进事件，具体到动作/画面",
    "suspense": "【结尾悬念】下一集开场必须承接",
    "sceneIds": ["S01"],
    "characterIds": ["C01"],
    "propIds": ["P01"],
    "crowdPlan": "出场角色 ≥3 人时必填：同框拆解方案（三人分处两场，无同框，分场拍——也算方案）",
    "warnings": ["雨戏"]
  }]
}`;

export async function generateEpisodes(
  outline: AdaptationOutline,
  model: string,
  onProgress?: OutlineProgress,
  abort?: AbortSignal
): Promise<{ episodes: OutlineEpisode[]; gates: OutlineGateResult[] }> {
  if (!outline.skeletonApproved) {
    throw new Error('骨架还没拍板：先确认砍线/合人/爽点安排，再写分集（先拍板再细化，这是流程门）。');
  }
  const th = outlineThresholdsOf(outline);
  const total = outline.params.episodes;
  const skeletonContext = JSON.stringify({
    adaptation: outline.adaptation,
    characters: outline.characters,
    scenes: outline.scenes,
    props: outline.props ?? [],
    beats: outline.beats,
  });

  const rules = [
    `写第 1..${total} 集的分集梗概，每集三栏（梗概/【开场钩子】/【结尾悬念】）都必填。`,
    '梗概是叙述体：任何一栏出现「」『』“”引号对白即越界，会被校验拦截。',
    'hook 要具象：第 1 拍就进事件，写具体动作/画面，不写气氛渲染；第 1 集的钩子尤其要当场兑现。',
    'suspense 要让下一集开场必须承接；相邻集因果连贯。',
    'sceneIds / characterIds 只能引用骨架里已登记的 id；每个登记的角色/场景至少出现一集。',
    '出场角色 ≥3 人的集必须写 crowdPlan（三人分处两场、无同框、分场拍，也算合格方案）。',
    '梗概扫到这些关键词时必须把对应项写进 warnings：雨戏(雨)、肢体接触(吻/拥抱/牵手/扭打…)、人群(围观/众人/满堂/集市…)、手部特写(手部/指尖…)。宁可多报。',
    outline.props?.length ? 'propIds 引用骨架的道具 id；每件道具至少出现一集。' : '骨架没有登记叙事道具时，不要输出 propIds。',
    `每集爽点落点以骨架 beats 的 episode 为准（episode 是唯一数据源，分集不重复登记爽点）。`,
  ].join('\n');

  const episodes: OutlineEpisode[] = [];
  let gates: OutlineGateResult[] = [];
  for (let start = 1; start <= total; start += MAX_EPISODES_PER_BATCH) {
    const end = Math.min(start + MAX_EPISODES_PER_BATCH - 1, total);
    onProgress?.(`正在写第 ${start}–${end} 集分集梗概…`, 0.3 + (start / total) * 0.4);
    const prompt = [
      '你是短剧改编总编剧。基于已拍板的改编骨架，写出指定范围的分集梗概。',
      skeletonContext,
      '',
      '硬规则：',
      rules,
      '',
      `本批只写第 ${start}–${end} 集。只输出 JSON（不要 markdown 围栏），结构：${episodesSchemaText}`,
    ].join('\n');
    const data = await askJson(prompt, model, 0.5, abort);
    const batch: OutlineEpisode[] = Array.isArray(data?.episodes) ? data.episodes : [];
    for (const e of batch) {
      const idx = episodes.findIndex((x) => x.ep === e.ep);
      if (idx >= 0) episodes[idx] = e; else episodes.push(e);
    }
    episodes.sort((a, b) => a.ep - b.ep);
  }

  // full 门 + 自动修复循环（对完整的分集数组整体修复，而不是逐集打补丁）
  let current = episodes;
  for (let round = 0; round <= 2; round++) {
    onProgress?.(round === 0 ? '正在跑 14 道质量门…' : `质量门未过，第 ${round} 次自动修复…`, 0.72 + round * 0.06);
    const draft: AdaptationOutline = { ...outline, episodes: current };
    gates = runOutlineGates(draft, 'full');
    if (outlineGatesPassed(gates)) break;
    if (round === 2) break;
    const repairPrompt = [
      '你是短剧改编总编剧。下面的分集梗概没有通过确定性质量门，请逐条修复后重新输出「完整的分集梗概 JSON」（全部集数，不是只输出改动的集）。',
      skeletonContext,
      '',
      '【当前分集梗概 JSON】',
      JSON.stringify(current),
      '',
      '【质量门检查结果——以下门未过，必须全部修复】',
      failed(gates),
      '',
      '硬规则：',
      rules,
      '',
      `只输出 JSON：${episodesSchemaText}（episodes 覆盖第 1..${total} 集）`,
    ].join('\n');
    const data = await askJson(repairPrompt, model, 0.2, abort);
    if (Array.isArray(data?.episodes) && data.episodes.length > 0) current = data.episodes;
  }

  return { episodes: current, gates };
}

/* ------------------------------------------------------------------ */
/* 资产清单 — 代码汇总，不让模型写                                      */
/* ------------------------------------------------------------------ */

export function buildAssetInventory(outline: AdaptationOutline): OutlineAssetRow[] {
  const rows: OutlineAssetRow[] = [];
  const eps = outline.episodes ?? [];
  const countOf = (idsOf: (e: OutlineEpisode) => string[] | undefined, id: string): number[] =>
    eps.filter((e) => (idsOf(e) ?? []).includes(id)).map((e) => e.ep);

  const charEp = (id: string) => countOf((e) => e.characterIds, id);
  const sceneEp = (id: string) => countOf((e) => e.sceneIds, id);
  const propEp = (id: string) => countOf((e) => e.propIds, id);

  for (const c of outline.characters ?? []) {
    const appe = charEp(c.id);
    rows.push({
      kind: 'character', id: c.id, name: `${c.name}（${c.role}）`,
      episodes: appe, count: appe.length,
      note: TIER_ASSET_SPEC[c.tier] ?? '',
    });
  }
  for (const s of outline.scenes ?? []) {
    const appe = sceneEp(s.id);
    const once = appe.length === 1;
    rows.push({
      kind: 'scene', id: s.id, name: s.name,
      episodes: appe, count: appe.length,
      note: once ? `一次性场景 → ${s.reusePlan || '缺规避方案'}` : s.primary ? '主场景' : '',
    });
  }
  for (const p of outline.props ?? []) {
    const appe = propEp(p.id);
    rows.push({
      kind: 'prop', id: p.id, name: p.name,
      episodes: appe, count: appe.length,
      note: p.function || '',
    });
  }
  // 生成难点预警标注到涉及该集的行上（宁可多报）
  for (const row of rows) {
    const warns = new Set<string>();
    for (const e of eps) {
      if (!row.episodes.includes(e.ep)) continue;
      for (const w of e.warnings ?? []) warns.add(w);
    }
    if (warns.size) row.warnings = [...warns];
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 应用到剧本 — 组装结构化剧本任务书，交给既有 StageScript 流水线        */
/* ------------------------------------------------------------------ */

export function composeEpisodeScriptInput(outline: AdaptationOutline, ep: number): string {
  const total = outline.params.episodes;
  const e = outline.episodes.find((x) => x.ep === ep);
  if (!e) throw new Error(`大纲里没有第 ${ep} 集`);
  const charName = (id: string) => {
    const c = outline.characters.find((x) => x.id === id);
    return c ? `${c.name}（${c.role}${c.arc ? `；弧线：${c.arc}` : ''}）` : id;
  };
  const sceneName = (id: string) => {
    const s = outline.scenes.find((x) => x.id === id);
    return s ? `${s.name}${s.primary ? '【主场景】' : ''}` : id;
  };
  const prev = outline.episodes.find((x) => x.ep === ep - 1);
  const beatLines = (outline.beats ?? []).filter((b: OutlineBeat) => b.episode === ep)
    .map((b) => `- ${b.id} ${b.type}（${b.weight === 'major' ? '大爆点' : '常规'}）：铺垫 ${b.setup ?? ''} → 兑现 ${b.payoff ?? ''}`);

  return [
    `【AI 短剧剧本任务】第 ${ep} 集 / 共 ${total} 集 · 单集约 ${outline.params.minutesPerEpisode} 分钟`,
    `题材：${outline.params.genre} · 改编方式：${outline.params.adaptMode}`,
    outline.adaptation?.core ? `全剧核心：${outline.adaptation.core}` : '',
    '',
    `【本集梗概】${e.synopsis}`,
    `【开场钩子（第 1 拍就进事件）】${e.hook}`,
    `【结尾悬念（下一集开场必须承接）】${e.suspense}`,
    '',
    `【出场角色】${(e.characterIds ?? []).map(charName).join('；')}`,
    `【场景】${(e.sceneIds ?? []).map(sceneName).join('；')}`,
    (e.propIds?.length ? `【叙事道具】${e.propIds.join('、')}` : ''),
    beatLines.length ? `【本集爽点】\n${beatLines.join('\n')}` : '',
    (e.crowdPlan ? `【同框拆解】${e.crowdPlan}` : ''),
    (e.warnings?.length ? `【生成难点预警】${e.warnings.join('、')}` : ''),
    prev ? `\n【上一集结尾悬念（开场须承接）】${prev.suspense}` : '',
    '',
    '【写作约束】动作节拍与台词行交替；单句台词 ≤ 35 字；每场至少一个动作节拍——纯对白的场是广播剧；开场钩子的具象必须在前 3 拍内兑现。',
  ].filter(Boolean).join('\n');
}

/** 骨架拍板后组装完整大纲对象（供 StageOutline 保存） */
export function assembleOutline(
  base: AdaptationOutline,
  patch: Partial<AdaptationOutline>
): AdaptationOutline {
  return {
    ...base,
    ...patch,
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* 引擎模式：用真实技能 CLI 的质量门输出驱动修复                         */
/* ------------------------------------------------------------------ */

const skeletonPromptBase = (params: OutlineParams, th: OutlineThresholds): string =>
  [
    '你是短剧改编总编剧。根据小说素材摘要与改编参数，产出「改编骨架快版」——只出骨架，不写分集梗概。',
    `改编参数：总集数 ${params.episodes}；单集约 ${params.minutesPerEpisode} 分钟；题材：${params.genre}；改编方式：${params.adaptMode}。`,
    params.preferences.length ? `用户点名要保：${params.preferences.join('、')}。` : '',
    '',
    '硬规则（违反任何一条都会被确定性校验拦截）：',
    `- 人物三档：主角组(lead) 1–${th.maxLeads} 人（arc 必填）；重要配角(support) ≤ ${th.maxSupport}（arc 必填）；功能性角色(functional) ≤ ${th.maxFunctional}（占脸不占名，name 用称呼标签，arc 可省）。无名背景人不进表。`,
    `- 主场景(primary=true) ≤ ${primarySceneCap(params.episodes)} 个；只出现一次的场景必须写 reusePlan。`,
    `- 叙事道具 ≤ ${th.maxProps} 件，function 必填，beatIds 指向真实爽点 id。`,
    `- 爽点：相邻集号间隔 ≤ ${th.maxBeatGap}；第一个爽点不晚于第 ${th.maxBeatGap} 集；最后一个爽点距最后一集 < ${th.maxBeatGap}；至少一个 major 且最早的 major 不落最后一集。episode 用 1..${params.episodes}。`,
    '- keep 至少 1 条且必须带 evidence（原文逐字片段）；改编方式不是「忠实」时 cut 不能为空。',
    '- from 数组记录改动来源；纯原创写 ["原创"]。',
  ].filter(Boolean).join('\n');

/** 引擎 validate --stage skeleton 的 ✗ 详情回炉：修复骨架 JSON */
export async function repairSkeleton(
  summaries: string[],
  params: OutlineParams,
  draft: { adaptation: AdaptationOutline['adaptation']; characters: OutlineCharacter[]; scenes: OutlineScene[]; props?: OutlineProp[]; beats: OutlineBeat[] },
  gateText: string,
  model: string,
  abort?: AbortSignal
): Promise<{ adaptation: AdaptationOutline['adaptation']; characters: OutlineCharacter[]; scenes: OutlineScene[]; props?: OutlineProp[]; beats: OutlineBeat[] }> {
  const th = outlineThresholdsOf({ params } as AdaptationOutline);
  const prompt = [
    skeletonPromptBase(params, th),
    '',
    '【你上一版的骨架 JSON】',
    JSON.stringify({ adaptation: draft.adaptation, characters: draft.characters, scenes: draft.scenes, props: draft.props, beats: draft.beats }),
    '',
    '【确定性质量门（novel-outline validate --stage skeleton）原始输出——✗ 项必须逐条修复】',
    gateText,
    '',
    '素材摘要（节选）：',
    summaries.join('\n\n').slice(0, 60000),
    '',
    `只输出修复后的完整骨架 JSON（不要围栏），结构：${skeletonSchemaText}`,
  ].join('\n');
  const data = await askJson(prompt, model, 0.2, abort);
  return {
    adaptation: data.adaptation ?? draft.adaptation,
    characters: Array.isArray(data.characters) ? data.characters : draft.characters,
    scenes: Array.isArray(data.scenes) ? data.scenes : draft.scenes,
    props: Array.isArray(data.props) ? data.props : draft.props,
    beats: Array.isArray(data.beats) ? data.beats : draft.beats,
  };
}

/** 引擎 validate --stage full 的 ✗ 详情回炉：修复分集（整体输出全部集） */
export async function repairEpisodes(
  outline: AdaptationOutline,
  episodes: OutlineEpisode[],
  gateText: string,
  model: string,
  abort?: AbortSignal
): Promise<OutlineEpisode[]> {
  const skeletonContext = JSON.stringify({
    adaptation: outline.adaptation,
    characters: outline.characters,
    scenes: outline.scenes,
    props: outline.props ?? [],
    beats: outline.beats,
  });
  const prompt = [
    '你是短剧改编总编剧。下面的分集梗概没有通过 novel-outline 的确定性质量门，请逐条修复后输出「完整的分集梗概 JSON」（全部集数）。',
    skeletonContext,
    '',
    '【当前分集梗概 JSON】',
    JSON.stringify(episodes),
    '',
    '【质量门原始输出——✗ 项必须全部修复】',
    gateText,
    '',
    '硬规则：梗概叙述体无引号；三栏齐全；只引用骨架已登记 id；≥3 人写 crowdPlan；扫到雨戏/肢体接触/人群/手部特写关键词必须写进 warnings；每件道具至少出现一集。',
    '',
    `只输出 JSON：${episodesSchemaText}（episodes 覆盖全部集数）`,
  ].join('\n');
  const data = await askJson(prompt, model, 0.2, abort);
  return Array.isArray(data?.episodes) && data.episodes.length > 0 ? data.episodes : episodes;
}

/** 组装技能口径的 outline.json（source/lang 顶层字段与技能对齐，render --lang 会读它） */
export function outlineJsonOf(outline: AdaptationOutline, title: string): Record<string, unknown> {
  return {
    source: title || '未命名',
    lang: 'zh',
    params: outline.params,
    adaptation: outline.adaptation,
    characters: outline.characters,
    scenes: outline.scenes,
    ...(outline.props?.length ? { props: outline.props } : {}),
    beats: outline.beats,
    episodes: outline.episodes,
  };
}

/** 阶段主产物的规范相对路径（与服务端 artifactRel / 仓库工作目录约定一致） */
export function artifactJsonPath(slug: string, stage: 'outline' | 'characters' | 'art' | 'script' | 'storyboard'): string {
  const names = { outline: 'outline', characters: 'cast', art: 'art', script: 'script', storyboard: 'storyboard' };
  return `${stage}/${slug}-${names[stage]}.json`;
}

