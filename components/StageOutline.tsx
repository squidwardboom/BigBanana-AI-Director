import React, { useRef, useState } from 'react';
import {
  BookOpen, Play, CheckCircle2, XCircle, RotateCcw, Loader2, ArrowRight,
  ThumbsUp, AlertTriangle, FileStack, Wand2, Ban,
} from 'lucide-react';
import { ProjectState, AdaptationOutline, OutlineGateResult, OutlineParams, OutlineAssetRow } from '../types';
import { useAlert } from './GlobalAlert';
import {
  splitVolumes, summarizeVolumes, generateSkeleton, generateEpisodes,
  buildAssetInventory, composeEpisodeScriptInput, MAX_EPISODES_PER_BATCH,
} from '../services/adaptationService';
import { runOutlineGates, outlineGatesPassed, primarySceneCap } from '../services/shuohaoGates';

interface Props {
  project: ProjectState;
  updateProject: (updates: Partial<ProjectState> | ((prev: ProjectState) => ProjectState)) => void;
  onGeneratingChange?: (generating: boolean) => void;
}

const adaptModes: OutlineParams['adaptMode'][] = ['忠实', '抽核', '借壳'];

/** 爽点节奏轴：major 实心、minor 浅色，真空段直接标在轴上（超阈值变红） */
const BeatTimeline: React.FC<{ outline: AdaptationOutline }> = ({ outline }) => {
  const total = outline.params.episodes;
  const gap = outline.params.thresholds?.maxBeatGap ?? 3;
  const w = 24, pad = 20, height = 64;
  const width = pad * 2 + total * w;
  const beatEp = new Map<number, 'major' | 'minor'>();
  for (const b of outline.beats ?? []) {
    const prev = beatEp.get(b.episode);
    if (b.weight === 'major' || !prev) beatEp.set(b.episode, b.weight === 'major' ? 'major' : 'minor');
  }
  const sorted = [...beatEp.keys()].sort((a, b) => a - b);
  const vacuums: { from: number; to: number; bad: boolean }[] = [];
  if (sorted.length) {
    if (sorted[0]! > gap) vacuums.push({ from: 1, to: sorted[0]! - 1, bad: true });
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i]! - sorted[i - 1]!;
      if (d > gap) vacuums.push({ from: sorted[i - 1]! + 1, to: sorted[i]! - 1, bad: true });
    }
    if (total - sorted[sorted.length - 1]! >= gap) vacuums.push({ from: sorted[sorted.length - 1]! + 1, to: total, bad: true });
  }
  const x = (ep: number) => pad + (ep - 0.5) * w;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: 96 }}>
      {vacuums.map((v, i) => (
        <rect key={i} x={x(v.from) - w / 2} y={height / 2 - 12} width={(v.to - v.from + 1) * w} height={24}
          fill="rgba(209,84,60,0.18)" stroke="#d1543c" strokeDasharray="3 3" rx={4} />
      ))}
      {Array.from({ length: total }, (_, i) => i + 1).map((ep) => {
        const weight = beatEp.get(ep);
        const beat = (outline.beats ?? []).find((b) => b.episode === ep && b.weight === 'major') || (outline.beats ?? []).find((b) => b.episode === ep);
        return (
          <g key={ep}>
            <text x={x(ep)} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{ep}</text>
            {weight ? (
              <>
                <circle cx={x(ep)} cy={height / 2 - 12} r={weight === 'major' ? 7 : 4}
                  fill={weight === 'major' ? 'var(--accent-text, #6aa1ff)' : 'rgba(106,161,255,0.45)'} />
                {beat && (
                  <text x={x(ep)} y={height / 2 - 28} textAnchor="middle" fontSize="9"
                    fill={weight === 'major' ? 'var(--accent-text, #6aa1ff)' : 'var(--text-muted)'}>
                    {beat.type}
                  </text>
                )}
              </>
            ) : (
              <circle cx={x(ep)} cy={height / 2 - 12} r={2} fill="var(--text-muted)" opacity={0.5} />
            )}
          </g>
        );
      })}
      <text x={pad} y={12} fontSize="10" fill="var(--text-muted)">
        爽点节奏 · 间隔 ≤ {gap} 集 · 实心=大爆点 · 红框=真空区
      </text>
    </svg>
  );
};

const GatePanel: React.FC<{ gates: OutlineGateResult[] | null | undefined }> = ({ gates }) => {
  if (!gates || gates.length === 0) return null;
  const passed = gates.every((g) => g.ok);
  return (
    <div className={`rounded-lg border p-3 space-y-1.5 ${passed ? 'border-[var(--success)]/40 bg-[var(--success)]/5' : 'border-[#d1543c]/50 bg-[#d1543c]/5'}`}>
      <div className="flex items-center gap-2 text-xs font-medium">
        {passed
          ? <><CheckCircle2 className="w-4 h-4 text-[var(--success)]" /><span className="text-[var(--success)]">全部质量门通过</span></>
          : <><AlertTriangle className="w-4 h-4 text-[#d1543c]" /><span className="text-[#d1543c]">有未过项——把 ✗ 详情交给「重新生成」自动修复</span></>}
      </div>
      {gates.map((g) => (
        <div key={g.id} className="flex gap-2 text-xs leading-relaxed">
          {g.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-[var(--success)] flex-shrink-0" />
                : <XCircle className="w-3.5 h-3.5 mt-0.5 text-[#d1543c] flex-shrink-0" />}
          <span className={g.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)] font-medium'}>
            {g.label}{g.detail ? <span className="text-[#d1543c]"> — {g.detail}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
};

const tierChip = (tier: string) => tier === 'lead'
  ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--accent-bg)] text-[var(--accent-text)]">主角组</span>
  : tier === 'support'
    ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">配角</span>
    : <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">功能</span>;

const StageOutline: React.FC<Props> = ({ project, updateProject, onGeneratingChange }) => {
  const { showAlert } = useAlert();
  const outline = project.adaptation ?? null;
  const [busy, setBusy] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const params: OutlineParams = outline?.params ?? {
    episodes: 6,
    minutesPerEpisode: 2,
    genre: '',
    adaptMode: '忠实',
    preferences: [],
  };
  const [form, setForm] = useState({
    episodes: String(params.episodes),
    minutesPerEpisode: String(params.minutesPerEpisode),
    genre: params.genre,
    adaptMode: params.adaptMode,
    preferences: (params.preferences ?? []).join('、'),
  });

  const novelChars = (project.rawScript || '').replace(/\s/g, '').length;
  const episodesDone = (outline?.episodes?.length ?? 0) >= (outline?.params.episodes ?? Infinity);
  const canGenerate = novelChars >= 200;

  const withBusy = async (fn: (signal: AbortSignal, onProgress: (m: string, p?: number) => void) => Promise<void>) => {
    setBusy(true); setError(''); onGeneratingChange?.(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const onProgress = (m: string, p?: number) => { setProgressMsg(m); if (p !== undefined) setProgressPct(Math.round(p * 100)); };
    try {
      await fn(controller.signal, onProgress);
    } catch (e: any) {
      if (!controller.signal.aborted) setError(String(e?.message || e));
    } finally {
      setBusy(false); setProgressMsg(''); onGeneratingChange?.(false);
      abortRef.current = null;
    }
  };

  const currentOutline = (): AdaptationOutline => {
    const p: OutlineParams = {
      episodes: Math.max(1, parseInt(form.episodes) || 6),
      minutesPerEpisode: Math.max(0.5, parseFloat(form.minutesPerEpisode) || 2),
      genre: form.genre.trim(),
      adaptMode: form.adaptMode,
      preferences: form.preferences.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
    };
    return {
      params: p,
      adaptation: outline?.adaptation ?? null,
      characters: outline?.characters ?? [],
      scenes: outline?.scenes ?? [],
      props: outline?.props,
      beats: outline?.beats ?? [],
      episodes: outline?.episodes ?? [],
      skeletonApproved: outline?.skeletonApproved ?? false,
      volumeSummaries: outline?.volumeSummaries ?? [],
      gates: outline?.gates ?? null,
      gatesStage: outline?.gatesStage,
      gatesPassedAt: outline?.gatesPassedAt,
      assetInventory: outline?.assetInventory,
      updatedAt: Date.now(),
    };
  };

  const startAdaptation = () => withBusy(async (signal, onProgress) => {
    const model = project.shotGenerationModel || '';
    onProgress('正在按章节分卷…', 0.02);
    const volumes = splitVolumes(project.rawScript, 15);
    onProgress(`已切 ${volumes.length} 卷，开始分卷摘要…`, 0.05);
    const summaries = await summarizeVolumes(volumes, model, onProgress, signal);
    onProgress('正在出骨架快版…', 0.15);
    const base = currentOutline();
    const { adaptation, gates } = await generateSkeleton(summaries, base.params, model, onProgress, signal);
    updateProject({
      adaptation: {
        ...adaptation,
        volumeSummaries: summaries,
        gates,
        gatesStage: 'skeleton',
      },
    });
  });

  const approveSkeleton = () => withBusy(async (signal, onProgress) => {
    const model = project.shotGenerationModel || '';
    const base: AdaptationOutline = { ...(outline!), skeletonApproved: true, updatedAt: Date.now() };
    onProgress('拍板生效，开始分批写分集梗概…', 0.05);
    const { episodes, gates } = await generateEpisodes(base, model, onProgress, signal);
    const full: AdaptationOutline = { ...base, episodes, gates, gatesStage: 'full', gatesPassedAt: gates.every((g) => g.ok) ? Date.now() : undefined };
    updateProject({
      adaptation: {
        ...full,
        assetInventory: buildAssetInventory(full),
      },
    });
  });

  const regenerateSkeleton = () => {
    showAlert('重新出骨架会覆盖当前骨架（分集也会清空），确定吗？', {
      title: '重新出骨架', type: 'warning', showCancel: true,
      confirmText: '重新出骨架', cancelText: '取消',
      onConfirm: () => {
        updateProject({ adaptation: { ...(outline!), episodes: [], skeletonApproved: false, gates: null, assetInventory: undefined } });
        startAdaptation();
      },
    });
  };

  const cancel = () => abortRef.current?.abort();

  const applyToScript = (ep: number) => {
    if (!outline) return;
    const text = composeEpisodeScriptInput(outline, ep);
    updateProject({
      rawScript: text,
      targetDuration: `${outline.params.minutesPerEpisode}分钟`,
      scriptData: null,
      shots: [],
      scriptGenerationCheckpoint: null,
      stage: 'script',
    });
    showAlert(`第 ${ep} 集的结构化剧本任务书已写入「剧本与故事」，去那里开始拆解与生成。`, { title: '已应用到剧本', type: 'success' });
  };

  const gates = outline?.gates ?? null;
  const gatesPassed = outlineGatesPassed(gates);
  const inventory: OutlineAssetRow[] = outline?.assetInventory ?? [];

  return (
    <div className="h-full overflow-y-auto p-8 space-y-6">
      {/* 页头 */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <BookOpen className="w-5 h-5 text-[var(--accent-text)]" />
            <h1 className="text-xl font-bold text-[var(--text-primary)]">改编大纲 <span className="text-xs font-mono text-[var(--text-muted)]">shuohao-skills 流水线</span></h1>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1 max-w-3xl leading-relaxed">
            小说 → 分卷摘要 → 骨架快版（砍线 / 合人 / 排爽点）→ <b className="text-[var(--text-secondary)]">导演拍板</b> → 分批写分集（每批 ≤ {MAX_EPISODES_PER_BATCH} 集）→ 14 道确定性质量门 → 资产清单（代码汇总）。
            先拍板再细化；质量门未过会带着 ✗ 详情自动回炉修复。
          </p>
        </div>
        {outline && (
          <div className="flex items-center gap-2 text-xs">
            {outline.skeletonApproved
              ? <span className="px-2 py-1 rounded bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/30">骨架已拍板</span>
              : <span className="px-2 py-1 rounded bg-[#d9a13c]/10 text-[#d9a13c] border border-[#d9a13c]/30">骨架待拍板</span>}
            {episodesDone && gatesPassed && (
              <span className="px-2 py-1 rounded bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/30">大纲完成</span>
            )}
          </div>
        )}
      </div>

      {/* 参数 + 原文 */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 space-y-3">
          <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-muted)]">改编参数</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">总集数</span>
              <input value={form.episodes} onChange={(e) => setForm({ ...form, episodes: e.target.value })}
                disabled={busy} className="w-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg px-2 py-1.5 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">单集（分钟）</span>
              <input value={form.minutesPerEpisode} onChange={(e) => setForm({ ...form, minutesPerEpisode: e.target.value })}
                disabled={busy} className="w-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg px-2 py-1.5 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">题材</span>
              <input value={form.genre} placeholder="女频逆袭 / 悬疑反转…" onChange={(e) => setForm({ ...form, genre: e.target.value })}
                disabled={busy} className="w-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg px-2 py-1.5 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">改编方式</span>
              <select value={form.adaptMode} onChange={(e) => setForm({ ...form, adaptMode: e.target.value as OutlineParams['adaptMode'] })}
                disabled={busy} className="w-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg px-2 py-1.5 text-sm">
                {adaptModes.map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] text-[var(--text-muted)]">点名要保的角色 / 戏（顿号分隔，可空）</span>
            <input value={form.preferences} onChange={(e) => setForm({ ...form, preferences: e.target.value })}
              disabled={busy} className="w-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <div className="text-[11px] text-[var(--text-muted)]">
            主场景上限随集数动态：{primarySceneCap(parseInt(form.episodes) || 0)} 个（4 + ⌈集数/10⌉，夹 5–15）
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 flex flex-col">
          <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-muted)] mb-2">小说原文（在「剧本与故事」粘贴，或直接由项目导入）</div>
          <div className="flex-1 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-primary)] p-3 text-xs text-[var(--text-muted)] overflow-y-auto max-h-28 whitespace-pre-wrap">
            {project.rawScript ? project.rawScript.slice(0, 400) + (project.rawScript.length > 400 ? ' …' : '') : '（空）'}
          </div>
          <div className="flex items-center justify-between mt-3">
            <span className={`text-xs ${canGenerate ? 'text-[var(--text-muted)]' : 'text-[#d9a13c]'}`}>
              {novelChars} 字 {canGenerate ? '' : '· 至少约 200 字才能开始改编'}
            </span>
            <div className="flex items-center gap-2">
              {busy && (
                <button onClick={cancel} className="px-3 py-1.5 rounded-lg border border-[var(--border-primary)] text-xs text-[var(--text-secondary)] hover:border-[#d1543c]">
                  取消
                </button>
              )}
              {!outline ? (
                <button onClick={startAdaptation} disabled={busy || !canGenerate}
                  className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-[var(--accent-text)] text-white text-sm font-medium disabled:opacity-40">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  开始改编
                </button>
              ) : (
                <button onClick={regenerateSkeleton} disabled={busy}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border-primary)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent-text)]">
                  <RotateCcw className="w-3.5 h-3.5" /> 重新出骨架
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 进度 / 错误 */}
      {busy && (
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
          <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-text)]" /> {progressMsg}
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div className="h-full bg-[var(--accent-text)] transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-[#d1543c]/50 bg-[#d1543c]/5 p-4 text-sm text-[#d1543c] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}

      {/* 骨架拍板卡 */}
      {outline?.adaptation && (
        <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
              <Wand2 className="w-4 h-4 text-[var(--accent-text)]" /> 骨架快版 — 砍线 / 合人 / 排爽点（等您拍板）
            </div>
            {!outline.skeletonApproved && (
              <button onClick={approveSkeleton} disabled={busy}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-[var(--success)] text-white text-sm font-medium disabled:opacity-40">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsUp className="w-4 h-4" />}
                拍板，开始写分集
              </button>
            )}
            {outline.skeletonApproved && !episodesDone && (
              <button onClick={approveSkeleton} disabled={busy}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-[var(--accent-text)] text-white text-sm font-medium disabled:opacity-40">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                继续写分集（{outline.episodes?.length ?? 0}/{outline.params.episodes}）
              </button>
            )}
          </div>

          <div className="text-sm text-[var(--text-secondary)]">
            <span className="text-[var(--text-muted)] text-xs font-mono mr-2">CORE</span>{outline.adaptation.core}
          </div>

          <div className="grid grid-cols-3 gap-3 text-xs">
            {([['保留', outline.adaptation.keep, 'var(--success)'], ['砍掉', outline.adaptation.cut, '#d1543c'], ['合并', outline.adaptation.merge, '#d9a13c']] as const).map(([label, rows, color]) => (
              <div key={label} className="rounded-lg border border-[var(--border-subtle)] p-3">
                <div className="font-medium mb-2" style={{ color }}>{label}{rows?.length ? ` × ${rows.length}` : ''}</div>
                <div className="space-y-2">
                  {(rows ?? []).map((r, i) => (
                    <div key={i}>
                      <div className="text-[var(--text-primary)]">{r.what}</div>
                      <div className="text-[var(--text-muted)] leading-relaxed">{r.why}</div>
                      {('evidence' in r && (r as any).evidence) && (
                        <div className="mt-1 pl-2 border-l-2 border-[var(--border-subtle)] text-[var(--text-muted)] italic">「{(r as any).evidence}」</div>
                      )}
                    </div>
                  ))}
                  {(!rows || rows.length === 0) && <span className="text-[var(--text-muted)]">（空）</span>}
                </div>
              </div>
            ))}
          </div>

          {(outline.adaptation.cutNote || outline.adaptation.mergeNote) && (
            <div className="space-y-1 text-xs">
              {outline.adaptation.cutNote && <div className="text-[var(--text-secondary)]"><span className="text-[#d1543c] font-mono mr-2">CUT→</span>{outline.adaptation.cutNote}</div>}
              {outline.adaptation.mergeNote && <div className="text-[var(--text-secondary)]"><span className="text-[#d9a13c] font-mono mr-2">MERGE→</span>{outline.adaptation.mergeNote}</div>}
            </div>
          )}

          {/* 人物表 */}
          <div>
            <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-muted)] mb-2">人物表（{outline.characters?.length ?? 0}）— 分档守的是 AI 角色资产成本</div>
            <div className="flex flex-wrap gap-2">
              {(outline.characters ?? []).map((c) => (
                <div key={c.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-xs">
                  <span className="font-mono text-[var(--text-muted)]">{c.id}</span>
                  <span className="text-[var(--text-primary)] font-medium">{c.name}</span>
                  {tierChip(c.tier)}
                </div>
              ))}
            </div>
          </div>

          {/* 场景表 */}
          <div>
            <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-muted)] mb-2">场景表（{outline.scenes?.length ?? 0}）</div>
            <div className="flex flex-wrap gap-2">
              {(outline.scenes ?? []).map((s) => (
                <div key={s.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-xs">
                  <span className="font-mono text-[var(--text-muted)]">{s.id}</span>
                  <span className="text-[var(--text-primary)]">{s.name}</span>
                  {s.primary && <span className="px-1 rounded text-[10px] bg-[var(--accent-bg)] text-[var(--accent-text)]">主</span>}
                </div>
              ))}
            </div>
          </div>

          {/* 爽点节奏轴 */}
          <div className="rounded-lg border border-[var(--border-subtle)] p-3 bg-[var(--bg-secondary)]">
            <BeatTimeline outline={outline} />
          </div>

          <GatePanel gates={gates && outline.gatesStage === 'skeleton' ? gates : runOutlineGates(outline, 'skeleton')} />
        </div>
      )}

      {/* 分集 + 门 + 资产清单 */}
      {outline?.skeletonApproved && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
            <FileStack className="w-4 h-4 text-[var(--accent-text)]" /> 分集梗概（{outline.episodes?.length ?? 0}/{outline.params.episodes}）
          </div>

          <GatePanel gates={gates} />

          <div className="grid grid-cols-2 gap-3">
            {(outline.episodes ?? []).map((e) => (
              <div key={e.ep} className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-[var(--text-primary)]">第 {e.ep} 集</span>
                  <button onClick={() => applyToScript(e.ep)} disabled={busy}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--border-primary)] text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent-text)] hover:text-[var(--accent-text)]">
                    <ArrowRight className="w-3 h-3" /> 应用到剧本
                  </button>
                </div>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{e.synopsis}</p>
                <div className="text-xs space-y-1">
                  <div className="text-[var(--text-secondary)]"><span className="text-[var(--accent-text)] font-medium">【钩子】</span>{e.hook}</div>
                  <div className="text-[var(--text-secondary)]"><span className="text-[#d9a13c] font-medium">【悬念】</span>{e.suspense}</div>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[10px] text-[var(--text-muted)]">
                  {(e.characterIds ?? []).map((id) => <span key={id} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]">{id}</span>)}
                  {(e.sceneIds ?? []).map((id) => <span key={id} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]">{id}</span>)}
                  {(e.warnings ?? []).map((w) => <span key={w} className="px-1.5 py-0.5 rounded bg-[#d9a13c]/10 text-[#d9a13c]">⚠ {w}</span>)}
                </div>
              </div>
            ))}
          </div>

          {/* 资产清单（代码汇总） */}
          {inventory.length > 0 && (
            <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)] mb-3">
                <FileStack className="w-4 h-4 text-[var(--accent-text)]" /> 资产清单 <span className="text-xs font-normal text-[var(--text-muted)]">（脚本自动汇总，出现集 / 资产量折算 / 一次性场景复用）</span>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                    <th className="py-1.5 pr-2">ID</th><th className="py-1.5 pr-2">名称</th><th className="py-1.5 pr-2">出现集</th>
                    <th className="py-1.5 pr-2">次数</th><th className="py-1.5 pr-2">备产说明</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.map((r) => (
                    <tr key={`${r.kind}-${r.id}`} className="border-b border-[var(--border-subtle)]/50">
                      <td className="py-1.5 pr-2 font-mono text-[var(--text-muted)]">{r.id}</td>
                      <td className="py-1.5 pr-2 text-[var(--text-primary)]">{r.name}</td>
                      <td className="py-1.5 pr-2 text-[var(--text-muted)]">{r.episodes.join('、') || '—'}</td>
                      <td className="py-1.5 pr-2">{r.count}</td>
                      <td className="py-1.5 pr-2 text-[var(--text-muted)]">
                        {r.note}{r.warnings?.length ? <span className="text-[#d9a13c]"> · ⚠ {r.warnings.join('、')}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {episodesDone && !gatesPassed && (
            <div className="rounded-xl border border-[#d1543c]/50 bg-[#d1543c]/5 p-4 text-xs text-[#d1543c] flex items-center gap-2">
              <Ban className="w-4 h-4" /> 分集已写完但质量门未全过——点「继续写分集」会带 ✗ 详情自动修复。
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StageOutline;
