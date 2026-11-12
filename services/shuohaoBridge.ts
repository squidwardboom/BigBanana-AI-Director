/**
 * shuohao-engine 桥接 —— 探测并调用本地伴随服务（server/shuohaoServer.mjs）。
 *
 * 引擎在，功能全量：真实技能 CLI 的 chunk / validate(--stage) / checkup / assets /
 * render / blocking / export，质量门输出原样来自技能脚本（校验口径零偏差），
 * 单页评审报告直接在 iframe 里打开。
 * 引擎不在：StageOutline 自动降级到浏览器内实现（services/shuohaoGates.ts 的移植版）。
 */

import { OutlineGateResult } from '../types';

export interface ShuohaoEngineStatus {
  ok: boolean;
  service: string;
  node: string;
  skillsDir: string;
  skillsDirOk: boolean;
  workspacesDir: string;
  skills: Record<string, boolean>;
  ops: string[];
}

const ENGINE_BASE = 'http://127.0.0.1:7791';
let statusCache: ShuohaoEngineStatus | null | undefined;

/** 探测引擎（结果缓存 5 秒）；不可达返回 null */
export async function probeEngine(force = false): Promise<ShuohaoEngineStatus | null> {
  if (!force && statusCache !== undefined) return statusCache;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${ENGINE_BASE}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    statusCache = res.ok ? ((await res.json()) as ShuohaoEngineStatus) : null;
  } catch {
    statusCache = null;
  }
  setTimeout(() => { statusCache = undefined; }, 5000);
  return statusCache;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string | null;
  op: string;
  ms?: number;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ENGINE_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
  return data as T;
}

export function ensureWorkspace(id: string): Promise<{ ok: boolean }> {
  return post('/api/workspace', { id });
}

export function writeWorkspaceFile(id: string, path: string, content: string): Promise<{ ok: boolean; bytes: number }> {
  return fetch(`${ENGINE_BASE}/api/workspace/${encodeURIComponent(id)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
    return data as { ok: boolean; bytes: number };
  });
}

export async function readWorkspaceFile(id: string, path: string): Promise<string> {
  const res = await fetch(`${ENGINE_BASE}/api/workspace/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
  return (data as { content: string }).content;
}

export interface WorkspaceFileInfo { path: string; size: number; mtime: string }
export async function listWorkspaceFiles(id: string): Promise<WorkspaceFileInfo[]> {
  const res = await fetch(`${ENGINE_BASE}/api/workspace/${encodeURIComponent(id)}/files`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
  return (data as { files: WorkspaceFileInfo[] }).files;
}

export function runOp(payload: {
  op: string;
  workspace: string;
  slug: string;
  [key: string]: unknown;
}): Promise<RunResult> {
  return post('/api/run', payload);
}

/** 报告等产物的浏览器直连地址（iframe / 新窗口） */
export function workspaceUrl(id: string, relPath: string): string {
  return `${ENGINE_BASE}/workspace/${encodeURIComponent(id)}/${relPath.split('\\').join('/')}`;
}

/**
 * 解析技能 CLI 的质量门输出（全仓库统一格式）：
 *   ✓ 描述 / ✗ 描述 — 细节 / 末行 ✓ 全部通过 或 ✗ N 项未过 / ⚠️ 警告走 stderr
 */
export function parseEngineGateOutput(stdout = '', stderr = ''): { gates: OutlineGateResult[]; pass: boolean | null; warnings: string[] } {
  const gates: OutlineGateResult[] = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^([✓✗])\s*(.+)$/);
    if (!m) continue;
    const ok = m[1] === '✓';
    const rest = m[2].trim();
    if (rest === '全部通过' || /^\d+\s*项未过$/.test(rest)) continue;
    const sep = rest.indexOf(' — ');
    const label = sep >= 0 ? rest.slice(0, sep).trim() : rest;
    const detail = sep >= 0 ? rest.slice(sep + 3).trim() : '';
    gates.push({ id: label, label, ok, detail });
  }
  const warnings = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('⚠️') || l.startsWith('⚠'));
  const pass = gates.length > 0 ? gates.every((g) => g.ok) : null;
  return { gates, pass, warnings };
}

/** 引擎 slug 命令：书名 → 安全产物文件名（与技能生态一致） */
export async function engineSlug(name: string): Promise<string | null> {
  try {
    const r = await runOp({ op: 'slug', workspace: '__slug__', slug: '__slug__', name });
    return r.stdout.trim().split(/\r?\n/).pop() || null;
  } catch {
    return null;
  }
}
