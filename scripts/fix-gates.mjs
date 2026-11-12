/**
 * 门修复器：对工作区里残留未过质量门的产物跑额外回炉轮次。
 * 用法：node scripts/fix-gates.mjs storyboard
 * 策略：能确定性修的先程序修（promptLang 切 zh、台词装不下的切加秒、对齐首行用技能
 * 导出的 h3AlignmentLine() 逐字替换），剩余的交 GLM 带真实 ✗ 输出回炉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ENV = {};
for (const rel of ['../../pipeline.env', '../pipeline.env', 'E:/DeepSeek Harness/WorkSpace/pipeline.env']) {
  const p = path.resolve(process.cwd(), rel);
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) ENV[m[1]] = m[2];
  }
}
const GLM = { base: ENV.GLM_BASE_URL, key: ENV.GLM_API_KEY, model: ENV.GLM_MODEL || 'glm-5.3-flash' };
const ENGINE = ENV.ENGINE || 'http://127.0.0.1:7791';
const WS = 'shortfilm-demo';
const SLUG = '灯塔来信';
const SKILLS = 'E:/DeepSeek Harness/Skills/shuohao-skills';
const target = process.argv[2] || 'storyboard';
const log = (...a) => console.log('[fix]', ...a);
const die = (m) => { console.error('[fix:FATAL]', m); process.exit(1); };
if (!GLM.key) die('缺 GLM_API_KEY');

const { h3AlignmentLine } = await import(pathToFileURL(`${SKILLS}/skills/novel-storyboard/scripts/novel-storyboard.mjs`));

async function glm(prompt, maxTokens = 16384) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${GLM.base}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GLM.key}` },
        body: JSON.stringify({ model: GLM.model, temperature: 0.2, max_tokens: maxTokens, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
      return JSON.parse(String(data.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim());
    } catch (e) { last = e; log(`  GLM 尝试 ${i + 1}: ${String(e.message).slice(0, 120)}`); }
  }
  throw last;
}
async function eng(op, extra = {}) {
  const res = await fetch(`${ENGINE}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, workspace: WS, slug: SLUG, ...extra }) });
  const d = await res.json(); if (!res.ok) throw new Error(d.error); return d;
}
async function wsRead(p) { const r = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS)}/file?path=${encodeURIComponent(p)}`); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d.content; }
async function wsWrite(p, c) { const r = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS)}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, content: c }) }); if (!r.ok) throw new Error((await r.json()).error); }

const gatesOf = (r) => ((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/).filter((l) => l.trim().startsWith('✗'));
const pass = (r) => r.exitCode === 0;

/** 从违规文本解析「E01-01#2 台词 3.1 秒装不进 3 秒」→ {segId, cutIdx, need} */
function parseDialogueFit(text) {
  const out = [];
  const re = /(E\d+-\d+)#(\d+)\s*台词\s*([\d.]+)\s*秒装不进\s*([\d.]+)\s*秒/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ segId: m[1], cutIdx: Number(m[2]), need: Number(m[3]) });
  return out;
}

/** 确定性预处理：promptLang→zh；装不下的切加秒（段内超 15 就削最长切）；对齐首行逐字替换 */
function preprocess(doc, violationText) {
  doc.promptLang = 'zh';
  const fixes = parseDialogueFit(violationText);
  for (const ep of doc.episodes ?? []) {
    for (const seg of ep.segments ?? []) {
      for (const f of fixes.filter((x) => x.segId === seg.id)) {
        const cut = (seg.cuts ?? [])[f.cutIdx - 1];
        if (cut) cut.seconds = Math.max(cut.seconds, Math.ceil(f.need));
      }
      // 段 ≤15s：超了就削最长的切（不低于 2s），直到合规
      for (let guard = 0; guard < 20; guard++) {
        const sum = (seg.cuts ?? []).reduce((s, c) => s + c.seconds, 0);
        if (sum <= 15) break;
        const longest = [...(seg.cuts ?? [])].sort((a, b) => b.seconds - a.seconds)[0];
        if (!longest || longest.seconds <= 2.5) break;
        longest.seconds -= 1;
      }
      const want = h3AlignmentLine(seg.cuts ?? [], 'zh');
      const body = String(seg.h3Prompt ?? '');
      const nl = body.indexOf('\n');
      seg.h3Prompt = want + (nl >= 0 ? body.slice(nl) : '\n' + body);
    }
  }
  return doc;
}

const CFG = {
  art: {
    read: `art/${SLUG}-art.json`,
    write: `art/${SLUG}-art.json`,
    validate: () => eng('art_validate'),
    // 程序化字段手术（与 novel-art.mjs 的门判据一一对应）：
    // 光照字段名是 lighting（不是 lightings）；道具提示词在 image.prompt / image.sheet；
    // scale 短语必须同时出现在两者；sheet 含 white background；negativePrompt 禁手禁人且全英文
    preprocess: (doc) => {
      const noCjk = (t) => String(t ?? '').replace(/[\u4e00-\u9fff]/g, '').replace(/\s{2,}/g, ' ').trim();
      for (const scene of doc.scenes ?? []) {
        const src = Array.isArray(scene.lightings) ? scene.lightings : (Array.isArray(scene.lighting) ? scene.lighting : []);
        scene.lighting = (src.length ? src : [{ state: '夜戏', prompt: '' }]).map((l) => ({
          state: String(l.state ?? '夜戏'),
          prompt: noCjk(l.prompt) || `Cinematic empty set still, ${l.state || 'moody'} lighting mood, atmospheric, detailed environment, photorealistic, no people, no text`,
        }));
        delete scene.lightings;
        scene.image = scene.image ?? {};
        scene.image.prompt = noCjk(scene.image.prompt) || `${scene.name} empty set, cinematic, photorealistic, no people, no text`;
        scene.image.negativePrompt = noCjk(scene.image.negativePrompt) || 'no people, no humans, no text, no watermark';
      }
      const SCALES = { '手持级': 'handheld scale', '桌面级': 'tabletop scale', '家具级': 'furniture scale' };
      for (const prop of doc.props ?? []) {
        prop.image = prop.image ?? {};
        const scaleEn = SCALES[prop.scale] || 'handheld scale';
        const base = noCjk(prop.image.prompt) || noCjk((prop.states ?? [])[0]?.prompt) || `${prop.name} reference, detailed, photorealistic`;
        const withScale = /handheld scale|tabletop scale|furniture scale/i.test(base) ? base : `${base}, ${scaleEn}`;
        prop.image.prompt = withScale;
        prop.image.sheet = /white background/i.test(prop.image.sheet ?? '')
          ? (/(handheld scale|tabletop scale|furniture scale)/i.test(prop.image.sheet) ? prop.image.sheet : `${prop.image.sheet}, ${scaleEn}`)
          : `${withScale}, main view with bottom and right detail strips, pure white background`;
        const neg = noCjk(prop.image.negativePrompt) || '';
        prop.image.negativePrompt = /hand|finger/i.test(neg) ? neg : `${neg}, no hands, no fingers`.replace(/^,\s*/, '');
        if (!/no people/i.test(prop.image.negativePrompt)) prop.image.negativePrompt += ', no people';
      }
      return doc;
    },
    hint: [
      '字段形状（必须严格如此，违规就是形状不对）：',
      '- 场景与道具的 anchors = [{ "name": "短名", "desc": "一句描述" }]，3–5 个，不许用纯字符串；',
      '- 场景 lightings = [{ "state": "夜戏-塔灯 / 晨雾 / 黄昏…", "prompt": "英文出图提示词" }] 至少 1 个；',
      '- 道具 states = [{ "state": "合上 / 打开 / 破损…", "prompt": "英文出图提示词" }] 至少 1 个；',
      '- 道具 prompt 里必须写尺度参照句（手持级：held in hand；桌面级：on a desk；家具级：furniture-sized）；',
      '- 道具设定图提示词必须纯白背景可抠（pure white background, isolated object, studio product photography）；道具 negativePrompt 禁手（no hands）；场景提示词与 negativePrompt 禁人（no people）；',
      '- 全部出图提示词（prompt/lightings[].prompt/states[].prompt）必须英文；任何提示词里不得出现角色名（用身份描述）。',
    ].join('\n'),
  },
  storyboard: {
    read: `storyboard/${SLUG}-storyboard.json`,
    write: `storyboard/${SLUG}-storyboard.json`,
    validate: () => eng('storyboard_validate'),
    preprocess: (doc, text) => preprocess(doc, text),
    hint: [
      '顶层 promptLang=zh；每段 h3Prompt 首行是程序给定的对齐指令，逐字保留不许改一个字。',
      '每段 h3Prompt 的结构（zh 模式官方格式）：首行对齐指令 → integrated_multimodal_description: → 每镜一行 [Shot k] … → overall_soundscape: … → non_diegetic_music: …（没有写 N/A）。',
      '[Shot k]（k≥2）必须以切点时刻开头（如 At 00:03.000, the camera cuts to…），时刻=前面分镜秒数累计；camera 官方词必须出现在自己段落里。',
      '台词逐字进 <d>[Chinese]…</d>；说话人身份与语气用英文写在 <d> 外；VO 用 says in an off-screen voiceover。',
      'h3Prompt 首行之外整条中文；全文禁角色名（用 the keeper / the old captain 等通用身份，台词除外——<d> 里是原台词）。',
      '段 Σcut.seconds ≤15；每切 2-5 秒。',
    ].join('\n'),
  },
};

const cfg = CFG[target];
if (!cfg) die('参数只支持 storyboard');

let doc = JSON.parse(await wsRead(cfg.read));
let violationText = '';
for (let round = 1; round <= 3; round++) {
  log(`第 ${round} 轮校验 ${target}…`);
  const r = await cfg.validate();
  if (pass(r)) { log('✓ 质量门全过！'); process.exit(0); }
  violationText = (r.stdout || '') + '\n' + (r.stderr || '');
  const bad = gatesOf(r);
  log(`✗ ${bad.length} 行违规：\n${bad.slice(0, 6).map((l) => '   ' + l.trim().slice(0, 150)).join('\n')}`);
  if (round === 3) { log('3 轮未清零，保留现状。'); process.exit(2); }
  if (cfg.preprocess) {
    doc = cfg.preprocess(doc, violationText);
    await wsWrite(cfg.write, JSON.stringify(doc, null, 2));
    const r2 = await cfg.validate();
    if (pass(r2)) { log('✓ 程序化预处理后已全过（无需 GLM）！'); process.exit(0); }
    log(`  程序预处理后仍有残留，交 GLM 带原文回炉…`);
  }
  const fixed = await glm([
    `修复这份 storyboard JSON 使其通过确定性质量门。`,
    '硬规则：' + cfg.hint,
    '【当前 JSON】', JSON.stringify(doc),
    '【validate 原始输出——✗ 每一行都必须解决】', violationText,
    '只输出修复后的完整 JSON（结构不变，h3Prompt 首行保持程序给定文案逐字不动）。',
  ].join('\n'));
  doc = fixed;
  // GLM 输出后再做一次确定性矫正（若该阶段有预处理）
  if (cfg.preprocess) doc = cfg.preprocess(doc, '');
  await wsWrite(cfg.write, JSON.stringify(doc, null, 2));
}
