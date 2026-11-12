/**
 * 收集 E01-01：轮询 ComfyUI /history，找到 MiniMax H3 段视频产物就搬进工作区。
 * （原等待任务用的是 90 分钟超时旧脚本，会先超时退出；这个收集器兜底。）
 */
import fs from 'node:fs';
import path from 'node:path';

const ENGINE = 'http://127.0.0.1:7791';
const COMFY = 'http://127.0.0.1:8188';
const WS_ID = 'shortfilm-demo';
const log = (...a) => console.log('[collect]', ...a);

async function wsWriteBin(p, buf) {
  const res = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS_ID)}/file`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, contentB64: Buffer.from(buf).toString('base64') }),
  });
  const d = await res.json(); if (!res.ok) throw new Error(d.error); return d;
}

async function findVideo() {
  const res = await fetch(`${COMFY}/history`);
  const h = await res.json();
  for (const [pid, entry] of Object.entries(h)) {
    const graph = entry.prompt?.[2] ?? {};
    const isH3 = Object.values(graph).some((n) => /MiniMaxH3/i.test(n?.class_type || ''));
    if (!isH3) continue;
    if (entry.status && entry.status.completed === false && entry.status.status_str === 'running') return { pending: true, pid };
    for (const o of Object.values(entry.outputs || {})) {
      for (const key of ['videos', 'gifs', 'images']) {
        const arr = o[key];
        if (Array.isArray(arr) && arr.length) {
          const f = arr.find((x) => /\.mp4$|\.webm$/i.test(x.filename)) || arr[0];
          return { pid, filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' };
        }
      }
    }
  }
  return null;
}

for (;;) {
  const r = await findVideo();
  if (r?.pending) { log(`H3 任务 ${r.pid.slice(0, 8)} 仍在队列执行…`); }
  else if (r?.filename) {
    log(`找到产物：${r.filename}（${r.subfolder || 'output'}）`);
    const q = new URLSearchParams({ filename: r.filename, subfolder: r.subfolder, type: r.type });
    const res = await fetch(`${COMFY}/view?${q}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const rel = 'storyboard/E01-01/E01-01.mp4';
    await wsWriteBin(rel, buf);
    log(`✓ 已入库 ${rel}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
    process.exit(0);
  } else {
    log('历史里暂无 H3 产物…');
  }
  await new Promise((r2) => setTimeout(r2, 30000));
}
