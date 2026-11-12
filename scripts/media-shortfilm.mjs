/**
 * E2E 媒体驱动：分镜图（z_image turbo）→ 段视频（本地 MiniMax H3 首尾帧→视频+音频）→ ffmpeg 合成短片
 *
 * 前置：scripts/e2e-shortfilm.mjs 已跑到 export（storyboard.json + manifest 就绪）；ComfyUI 在 8188。
 * 用法：
 *   node scripts/media-shortfilm.mjs --kf            # 只出分镜图
 *   node scripts/media-shortfilm.mjs --seg E01-01    # 只跑一个段视频（先试水）
 *   node scripts/media-shortfilm.mjs --all           # 全部段视频
 *   node scripts/media-shortfilm.mjs --film          # ffmpeg 合成成片
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** winget 装的 ffmpeg 别名目录可能不在本进程 PATH 里，逐个探测 */
function findFfmpeg() {
  const candidates = [
    'ffmpeg',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  ];
  // winget Packages 目录下 Gyan.FFmpeg 的实际 bin 目录
  try {
    const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    for (const dir of fs.readdirSync(pkgs).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      const bin = path.join(pkgs, dir);
      const exe = findExeDeep(bin);
      if (exe) candidates.push(exe);
    }
  } catch { /* 没有 winget 目录 */ }
  for (const c of candidates) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; } catch { /* 下一个 */ }
  }
  throw new Error('找不到 ffmpeg（winget install Gyan.FFmpeg）');
}
function findExeDeep(dir, depth = 0) {
  if (depth > 4) return null;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'ffmpeg.exe') return p;
      if (e.isDirectory()) { const r = findExeDeep(p, depth + 1); if (r) return r; }
    }
  } catch { /* 忽略 */ }
  return null;
}
const FFMPEG = findFfmpeg();

const ENV = {};
const envFile = path.resolve(process.cwd(), '../../pipeline.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) ENV[m[1]] = m[2];
}
const ENGINE = ENV.ENGINE || 'http://127.0.0.1:7791';
const COMFY = ENV.COMFY || 'http://127.0.0.1:8188';
const WS_ID = 'shortfilm-demo';
const SLUG = '灯塔来信';
const CLIENT = 'bigbanana-e2e';
const W = 1344, H = 768, FPS = 24, FRAMES = 124; // 17k+5 网格：124 帧 ≈ 5.2 秒
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const has = (k) => process.argv.includes(k);
const MODE = has('--kf') ? 'kf' : has('--seg') ? 'seg' : has('--all') ? 'all' : has('--film') ? 'film' : 'all';
const log = (...a) => console.log('[media]', ...a);

/* ---------- workspace IO ---------- */
async function wsRead(p) {
  const res = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS_ID)}/file?path=${encodeURIComponent(p)}`);
  const d = await res.json(); if (!res.ok) throw new Error(d.error); return d.content;
}
async function wsWriteBin(p, buf) {
  const res = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS_ID)}/file`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, contentB64: Buffer.from(buf).toString('base64') }),
  });
  const d = await res.json(); if (!res.ok) throw new Error(d.error); return d;
}

/* ---------- ComfyUI ---------- */
async function comfyPost(graph) {
  const res = await fetch(`${COMFY}/prompt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: CLIENT }),
  });
  const d = await res.json();
  if (!res.ok || d.error) throw new Error(`/prompt 失败: ${JSON.stringify(d).slice(0, 400)}`);
  return d.prompt_id;
}
async function comfyWait(promptId, timeoutMs = 40 * 60000) {
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetch(`${COMFY}/history/${promptId}`);
    const h = await res.json();
    const entry = h[promptId];
    if (entry) {
      if (entry.status?.completed || entry.outputs && Object.keys(entry.outputs).length) {
        if (entry.status?.status_str === 'error') throw new Error('执行出错: ' + JSON.stringify(entry.status).slice(0, 500));
        return entry.outputs;
      }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`超时（${Math.round(timeoutMs / 60000)} 分钟）`);
    if (Date.now() - t0 > 30000 && Math.floor((Date.now() - t0) / 30000) !== Math.floor((Date.now() - t0 - 4000) / 30000)) log(`  … 执行中 ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
async function comfyUpload(buf, filename) {
  const form = new FormData();
  form.append('image', new Blob([buf]), filename);
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form });
  const d = await res.json();
  if (!res.ok) throw new Error('upload: ' + JSON.stringify(d).slice(0, 200));
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}
async function comfyDownload(outputs, preferPrefix) {
  for (const [nodeId, o] of Object.entries(outputs)) {
    for (const key of ['images', 'gifs', 'videos', 'audio']) {
      const arr = o[key];
      if (Array.isArray(arr) && arr.length) {
        const f = arr.find((x) => !preferPrefix || (x.filename || '').includes(preferPrefix)) || arr[0];
        const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
        const res = await fetch(`${COMFY}/view?${q}`);
        if (!res.ok) throw new Error(`view ${f.filename}: ${res.status}`);
        return { buf: Buffer.from(await res.arrayBuffer()), filename: f.filename, subfolder: f.subfolder, nodeId };
      }
    }
  }
  throw new Error('输出里没有可下载的产物: ' + JSON.stringify(outputs).slice(0, 300));
}

/* ---------- 图：z_image turbo ---------- */
function zImageGraph(prompt, seed) {
  return {
    _1: { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    _2: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['_1', 0], shift: 3 } },
    _3: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
    _4: { class_type: 'CLIPTextEncode', inputs: { clip: ['_3', 0], text: prompt } },
    _5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['_4', 0] } },
    _6: { class_type: 'EmptySD3LatentImage', inputs: { width: W, height: H, batch_size: 1 } },
    _7: { class_type: 'KSampler', inputs: { model: ['_2', 0], positive: ['_4', 0], negative: ['_5', 0], latent_image: ['_6', 0], seed, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1 } },
    _8: { class_type: 'VAEDecode', inputs: { samples: ['_7', 0], vae: ['_9', 0] } },
    _9: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    _10: { class_type: 'SaveImage', inputs: { images: ['_8', 0], filename_prefix: `shortfilm/${SLUG}` } },
  };
}
const STYLE_PREFIX = '电影感画面，写实风格，冷暖对比的光线，胶片颗粒感。';

/* ---------- 视频：本地 MiniMax H3（首尾帧 → 视频+音频） ---------- */
function h3Graph(prompt, firstImage, lastImage, seed) {
  return {
    _1: { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
    _2: { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['_1', 0], shift_video: 12, shift_audio: 3 } },
    _3: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
    _4: { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['_3', 0], vae: ['_8', 0], prompt, width: W, height: H, length: FRAMES, first_frame: ['_10', 0], last_frame: ['_11', 0] } },
    _5: { class_type: 'CLIPTextEncode', inputs: { clip: ['_3', 0], text: '' } },
    _6: { class_type: 'EmptyMiniMaxH3LatentAV', inputs: { width: W, height: H, length: FRAMES } },
    _7: { class_type: 'KSampler', inputs: { model: ['_2', 0], positive: ['_4', 0], negative: ['_5', 0], latent_image: ['_6', 0], seed, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    _8: { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' } },
    _9: { class_type: 'VAEDecode', inputs: { samples: ['_7', 0], vae: ['_8', 0] } },
    _12: { class_type: 'VAEDecodeAudio', inputs: { samples: ['_7', 0], vae: ['_13', 0] } },
    _13: { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    _10: { class_type: 'LoadImage', inputs: { image: firstImage } },
    _11: { class_type: 'LoadImage', inputs: { image: lastImage } },
    _14: { class_type: 'CreateVideo', inputs: { images: ['_9', 0], fps: FPS, audio: ['_12', 0], codec: 'auto' } },
    _15: { class_type: 'SaveVideo', inputs: { video: ['_14', 0], filename_prefix: `shortfilm/${SLUG}`, format: 'mp4' } },
  };
}

/* ---------- 主流程 ---------- */
async function main() {
  const sb = JSON.parse(await wsRead(`storyboard/${SLUG}-storyboard.json`));
  const ep1 = sb.episodes[0];
  const segments = ep1?.segments ?? [];
  if (!segments.length) throw new Error('storyboard 里没有段');
  log(`第 ${ep1.ep} 集：${segments.length} 段`);

  // ---- 1) 分镜图 ----
  const keyframes = new Map(); // segId → [{k, path}]
  if (MODE === 'kf' || MODE === 'all') {
    for (const seg of segments) {
      const list = [];
      for (let k = 1; k <= seg.cuts.length; k++) {
        const cut = seg.cuts[k - 1];
        const rel = `storyboard/${seg.id}/f${k}.png`;
        const prompt = `${STYLE_PREFIX}${cut.frame}`;
        log(`出图 ${seg.id}/f${k}.png（${cut.size}）: ${cut.frame.slice(0, 60)}…`);
        const pid = await comfyPost(zImageGraph(prompt, 1000 + k));
        const outputs = await comfyWait(pid, 10 * 60000);
        const { buf } = await comfyDownload(outputs);
        await wsWriteBin(rel, buf);
        list.push({ k, path: rel, buf });
      }
      keyframes.set(seg.id, list);
    }
    log('分镜图全部完成');
  }

  // ---- 2) 段视频（H3 首尾帧）----
  if (MODE === 'seg' || MODE === 'all') {
    const only = MODE === 'seg' ? arg('--seg') : null;
    for (const seg of segments) {
      if (only && seg.id !== only) continue;
      // 键帧：确保存在（--seg 模式可能跳过了出图）
      let frames = keyframes.get(seg.id);
      if (!frames) {
        frames = [];
        for (let k = 1; k <= seg.cuts.length; k++) {
          const rel = `storyboard/${seg.id}/f${k}.png`;
          const b64 = JSON.parse(JSON.stringify(await wsReadB64(rel)));
          frames.push({ k, path: rel, buf: Buffer.from(b64, 'base64') });
        }
      }
      const first = frames[0], last = frames[frames.length - 1];
      log(`H3 生成 ${seg.id}（首帧 ${first.path.split('/').pop()} / 末帧 ${last.path.split('/').pop()}，${FRAMES} 帧 ≈ ${(FRAMES / FPS).toFixed(1)}s）`);
      const firstName = await comfyUpload(first.buf, `${seg.id}-f1.png`);
      const lastName = await comfyUpload(last.buf, `${seg.id}-fN.png`);
      const pid = await comfyPost(h3Graph(seg.h3Prompt, firstName, lastName, 424242));
      log(`  prompt_id=${pid}，等待采样（20 步 × ${FRAMES} 帧，首跑会慢）…`);
      const outputs = await comfyWait(pid, 90 * 60000);
      const { buf, filename } = await comfyDownload(outputs, seg.id);
      const rel = `storyboard/${seg.id}/${seg.id}.mp4`;
      await wsWriteBin(rel, buf);
      log(`  ✓ ${rel}（${(buf.length / 1024 / 1024).toFixed(1)} MB，来自 ${filename}）`);
    }
  }

  // ---- 3) ffmpeg 合成 ----
  if (MODE === 'film' || MODE === 'all') {
    const localRoot = path.resolve(process.cwd(), '../shuohao-workspaces', WS_ID, 'storyboard');
    const segIds = segments.map((s) => s.id);
    const parts = [];
    for (const id of segIds) {
      const f = path.join(localRoot, id, `${id}.mp4`);
      if (!fs.existsSync(f)) { log(`跳过 ${id}（无 ${id}.mp4）`); continue; }
      parts.push(f);
    }
    if (!parts.length) throw new Error('没有可合成的段视频');
    const listFile = path.join(localRoot, 'concat.txt');
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const outRel = '短片-灯塔来信.mp4';
    const outAbs = path.join(localRoot, '..', outRel);
    log(`ffmpeg 合成 ${parts.length} 段 → ${outRel}`);
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outAbs], { stdio: ['ignore', 'ignore', 'pipe'] });
    const size = fs.statSync(outAbs).size;
    log(`✓ 成片：${outAbs}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  }
}

async function wsReadB64(p) {
  const res = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS_ID)}/file?path=${encodeURIComponent(p)}`);
  const d = await res.json(); if (!res.ok) throw new Error(d.error);
  if (d.contentB64) return d.contentB64;
  throw new Error('read 不支持二进制（contentB64 缺失）');
}

main().catch((e) => { console.error('[media:FATAL]', e.message); process.exit(1); });
