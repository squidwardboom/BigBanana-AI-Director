/**
 * 烁皓改编大纲质量门 —— 从 shuohao-skills/novel-outline 的 gateReport() 逐行移植。
 *
 * 设计主张与原仓库一致：checklist 交给模型自觉是靠不住的。
 * 每一道门都是确定性代码：阈值同款（主角组 1–5、配角 ≤10、功能角色 ≤10、
 * 爽点间隔 ≤3 无真空、主场景 4+⌈集数/10⌉ 夹 5–15、道具 ≤8）、
 * 门 id 同款（是对账凭据，保持稳定不动）。
 *
 * 阶段口径（流程门，不是口头约定）：
 *   skeleton — 骨架拍板前：角色分档 + 场景/道具上限
 *   beats    — 写分集前：+ 爽点间隔、major 时机（这两条错了，分集写完全废）
 *   full     — 交付前：全部 14 道
 */

import { AdaptationOutline, OutlineGateResult, OutlineThresholds } from '../types';

const OUTLINE_TIERS = ['lead', 'support', 'functional'] as const;
const TIER_LABELS: Record<string, string> = {
  lead: '主角组',
  support: '重要配角',
  functional: '功能性角色',
};

export const OUTLINE_DEFAULT_THRESHOLDS = {
  maxLeads: 5,
  maxSupport: 10,
  maxFunctional: 10,
  maxBeatGap: 3,
  maxProps: 8,
};

/** 主场景上限随集数走。这是给 AI 短剧定的数——场景是生成的，没有搭景钱。 */
export function primarySceneCap(episodes?: number): number {
  const n = Number(episodes) || 0;
  if (!n) return 5;
  return Math.max(5, Math.min(15, 4 + Math.ceil(n / 10)));
}

export function outlineThresholdsOf(outline: AdaptationOutline | null | undefined): OutlineThresholds {
  const explicit = outline?.params?.thresholds ?? {};
  const merged = { ...OUTLINE_DEFAULT_THRESHOLDS, maxPrimaryScenes: primarySceneCap(outline?.params?.episodes) };
  return { ...merged, ...explicit } as OutlineThresholds;
}

const thText = (s: unknown): s is string => typeof s === 'string' && !!s.trim();

/** 每集的正文字段，关键词扫描和对白检查都扫这三栏。 */
const EP_TEXT_FIELDS = ['synopsis', 'hook', 'suspense'] as const;

/** 生成难点关键词（宁可多报）。 */
const RISK_PATTERNS: Record<string, RegExp> = {
  雨戏: /雨/,
  肢体接触: /吻|拥抱|相拥|牵手|贴身|扭打|搂/,
  人群: /人群|围观|众人|满堂|满座|集市|人山/,
  手部特写: /手部|指尖|十指|特写.{0,4}手/,
};

/** 梗概必须是叙述体——出现引号对白就是在写剧本，越界。 */
const DIALOGUE_RE = /「|」|『|』|“|”/;

export type OutlineGateStage = 'skeleton' | 'beats' | 'full';

/** 各阶段要跑的门 id 子集；full = 全部。 */
const STAGE_GATES: Record<OutlineGateStage, string[] | null> = {
  skeleton: ['lead-cap', 'support-cap', 'functional-cap', 'scene-cap', 'prop-cap'],
  beats: ['lead-cap', 'support-cap', 'functional-cap', 'scene-cap', 'prop-cap', 'beat-gap', 'major-early'],
  full: null,
};

/**
 * 移植自 novel-outline.mjs gateReport()：阈值、判据、失败详情文案逐行对齐。
 */
export function runOutlineGates(
  outline: AdaptationOutline | null | undefined,
  stage: OutlineGateStage = 'full'
): OutlineGateResult[] {
  const th = outlineThresholdsOf(outline);
  const gates: OutlineGateResult[] = [];
  const add = (id: string, label: string, ok: boolean, detail = '') => gates.push({ id, label, ok, detail });

  const chars = Array.isArray(outline?.characters) ? outline!.characters : [];
  const scenes = Array.isArray(outline?.scenes) ? outline!.scenes : [];
  const beats = Array.isArray(outline?.beats) ? outline!.beats : [];
  const eps = Array.isArray(outline?.episodes) ? outline!.episodes : [];
  const total = outline?.params?.episodes ?? eps.length;
  // props 是后加的字段。没有这个字段的旧大纲要照常通过——两道相关的门都明说跳过。
  const hasProps = Array.isArray(outline?.props);
  const props = hasProps ? outline!.props! : [];

  // G1a–G1c 角色分档上限。主角组还要求至少 1 人——没有主角的剧不成立
  const tierCap: Record<string, number> = {
    lead: th.maxLeads,
    support: th.maxSupport,
    functional: th.maxFunctional,
  };
  for (const tier of OUTLINE_TIERS) {
    const n = chars.filter((c) => c?.tier === tier).length;
    const needMin = tier === 'lead';
    add(
      `${tier}-cap`,
      `${TIER_LABELS[tier]} ${needMin ? `1–${tierCap[tier]}` : `≤ ${tierCap[tier]}`} 人`,
      (needMin ? n >= 1 : true) && n <= tierCap[tier],
      `${n} 位`
    );
  }

  // G2 主场景上限
  const primary = scenes.filter((s) => s?.primary);
  add(
    'scene-cap',
    `主场景 ≤ ${th.maxPrimaryScenes}`,
    scenes.length > 0 && primary.length <= th.maxPrimaryScenes,
    `${primary.length} 个`
  );

  // G2b 叙事道具上限。只收有特写、跨集、承载剧情的那几件。
  add(
    'prop-cap',
    `叙事道具 ≤ ${th.maxProps} 件`,
    !hasProps || props.length <= th.maxProps,
    hasProps ? `${props.length} 件` : '大纲没有 props 字段，跳过'
  );

  // 场景/角色使用统计（一次性场景、引用完整两道门共用）。
  // 只给已登记的 id 计数——未知 id 塞进索引会让「引用不存在」形同虚设。
  const sceneUse = new Map(scenes.map((s) => [s?.id, 0]));
  const charUse = new Map(chars.map((c) => [c?.id, 0]));
  const propUse = new Map(props.map((pr) => [pr?.id, 0]));
  for (const e of eps) {
    for (const id of e?.sceneIds ?? []) if (sceneUse.has(id)) sceneUse.set(id, sceneUse.get(id)! + 1);
    for (const id of e?.characterIds ?? []) if (charUse.has(id)) charUse.set(id, charUse.get(id)! + 1);
    for (const id of e?.propIds ?? []) if (propUse.has(id)) propUse.set(id, propUse.get(id)! + 1);
  }

  // G3 一次性场景要有规避方案
  const onceNoPlan = scenes.filter((s) => sceneUse.get(s?.id) === 1 && !thText(s?.reusePlan));
  add(
    'once-scene',
    '一次性场景已标注规避方案',
    eps.length > 0 && onceNoPlan.length === 0,
    onceNoPlan.length ? `缺：${onceNoPlan.map((s) => s.name ?? s.id).join('、')}` : ''
  );

  // G4 爽点间隔 ≤ N，首尾无真空
  const beatEps = [...new Set(beats.map((b) => b?.episode).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  let gapOk = beatEps.length > 0 && total > 0;
  let gapDetail = '';
  if (gapOk) {
    if (beatEps[0]! > th.maxBeatGap) {
      gapOk = false;
      gapDetail = `开头 ${beatEps[0]! - 1} 集真空`;
    }
    for (let i = 1; i < beatEps.length && gapOk; i++) {
      if (beatEps[i]! - beatEps[i - 1]! > th.maxBeatGap) {
        gapOk = false;
        gapDetail = `第 ${beatEps[i - 1]}–${beatEps[i]} 集之间断档`;
      }
    }
    if (gapOk && total - beatEps[beatEps.length - 1]! >= th.maxBeatGap) {
      gapOk = false;
      gapDetail = `结尾 ${total - beatEps[beatEps.length - 1]!} 集真空`;
    }
  }
  add('beat-gap', `爽点间隔 ≤ ${th.maxBeatGap} 集，无真空区`, gapOk, gapDetail);

  // G5 第 1 集有钩子
  add('ep1-hook', '第 1 集有钩子', eps.length > 0 && thText(eps[0]?.hook), '');

  // G6 大爆点不能到最后一集才第一次出现
  const majors = beats.filter((b) => (b?.weight ?? 'minor') === 'major').map((b) => b.episode);
  add(
    'major-early',
    '大爆点不在最后一集才首次出现',
    majors.length > 0 && Math.min(...majors) < total,
    majors.length ? `最早在第 ${Math.min(...majors)} 集` : '没有 major 爽点'
  );

  // G7 每集三栏齐全（钩子/悬念必填）
  const incomplete = eps.filter((e) => !EP_TEXT_FIELDS.every((f) => thText(e?.[f])));
  add(
    'ep-fields',
    '每集梗概三栏齐全（含【钩子】【悬念】）',
    eps.length > 0 && incomplete.length === 0,
    incomplete.length ? `缺栏：第 ${incomplete.map((e) => e.ep).join('、')} 集` : ''
  );

  // G8 三人以上同框要有拆解方案
  const crowdBad = eps.filter((e) => (e?.characterIds?.length ?? 0) >= 3 && !thText(e?.crowdPlan));
  add(
    'crowd-plan',
    '三人以上同框已标注拆解方案',
    crowdBad.length === 0,
    crowdBad.length ? `缺：第 ${crowdBad.map((e) => e.ep).join('、')} 集` : ''
  );

  // G9 生成难点进预警清单
  const riskBad: string[] = [];
  for (const e of eps) {
    const text = EP_TEXT_FIELDS.map((f) => e?.[f] ?? '').join(' ');
    for (const [risk, re] of Object.entries(RISK_PATTERNS)) {
      if (re.test(text) && !(e?.warnings ?? []).includes(risk)) riskBad.push(`第 ${e.ep} 集缺「${risk}」`);
    }
  }
  add('risk-flag', '生成难点已进预警清单', eps.length > 0 && riskBad.length === 0, riskBad.join('；'));

  // G10 引用完整：ID 都存在、没有失业角色、没有空转场景
  const refBad: string[] = [];
  for (const e of eps) {
    for (const id of e?.sceneIds ?? []) if (!sceneUse.has(id)) refBad.push(`第 ${e.ep} 集引用了不存在的场景 ${id}`);
    for (const id of e?.characterIds ?? []) if (!charUse.has(id)) refBad.push(`第 ${e.ep} 集引用了不存在的角色 ${id}`);
    if (hasProps) {
      for (const id of e?.propIds ?? []) if (!propUse.has(id)) refBad.push(`第 ${e.ep} 集引用了不存在的道具 ${id}`);
    }
  }
  for (const b of beats) {
    if (Number.isInteger(b?.episode) && (b.episode < 1 || b.episode > total)) {
      refBad.push(`爽点 ${b.id} 落在不存在的第 ${b.episode} 集`);
    }
  }
  for (const [id, n] of charUse) if (n === 0) refBad.push(`角色 ${id} 从未在任何一集出现`);
  for (const [id, n] of sceneUse) if (n === 0) refBad.push(`场景 ${id} 从未被用到`);
  if (hasProps) {
    for (const [id, n] of propUse) if (n === 0) refBad.push(`道具 ${id} 从未在任何一集出现`);
    const beatIds = new Set(beats.map((b) => b?.id));
    for (const pr of props) {
      for (const bid of pr?.beatIds ?? []) {
        if (!beatIds.has(bid)) refBad.push(`道具 ${pr.id} 关联了不存在的爽点 ${bid}`);
      }
    }
  }
  add(
    'refs',
    hasProps
      ? '场景/角色/道具引用完整，无失业角色、无空转场景、无零集道具'
      : '场景/角色引用完整，无失业角色、无空转场景',
    eps.length > 0 && refBad.length === 0,
    refBad.join('；')
  );

  // G11 梗概是叙述体
  const dlgBad = eps.filter((e) => EP_TEXT_FIELDS.some((f) => DIALOGUE_RE.test(e?.[f] ?? '')));
  add(
    'no-dialogue',
    '梗概是叙述体，无引号对白',
    dlgBad.length === 0,
    dlgBad.length ? `第 ${dlgBad.map((e) => e.ep).join('、')} 集出现引号` : ''
  );

  const allowed = STAGE_GATES[stage];
  return allowed ? gates.filter((g) => allowed.includes(g.id)) : gates;
}

export const outlineGatesPassed = (gates: OutlineGateResult[] | null | undefined): boolean =>
  !!gates && gates.length > 0 && gates.every((g) => g.ok);

/** 章节标题正则（与技能同款）：识别不出章节就退回按字数切。 */
export const OUTLINE_CHAPTER_RE =
  /^[ \t　]*(第[0-9零一二三四五六七八九十百千两]+[章回节卷部][^\n]*|楔子[^\n]*|序章[^\n]*|尾声[^\n]*|番外[^\n]*|Chapter\s+\d+[^\n]*)$/gm;
