/**
 * shuohao-engine —— BigBanana 的本地伴随服务（三号伴随服务，与 media-proxy / new-api-proxy 同模式）。
 *
 * 职责：把本机 shuohao-skills 仓库的六阶段 Node CLI 作为确定性引擎暴露给前端。
 * 创作仍然由前端驱动（BigBanana 自己的模型配置），这里只做技能脚本做得了的事：
 *   chunk / validate(--stage) / checkup / assets / render / blocking / export / seed / slug / stats
 * 质量门的输出（✓/✗ + 详情）原样透传，由前端解析展示——校验口径零偏差。
 *
 * 安全边界：
 *   - 只绑定 127.0.0.1
 *   - workspace id / 文件路径严格 containment，不进 shell（spawn 参数数组）
 *   - 技能 id 与操作（op）走服务端白名单，前端不能传任意 argv
 *
 * 启动：npm run shuohao
 *   env: SHUOHAO_SKILLS_DIR（shuohao-skills 仓库根）
 *        SHUOHAO_WORKSPACES_DIR（项目工作区根，默认 <repo>/shuohao-workspaces）
 *        SHUOHAO_PORT（默认 7791）
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.SHUOHAO_PORT || process.env.PORT || '7791', 10);
const HOST = process.env.SHUOHAO_HOST || '127.0.0.1';
const CORS_ORIGIN = process.env.SHUOHAO_CORS_ORIGIN || '*';
const RUN_TIMEOUT_MS = Number.parseInt(process.env.SHUOHAO_TIMEOUT_MS || '240000', 10);

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = process.env.SHUOHAO_SKILLS_DIR || 'E:\\DeepSeek Harness\\Skills\\shuohao-skills';
const WORKSPACES_DIR = process.env.SHUOHAO_WORKSPACES_DIR || path.join(REPO_ROOT, 'shuohao-workspaces');

/** 六阶段技能注册表：阶段 id → 技能目录名 + 脚本文件名（目录名带 novel- 前缀，别混用） */
const SKILL_SCRIPTS = {
  outline: { dir: 'novel-outline', file: 'novel-outline.mjs' },
  characters: { dir: 'novel-characters', file: 'novel-characters.mjs' },
  art: { dir: 'novel-art', file: 'novel-art.mjs' },
  script: { dir: 'novel-script', file: 'novel-script.mjs' },
  staging: { dir: 'novel-staging', file: 'novel-staging.mjs' },
  storyboard: { dir: 'novel-storyboard', file: 'novel-storyboard.mjs' },
};

const STAGE_DIRS = ['outline', 'characters', 'art', 'script', 'staging', 'storyboard', 'docs'];

/** 前端可用的语义操作 →（技能、CLI 命令）。路径类载荷一律在服务端拼装。 */
const OPS = {
  slug: { skill: 'script', cmd: 'slug', args: (p) => [String(p.name || '')] },
  outline_chunk: { skill: 'outline', cmd: 'chunk', args: (p, ws) => [ws.abs(p.novel || 'novel.txt'), ws.abs(p.workdir || 'outline/wk'), ...(p.perVolume ? ['--per-volume', String(p.perVolume)] : [])] },
  outline_validate: { skill: 'outline', cmd: 'validate', args: (p, ws) => [ws.json('outline'), '--stage', pick(p.stage, ['skeleton', 'beats', 'full'], 'full')] },
  outline_checkup: { skill: 'outline', cmd: 'checkup', args: (_p, ws) => [ws.json('outline')] },
  outline_render: { skill: 'outline', cmd: 'render', args: (p, ws) => [ws.json('outline'), '--html', '--lang', pick(p.lang, ['zh', 'en'], 'zh')] },
  outline_assets: { skill: 'outline', cmd: 'assets', args: (_p, ws) => [ws.json('outline')] },

  characters_seed: { skill: 'characters', cmd: 'seed', args: (_p, ws) => [ws.json('outline')] },
  characters_chunk: { skill: 'characters', cmd: 'chunk', args: (p, ws) => [ws.abs(p.novel || 'novel.txt'), ws.abs(p.workdir || 'characters/wk')] },
  characters_merge: { skill: 'characters', cmd: 'merge', args: (p, ws) => [ws.abs(p.workdir || 'characters/wk'), ...(p.apply ? ['--apply', ws.abs(p.apply)] : [])] },
  characters_assemble: { skill: 'characters', cmd: 'assemble', args: (p, ws) => [ws.abs(p.workdir || 'characters/wk'), '--source', String(p.source || ''), ...(p.summary ? ['--summary', ws.abs(p.summary)] : []), '--out', ws.json('characters')] },
  characters_validate: { skill: 'characters', cmd: 'validate', args: (_p, ws) => [ws.json('characters'), ws.abs('novel.txt')] },
  characters_render: { skill: 'characters', cmd: 'render', args: (p, ws) => [ws.json('characters'), '--html', '--source', String(p.source || ''), '--lang', pick(p.lang, ['zh', 'en'], 'zh'), '--images', ws.abs('characters/images')] },

  art_seed: { skill: 'art', cmd: 'seed', args: (_p, ws) => [ws.json('outline')] },
  art_validate: { skill: 'art', cmd: 'validate', args: (_p, ws) => [ws.json('art'), ...ifExists(ws, 'characters', '--cast')] },
  art_checkup: { skill: 'art', cmd: 'checkup', args: (_p, ws) => [ws.json('art'), ...ifExists(ws, 'characters', '--cast')] },
  art_render: { skill: 'art', cmd: 'render', args: (p, ws) => [ws.json('art'), '--html', '--lang', pick(p.lang, ['zh', 'en'], 'zh'), '--images', ws.abs('art/images')] },

  script_seed: { skill: 'script', cmd: 'seed', args: (p, ws) => [ws.json('outline'), '--eps', String(p.eps || '1-3')] },
  script_validate: { skill: 'script', cmd: 'validate', args: (_p, ws) => [ws.json('script'), ...ifExists(ws, 'outline', '--outline'), ...ifExists(ws, 'art', '--art')] },
  script_checkup: { skill: 'script', cmd: 'checkup', args: (_p, ws) => [ws.json('script'), ...ifExists(ws, 'outline', '--outline'), ...ifExists(ws, 'art', '--art')] },
  script_render: { skill: 'script', cmd: 'render', args: (p, ws) => [ws.json('script'), '--html', '--lang', pick(p.lang, ['zh', 'en'], 'zh'), ...ifExists(ws, 'outline', '--outline'), ...ifExists(ws, 'art', '--art'), ...ifExists(ws, 'characters', '--cast')] },

  staging_seed: { skill: 'staging', cmd: 'seed', args: (p, ws) => [ws.abs(ws.json('script')), ...ifExists(ws, 'art', '--art'), ...ifExists(ws, 'outline', '--outline'), ...(p.eps ? ['--eps', String(p.eps)] : [])] },
  staging_validate: { skill: 'staging', cmd: 'validate', args: (_p, ws) => [ws.abs('staging/staging.json'), ...ifExists(ws, 'script', '--script'), ...ifExists(ws, 'art', '--art')] },
  staging_checkup: { skill: 'staging', cmd: 'checkup', args: (_p, ws) => [ws.abs('staging/staging.json'), ...ifExists(ws, 'script', '--script'), ...ifExists(ws, 'art', '--art')] },
  staging_render: { skill: 'staging', cmd: 'render', args: (p, ws) => [ws.abs('staging/staging.json'), '--html', '--lang', pick(p.lang, ['zh', 'en'], 'zh'), '--images', ws.abs('staging/images')] },
  staging_md: { skill: 'staging', cmd: 'render', args: (p, ws) => [ws.abs('staging/staging.json'), '--md', '--lang', pick(p.lang, ['zh', 'en'], 'zh')] },
  staging_blocking: { skill: 'staging', cmd: 'blocking', args: (p, ws) => [ws.abs('staging/staging.json'), '--lang', pick(p.lang, ['zh', 'en'], 'zh')] },

  storyboard_seed: { skill: 'storyboard', cmd: 'seed', args: (p, ws) => [ws.abs(ws.json('script')), '--eps', String(p.eps || '1'), '--aspect', pick(p.aspect, ['16:9', '9:16'], '16:9')] },
  storyboard_validate: { skill: 'storyboard', cmd: 'validate', args: (p, ws) => [ws.json('storyboard'), ...ifExists(ws, 'script', '--script'), ...ifExists(ws, 'outline', '--outline'), ...ifExists(ws, 'characters', '--cast'), ...(p.shots ? ['--shots', ws.abs(p.shots)] : [])] },
  storyboard_checkup: { skill: 'storyboard', cmd: 'checkup', args: (_p, ws) => [ws.json('storyboard'), ...ifExists(ws, 'script', '--script')] },
  storyboard_render: { skill: 'storyboard', cmd: 'render', args: (p, ws) => [ws.json('storyboard'), ...ifExists(ws, 'script', '--script'), '--html', '--lang', pick(p.lang, ['zh', 'en'], 'zh'), ...ifExists(ws, 'outline', '--outline'), ...ifExists(ws, 'art', '--art')] },
  storyboard_export: { skill: 'storyboard', cmd: 'export', args: (p, ws) => [ws.json('storyboard'), ...ifExists(ws, 'script', '--script'), '--protocol', pick(p.protocol, ['h3', 'seedance'], 'h3'), '--out', ws.abs('storyboard')] },
  storyboard_stats: { skill: 'storyboard', cmd: 'stats', args: () => [] },
};

/** 各阶段主产物的规范文件名（<slug>-<stage>.json；staging 固定名） */
function artifactRel(stage, slug) {
  switch (stage) {
    case 'outline': return `outline/${slug}-outline.json`;
    case 'characters': return `characters/${slug}-cast.json`;
    case 'art': return `art/${slug}-art.json`;
    case 'script': return `script/${slug}-script.json`;
    case 'staging': return 'staging/staging.json';
    case 'storyboard': return `storyboard/${slug}-storyboard.json`;
    default: throw new Error(`未知阶段 ${stage}`);
  }
}

/** 渲染报告的规范文件名（与仓库工作目录约定一致：characters 用 cast 名） */
function reportRel(stage, slug) {
  switch (stage) {
    case 'outline': return `outline/${slug}-outline-report.html`;
    case 'characters': return `characters/${slug}-cast-report.html`;
    case 'art': return `art/${slug}-art-report.html`;
    case 'script': return `script/${slug}-script-report.html`;
    case 'staging': return 'staging/staging-report.html';
    case 'storyboard': return `storyboard/${slug}-storyboard-report.html`;
    default: throw new Error(`未知阶段 ${stage}`);
  }
}

const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);

function safeWorkspaceId(id) {
  const s = String(id || '').trim();
  if (!s || s.length > 120 || !/^[A-Za-z0-9_\-\u4e00-\u9fa5（）()]+$/.test(s)) {
    throw new Error(`非法 workspace id：${s}`);
  }
  return s;
}

function safeRelPath(root, rel) {
  const abs = path.resolve(root, String(rel || ''));
  if (!abs.startsWith(path.resolve(root))) throw new Error(`路径越界：${rel}`);
  return abs;
}

function workspaceCtx(id, slug) {
  const root = path.join(WORKSPACES_DIR, safeWorkspaceId(id));
  return {
    root,
    // json(stage)：该阶段主产物的绝对路径
    json: (stage) => safeRelPath(root, artifactRel(stage, slug)),
    abs: (rel) => safeRelPath(root, rel),
  };
}

/** 上游产物存在就带上对应 flag（与技能 USAGE 的口径一致） */
function ifExists(ws, stage, flag) {
  const p = ws.json(stage);
  return fs.existsSync(p) ? [flag, p] : [];
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function writeJson(res, statusCode, payload) {
  setCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 运行技能脚本：参数数组直传，不进 shell；stdout 可选落盘（render 报告） */
function runSkill(stage, cmd, argv, { cwd, toFile } = {}) {
  const { dir, file } = SKILL_SCRIPTS[stage];
  const script = path.join(SKILLS_DIR, 'skills', dir, 'scripts', file);
  if (!fs.existsSync(script)) throw new Error(`技能脚本不存在：${script}（检查 SHUOHAO_SKILLS_DIR）`);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, cmd, ...argv], { cwd: cwd || undefined, windowsHide: true });
    let out = '';
    let err = '';
    let outStream = null;
    if (toFile) {
      fs.mkdirSync(path.dirname(toFile), { recursive: true });
      outStream = fs.createWriteStream(toFile, 'utf8');
      child.stdout.pipe(outStream);
      child.stdout.resume();
    } else {
      child.stdout.on('data', (d) => { out += d; if (out.length > 8_000_000) out = out.slice(-4_000_000); });
    }
    child.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    const timer = setTimeout(() => { try { child.kill('killed'); } catch { /* 已退出 */ } }, RUN_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout: out, stderr: `${err}${e.message}`, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (outStream) outStream.end();
      resolve({ exitCode: code, stdout: toFile ? '' : out, stderr: err, toFile: toFile || null, ms: Date.now() - started });
    });
  });
}

async function handleRun(payload, res) {
  const op = OPS[payload?.op];
  if (!op) { writeJson(res, 400, { error: `未知操作：${payload?.op}（可用：${Object.keys(OPS).join(', ')}）` }); return; }
  const needsWorkspace = payload.op !== 'slug';
  const id = safeWorkspaceId(payload.workspace);
  const slug = safeWorkspaceId(payload.slug || 'project');
  const ws = workspaceCtx(id, slug);
  if (needsWorkspace && !fs.existsSync(ws.root)) { writeJson(res, 404, { error: `工作区不存在：${id}（先 POST /api/workspace 创建）` }); return; }

  // 渲染类操作：stdout 流式写进规范产物路径（md 导出走 staging/staging.md）
  const RENDER_TARGETS = {
    outline_render: () => reportRel('outline', slug),
    characters_render: () => reportRel('characters', slug),
    art_render: () => reportRel('art', slug),
    script_render: () => reportRel('script', slug),
    storyboard_render: () => reportRel('storyboard', slug),
    staging_render: () => reportRel('staging', slug),
    staging_md: () => 'staging/staging.md',
  };
  const targetFn = RENDER_TARGETS[payload.op];
  const toFile = targetFn ? safeRelPath(ws.root, targetFn()) : null;
  // blocking / assets / seed 的 stdout 由前端直接消费；md 落盘由 toFile 承担

  const argv = op.args(payload || {}, ws);
  const result = await runSkill(op.skill, op.cmd, argv, { cwd: ws.root, toFile });
  const output = toFile && fs.existsSync(toFile) ? path.relative(ws.root, toFile) : null;
  writeJson(res, 200, { ...result, output, op: payload.op, argvHint: argv.map((a) => (String(a).startsWith(ws.root) ? `.${String(a).slice(ws.root.length)}` : a)) });
}

async function handleWorkspaceCreate(payload, res) {
  const id = safeWorkspaceId(payload?.id);
  const root = path.join(WORKSPACES_DIR, id);
  for (const d of STAGE_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
  writeJson(res, 200, { ok: true, id, root: WORKSPACES_DIR, dirs: STAGE_DIRS });
}

async function handleFileWrite(req, res, id) {
  const body = JSON.parse(await readBody(req));
  const root = path.join(WORKSPACES_DIR, safeWorkspaceId(id));
  const abs = safeRelPath(root, body.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const content = String(body.content ?? '').replace(/^\uFEFF/, '');
  fs.writeFileSync(abs, content, 'utf8'); // 无 BOM：技能脚本的 JSON.parse 不吃 BOM
  writeJson(res, 200, { ok: true, path: body.path, bytes: Buffer.byteLength(content, 'utf8') });
}

async function handleFileRead(res, id, rel) {
  const root = path.join(WORKSPACES_DIR, safeWorkspaceId(id));
  const abs = safeRelPath(root, rel);
  if (!fs.existsSync(abs)) { writeJson(res, 404, { error: '文件不存在' }); return; }
  const st = fs.statSync(abs);
  if (st.size > 4 * 1024 * 1024) { writeJson(res, 413, { error: '文件过大，请用 /workspace 静态入口' }); return; }
  writeJson(res, 200, { path: rel, content: await fsp.readFile(abs, 'utf8'), size: st.size });
}

async function handleFileList(res, id) {
  const root = path.join(WORKSPACES_DIR, safeWorkspaceId(id));
  if (!fs.existsSync(root)) { writeJson(res, 404, { error: '工作区不存在' }); return; }
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else out.push({ path: `${prefix}${name}`, size: st.size, mtime: st.mtime.toISOString() });
    }
  };
  walk(root, '');
  writeJson(res, 200, { files: out });
}

/** /workspace/:id/... 静态服务：报告 HTML（含相对路径引用的分镜图）直接在浏览器里打开 */
function serveWorkspaceFile(req, res, pathname) {
  const m = pathname.match(/^\/workspace\/([^/]+)\/(.+)$/);
  if (!m) { writeJson(res, 404, { error: 'Not found.' }); return; }
  let abs;
  try {
    const root = path.join(WORKSPACES_DIR, safeWorkspaceId(decodeURIComponent(m[1])));
    abs = safeRelPath(root, decodeURIComponent(m[2]));
  } catch (e) { writeJson(res, 400, { error: String(e.message) }); return; }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { writeJson(res, 404, { error: 'Not found.' }); return; }
  const ext = path.extname(abs).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
  setCors(res);
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  fs.createReadStream(abs).pipe(res);
}

function statusPayload() {
  const skills = {};
  for (const [id, file] of Object.entries(SKILL_SCRIPTS)) {
    skills[id] = fs.existsSync(path.join(SKILLS_DIR, 'skills', id, 'scripts', file));
  }
  return {
    ok: true,
    service: 'shuohao-engine',
    node: process.version,
    skillsDir: SKILLS_DIR,
    skillsDirOk: fs.existsSync(path.join(SKILLS_DIR, 'skills', 'novel-outline', 'scripts', 'novel-outline.mjs')),
    workspacesDir: WORKSPACES_DIR,
    skills,
    ops: Object.keys(OPS),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'OPTIONS') { setCors(res); res.statusCode = 204; res.end(); return; }

    if (req.method === 'GET' && pathname === '/healthz') { writeJson(res, 200, statusPayload()); return; }
    if (req.method === 'GET' && pathname === '/api/status') { writeJson(res, 200, statusPayload()); return; }

    if (pathname.startsWith('/workspace/')) { serveWorkspaceFile(req, res, pathname); return; }

    if (req.method === 'POST' && pathname === '/api/run') {
      const body = JSON.parse(await readBody(req));
      await handleRun(body, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/workspace') {
      const body = JSON.parse(await readBody(req));
      await handleWorkspaceCreate(body, res);
      return;
    }
    let m;
    if (req.method === 'PUT' && (m = pathname.match(/^\/api\/workspace\/([^/]+)\/file$/))) {
      await handleFileWrite(req, res, decodeURIComponent(m[1]));
      return;
    }
    if (req.method === 'GET' && (m = pathname.match(/^\/api\/workspace\/([^/]+)\/file$/))) {
      await handleFileRead(res, decodeURIComponent(m[1]), requestUrl.searchParams.get('path') || '');
      return;
    }
    if (req.method === 'GET' && (m = pathname.match(/^\/api\/workspace\/([^/]+)\/files$/))) {
      await handleFileList(res, decodeURIComponent(m[1]));
      return;
    }

    writeJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    writeJson(res, 500, { error: String((error && error.message) || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[shuohao-engine] listening on http://${HOST}:${PORT}`);
  console.log(`[shuohao-engine] skills dir: ${SKILLS_DIR}`);
  console.log(`[shuohao-engine] workspaces dir: ${WORKSPACES_DIR}`);
});
