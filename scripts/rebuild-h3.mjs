/**
 * 用技能自身导出的常量/函数，确定性重建每段的 h3Prompt（zh 模式），
 * 然后跑 storyboard_validate，全过就刷新投产包 export 与报告。
 * 用法：node scripts/rebuild-h3.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ENGINE = 'http://127.0.0.1:7791';
const WS = 'shortfilm-demo';
const SLUG = '灯塔来信';
const SKILLS = 'E:/DeepSeek Harness/Skills/shuohao-skills';
const sbMod = await import(pathToFileURL(`${SKILLS}/skills/novel-storyboard/scripts/novel-storyboard.mjs`));
const { h3AlignmentLine, h3CutTime, cutStarts, CAMERA_MOVES, H3_TOKENS } = sbMod;
const tk = H3_TOKENS.zh;
const log = (...a) => console.log('[rebuild]', ...a);

async function wsRead(p) { const r = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS)}/file?path=${encodeURIComponent(p)}`); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d.content; }
async function wsWrite(p, c) { const r = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS)}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, content: c }) }); if (!r.ok) throw new Error((await r.json()).error); }
async function eng(op, extra = {}) {
  const res = await fetch(`${ENGINE}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, workspace: WS, slug: SLUG, ...extra }) });
  const d = await res.json(); if (!res.ok) throw new Error(d.error); return d;
}

// 通用身份表（h3Prompt 正文与 <d> 外的说话人描述禁角色名）
const IDENTITY = { C01: 'The keeper', C02: 'The old captain' };
const identityOf = (id) => IDENTITY[id] || 'A figure';

const sb = JSON.parse(await wsRead(`storyboard/${SLUG}-storyboard.json`));
const script = JSON.parse(await wsRead(`script/${SLUG}-script.json`));

for (const ep of sb.episodes ?? []) {
  const sEp = (script.episodes ?? []).find((x) => x.ep === ep.ep);
  for (const seg of ep.segments ?? []) {
    const cuts = seg.cuts ?? [];
    const scene = sEp?.scenes?.[seg.sceneIndex - 1];
    const starts = cutStarts(cuts);
    const lines = [h3AlignmentLine(cuts, 'zh'), tk.fields[0]];
    cuts.forEach((cut, ci) => {
      const k = ci + 1;
      const head = k === 1 ? `${tk.shot(1)} ` : `${tk.cutMark(k, h3CutTime(starts[k - 1]))} `;
      const cam = CAMERA_MOVES[cut.camera] || cut.camera;
      let text = `${head}${cam}。${cut.shot ?? ''}`;
      // 该切认领节拍里的台词：逐字进 <d>[Chinese]…</d>，说话人身份英文写在 <d> 外
      const [a, b] = Array.isArray(cut.beats) ? cut.beats : [0, -1];
      const flow = scene?.flow ?? [];
      for (let bi = a; bi <= b; bi++) {
        const beat = flow[bi - 1];
        if (!beat || !beat.line) continue;
        if (beat.speaker === 'VO') {
          text += ` ${identityOf('C01')} says in an off-screen voiceover：<d>[Chinese]${beat.line}</d>`;
        } else {
          text += ` ${identityOf(beat.speaker)} says in Chinese，${beat.delivery ?? ''}：<d>[Chinese]${beat.line}</d>`;
        }
      }
      lines.push(text.trim());
    });
    lines.push(`${tk.fields[1]} ${String(seg.soundscape ?? '').trim()}`);
    lines.push(`${tk.fields[2]} ${String(seg.music ?? '').trim() || 'N/A'}`);
    seg.h3Prompt = lines.join('\n');
    // 结构自检（与 validate 同口径的本地预检）
    const want = h3AlignmentLine(cuts, 'zh');
    if (!seg.h3Prompt.startsWith(want)) log(`  ⚠ ${seg.id} 首行自检失败`);
  }
}

await wsWrite(`storyboard/${SLUG}-storyboard.json`, JSON.stringify(sb, null, 2));
log('h3Prompt 已按 zh 模式确定性重建');

const r = await eng('storyboard_validate');
log(`validate exit=${r.exitCode}`);
if (r.exitCode !== 0) {
  console.log(((r.stderr || '') + (r.stdout || '')).split('\n').filter((l) => l.trim()).slice(0, 8).join('\n'));
  process.exit(2);
}
log('✓ 分镜质量门全过——刷新投产包与报告…');
const ex = await eng('storyboard_export', { protocol: 'h3' });
log((ex.stdout || ex.stderr).trim().slice(0, 200));
const rr = await eng('storyboard_render', { lang: 'zh' });
log('报告：', rr.output ?? '(失败)');
