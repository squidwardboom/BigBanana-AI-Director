/**
 * E2E 全流程驱动：小说 → 大纲(拍板) → 分集 → 角色 → 美术 → 剧本 → 站位 → 分镜 → H3 投产包
 *
 * 创作：GLM（OpenAI 兼容端点，env 里配）；确定性：shuohao-engine（真实技能 CLI）。
 * 用法：
 *   node scripts/e2e-shortfilm.mjs --until outline
 *   node scripts/e2e-shortfilm.mjs --until film   （全链）
 * 必需 env：GLM_API_KEY（或 pipeline.env 文件）
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---------- env ---------- */
const envFile = path.resolve(process.cwd(), '../../pipeline.env');
const ENV = {};
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) ENV[m[1]] = m[2];
}
for (const [k, v] of Object.entries(process.env)) if (/^(GLM_|ENGINE|COMFY)/.test(k)) ENV[k] = v;
const GLM = {
  base: ENV.GLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4',
  key: ENV.GLM_API_KEY || '',
  model: ENV.GLM_MODEL || 'glm-5.3-flash',
};
const ENGINE = ENV.ENGINE || 'http://127.0.0.1:7791';
const WS_ID = process.argv.includes('--ws') ? process.argv[process.argv.indexOf('--ws') + 1] : 'shortfilm-demo';
const UNTIL = (process.argv.includes('--until') ? process.argv[process.argv.indexOf('--until') + 1] : 'film').toLowerCase();
const STAGES = ['outline', 'characters', 'art', 'script', 'staging', 'storyboard', 'export', 'film'];
const SLUG = '灯塔来信';

const log = (...a) => console.log('[e2e]', ...a);
const die = (m) => { console.error('[e2e:FATAL]', m); process.exit(1); };
const idx = (s) => STAGES.indexOf(s);
if (!GLM.key) die('缺 GLM_API_KEY（pipeline.env 或环境变量）');

/* ---------- GLM ---------- */
async function glmOnce(prompt, { temperature = 0.5, maxTokens = 16384, json = true, noThink = true } = {}) {
  const body = {
    model: GLM.model,
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (json) body.response_format = { type: 'json_object' };
  if (noThink) body.thinking = { type: 'disabled' };
  const res = await fetch(`${GLM.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GLM.key}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GLM ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const choice = data.choices?.[0];
  let raw = String(choice?.message?.content ?? '');
  raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const text = raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  if (json) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`JSON 解析失败（finish=${choice?.finish_reason}，len=${text.length}）：${String(e.message).slice(0, 120)}`);
    }
  }
  return text;
}
async function glm(prompt, opts = {}) {
  const attempts = [
    { ...opts, noThink: true },
    { ...opts, maxTokens: Math.max(opts.maxTokens ?? 16384, 16384), noThink: true },
    { ...opts, maxTokens: 24576, noThink: false },
  ];
  let last;
  for (let i = 0; i < attempts.length; i++) {
    try { return await glmOnce(prompt, attempts[i]); }
    catch (e) { last = e; log(`  GLM 尝试 ${i + 1} 失败：${String(e.message).slice(0, 140)}`); }
  }
  throw last;
}
const glmRetry = async (prompt, opts, n = 2) => {
  let last;
  for (let i = 0; i <= n; i++) { try { return await glm(prompt, opts); } catch (e) { last = e; log(`  GLM 重试 ${i + 1}: ${String(e.message).slice(0, 120)}`); } }
  throw last;
};

/* ---------- 引擎 ---------- */
async function eng(op, extra = {}) {
  const res = await fetch(`${ENGINE}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, workspace: WS_ID, slug: SLUG, ...extra }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`引擎 ${op}: ${data.error}`);
  return data;
}
async function wsCreate() { await fetch(`${ENGINE}/api/workspace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: WS_ID }) }); }
async function wsWrite(p, content) {
  const res = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS_ID)}/file`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, content }),
  });
  if (!res.ok) throw new Error(`写文件 ${p}: ${(await res.json()).error}`);
}
async function wsRead(p) {
  const res = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS_ID)}/file?path=${encodeURIComponent(p)}`);
  const d = await res.json(); if (!res.ok) throw new Error(d.error); return d.content;
}
async function wsList() {
  const res = await fetch(`${ENGINE}/api/workspace/${encodeURIComponent(WS_ID)}/files`);
  const d = await res.json(); if (!res.ok) throw new Error(d.error); return d.files;
}
function parseGates(stdout = '') {
  const gates = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const m = raw.trim().match(/^([✓✗])\s*(.+)$/); if (!m) continue;
    if (m[2] === '全部通过' || /^\d+\s*项未过$/.test(m[2])) continue;
    const sep = m[2].indexOf(' — ');
    gates.push({ ok: m[1] === '✓', label: sep >= 0 ? m[2].slice(0, sep).trim() : m[2].trim(), detail: sep >= 0 ? m[2].slice(sep + 3).trim() : '' });
  }
  return gates;
}
/** 引擎校验 + 原样 ✗ 回炉循环。validate(op, buildPrompt) */
async function gateLoop({ op, payload, runFill, label, maxRounds = 2, stage }) {
  let result = null, gates = [];
  for (let round = 0; round <= maxRounds; round++) {
    log(`  ${label} 校验（第 ${round + 1} 次）：${op}${stage ? ' --stage ' + stage : ''}`);
    result = await eng(op, { ...payload, ...(stage ? { stage } : {}) });
    gates = parseGates(result.stdout);
    const pass = result.exitCode === 0 && (gates.length === 0 || gates.every((g) => g.ok));
    if (pass) return { result, gates };
    const failText = result.stdout + (result.stderr ? `\n${result.stderr}` : '');
    log(`  ✗ 未过（exit=${result.exitCode}），回炉：${failText.split('\n').filter((l) => l.includes('✗')).slice(0, 4).join(' | ')}`);
    if (round === maxRounds) break;
    const patched = await runFill(failText);
    await wsWrite(payload.filePath, JSON.stringify(patched, null, 2));
  }
  return { result, gates, failed: true };
}

/* ---------- 小说 ---------- */
const NOVEL = `灯塔来信

第一回 塔灯熄了
守塔人林岸在北屿灯塔守了十一年。风暴夜，塔灯忽然熄灭，他在楼梯口捡到一封没有署名的信，信里只写着一句话：明晚十点，旧栈桥，还你三十年前的东西。落款是一个褪色的船锚印章。

第二回 栈桥赴约
第二天夜里，林岸握着信走上旧栈桥。潮水拍打木桩，雾里亮起一盏马灯——是三十年前和他父亲一起失踪的船长老周。老周交还一枚黄铜罗盘：当年风暴夜，是林岸的父亲把最后一号救生圈让给了少年老周。罗盘背面刻着：北屿林，永远向北。林岸终于明白，塔灯不是风弄灭的，是老周特意熄的——他要让守塔人下楼来，接回这份迟到三十年的道谢。`

const PARAMS = { episodes: 2, minutesPerEpisode: 1, genre: '治愈悬疑', adaptMode: '借壳', preferences: ['罗盘', '栈桥夜雾'] };

/* ---------- 主流程 ---------- */
async function main() {
  const done = JSON.parse(fs.existsSync(`progress-${WS_ID}.json`) ? fs.readFileSync(`progress-${WS_ID}.json`, 'utf8') : '{}');
  const mark = (s, extra = {}) => { done[s] = { at: Date.now(), ...extra }; fs.writeFileSync(`progress-${WS_ID}.json`, JSON.stringify(done, null, 2)); };
  const reached = (s) => done[s];

  await wsCreate();
  if (!reached('novel')) { await wsWrite('novel.txt', NOVEL); mark('novel'); }
  log('工作区就绪：', WS_ID);

  /* ============ outline ============ */
  if (idx(UNTIL) >= idx('outline') && !reached('outline_full')) {
    log('== 大纲 ==');
    const ch = await eng('outline_chunk', { novel: 'novel.txt', workdir: 'outline/wk' });
    if (ch.exitCode !== 0) die('分卷失败: ' + ch.stderr);
    const volFiles = (await wsList()).filter((f) => /^outline\/wk\/vol-\d+\.txt$/.test(f.path)).map((f) => f.path).sort();
    const volumes = [];
    for (const p of volFiles) volumes.push(await wsRead(p));
    log(`  分卷 ${volumes.length}`);

    log('  分卷摘要…');
    const summaries = [];
    for (let i = 0; i < volumes.length; i++) {
      summaries.push(await glmRetry([
        '为一部 AI 短剧的改编大纲做素材。输出改编向中间摘要（≤400字纯文本）：出场人物与关系、关键事件因果链、有爽点潜力的场面、可砍支线、高频场景。',
        `【卷 ${i + 1}】`, volumes[i],
      ].join('\n'), { json: false, temperature: 0.3, maxTokens: 2048 }));
    }

    log('  骨架快版…');
    const skPrompt = [
      '你是短剧改编总编剧。基于素材摘要产出改编骨架 JSON（只出骨架，不写分集）。',
      `改编参数：总集数 ${PARAMS.episodes}；单集约 ${PARAMS.minutesPerEpisode} 分钟；题材：${PARAMS.genre}；改编方式：${PARAMS.adaptMode}。`,
      `用户点名要保：${PARAMS.preferences.join('、')}。`,
      '硬规则：主角组(lead)1-5人 arc必填；配角(support)≤10；功能性(functional)≤10 占脸不占名；主场景(primary=true)≤5；道具≤8 function必填；',
      `爽点：相邻集号间隔≤3、首爽点≤第3集、末爽点距最后一集<3、至少一个major且最早major不在最后一集；episode取1..${PARAMS.episodes}。`,
      'keep至少1条带原文逐字evidence；借壳时cut非空；from记录改动来源，纯原创写["原创"]。',
      '只输出JSON：{"adaptation":{"core","keep":[{"what","why","evidence"}],"cut":[...],"merge":[...],"risks":[{"what","plan"}],"cutNote","mergeNote"},"characters":[{"id":"C01","name","role","tier","arc","from":[]}],"scenes":[{"id":"S01","name","primary":true,"reusePlan"}],"props":[{"id":"P01","name","function","beatIds":[]}],"beats":[{"id":"B01","type","weight":"major|minor","episode":1,"setup","payoff"}]}',
      '【素材摘要】', summaries.join('\n\n'),
    ].join('\n');
    const sk = await glmRetry(skPrompt, { temperature: 0.4 });
    const outline = { source: SLUG, lang: 'zh', params: PARAMS, adaptation: sk.adaptation, characters: sk.characters, scenes: sk.scenes, props: sk.props ?? [], beats: sk.beats, episodes: [] };
    await wsWrite(`outline/${SLUG}-outline.json`, JSON.stringify(outline, null, 2));

    const g1 = await gateLoop({
      op: 'outline_validate', payload: { filePath: `outline/${SLUG}-outline.json` }, stage: 'skeleton', label: '骨架',
      runFill: async (gateText) => {
        const fixed = await glmRetry([
          skPrompt, '【你上一版骨架 JSON】', JSON.stringify({ adaptation: outline.adaptation, characters: outline.characters, scenes: outline.scenes, props: outline.props, beats: outline.beats }),
          '【validate --stage skeleton 原始输出，✗ 必须逐条修复】', gateText,
          '只输出修复后的完整骨架 JSON（结构同前）。',
        ].join('\n'), { temperature: 0.2 });
        return { source: SLUG, lang: 'zh', params: PARAMS, adaptation: fixed.adaptation, characters: fixed.characters, scenes: fixed.scenes, props: fixed.props ?? [], beats: fixed.beats, episodes: [] };
      },
    });
    log('  骨架质量门：', g1.failed ? '✗ 仍有未过（继续，导演拍板时裁决）' : '✓ 全过');

    /* —— 导演拍板（driver 代行：打印决策并批准）—— */
    log('  [拍板] 砍线：' + (outline.adaptation.cut ?? []).map((c) => c.what).join('、') || '无');
    log('  [拍板] 合人：' + (outline.adaptation.merge ?? []).map((c) => c.what).join('、') || '无');
    log('  [拍板] 大爆点：第 ' + Math.min(...outline.beats.filter((b) => b.weight === 'major').map((b) => b.episode)) + ' 集 —— 批准，开始写分集');

    log('  分集梗概（每批 ≤10 集）…');
    const epPrompt = (a, b) => [
      '基于已拍板骨架写分集梗概。骨架JSON：', JSON.stringify({ adaptation: outline.adaptation, characters: outline.characters, scenes: outline.scenes, props: outline.props, beats: outline.beats }),
      `本批只写第 ${a}-${b} 集。硬规则：三栏齐全且叙述体（任何一栏禁止「」『』“”引号）；钩子第1拍进事件；sceneIds/characterIds 只用骨架已登记id；≥3人写crowdPlan；梗概扫到雨/吻/拥抱/围观/人群/手部特写等关键词必须写进warnings。`,
      '只输出JSON：{"episodes":[{"ep","synopsis"(≤120字),"hook","suspense","sceneIds":[],"characterIds":[],"propIds":[],"crowdPlan","warnings":[]}]}',
    ].join('\n');
    let episodes = [];
    for (let a = 1; a <= PARAMS.episodes; a += 10) {
      const b = Math.min(a + 9, PARAMS.episodes);
      const r = await glmRetry(epPrompt(a, b), { temperature: 0.5 });
      for (const e of r.episodes ?? []) { const i = episodes.findIndex((x) => x.ep === e.ep); if (i >= 0) episodes[i] = e; else episodes.push(e); }
    }
    episodes.sort((x, y) => x.ep - y.ep);
    const outlineFull = { ...outline, episodes };
    await wsWrite(`outline/${SLUG}-outline.json`, JSON.stringify(outlineFull, null, 2));
    const g2 = await gateLoop({
      op: 'outline_validate', payload: { filePath: `outline/${SLUG}-outline.json` }, stage: 'full', label: '分集',
      runFill: async (gateText) => {
        const fixed = await glmRetry([
          epPrompt(1, PARAMS.episodes), '【当前分集 JSON】', JSON.stringify(episodes),
          '【validate --stage full 原始输出，✗ 逐条修复，输出全部集数】', gateText,
          '只输出JSON：{"episodes":[...全部集...]}',
        ].join('\n'), { temperature: 0.2 });
        return { ...outlineFull, episodes: fixed.episodes };
      },
    });
    log('  full 门：', parseGates(g2.result.stdout).every((g) => g.ok) ? '✓ 全过' : '✗ 仍有未过');

    const ar = await eng('outline_assets');
    const assets = ar.exitCode === 0 ? JSON.parse(ar.stdout) : null;
    const rr = await eng('outline_render', { lang: 'zh' });
    log('  大纲报告：', rr.output ?? '(渲染失败)');
    mark('outline_full', { assets: !!assets, report: rr.output });
  }

  reached('outline_full') || die('先 --until outline');
  if (idx(UNTIL) < idx('characters')) return log('到 outline 为止');

  /* ============ characters ============ */
  if (!reached('characters')) {
    log('== 角色设定 ==');
    const seed = await eng('characters_seed');
    if (seed.exitCode !== 0) die('characters seed: ' + seed.stderr);
    let cast = JSON.parse(seed.stdout);
    const outline = JSON.parse(await wsRead(`outline/${SLUG}-outline.json`));
    const cPrompt = [
      '把角色表骨架填成完整角色设定集 JSON。小说素材：', (await wsRead('novel.txt')).slice(0, 3000),
      '骨架：', JSON.stringify(cast),
      '要求：每个角色 importance 保持骨架 tier 对应（lead→protagonist,support→supporting,functional→minor）；',
      'profile 人物画像 150-250字（性格/动机/口癖/人物弧）；visualPrompt 角色形象提示词（中文，外貌+服装+气质，写具体可画，适合出角色设定图）；',
      'voicePrompt 音色提示词（给 TTS：音色/语速/语气，中文）；negativePrompt 可选。',
      '保持骨架字段不变，只填充空字段。只输出完整 JSON。',
    ].join('\n');
    cast = await glmRetry(cPrompt, { temperature: 0.5 });
    await wsWrite(`characters/${SLUG}-cast.json`, JSON.stringify(cast, null, 2));
    const g = await gateLoop({
      op: 'characters_validate', payload: { filePath: `characters/${SLUG}-cast.json` }, label: '角色卡',
      runFill: async (gateText) => {
        const fixed = await glmRetry([cPrompt, '【当前 cast.json】', JSON.stringify(cast), '【validate 原始输出，✗ 逐条修复】', gateText, '只输出修复后的完整 cast.json'].join('\n'), { temperature: 0.2 });
        return fixed;
      },
    });
    log('  角色卡门：', g.failed ? '✗' : '✓');
    const rr = await eng('characters_render', { source: SLUG, lang: 'zh' });
    log('  角色报告：', rr.output ?? '(失败)');
    mark('characters');
  }

  /* ============ art ============ */
  if (!reached('art')) {
    log('== 美术设定 ==');
    const seed = await eng('art_seed');
    if (seed.exitCode !== 0) die('art seed: ' + seed.stderr);
    let art = JSON.parse(seed.stdout);
    const outline = JSON.parse(await wsRead(`outline/${SLUG}-outline.json`));
    const aPrompt = [
      '把美术设定骨架填成完整 art.json。小说素材：', (await wsRead('novel.txt')).slice(0, 3000),
      '骨架：', JSON.stringify(art),
      '要求：每个场景 anchors 一致性锚点3-5个（颜色/材质/光线/空间特征，短句）；',
      'lightings 光照状态至少1个（如 夜晚-塔灯/清晨-薄雾），每个含 name + prompt（英文出图提示词，含光照描述，无人）；',
      'prompt 字段：主视角空景出图提示词（英文，无人，无文字）；negativePrompt（英文，含 no people, no text）；',
      '道具（如有）：function 戏剧功能；states 状态变体至少1个；prompt 白底道具提示词（英文，纯白背景，no hands）；',
      '全部出图提示词必须英文；提示词里禁止出现角色名。保持骨架结构，只填充。只输出完整 JSON。',
    ].join('\n');
    art = await glmRetry(aPrompt, { temperature: 0.5 });
    await wsWrite(`art/${SLUG}-art.json`, JSON.stringify(art, null, 2));
    const g = await gateLoop({
      op: 'art_validate', payload: { filePath: `art/${SLUG}-art.json` }, label: '美术',
      runFill: async (gateText) => {
        const fixed = await glmRetry([aPrompt, '【当前 art.json】', JSON.stringify(art), '【validate 原始输出，✗ 逐条修复】', gateText, '只输出修复后的完整 art.json'].join('\n'), { temperature: 0.2 });
        return fixed;
      },
    });
    log('  美术门：', g.failed ? '✗' : '✓');
    const rr = await eng('art_render', { lang: 'zh' });
    log('  美术报告：', rr.output ?? '(失败)');
    mark('art');
  }

  /* ============ script ============ */
  if (!reached('script')) {
    log('== 剧本 ==');
    const seed = await eng('script_seed', { eps: `1-${PARAMS.episodes}` });
    if (seed.exitCode !== 0) die('script seed: ' + seed.stderr);
    let script = JSON.parse(seed.stdout);
    const outline = JSON.parse(await wsRead(`outline/${SLUG}-outline.json`));
    const sPrompt = (cur) => [
      '把剧本骨架填成完整剧本 JSON（场次 + 节拍流）。骨架（含每集 targetSeconds/hook/cliff）：', JSON.stringify(cur),
      '大纲参考：', JSON.stringify(outline).slice(0, 4000),
      '硬规则（validate 会确定性检查）：',
      '- 每集 scenes[] 按剧情顺序；每场 flow[] 是节拍流：动作与台词交替，一个节拍要么 {"action":"叙述体"} 要么 {"speaker":"C01|VO","line":"台词","delivery":"语气"}，不能两有/两无；',
      '- action 禁止任何引号（「」『』“”）；line 单句≤35字（非空白计）；speaker 必须在本场 characters 里或 VO；',
      '- 每场至少一个动作节拍；hookBeat [场,拍] 认领钩子具象，必须落在全集前3拍内；beatsClaimed 认领大纲爽点 type；',
      `- 时长确定性折算：台词秒=非空白字符÷4.5，动作秒=拍数×2.5，每集总和须落在 targetSeconds±15%（${PARAMS.minutesPerEpisode * 60}秒 → 约${Math.round(PARAMS.minutesPerEpisode * 60 * 0.85)}-${PARAMS.minutesPerEpisode * 60}秒）。单集1分钟约35拍、台词20句上下。`,
      '只输出完整剧本 JSON（结构同骨架）。',
    ].join('\n');
    script = await glmRetry(sPrompt(script), { temperature: 0.6, maxTokens: 16384 });
    await wsWrite(`script/${SLUG}-script.json`, JSON.stringify(script, null, 2));
    const g = await gateLoop({
      op: 'script_validate', payload: { filePath: `script/${SLUG}-script.json` }, label: '剧本',
      runFill: async (gateText) => {
        const cur = JSON.parse(await wsRead(`script/${SLUG}-script.json`));
        const fixed = await glmRetry([sPrompt(cur), '【当前 script.json】', JSON.stringify(cur), '【validate 原始输出，✗ 逐条修复（时长不够就加节拍，超了就删）】', gateText, '只输出修复后的完整 script.json'].join('\n'), { temperature: 0.25, maxTokens: 16384 });
        return fixed;
      },
    });
    log('  剧本门：', g.failed ? '✗（看上面 ✗ 详情）' : '✓');
    const rr = await eng('script_render', { lang: 'zh' });
    log('  剧本报告：', rr.output ?? '(失败)');
    mark('script');
  }

  /* ============ staging ============ */
  if (!reached('staging')) {
    log('== 开场站位 ==');
    const seed = await eng('staging_seed');
    if (seed.exitCode !== 0) die('staging seed: ' + seed.stderr);
    let staging = JSON.parse(seed.stdout);
    const art = JSON.parse(await wsRead(`art/${SLUG}-art.json`));
    const stPrompt = [
      '给每一场排开场站位。当前 staging.json（cast 已从剧本搬好）：', JSON.stringify(staging),
      '美术场景（锚点/提示词里能推算的东西）：', JSON.stringify(art).slice(0, 3000),
      '要求：locations[].items 4-20件（name 用中文叫法≤10字，alt 英文，plan=[西,北,东,南] 0-1，on=能否坐站），readFrom="prompt"；',
      'scenes[].places 每人一条：present/present=false 时 item,side,along,posture,facing 全 null；在场时 item 来自该地点 items、side 是 north/east/south/west/on、along 0-1、posture sit|stand、facing 八方位；',
      'extras=0 时 extrasWhere=null。why 一句话说明理由。',
      '只输出完整 staging.json。',
    ].join('\n');
    staging = await glmRetry(stPrompt, { temperature: 0.3 });
    await wsWrite('staging/staging.json', JSON.stringify(staging, null, 2));
    const g = await gateLoop({
      op: 'staging_validate', payload: { filePath: 'staging/staging.json' }, label: '站位',
      runFill: async (gateText) => {
        const fixed = await glmRetry([stPrompt, '【当前 staging.json】', JSON.stringify(staging), '【validate 原始输出，✗ 逐条修复】', gateText, '只输出修复后的完整 staging.json'].join('\n'), { temperature: 0.2 });
        return fixed;
      },
    });
    log('  站位门：', g.failed ? '✗' : '✓');
    const bl = await eng('staging_blocking', { lang: 'zh' });
    log('  开场走位句：\n    ' + bl.stdout.trim().split('\n').join('\n    '));
    await wsWrite('staging/blocking.md', bl.stdout.replace(/^\uFEFF/, ''));
    mark('staging', { blocking: bl.stdout.trim().split('\n') });
  }

  /* ============ storyboard ============ */
  if (!reached('storyboard')) {
    log('== 分镜 ==');
    const seed = await eng('storyboard_seed', { eps: '1', aspect: '16:9' });
    if (seed.exitCode !== 0) die('storyboard seed: ' + seed.stderr);
    let sb = JSON.parse(seed.stdout);
    const script = JSON.parse(await wsRead(`script/${SLUG}-script.json`));
    const blocking = (done.staging?.blocking ?? []).join('\n');
    const sbPrompt = (cur) => [
      '把分镜骨架填成完整 storyboard.json。骨架：', JSON.stringify(cur),
      '剧本第1集（节拍流，分镜要认领 beats 区间）：', JSON.stringify(script.episodes?.[0]).slice(0, 6000),
      '开场走位句（第一场第一段的 blocking 字段照抄）：', blocking,
      '硬规则（validate 逐字对账，违反必被拦）：',
      '- 段 id E01-01 顺序连号；段 ≤15 秒（Σcut.seconds）；不跨场次（sceneIndex）;',
      '- 每个 cut：beats=[a,b] 认领该场第几拍到第几拍，全部节拍恰好被认领一次且连续有序；seconds 2-5 且装得下认领台词的语速秒数；',
      '- size 枚举 extreme-wide/wide/medium/close/extreme-close；camera 用官方英文词表（Static Shot/Push In/Pan Left/Tracking Shot 等）；',
      '- 构图六字段每镜必填：lens（如 50mm 标准，中浅景深）/cameraPosition（如 男主+平视正面）/composition（三分法等）/eyeline/focus/stability（stable|slight-shake|handheld）；',
      '- characters ⊆ 该场人物；>3人必带 note；',
      '- frame：分镜图提示词（中文，含景别中文词，直呼角色名）；shot：镜头正文（中文，通用身份不写角色名，无秒数/编号/台词/{}<>（））；',
      '- h3Prompt：一段一条。首行整行 = "How the reference pictures align with the target video — " + 每张分镜图 "(from Shot k) aligns with the <切点秒>.000-second mark of the target video"（单分镜段用固定单图句式）；',
      '  然后 "integrated_multimodal_description:" 行、每镜一行 "[Shot k] ..."（k≥2 必须以 "At 00:0X.000, the camera cuts to" 开头且时刻=前面分镜秒数累计，camera 官方词必须出现在自己段落里），台词逐字进 <d>[Chinese]台词</d>（说话人英文语气写在 <d> 外，VO 用 says in an off-screen voiceover）；',
      '  然后 "overall_soundscape:" 1-4句、"non_diegetic_music:" 1-3句；正文中禁角色名（用 the keeper / the old captain 这类通用身份）；',
      '- soundscape 中文音景；music 中文配乐（可省）；blocking 字段：开场谁在画面左右、朝向、距离（每段一份）。',
      '段数控制在 3 段以内（短片）。只输出完整 storyboard.json。',
    ].join('\n');
    sb = await glmRetry(sbPrompt(sb), { temperature: 0.4, maxTokens: 16384 });
    await wsWrite(`storyboard/${SLUG}-storyboard.json`, JSON.stringify(sb, null, 2));
    const g = await gateLoop({
      op: 'storyboard_validate', payload: { filePath: `storyboard/${SLUG}-storyboard.json` }, label: '分镜',
      runFill: async (gateText) => {
        const cur = JSON.parse(await wsRead(`storyboard/${SLUG}-storyboard.json`));
        const fixed = await glmRetry([sbPrompt(cur), '【当前 storyboard.json】', JSON.stringify(cur), '【validate 原始输出，✗ 逐条修复（尤其 h3Prompt 的切点时刻和对账）】', gateText, '只输出修复后的完整 storyboard.json'].join('\n'), { temperature: 0.2, maxTokens: 16384 });
        return fixed;
      },
    }, 3);
    log('  分镜门：', g.failed ? '✗（投产前必须修过）' : '✓');
    const rr = await eng('storyboard_render', { lang: 'zh' });
    log('  分镜报告：', rr.output ?? '(失败)');
    mark('storyboard');
  }

  /* ============ export ============ */
  if (!reached('export')) {
    log('== H3 投产包 ==');
    const ex = await eng('storyboard_export', { protocol: 'h3' });
    log('  ', (ex.stdout || ex.stderr).trim().slice(0, 300));
    const manifest = JSON.parse(await wsRead('storyboard/manifest.json'));
    log('  manifest 段数：', manifest.segments?.length ?? Object.keys(manifest).length);
    mark('export');
  }
  log('文本流水线全部完成。下一步：ComfyUI 出分镜图/视频（agent 用 MCP 驱动）。');
}

main().catch((e) => die(e.stack || e.message));
