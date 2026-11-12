/**
 * ShuohaoEngineBar —— 可复用的"本阶段技能引擎"横幅。
 *
 * 默认收起成一行状态条（引擎已连接 / 未启动），点开后展开本阶段可用的
 * 技能操作（体检 / 校验 / 渲染报告 / 导出），全部走 services/shuohaoBridge
 * 调用本地伴随服务（server/shuohaoServer.mjs，端口 7791）。
 * 错误一律行内红字展示，不打断各阶段页面的既有布局。
 */

import React, { useEffect, useState } from 'react';
import {
  Cpu, PlugZap, Loader2, ChevronDown, Play, ExternalLink, RefreshCw,
} from 'lucide-react';
import { OutlineGateResult } from '../types';
import {
  probeEngine, ShuohaoEngineStatus, ensureWorkspace, readWorkspaceFile,
  runOp, workspaceUrl, parseEngineGateOutput, RunResult,
} from '../services/shuohaoBridge';
import GatePanel from './GatePanel';

export type EngineBarTab = 'script' | 'assets' | 'director' | 'export';

interface Props {
  projectId: string;
  projectTitle: string;
  tab: EngineBarTab;
}

/** storyboard export 交付清单里的一段（manifest.json 数组元素） */
interface ManifestSegment {
  segment?: string;
  seconds?: number;
  cuts?: number;
  prompt?: string;
  pictures?: string[];
  missing?: string[];
}

/** 单个引擎操作的前端运行状态 */
interface OpState {
  running?: boolean;
  error?: string;
  result?: RunResult;
  gates?: OutlineGateResult[];
  warnings?: string[];
}

/** 书名 → 安全产物文件名（与 StageOutline / 技能生态同一清洗规则） */
const slugOf = (title: string): string =>
  (title || 'project').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

/** 清单里的绝对路径 → 工作区相对路径（导出产物固定在 storyboard/ 目录下） */
const relOf = (abs: string): string => {
  const norm = String(abs || '').split('\\').join('/');
  const m = norm.match(/storyboard\/(.+)$/);
  return m ? `storyboard/${m[1]}` : norm;
};

const basenameOf = (p: string): string => String(p || '').split(/[\\/]/).pop() || p;

/** 运行按钮：运行中禁用并转圈 */
const RunButton: React.FC<{ onClick: () => void; running?: boolean; label: string }> = ({ onClick, running, label }) => (
  <button
    onClick={onClick}
    disabled={!!running}
    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-primary)] text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent-text)] hover:text-[var(--accent-text)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--border-primary)] disabled:hover:text-[var(--text-secondary)]"
  >
    {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
    {label}
  </button>
);

/** 单个操作的行内反馈：错误红字 / 警告琥珀 / 质量门列表 */
const OpFeedback: React.FC<{ state: OpState; workspaceId: string }> = ({ state, workspaceId }) => {
  if (state.running) {
    return <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> 技能脚本运行中，输出原样来自 shuohao-skills…</div>;
  }
  return (
    <div className="space-y-2">
      {state.error && (
        <div className="text-[11px] text-[#d1543c] leading-relaxed break-all">✗ 调用失败：{state.error}</div>
      )}
      {state.result && state.result.exitCode !== 0 && !state.gates?.length && (
        <div className="text-[11px] text-[#d1543c] leading-relaxed break-all">
          ✗ 退出码 {state.result.exitCode}{state.result.stderr ? `：${state.result.stderr.slice(-400)}` : ''}
        </div>
      )}
      {(state.warnings?.length ?? 0) > 0 && (
        <div className="space-y-0.5">
          {state.warnings!.map((w, i) => (
            <div key={i} className="text-[11px] text-[#d9a13c] leading-relaxed break-all">{w}</div>
          ))}
        </div>
      )}
      <GatePanel gates={state.gates} source="engine" />
      {state.result?.output && (
        <a
          href={workspaceUrl(workspaceId, state.result.output)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-[var(--accent-text)] hover:underline"
        >
          <ExternalLink className="w-3 h-3" /> 打开渲染报告（{state.result.output}）
        </a>
      )}
    </div>
  );
};

const ShuohaoEngineBar: React.FC<Props> = ({ projectId, projectTitle, tab }) => {
  // 引擎探测：undefined = 还没返回；null = 离线；对象 = 已连接
  const [engine, setEngine] = useState<ShuohaoEngineStatus | null | undefined>(undefined);
  const [probingSlow, setProbingSlow] = useState(false);
  const [open, setOpen] = useState(false);
  const [ops, setOps] = useState<Record<string, OpState>>({});
  const [manifest, setManifest] = useState<ManifestSegment[] | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState('');

  useEffect(() => {
    let alive = true;
    const slowTimer = window.setTimeout(() => { if (alive) setProbingSlow(true); }, 500);
    probeEngine().then((status) => {
      if (!alive) return;
      window.clearTimeout(slowTimer);
      setEngine(status);
      setProbingSlow(false);
    });
    return () => { alive = false; window.clearTimeout(slowTimer); };
  }, []);

  const engineOn = !!engine?.ok && engine?.skillsDirOk === true;
  const skillCount = engine ? Object.values(engine.skills).filter(Boolean).length : 0;
  const slug = slugOf(projectTitle);

  const opState = (op: string): OpState => ops[op] ?? {};

  const execOp = async (op: string) => {
    setOps((prev) => ({ ...prev, [op]: { running: true } }));
    try {
      await ensureWorkspace(projectId);
      const result = await runOp({ op, workspace: projectId, slug });
      const parsed = parseEngineGateOutput(result.stdout, result.stderr);
      setOps((prev) => ({
        ...prev,
        [op]: {
          result,
          gates: parsed.gates.length ? parsed.gates : undefined,
          warnings: parsed.warnings,
        },
      }));
    } catch (e: any) {
      setOps((prev) => ({ ...prev, [op]: { error: String(e?.message || e) } }));
    }
  };

  const loadManifest = async () => {
    setManifestLoading(true);
    setManifestError('');
    try {
      const raw = await readWorkspaceFile(projectId, 'storyboard/manifest.json');
      const data = JSON.parse(raw);
      setManifest(Array.isArray(data) ? data : (data ? [data] : []));
    } catch (e: any) {
      setManifestError(String(e?.message || e));
    } finally {
      setManifestLoading(false);
    }
  };

  // export 页签：首次展开（引擎已连接）自动读交付清单；导出成功后也会刷新
  useEffect(() => {
    if (open && tab === 'export' && engineOn && manifest === null && !manifestLoading && !manifestError) {
      loadManifest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, engineOn]);

  const runExport = async () => {
    await execOp('storyboard_export');
    loadManifest();
  };

  const opRunning = Object.values(ops).some((s) => s.running);

  // 状态条配色：探测中中性、已连接绿色、未启动琥珀（与 StageOutline 顶部横幅一致）
  const bannerClass = engine === undefined
    ? 'border-[var(--border-primary)] bg-[var(--bg-primary)]'
    : engineOn
      ? 'border-[var(--success)]/40 bg-[var(--success)]/5'
      : 'border-[#d9a13c]/40 bg-[#d9a13c]/5';

  const statusNode = engine === undefined ? (
    probingSlow
      ? <><Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)] flex-shrink-0" /><span className="text-[var(--text-muted)]">正在探测本地技能引擎…</span></>
      : <><Cpu className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" /><span className="text-[var(--text-muted)]">连接技能引擎…</span></>
  ) : engineOn ? (
    <>
      <Cpu className="w-4 h-4 text-[var(--success)] flex-shrink-0" />
      <span className="text-[var(--text-secondary)] truncate min-w-0">
        <b>引擎已连接</b> —— 技能库：<span className="font-mono text-[11px]">{engine!.skillsDir}</span>（{skillCount}/6 技能就绪）
      </span>
    </>
  ) : (
    <>
      <PlugZap className="w-4 h-4 text-[#d9a13c] flex-shrink-0" />
      <span className="text-[var(--text-secondary)] truncate min-w-0">
        <b>引擎未启动</b> —— 在仓库根目录运行 <code className="px-1 rounded bg-[var(--bg-tertiary)] font-mono">npm run shuohao</code> 启动本阶段技能引擎
      </span>
    </>
  );

  return (
    <div className={`rounded-xl border text-xs ${bannerClass} shrink-0`}>
      {/* 一行状态条（收起态即整条横幅），点击展开/收起操作区 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left min-w-0"
        title={open ? '收起技能引擎面板' : '展开本阶段技能引擎操作'}
      >
        {statusNode}
        {opRunning && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-text)] flex-shrink-0" />}
        <ChevronDown className={`w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* 展开后的操作区 */}
      {open && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-3 space-y-3 max-h-80 overflow-y-auto">
          {!engineOn ? (
            <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              {engine === undefined
                ? '正在探测本地技能引擎，连上后这里会出现本阶段的技能操作。'
                : '引擎未启动，技能操作不可用——先在仓库根目录运行 npm run shuohao（需要本机装有 shuohao-skills 仓库与 Node ≥ 18）。'}
            </div>
          ) : (
            <>
              {(tab === 'script' || tab === 'assets' || tab === 'director') && (
                <div className={`grid ${tab === 'script' ? 'grid-cols-1' : 'grid-cols-2'} gap-3`}>
                  {tab === 'script' && (
                    <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[var(--text-primary)] font-medium">剧本质量门</span>
                        <span className="text-[10px] font-mono text-[var(--text-muted)]">script_checkup · script_render</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          <RunButton onClick={() => execOp('script_checkup')} running={opState('script_checkup').running} label="剧本体检" />
                          <RunButton onClick={() => execOp('script_render')} running={opState('script_render').running} label="渲染剧本报告" />
                        </span>
                      </div>
                      <OpFeedback state={opState('script_checkup')} workspaceId={projectId} />
                      <OpFeedback state={opState('script_render')} workspaceId={projectId} />
                    </div>
                  )}

                  {tab === 'assets' && (
                    <>
                      <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[var(--text-primary)] font-medium">美术设定</span>
                          <span className="text-[10px] font-mono text-[var(--text-muted)]">art_checkup · art_render</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            <RunButton onClick={() => execOp('art_checkup')} running={opState('art_checkup').running} label="美术体检" />
                            <RunButton onClick={() => execOp('art_render')} running={opState('art_render').running} label="渲染美术报告" />
                          </span>
                        </div>
                        <OpFeedback state={opState('art_checkup')} workspaceId={projectId} />
                        <OpFeedback state={opState('art_render')} workspaceId={projectId} />
                      </div>
                      <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[var(--text-primary)] font-medium">角色卡</span>
                          <span className="text-[10px] font-mono text-[var(--text-muted)]">characters_validate · characters_render</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            <RunButton onClick={() => execOp('characters_validate')} running={opState('characters_validate').running} label="角色校验" />
                            <RunButton onClick={() => execOp('characters_render')} running={opState('characters_render').running} label="渲染角色报告" />
                          </span>
                        </div>
                        <OpFeedback state={opState('characters_validate')} workspaceId={projectId} />
                        <OpFeedback state={opState('characters_render')} workspaceId={projectId} />
                      </div>
                    </>
                  )}

                  {tab === 'director' && (
                    <>
                      <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[var(--text-primary)] font-medium">开场站位</span>
                          <span className="text-[10px] font-mono text-[var(--text-muted)]">staging_blocking · staging_render</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            <RunButton onClick={() => execOp('staging_blocking')} running={opState('staging_blocking').running} label="输出走位句" />
                            <RunButton onClick={() => execOp('staging_render')} running={opState('staging_render').running} label="渲染站位报告" />
                          </span>
                        </div>
                        <OpFeedback state={opState('staging_blocking')} workspaceId={projectId} />
                        {(() => {
                          const stdout = opState('staging_blocking').result?.stdout ?? '';
                          const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                          if (!lines.length) return null;
                          return (
                            <div className="space-y-1">
                              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">每场开场走位句（第一段分镜照抄）</div>
                              {lines.map((line, i) => (
                                <div key={i} className="text-[11px] text-[var(--text-secondary)] leading-relaxed flex gap-1.5">
                                  <span className="text-[var(--accent-text)] font-mono flex-shrink-0">{i + 1}.</span>
                                  <span>{line}</span>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                        <OpFeedback state={opState('staging_render')} workspaceId={projectId} />
                      </div>
                      <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[var(--text-primary)] font-medium">分镜</span>
                          <span className="text-[10px] font-mono text-[var(--text-muted)]">storyboard_checkup · storyboard_render</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            <RunButton onClick={() => execOp('storyboard_checkup')} running={opState('storyboard_checkup').running} label="分镜体检" />
                            <RunButton onClick={() => execOp('storyboard_render')} running={opState('storyboard_render').running} label="渲染分镜报告" />
                          </span>
                        </div>
                        <OpFeedback state={opState('storyboard_checkup')} workspaceId={projectId} />
                        <OpFeedback state={opState('storyboard_render')} workspaceId={projectId} />
                      </div>
                    </>
                  )}
                </div>
              )}

              {tab === 'export' && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[var(--text-primary)] font-medium">分镜投产包导出</span>
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">storyboard_export</span>
                      <span className="ml-auto"><RunButton onClick={runExport} running={opState('storyboard_export').running} label="生成分镜投产包" /></span>
                    </div>
                    <OpFeedback state={opState('storyboard_export')} workspaceId={projectId} />
                    {(opState('storyboard_export').result?.stdout ?? '').trim() && (
                      <pre className="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-2.5 text-[11px] leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap font-mono text-[var(--text-secondary)]">
                        {opState('storyboard_export').result!.stdout.trim()}
                      </pre>
                    )}
                  </div>

                  <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[var(--text-primary)] font-medium">分段交付清单</span>
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">storyboard/manifest.json</span>
                      <span className="ml-auto">
                        <button
                          onClick={loadManifest}
                          disabled={manifestLoading}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-primary)] text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent-text)] hover:text-[var(--accent-text)] disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {manifestLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          刷新清单
                        </button>
                      </span>
                    </div>
                    {manifestError && (
                      <div className="text-[11px] text-[#d1543c] leading-relaxed break-all">✗ 读取清单失败：{manifestError}</div>
                    )}
                    {!manifestError && manifest !== null && manifest.length === 0 && (
                      <div className="text-[11px] text-[var(--text-muted)]">清单为空——先跑 storyboard_export 生成分段产物。</div>
                    )}
                    {!manifestError && manifest !== null && manifest.length > 0 && (
                      <div className="space-y-1">
                        {manifest.map((seg, i) => {
                          const missing = seg.missing ?? [];
                          const missingNames = missing.map(basenameOf).join('、');
                          return (
                            <div key={seg.segment ?? i} className="flex items-center gap-2 flex-wrap text-[11px] leading-relaxed">
                              <span className="font-mono text-[var(--text-primary)]">{seg.segment ?? `段 ${i + 1}`}</span>
                              <span className="text-[var(--text-muted)]">{seg.cuts ?? 0} 切{seg.seconds ? ` · ${seg.seconds} 秒` : ''}</span>
                              {missing.length > 0 ? (
                                <span className="text-[#d1543c]" title={missingNames}>缺图 {missing.length} 张（{missingNames}）</span>
                              ) : (
                                <span className="text-[var(--success)]">分镜图齐备</span>
                              )}
                              {seg.prompt && (
                                <a
                                  href={workspaceUrl(projectId, relOf(seg.prompt))}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[var(--accent-text)] hover:underline"
                                >
                                  <ExternalLink className="w-3 h-3" /> 打开 prompt.md
                                </a>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ShuohaoEngineBar;
