'use strict';
// 端到端业务测试：临时 DB + 真实 HTTP 服务，验证权限、范围、冲突合版、发布不可变、异议重定位
process.env.DATA_DIR = '/tmp/hrc-test-data';
process.env.PORT = '3987';
process.env.HOST = '127.0.0.1';

const fs = require('fs');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const assert = require('assert');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; console.log('  ✓', msg); }

async function req(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') || '' };
}
async function expectFail(p, statusPart, msgPart, label) {
  const r = await p;
  assert(r.status === statusPart || (r.status >= 400 && statusPart === 400),
    `${label}: 期望失败状态 ${statusPart}，实际 ${r.status}`);
  assert(r.json.error && r.json.error.includes(msgPart),
    `${label}: 错误信息应包含“${msgPart}”，实际：${r.json.error}`);
  ok(true, `${label} -> ${r.status} ${r.json.error}`);
}

async function login(u, p) {
  const r = await req('POST', '/api/login', { username: u, password: p });
  assert.strictEqual(r.status, 200, `登录失败: ${JSON.stringify(r.json)}`);
  return r.setCookie.split(';')[0];
}

// 对发布门槛中所有未满足的异议逐条回应（复核员），返回门槛条目
async function clearGate(cookie) {
  const check = await req('GET', '/api/publish-check', null, cookie);
  assert.strictEqual(check.status, 200, `发布前核对失败: ${JSON.stringify(check.json)}`);
  for (const it of check.json.items || []) {
    if (!it.satisfied) {
      const r = await req('POST', `/api/objections/${it.objectionId}/respond`,
        { note: `核对后回应异议 #${it.objectionId}：本批修订不影响其主张，允许发布` }, cookie);
      assert.strictEqual(r.status, 201, `回应异议 #${it.objectionId} 失败: ${JSON.stringify(r.json)}`);
    }
  }
  return check.json.items || [];
}

// 码点偏移版 indexOf
function cpIndexOf(text, needle) {
  const t = Array.from(text), n = Array.from(needle);
  outer: for (let i = 0; i + n.length <= t.length; i++) {
    for (let j = 0; j < n.length; j++) if (t[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));

  console.log('\n[认证与权限]');
  const rec = await login('recorder', 'recorder123');
  const rev = await login('reviewer', 'reviewer123');
  const par = await login('participant', 'participant123');
  ok(rec && rev && par, '三类用户登录成功');
  await expectFail(req('GET', '/api/booth'), 401, '未登录', '未登录访问总览');
  await expectFail(req('POST', '/api/doc/import', { title: 'x', text: '1. a' }, rev), 403, '无权操作', '复核员尝试导入');
  await expectFail(req('POST', '/api/proposals', { seg: 1, start: 0, end: 1, replacement: 'x', basis: 'b' }, par), 403, '无权操作', '参与者尝试提议');

  console.log('\n[导入与非法范围]');
  const transcript = fs.readFileSync(require('path').join(__dirname, '..', 'sample-transcript.txt'), 'utf8');
  const imp = await req('POST', '/api/doc/import', { title: '测试听证会', text: transcript }, rec);
  assert.strictEqual(imp.status, 201);
  ok(imp.json.baseVersionId === 1, '导入形成 v1');
  await expectFail(req('POST', '/api/doc/import', { title: 'x', text: '1. a' }, rec), 409, '不能重复导入', '重复导入');

  let booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.segments.length === 5, '解析出 5 个带段号段落');
  const seg2 = booth.segments.find((s) => s.seg === 2).text;
  const iDate = cpIndexOf(seg2, '2024'); // “2024年3月1日”起点
  ok(iDate > 0, `定位到第2段日期偏移 ${iDate}`);

  await expectFail(req('POST', '/api/proposals', { seg: 2, start: -1, end: 3, replacement: 'x', basis: 'b' }, rec),
    400, '非法范围', '负偏移');
  await expectFail(req('POST', '/api/proposals', { seg: 2, start: 0, end: 99999, replacement: 'x', basis: 'b' }, rec),
    400, '非法范围', '超出段长');
  await expectFail(req('POST', '/api/proposals', { seg: 99, start: 0, end: 1, replacement: 'x', basis: 'b' }, rec),
    400, '不存在段', '不存在的段号');
  await expectFail(req('POST', '/api/proposals', { seg: 2, start: iDate, end: iDate + 9, replacement: 'x', basis: '' }, rec),
    400, '依据不能为空', '空依据');

  console.log('\n[提议/采纳/驳回/冲突]');
  // P1: 第2段 2024年3月1日(9字符) -> 2024年3月2日
  const p1 = await req('POST', '/api/proposals',
    { seg: 2, start: iDate, end: iDate + 9, replacement: '2024年3月2日', basis: '被申请人指出录音为3月2日' }, rec);
  assert.strictEqual(p1.status, 201);
  const id1 = p1.json.id;
  ok(id1 >= 1, `记录员提交提议 #${id1}，绑定基版 v1`);

  // P2 与 P1 交叠：提交时即冲突（P1 还没采纳，故应为 pending）
  const p2 = await req('POST', '/api/proposals',
    { seg: 2, start: iDate + 2, end: iDate + 5, replacement: '25年', basis: '另一说法' }, rec);
  assert.strictEqual(p2.status, 201);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const P2 = booth.proposals.find((x) => x.id === p2.json.id);
  ok(P2.status === 'pending', '与待复核提议交叠允许提交（待复核不占位）');

  // 记录员不能自己采纳
  await expectFail(req('POST', `/api/proposals/${id1}/adopt`, {}, rec), 403, '无权操作', '记录员尝试采纳');

  let ad = await req('POST', `/api/proposals/${id1}/adopt`, {}, rev);
  assert.strictEqual(ad.status, 200);
  ok(!ad.json.markedConflict, `采纳 #${id1} 进入暂存区`);

  // 再采纳交叠的 P2 → 标记冲突，状态改变且不覆盖
  ad = await req('POST', `/api/proposals/${p2.json.id}/adopt`, {}, rev);
  ok(ad.json.markedConflict && ad.json.reason.includes('交叠'), `交叠采纳 #${p2.json.id} 被标记冲突且写明原因`);
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.proposals.find((x) => x.id === p2.json.id).status === 'conflicted', '交叠提议状态为 conflicted');
  ok(booth.stage.length === 1, '暂存区仍只有不冲突的 1 项（未覆盖其他修订）');

  // 同段内互不重叠的 P3：第2段“申请人张三” -> “申请人张三丰”？构造一个不与 P1 交叠的范围
  const iName = cpIndexOf(seg2, '张三');
  const p3 = await req('POST', '/api/proposals',
    { seg: 2, start: iName, end: iName + 2, replacement: '张三丰', basis: '身份证姓名为张三丰' }, rec);
  assert.strictEqual(p3.status, 201);
  ad = await req('POST', `/api/proposals/${p3.json.id}/adopt`, {}, rev);
  ok(!ad.json.markedConflict, `互不重叠提议 #${p3.json.id} 可采纳`);

  // 重复采纳
  await expectFail(req('POST', `/api/proposals/${id1}/adopt`, {}, rev), 409, '重复采纳', '重复采纳');

  // 驳回一个已采纳的（从暂存区撤回）——这里驳回 P3
  const rj = await req('POST', `/api/proposals/${p3.json.id}/reject`, { reason: '证据不足' }, rev);
  ok(rj.status === 200, '复核员可驳回并把已采纳项移出暂存区');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.stage.length === 1, '驳回后暂存区恢复为 1 项');

  console.log('\n[发布合并与不可变]');
  await expectFail(req('POST', '/api/publish', {}, par), 403, '无权操作', '参与者尝试发布');

  // 先发一个待复核的过期基版提议（段4的范围），发布后应变冲突
  const seg4 = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 4).text;
  const iW = cpIndexOf(seg4, '王五');
  const p4 = await req('POST', '/api/proposals',
    { seg: 4, start: iW, end: iW + 2, replacement: '王武', basis: '笔误' }, rec);
  assert.strictEqual(p4.status, 201);

  // 空发布防护：先把 P1 驳回，再发布应 409；然后恢复流程——改为直接发布（含P1）
  // 为保留空发布用例，另测：当前暂存区有 P1，直接发布成功；空发布用例会在之后验证。
  const pub = await req('POST', '/api/publish', { note: '第一次修订' }, rev);
  assert.strictEqual(pub.status, 201);
  ok(pub.json.versionId === 2, '发布形成不可变 v2');

  booth = (await req('GET', '/api/booth', null, rev)).json;
  const newSeg2 = booth.segments.find((s) => s.seg === 2).text;
  ok(newSeg2.includes('2024年3月2日') && !newSeg2.includes('2024年3月1日'),
    'v2 正文已合并替换（3月1日→3月2日）');
  const P1now = booth.proposals.find((x) => x.id === id1);
  ok(P1now.status === 'published' && P1now.published_version_id === 2, `#${id1} 状态为 published@v2`);
  const P4now = booth.proposals.find((x) => x.id === p4.json.id);
  ok(P4now.status === 'conflicted' && P4now.conflict_reason.includes('基版已过期'),
    `发布后基版过期的待决提议 #${p4.json.id} 自动标记冲突`);

  // 空发布（重复发布）必须报错且不改状态
  await expectFail(req('POST', '/api/publish', { note: '再发一次' }, rev), 409, '重复发布', '暂存区为空时发布');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 2, '失败发布未改变当前版本');

  // v1 不可变
  const v1 = (await req('GET', '/api/versions/1', null, par)).json;
  ok(v1.segments.find((s) => s.seg === 2).text.includes('2024年3月1日'), 'v1 正文快照保持原文不变');
  const v2 = (await req('GET', '/api/versions/2', null, par)).json;
  ok(v2.immutable === true, '版本视图标记 immutable');
  const decTypes = v2.decisions.map((d) => d.type);
  ok(decTypes.includes('adopt') && decTypes.includes('reject') &&
     decTypes.includes('conflict') && decTypes.includes('publish'),
    'v2 决议视图含采纳/驳回/冲突/发布留痕');

  console.log('\n[异议引用与重新定位]');
  // 异议锚定 v2 第2段中现在的文字“2024年3月2日”
  const v2seg2 = v2.segments.find((s) => s.seg === 2).text;
  const iNewDate = cpIndexOf(v2seg2, '2024年3月2日');
  const obj = await req('POST', '/api/objections',
    { seg: 2, start: iNewDate, end: iNewDate + 9, note: '日期仍需核对原始录音' }, par);
  assert.strictEqual(obj.status, 201);
  const oid = obj.json.id;
  ok(oid >= 1, `参与者提出异议 #${oid}`);
  await expectFail(req('POST', '/api/objections',
    { seg: 2, start: 0, end: 999, note: 'x' }, par), 400, '非法范围', '异议非法范围');

  // 记录员再提一个修订删除“2024年3月2日”，复核采纳发布 v3 -> 异议须 needs_relocation，快照保留
  const p5 = await req('POST', '/api/proposals',
    { seg: 2, start: iNewDate, end: iNewDate + 9, replacement: '3月上旬', basis: '录音仅可辨认到3月上旬' }, rec);
  assert.strictEqual(p5.status, 201);
  const ad5 = await req('POST', `/api/proposals/${p5.json.id}/adopt`, {}, rev);
  assert.strictEqual(ad5.status, 200);

  // 发布前回应门槛：触及异议 oid，未回应时发布被拒绝（版本/提议不变）
  const gateV3 = (await req('GET', '/api/publish-check', null, rev)).json;
  const g3 = gateV3.items.find((x) => x.objectionId === oid);
  ok(g3 && g3.satisfied === false && g3.proposalIds.includes(p5.json.id),
    `发布前核对列出待回应异议 #${oid}，关联采纳提议 #${p5.json.id}`);
  await expectFail(req('POST', '/api/publish', { note: '第二次修订' }, rev),
    409, '未完成有效回应', '未回应触及异议时发布');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 2, '回应缺失导致发布被拒：当前版本仍为 v2');
  await clearGate(rev);
  await req('POST', '/api/publish', { note: '第二次修订' }, rev);

  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(booth.currentVersion.id === 3, '发布 v3');
  const o3 = booth.objections.find((x) => x.id === oid);
  ok(o3.anchor_status === 'needs_relocation', `相交修订发布后异议 #${oid} 标记待重新定位`);
  ok(o3.quoted_text === '2024年3月2日', `异议原文快照保留为“${o3.quoted_text}”，未悄悄指向新文字`);

  // v2 的异议视图仍为 active，历史不变
  const v2again = (await req('GET', '/api/versions/2', null, par)).json;
  const oa2 = v2again.objections.find((x) => x.id === oid);
  ok(oa2 && oa2.status === 'active' && oa2.quoted_text === '2024年3月2日', 'v2 历史异议锚点不被追溯修改');
  const v3 = (await req('GET', '/api/versions/3', null, par)).json;
  const oa3 = v3.objections.find((x) => x.id === oid);
  ok(oa3 && oa3.status === 'needs_relocation', 'v3 异议视图显示待重新定位');
  const rsp3 = v3.responses.find((x) => x.objection_id === oid);
  ok(rsp3 && rsp3.note.includes('核对后回应') && rsp3.proposalIds.includes(p5.json.id) &&
     rsp3.published_version_id === 3 && rsp3.version_id === 2,
    'v3 只读归档发布前回应（含说明、关联提议、回应时版本 v2 与发布版本 v3）');

  // 无权重新定位（其他参与者既非提出者也非复核员）—— 用 rec? rec 是 recordist 非作者
  const seg3 = booth.segments.find((s) => s.seg === 2).text;
  const i3 = cpIndexOf(seg3, '3月上旬');
  await expectFail(req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: i3, end: i3 + 4 }, rec), 403, '无权操作', '无关用户尝试重新定位');

  // 非法重定位范围
  await expectFail(req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: 0, end: 99999 }, par), 400, '非法范围', '重新定位非法范围');

  // 提出者重新定位成功
  const rl = await req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: i3, end: i3 + 4 }, par);
  ok(rl.status === 200, '提出者成功重新定位异议');
  booth = (await req('GET', '/api/booth', null, par)).json;
  const oDone = booth.objections.find((x) => x.id === oid);
  ok(oDone.anchor_status === 'active', '重新定位后异议恢复 active');

  // 对仍有效的异议重复重定位须报错
  await expectFail(req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: i3, end: i3 + 4 }, par), 409, '无需重新定位', '对有效异议重复重定位');

  console.log('\n[重定位后再发布不相交修订：锚点保持有效]');
  // 第1段的修订与已重定位到第2段的异议不相交，发布 v4 后异议仍应 active
  const curSeg1 = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 1).text;
  const iOpen = cpIndexOf(curSeg1, '现在开庭');
  const p6 = await req('POST', '/api/proposals',
    { seg: 1, start: iOpen, end: iOpen + 4, replacement: '现在宣布开庭', basis: '审判长原话' }, rec);
  assert.strictEqual(p6.status, 201);
  const ad6 = await req('POST', `/api/proposals/${p6.json.id}/adopt`, {}, rev);
  assert.strictEqual(ad6.status, 200);
  await req('POST', '/api/publish', { note: '第三次修订' }, rev);
  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(booth.currentVersion.id === 4, '发布 v4');
  const oAfter = booth.objections.find((x) => x.id === oid);
  ok(oAfter.anchor_status === 'active', '不相交修订发布后，已重定位异议保持 active（不回退）');

  console.log('\n[续提：权限与前置校验]');
  // 当前 v4；p4（第4段 王五→王武，基版 v1）已因发布被标“基版已过期”
  const pid4 = p4.json.id;
  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, rev), 403, '无权操作', '复核员尝试续提预览');
  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, par), 403, '无权操作', '参与者尝试续提预览');
  await expectFail(req('POST', `/api/proposals/${p2.json.id}/rebase-preview`, {}, rec), 409, '基版已过期', '交叠类冲突提议续提');
  await expectFail(req('POST', `/api/proposals/${id1}/rebase-preview`, {}, rec), 409, '冲突', '已发布提议续提');
  await expectFail(req('POST', '/api/proposals/9999/rebase-preview', {}, rec), 404, '不存在', '续提不存在的提议');

  // 第二名记录员（非本人）——直接落库建号后登录
  const { hashPassword, DB_PATH } = require('../src/db');
  const Database = require('better-sqlite3');
  const raw = new Database(DB_PATH);
  raw.prepare(`INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)`)
    .run('recorder2', '记录员乙', 'recordist', hashPassword('recorder234'));
  raw.close();
  const rec2 = await login('recorder2', 'recorder234');
  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, rec2), 403, '本人', '非本人提议拒绝续提');

  console.log('\n[续提：预览换算与确认生成]');
  const pv1 = await req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, rec);
  assert.strictEqual(pv1.status, 200);
  ok(pv1.json.fromVersion === 1 && pv1.json.toVersion === 4,
    `预览：v${pv1.json.fromVersion} → v${pv1.json.toVersion} 逐版换算`);
  ok(pv1.json.seg === 4 && pv1.json.excerpt === '王五', '目标选区摘录与原文一致（本段无中途修订，偏移不变）');
  ok(pv1.json.replacement === '王武' && pv1.json.basis === '笔误', '预览带回原替换文字与依据');
  ok(pv1.json.stageOverlap === null && pv1.json.token && pv1.json.token.v === 4, '暂存区无交叠，返回预览凭证');

  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-confirm`, {}, rec), 400, '预览凭证', '缺少预览凭证拒绝确认');

  const cf1 = await req('POST', `/api/proposals/${pid4}/rebase-confirm`, { token: pv1.json.token }, rec);
  assert.strictEqual(cf1.status, 201);
  const nid1 = cf1.json.id;
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const N1 = booth.proposals.find((x) => x.id === nid1);
  ok(N1 && N1.status === 'pending' && N1.base_ver === 4, `续提生成新待复核提议 #${nid1}（基版 v4）`);
  ok(N1.rebased_from_id === pid4 && N1.original_excerpt === '王五' && N1.replacement === '王武',
    '新提议关联原提议并沿用替换文字与依据');
  const P4after = booth.proposals.find((x) => x.id === pid4);
  ok(P4after.status === 'conflicted' && P4after.continued_by_id === nid1,
    '原冲突提议保持可追溯（状态不变，标注已续提）');

  // 新提议沿用现有复核与发布规则
  const adN1 = await req('POST', `/api/proposals/${nid1}/adopt`, {}, rev);
  ok(adN1.status === 200 && !adN1.json.markedConflict, '续提提议可被复核员正常采纳');
  const pub5 = await req('POST', '/api/publish', { note: '续提发布' }, rev);
  ok(pub5.status === 201 && pub5.json.versionId === 5, '续提提议随 v5 发布');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.segments.find((s) => s.seg === 4).text.includes('王武'), 'v5 正文已应用续提修订');

  console.log('\n[续提：中途修订触及选区 → 拒绝]');
  let seg1now = booth.segments.find((s) => s.seg === 1).text; // 含“现在宣布开庭”
  const iOpen2 = cpIndexOf(seg1now, '现在宣布开庭');
  const p7 = await req('POST', '/api/proposals',
    { seg: 1, start: iOpen2, end: iOpen2 + 6, replacement: '现在正式开庭', basis: '庭长口径' }, rec);
  assert.strictEqual(p7.status, 201);
  // 另一提议覆盖同一范围并被采纳发布 → p7 基版过期且选区被中途修订触及
  const p8 = await req('POST', '/api/proposals',
    { seg: 1, start: iOpen2, end: iOpen2 + 6, replacement: '现在继续开庭', basis: '录音核对' }, rec);
  assert.strictEqual(p8.status, 201);
  await req('POST', `/api/proposals/${p8.json.id}/adopt`, {}, rev);
  await req('POST', '/api/publish', { note: '触及选区' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 6, '发布 v6');
  ok(booth.proposals.find((x) => x.id === p7.json.id).status === 'conflicted', 'p7 因发布被标基版已过期');
  await expectFail(req('POST', `/api/proposals/${p7.json.id}/rebase-preview`, {}, rec), 409, '触及', '中途修订触及选区，预览即拒绝');

  console.log('\n[续提：零长度选区的插入点]');
  seg1now = booth.segments.find((s) => s.seg === 1).text; // 含“现在继续开庭”
  const iCont = cpIndexOf(seg1now, '现在继续开庭');
  // 插入点紧贴“现在继续开庭”之后
  const p9 = await req('POST', '/api/proposals',
    { seg: 1, start: iCont + 6, end: iCont + 6, replacement: '，全体起立', basis: '程序记录' }, rec);
  assert.strictEqual(p9.status, 201);
  // 修订替换“现在继续开庭”（其终点恰为插入点）→ 触及插入点
  const p10 = await req('POST', '/api/proposals',
    { seg: 1, start: iCont, end: iCont + 6, replacement: '庭审继续进行', basis: '录音核对' }, rec);
  assert.strictEqual(p10.status, 201);
  await req('POST', `/api/proposals/${p10.json.id}/adopt`, {}, rev);
  await req('POST', '/api/publish', { note: '触及插入点' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 7, '发布 v7');
  await expectFail(req('POST', `/api/proposals/${p9.json.id}/rebase-preview`, {}, rec), 409, '插入点', '修订终点触及插入点，拒绝换算');

  // 未被触及的零长度选区：可预览、可确认
  const p11 = await req('POST', '/api/proposals',
    { seg: 5, start: 0, end: 0, replacement: '【核对】', basis: '补记标记' }, rec);
  assert.strictEqual(p11.status, 201);
  // 在第2段发布与第5段无关的修订，使 p11 基版过期
  const seg2v7 = booth.segments.find((s) => s.seg === 2).text;
  const iShang = cpIndexOf(seg2v7, '3月上旬');
  const p12 = await req('POST', '/api/proposals',
    { seg: 2, start: iShang, end: iShang + 4, replacement: '3月初', basis: '录音仅可辨认到月初' }, rec);
  assert.strictEqual(p12.status, 201);
  await req('POST', `/api/proposals/${p12.json.id}/adopt`, {}, rev);
  // “3月上旬”正是异议 #oid 重定位后的锚点，发布 v8 前须回应
  const g8items = await clearGate(rev);
  ok(g8items.some((x) => x.objectionId === oid), 'v8 发布前核对：重定位后的异议被新暂存修订触及，须回应');
  await req('POST', '/api/publish', { note: '无关修订' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 8, '发布 v8（第5段未被改动）');
  const pv11 = await req('POST', `/api/proposals/${p11.json.id}/rebase-preview`, {}, rec);
  ok(pv11.status === 200 && pv11.json.start === 0 && pv11.json.end === 0 && pv11.json.excerpt === '',
    '零长度选区未被触及：预览成功（插入点不变）');
  const cf11 = await req('POST', `/api/proposals/${p11.json.id}/rebase-confirm`, { token: pv11.json.token }, rec);
  ok(cf11.status === 201, '零长度续提确认成功');

  console.log('\n[续提：暂存区交叠与预览后变化]');
  // p13：基版 v8，第2段范围覆盖“3月初”
  const seg2v8 = booth.segments.find((s) => s.seg === 2).text;
  const iChu = cpIndexOf(seg2v8, '3月初');
  const p13 = await req('POST', '/api/proposals',
    { seg: 2, start: iChu, end: iChu + 3, replacement: '3月上旬', basis: '再次核对录音' }, rec);
  assert.strictEqual(p13.status, 201);
  // p14：第2段前部“申请人张三称”→“申请人张某称”（等长替换，不改变后续偏移），采纳并发布 v9 → p13 过期
  const iName2 = cpIndexOf(seg2v8, '申请人张三称');
  const p14 = await req('POST', '/api/proposals',
    { seg: 2, start: iName2, end: iName2 + 6, replacement: '申请人张某称', basis: '匿名化处理' }, rec);
  assert.strictEqual(p14.status, 201);
  await req('POST', `/api/proposals/${p14.json.id}/adopt`, {}, rev);
  await req('POST', '/api/publish', { note: '匿名化' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 9, '发布 v9（等长替换，后续偏移不变）');
  ok(booth.proposals.find((x) => x.id === p13.json.id).conflict_kind === 'base_expired', 'p13 标记为基版已过期');

  // 暂存区交叠：p15 与 p13 的换算目标交叠且被采纳
  const seg2v9 = booth.segments.find((s) => s.seg === 2).text;
  const iChu9 = cpIndexOf(seg2v9, '3月初');
  const p15 = await req('POST', '/api/proposals',
    { seg: 2, start: iChu9, end: iChu9 + 3, replacement: '3月中旬', basis: '第三种说法' }, rec);
  assert.strictEqual(p15.status, 201);
  await req('POST', `/api/proposals/${p15.json.id}/adopt`, {}, rev);
  const pv13a = await req('POST', `/api/proposals/${p13.json.id}/rebase-preview`, {}, rec);
  ok(pv13a.status === 200 && pv13a.json.stageOverlap && pv13a.json.stageOverlap.id === p15.json.id,
    '预览提示目标与暂存区已采纳提议交叠');
  await expectFail(req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13a.json.token }, rec),
    409, '交叠', '目标与暂存区交叠，确认被拒绝');

  // 预览后暂存区变化：驳回 p15 后旧凭证失效
  const pv13b = await req('POST', `/api/proposals/${p13.json.id}/rebase-preview`, {}, rec);
  await req('POST', `/api/proposals/${p15.json.id}/reject`, { reason: '证据不足' }, rev);
  await expectFail(req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13b.json.token }, rec),
    409, '暂存区', '预览后暂存区变化，旧凭证被拒绝');

  // 重新预览后确认成功
  const pv13c = await req('POST', `/api/proposals/${p13.json.id}/rebase-preview`, {}, rec);
  const cf13 = await req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13c.json.token }, rec);
  ok(cf13.status === 201, '重新预览后确认成功');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const N13 = booth.proposals.find((x) => x.id === cf13.json.id);
  ok(N13.status === 'pending' && N13.base_ver === 9 && N13.rebased_from_id === p13.json.id,
    '新提议关联原提议并绑定当前基版');

  // 预览后版本变化：采纳 N13 并发布 v10，再用旧凭证确认 → 拒绝
  await req('POST', `/api/proposals/${cf13.json.id}/adopt`, {}, rev);
  const g10items = await clearGate(rev);
  ok(g10items.some((x) => x.objectionId === oid && x.proposalIds.includes(cf13.json.id)),
    `v10 发布前核对：异议 #${oid} 被续提提议 #${cf13.json.id} 触及，已逐条回应`);
  await req('POST', '/api/publish', { note: '续提再发布' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 10, '发布 v10');
  await expectFail(req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13c.json.token }, rec),
    409, '重新预览', '预览后版本变化，旧凭证被拒绝');

  // 决议留痕：续提决议产生于 v9 发布之后，按水位线语义应出现在 v10 的决议视图中
  const v10view = (await req('GET', '/api/versions/10', null, par)).json;
  ok(v10view.decisions.some((d) => d.type === 'rebase' && d.proposal_id === cf13.json.id),
    '版本决议视图含续提留痕，可追溯');

  console.log('\n[发布前异议回应：基础门槛、回应与发布归档]');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const v10 = booth.currentVersion.id;
  ok(v10 === 10, '新门槛用例起点为 v10');
  // 第3段此前从未修订，文字仍为原文
  const seg3v10 = booth.segments.find((s) => s.seg === 3).text;
  const iDate3 = cpIndexOf(seg3v10, '2024年3月2日');
  const iDate1_3 = cpIndexOf(seg3v10, '3月1日');

  // 记录员提议替换第3段“2024年3月2日”（9字符），复核采纳
  const q1 = await req('POST', '/api/proposals',
    { seg: 3, start: iDate3, end: iDate3 + 9, replacement: '2024年3月3日', basis: '录音核对为3月3日' }, rec);
  assert.strictEqual(q1.status, 201);
  await req('POST', `/api/proposals/${q1.json.id}/adopt`, {}, rev);

  // 参与者：先对一个不相关位置提异议（不应出现在门槛中）
  const oOther = await req('POST', '/api/objections',
    { seg: 3, start: iDate1_3, end: iDate1_3 + 4, note: '另一处“3月1日”也需核对' }, par);
  assert.strictEqual(oOther.status, 201);
  // 参与者再对将被替换的范围提异议（应进入待回应集合）
  const oA = await req('POST', '/api/objections',
    { seg: 3, start: iDate3, end: iDate3 + 9, note: '日期异议：请复核员发布前说明' }, par);
  assert.strictEqual(oA.status, 201);
  const oaid = oA.json.id;

  let gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(gate.versionId === 10, '发布前核对返回当前版本 v10');
  const gA = gate.items.find((x) => x.objectionId === oaid);
  ok(gA && !gA.satisfied && gA.response === null &&
     gA.proposalIds.length === 1 && gA.proposalIds[0] === q1.json.id,
    `门槛列出待回应异议 #${oaid}，关联已采纳提议 #${q1.json.id}，尚无回应`);
  ok(!gate.items.some((x) => x.objectionId === oOther.json.id), '未被暂存修订触及的异议不进入受影响集合');
  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(booth.publishCheck === null,
    '发布核对仅供记录员与复核员：参与者 booth.publishCheck 为 null，不暴露待回应项');

  // 无受影响异议时可按原规则发布：清空暂存后空发布仍按既有规则拒绝
  await req('POST', `/api/proposals/${q1.json.id}/reject`, { reason: '暂缓' }, rev);
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(gate.items.length === 0, '暂存为空：受影响异议集合为空');
  await expectFail(req('POST', '/api/publish', { note: '空发' }, rev), 409, '重复发布', '无暂存修订时仍按原规则拒绝空发布');
  // 重新采纳
  const q1b = await req('POST', '/api/proposals',
    { seg: 3, start: iDate3, end: iDate3 + 9, replacement: '2024年3月3日', basis: '录音核对为3月3日（重提）' }, rec);
  assert.strictEqual(q1b.status, 201);
  await req('POST', `/api/proposals/${q1b.json.id}/adopt`, {}, rev);

  // 权限与非空校验
  await expectFail(req('POST', `/api/objections/${oaid}/respond`, { note: '我也回应一下' }, rec),
    403, '无权操作', '记录员尝试回应异议');
  await expectFail(req('POST', `/api/objections/${oOther.json.id}/respond`, { note: '回应未触及的异议' }, rev),
    409, '未被暂存', '回应未被触及的异议被拒绝');
  await expectFail(req('POST', `/api/objections/${oaid}/respond`, { note: '   ' }, rev),
    400, '不能为空', '空回应说明被拒绝');

  // 未回应 → 发布被拒绝，版本与提议均不变
  await expectFail(req('POST', '/api/publish', { note: 'v11' }, rev),
    409, '未完成有效回应', '待回应异议存在时发布被拒绝');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 10, '发布失败：当前版本仍为 v10，未产生新版本');
  ok(booth.proposals.find((x) => x.id === q1b.json.id).status === 'adopted',
    `发布失败：提议 #${q1b.json.id} 仍为已采纳，决议未改变`);

  // 复核员回应后再发布
  const rsp = await req('POST', `/api/objections/${oaid}/respond`,
    { note: '经核对原始录音，发言人明确表述为3月3日；异议所指“2日”不成立，准予修订并在本版留痕。' }, rev);
  assert.strictEqual(rsp.status, 201);
  ok(rsp.json.proposalIds.includes(q1b.json.id) && rsp.json.versionId === 10,
    '回应关联触及提议与回应时版本 v10');
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(gate.items.find((x) => x.objectionId === oaid).satisfied === true, '回应后门槛标记为已满足');
  const pub11 = await req('POST', '/api/publish', { note: '第3段日期更正（含异议回应）' }, rev);
  ok(pub11.status === 201 && pub11.json.versionId === 11, '回应齐备后发布 v11 成功');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.segments.find((s) => s.seg === 3).text.includes('2024年3月3日'), 'v11 正文应用修订');
  const v11view = (await req('GET', '/api/versions/11', null, par)).json;
  const rsp11 = v11view.responses.find((x) => x.objection_id === oaid);
  ok(rsp11 && rsp11.published_version_id === 11 && rsp11.version_id === 10 &&
     rsp11.proposalIds.includes(q1b.json.id) && rsp11.note.includes('3月3日'),
    'v11 只读视图归档回应：非空说明、关联异议/提议、回应时版本 v10 与暂存绑定');
  const oOtherV11 = v11view.objections.find((x) => x.id === oOther.json.id);
  ok(oOtherV11 && oOtherV11.status === 'active', '未触及异议的锚点与原文快照照常保留');

  // 已随版发布的异议不再被标记待回应，无需重复回应即可发布下一批不相关修订
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(gate.items.length === 0, 'v11 发布后暂存为空：门槛为空');

  console.log('\n[发布前异议回应：暂存区变化致回应失效，重新核对后发布]');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const seg3v11 = booth.segments.find((s) => s.seg === 3).text;
  const iBei = cpIndexOf(seg3v11, '应当是');
  const oB = await req('POST', '/api/objections',
    { seg: 3, start: iBei, end: iBei + 3, note: '“应当是”措辞异议' }, par);
  assert.strictEqual(oB.status, 201);
  const obid = oB.json.id;
  const r1 = await req('POST', '/api/proposals',
    { seg: 3, start: iBei, end: iBei + 3, replacement: '应为', basis: '笔误更正' }, rec);
  assert.strictEqual(r1.status, 201);
  await req('POST', `/api/proposals/${r1.json.id}/adopt`, {}, rev);
  // 回应，绑定当前暂存状态
  let rspB = await req('POST', `/api/objections/${obid}/respond`,
    { note: '措辞更正不改变含义，同意发布。' }, rev);
  assert.strictEqual(rspB.status, 201);

  // 追加另一项互不重叠的暂存修订（“不是”→“而非”），暂存集合发生变化
  const iNot3 = cpIndexOf(seg3v11, '不是');
  const r2 = await req('POST', '/api/proposals',
    { seg: 3, start: iNot3, end: iNot3 + 2, replacement: '而非', basis: '措辞统一' }, rec);
  assert.strictEqual(r2.status, 201);
  await req('POST', `/api/proposals/${r2.json.id}/adopt`, {}, rev);
  // 再驳回 r1：旧回应关联的采纳集合已改变（且暂存指纹变化）
  await req('POST', `/api/proposals/${r1.json.id}/reject`, { reason: '再斟酌' }, rev);
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(!gate.items.some((x) => x.objectionId === obid),
    '触及异议的 r1 被驳回后：暂存修订不再触及本异议，受影响集合按现状重算');
  // 记录员就同一范围重新提交新提议 r1b，复核采纳 → 旧回应须被判定失效
  const r1b = await req('POST', '/api/proposals',
    { seg: 3, start: iBei, end: iBei + 3, replacement: '应为', basis: '笔误更正（重提）' }, rec);
  assert.strictEqual(r1b.status, 201);
  await req('POST', `/api/proposals/${r1b.json.id}/adopt`, {}, rev);
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  const gB = gate.items.find((x) => x.objectionId === obid);
  ok(gB && gB.response && gB.response.invalidCode === 'STAGE_CHANGED' &&
     gB.proposalIds.includes(r1b.json.id) && !gB.proposalIds.includes(r1.json.id),
    '暂存区变化后：旧回应失效（STAGE_CHANGED），关联提议集合按当前暂存重算');
  await expectFail(req('POST', '/api/publish', { note: 'v12' }, rev),
    409, '回应已失效', '失效回应存在时发布被拒绝');
  // 重新回应（旧回应被取代留痕）后发布
  rspB = await req('POST', `/api/objections/${obid}/respond`,
    { note: '重新核对：两项措辞修订均不改变事实主张，同意随版发布。' }, rev);
  assert.strictEqual(rspB.status, 201);
  ok(rspB.json.proposalIds.includes(r1b.json.id) && rspB.json.proposalIds.includes(r2.json.id) === false,
    '重新回应按当前触及集合关联提议（只关联 r1b）');
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(gate.items.find((x) => x.objectionId === obid).satisfied, '重新回应后门槛恢复满足');
  // 发布前再新建一个落在 r2 修订范围内的异议 → 无回应，发布须被拒绝（受影响集合重新核对）
  const oNew = await req('POST', '/api/objections',
    { seg: 3, start: iNot3, end: iNot3 + 2, note: '发布前临时新增异议' }, par);
  assert.strictEqual(oNew.status, 201);
  await expectFail(req('POST', '/api/publish', { note: 'v12' }, rev),
    409, '未完成有效回应', '发布前新建被触及异议：缺失回应，拒绝发布');
  await req('POST', `/api/objections/${oNew.json.id}/respond`,
    { note: '新增异议已核实：措辞统一可接受。' }, rev);
  const pub12 = await req('POST', '/api/publish', { note: '第3段措辞修订' }, rev);
  ok(pub12.status === 201 && pub12.json.versionId === 12, '重新核对并补全新异议回应后发布 v12');

  console.log('\n[发布前异议回应：重新定位异议致回应失效]');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const seg5v12 = booth.segments.find((s) => s.seg === 5).text;
  const iHe = cpIndexOf(seg5v12, '李四本人');
  const oC = await req('POST', '/api/objections',
    { seg: 5, start: iHe, end: iHe + 4, note: '发言人身份异议' }, par);
  assert.strictEqual(oC.status, 201);
  const ocid = oC.json.id;
  const rC = await req('POST', '/api/proposals',
    { seg: 5, start: iHe, end: iHe + 4, replacement: '李四', basis: '去冗余称谓' }, rec);
  assert.strictEqual(rC.status, 201);
  await req('POST', `/api/proposals/${rC.json.id}/adopt`, {}, rev);
  await req('POST', `/api/objections/${ocid}/respond`,
    { note: '身份异议先记录，修订仅去称谓，同意发布。' }, rev);
  // 暂不重新定位：直接发布 → 异议被修订触及并置待重定位，回应随 v13 发布
  const pub13 = await req('POST', '/api/publish', { note: '第5段称谓精简' }, rev);
  ok(pub13.status === 201 && pub13.json.versionId === 13, '回应在发布时仍有效：发布 v13，异议事后置为待重定位');
  booth = (await req('GET', '/api/booth', null, par)).json;
  const oCnow = booth.objections.find((x) => x.id === ocid);
  ok(oCnow.anchor_status === 'needs_relocation', '相交修订发布后异议待重新定位（既有规则保留）');
  // 下一批修订触及重定位后的同一区域：先回应，再把异议重定位到新锚点 → 旧回应应失效
  const seg5v13 = booth.segments.find((s) => s.seg === 5).text;
  const iJi = cpIndexOf(seg5v13, '记录员核对录音');
  const rD = await req('POST', '/api/proposals',
    { seg: 5, start: iJi, end: iJi + 7, replacement: '经核对录音', basis: '精简主语' }, rec);
  assert.strictEqual(rD.status, 201);
  const adD = await req('POST', `/api/proposals/${rD.json.id}/adopt`, {}, rev);
  assert.strictEqual(adD.status, 200);
  // 参与者把异议重定位到将被 rD 触及的新范围（重定位后无任何有效回应）
  await req('POST', `/api/objections/${ocid}/relocate`,
    { seg: 5, start: iJi, end: iJi + 7 }, par);
  // 重定位后门槛立即要求重新回应（无有效回应）
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  const gC = gate.items.find((x) => x.objectionId === ocid);
  ok(gC && !gC.satisfied && gC.proposalIds.includes(rD.json.id),
    '异议重新定位后：受影响集合按新锚点重新计算，需重新回应');
  await req('POST', `/api/objections/${ocid}/respond`,
    { note: '按重定位后的锚点重新核对：精简主语不影响异议主张。' }, rev);
  const pub14 = await req('POST', '/api/publish', { note: '第5段主语精简' }, rev);
  ok(pub14.status === 201 && pub14.json.versionId === 14, '按新锚点重新回应后发布 v14');

  console.log('\n[发布前异议回应：零长度纯插入的插入点判定]');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const seg3v14 = booth.segments.find((s) => s.seg === 4).text;
  const iArgue = cpIndexOf(seg3v14, '争论日期问题');
  const oPt = await req('POST', '/api/objections',
    { seg: 4, start: iArgue, end: iArgue + 6, note: '对争论内容的异议' }, par);
  assert.strictEqual(oPt.status, 201);
  const optid = oPt.json.id;
  // 插入点恰在异议起点 → 触及
  const rPin = await req('POST', '/api/proposals',
    { seg: 4, start: iArgue, end: iArgue, replacement: '【注】', basis: '插入批注标记' }, rec);
  assert.strictEqual(rPin.status, 201);
  await req('POST', `/api/proposals/${rPin.json.id}/adopt`, {}, rev);
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(gate.items.some((x) => x.objectionId === optid && x.proposalIds.includes(rPin.json.id)),
    '零长度修订插入点等于引用起点：算触及，须回应');
  await req('POST', `/api/objections/${optid}/respond`, { note: '批注插入不改变异议所指内容。' }, rev);
  const pub15a = await req('POST', '/api/publish', { note: '插入批注' }, rev);
  ok(pub15a.status === 201, '插入点在引用范围内：回应后可发布');
  // 插入点恰在异议终点 → 不触及，无需回应即可发布
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const seg3v15 = booth.segments.find((s) => s.seg === 4).text;
  // “陈述”位于“证人王五陈述”中，与前面插入的“【注】”相距较远，作为干净的插入点边界用例
  const iBian = cpIndexOf(seg3v15, '陈述');
  const oPt2 = await req('POST', '/api/objections',
    { seg: 4, start: iBian, end: iBian + 2, note: '“陈述”二字异议' }, par);
  assert.strictEqual(oPt2.status, 201);
  const rPinEnd = await req('POST', '/api/proposals',
    { seg: 4, start: iBian + 2, end: iBian + 2, replacement: '：', basis: '插入标点（插入点=引用终点）' }, rec);
  assert.strictEqual(rPinEnd.status, 201);
  await req('POST', `/api/proposals/${rPinEnd.json.id}/adopt`, {}, rev);
  gate = (await req('GET', '/api/publish-check', null, rev)).json;
  ok(!gate.items.some((x) => x.objectionId === oPt2.json.id),
    '零长度修订插入点恰在引用终点：半开区间不算触及，无需回应');
  const pub15b = await req('POST', '/api/publish', { note: '插入标点（未触及异议）' }, rev);
  ok(pub15b.status === 201, '无受影响异议：按原规则直接发布成功');

  console.log('\n[段落保密：权限、未知段号与重复设置]');
  const v15id = (await req('GET', '/api/booth', null, rec)).json.currentVersion.id;
  ok(v15id >= 15, `保密用例起点为 v${v15id}`);
  // 无权：参与者、记录员均不能设密/解密
  await expectFail(req('POST', '/api/segments/3/conceal', {}, par), 403, '无权操作', '参与者尝试设密');
  await expectFail(req('POST', '/api/segments/3/conceal', {}, rec), 403, '无权操作', '记录员尝试设密');
  await expectFail(req('GET', '/api/segments/confidential', null, par), 403, '无权操作', '参与者尝试查看保密清单');
  await expectFail(req('GET', '/api/publish-check', null, par), 403, '无权操作', '参与者访问发布核对');
  // 未登录
  await expectFail(req('POST', '/api/segments/3/conceal', {}), 401, '未登录', '未登录设密');
  // 未知段号 → 404，不改变状态
  await expectFail(req('POST', '/api/segments/999/conceal', {}, rev), 404, '不存在', '未知段号设密');
  await expectFail(req('POST', '/api/segments/999/reveal', {}, rev), 404, '不存在', '未知段号解密');

  console.log('\n[段落保密：设密留痕与参与者视图脱敏]');
  // 第3段在 v15 含“2024年3月3日”等正文，且历史上有提议、异议、回应
  const seg3before = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 3).text;
  const con3 = await req('POST', '/api/segments/3/conceal', {}, rev);
  assert.strictEqual(con3.status, 201, `设密返回 201: ${JSON.stringify(con3.json)}`);
  ok(con3.json.log.seg === 3 && con3.json.log.action === 'conceal' &&
     con3.json.log.before_status === 'normal' && con3.json.log.after_status === 'confidential' &&
     con3.json.log.actor_user === 'reviewer',
    '设密留痕：段号、操作人（reviewer）、时间与前后状态 normal→confidential');
  // 重复设置 → 409，不改变状态
  await expectFail(req('POST', '/api/segments/3/conceal', {}, rev), 409, '已经是保密', '重复设密');

  let parBooth = (await req('GET', '/api/booth', null, par)).json;
  ok(parBooth.confidentialSegs.includes(3), '参与者总览可见保密段号集合（含 3）');
  const pSeg3 = parBooth.segments.find((s) => s.seg === 3);
  ok(pSeg3.confidential === true && pSeg3.text === '【该段已保密】',
    '参与者总览：保密段只见占位，不获得正文');
  ok(pSeg3.text !== seg3before && !JSON.stringify(parBooth.segments).includes('2024年3月3日'),
    '参与者总览任何段落都不泄露第3段正文');
  const pPreview3 = parBooth.previewSegments.find((s) => s.seg === 3);
  ok(pPreview3.confidential === true && pPreview3.text === '【该段已保密】',
    '参与者：暂存预览中保密段同样为占位（不获得暂存预览）');
  ok(parBooth.stage.every((p) => p.seg !== 3), '参与者：暂存区不包含保密段修订');
  ok(parBooth.proposals.every((p) => p.seg !== 3), '参与者：提议列表不含保密段提议（含替换文字与依据）');
  ok(!JSON.stringify(parBooth.proposals).includes('2024年3月3日') &&
     !JSON.stringify(parBooth.proposals).includes('录音核对为3月3日'),
    '参与者：提议原始摘录与依据均不泄露');
  ok(parBooth.objections.every((o) => o.seg !== 3), '参与者：异议列表不含保密段异议（原文与说明）');
  ok(!JSON.stringify(parBooth.objections).includes('日期异议：请复核员发布前说明') &&
     !JSON.stringify(parBooth.objections).includes('应当是') &&
     !JSON.stringify(parBooth.objections).includes('发布前临时新增异议') &&
     !JSON.stringify(parBooth.objections).includes('2024年3月3日'),
    '参与者：保密段异议原文快照与说明均不泄露（第3段内容）');
  ok(parBooth.currentVersion.note === '' && parBooth.versions.every((v) => v.note === ''),
    '参与者：总览与版本列表不显示版本备注');

  // 工作人员视图不受影响：正文/提议/异议/备注照常
  let revBooth = (await req('GET', '/api/booth', null, rev)).json;
  const rSeg3 = revBooth.segments.find((s) => s.seg === 3);
  ok(rSeg3.text === seg3before && !rSeg3.confidential, '复核员：保密段正文仍完整可见，原始数据不改写');
  ok(revBooth.proposals.some((p) => p.seg === 3) && revBooth.objections.some((o) => o.seg === 3),
    '复核员：保密段提议与异议照常可见，校订流程不变');
  ok(revBooth.confidential.segments.some((s) => s.seg === 3) &&
     revBooth.confidential.logs[0].seg === 3 && revBooth.confidential.logs[0].action === 'conceal',
    '复核员：保密清单与变更留痕可查（操作人、时间、前后状态）');
  const recBooth = (await req('GET', '/api/booth', null, rec)).json;
  ok(recBooth.segments.find((s) => s.seg === 3).text === seg3before &&
     recBooth.confidential && recBooth.confidential.logs.length >= 1,
    '记录员：正文可见且可只读查看保密留痕');

  console.log('\n[段落保密：参与者历史版本视图脱敏（全部历史版本）]');
  for (const vid of [1, 11, v15id]) {
    const pv = (await req('GET', `/api/versions/${vid}`, null, par)).json;
    const ps3 = pv.segments.find((s) => s.seg === 3);
    ok(ps3.confidential === true && ps3.text === '【该段已保密】',
      `参与者查看历史 v${vid}：第3段为保密占位`);
    ok(pv.note === '', `参与者查看历史 v${vid}：不显示版本备注`);
    ok(pv.decisions.every((d) => d.seg !== 3), `参与者 v${vid}：不提供保密段决议（提议/依据/摘录）`);
    ok(pv.objections.every((o) => o.seg !== 3), `参与者 v${vid}：不提供保密段异议原文与说明`);
    ok(pv.responses.every((r) => r.seg !== 3), `参与者 v${vid}：不提供保密段发布前回应`);
    // 其他段不受影响
    const other = pv.segments.find((s) => s.seg === 1);
    ok(other && !other.confidential && other.text, `参与者 v${vid}：非保密段（第1段）正文照常可见`);
    ok(pv.objections.some((o) => o.seg !== 3) === (pv.objections.length > 0),
      `参与者 v${vid}：非保密段异议照常保留`);
  }
  // v11 的归档回应（对第3段异议 oA）对参与者不可见
  const pv11par = (await req('GET', '/api/versions/11', null, par)).json;
  ok(!JSON.stringify(pv11par.responses).includes('3月3日'),
    '参与者 v11：第3段回应原文（含3月3日说明）不泄露');
  // 工作人员历史视图：原始记录完全不改写
  const pv11rev = (await req('GET', '/api/versions/11', null, rev)).json;
  ok(pv11rev.note !== '' && pv11rev.segments.find((s) => s.seg === 3).text.includes('2024年3月3日'),
    '复核员 v11：版本备注与第3段原文快照保持不变（保密不改写已发布版本）');
  ok(pv11rev.responses.some((r) => r.seg === 3 && r.note.includes('3月3日')),
    '复核员 v11：第3段回应只读归档照常可见');

  console.log('\n[段落保密：参与者不得在保密段新建或重新定位异议]');
  const seg3len = Array.from(parBooth.segments.find((s) => s.seg === 3).text).length; // 占位长度
  // 以工作人员视角的真实长度构造范围，服务端仍应按角色拒绝（而非因范围问题拒绝）
  const realLen3 = Array.from(seg3before).length;
  await expectFail(req('POST', '/api/objections',
    { seg: 3, start: 0, end: Math.min(2, realLen3), note: '保密段内新建异议' }, par),
    403, '已保密', '参与者在保密段新建异议被拒绝');
  // 参与者尝试把既有异议重定位到保密段（第3段）：拒绝；用一个参与者拥有的待重定位异议
  // 先制造一个属于 par 的待重定位异议
  const seg5now = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 5).text;
  // 取第5段开头的稳定文字作为异议锚点，再用覆盖该锚点的修订使其待重新定位
  const iHead5 = 0;
  const headText5 = Array.from(seg5now).slice(0, 3).join('');
  const oRel = await req('POST', '/api/objections',
    { seg: 5, start: iHead5, end: iHead5 + Array.from(headText5).length, note: '用于保密重定位测试的异议' }, par);
  assert.strictEqual(oRel.status, 201);
  const rRelEdit = await req('POST', '/api/proposals',
    { seg: 5, start: iHead5, end: iHead5 + Array.from(headText5).length, replacement: '【' + headText5 + '】', basis: '加标记' }, rec);
  const adRel = await req('POST', `/api/proposals/${rRelEdit.json.id}/adopt`, {}, rev);
  assert.strictEqual(adRel.status, 200, `采纳测试用修订失败: ${JSON.stringify(adRel.json)}`);
  await clearGate(rev);
  const pubRel = await req('POST', '/api/publish', { note: '制造待重定位异议' }, rev);
  assert.strictEqual(pubRel.status, 201, `制造待重定位异议的发布失败: ${JSON.stringify(pubRel.json)}`);
  const relBooth = (await req('GET', '/api/booth', null, par)).json;
  const oRelNow = relBooth.objections.find((x) => x.id === oRel.json.id);
  ok(oRelNow && oRelNow.anchor_status === 'needs_relocation', '测试前置：制造一条参与者的待重定位异议');
  await expectFail(req('POST', `/api/objections/${oRel.json.id}/relocate`,
    { seg: 3, start: 0, end: Math.min(2, realLen3) }, par),
    403, '已保密', '参与者把异议重新定位到保密段被拒绝');
  // 重定位到非保密段仍可成功（既有流程保持）：定位到修订后第5段开头的新文字
  const seg5after = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 5).text;
  const iSec2 = 0;
  const rloc = await req('POST', `/api/objections/${oRel.json.id}/relocate`,
    { seg: 5, start: iSec2, end: iSec2 + 3 }, par);
  ok(rloc.status === 200, `参与者在非保密段重新定位成功（既有重定位流程不变）：${seg5after.slice(0, 6)}`);

  console.log('\n[段落保密：工作人员校订与发布流程不受影响]');
  // 复核员仍可对保密段上的提议走采纳/驳回/发布；记录员仍可在保密段提议
  const seg3cur = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 3).text;
  const iPub = cpIndexOf(seg3cur, '李四'); // 第3段含“被申请人李四辩称”
  const pSec = await req('POST', '/api/proposals',
    { seg: 3, start: iPub, end: iPub + 2, replacement: '李四（化名）', basis: '匿名化' }, rec);
  assert.strictEqual(pSec.status, 201, '记录员在保密段仍可提交提议');
  const adSec = await req('POST', `/api/proposals/${pSec.json.id}/adopt`, {}, rev);
  ok(adSec.status === 200 && !adSec.json.markedConflict, '复核员在保密段仍可采纳提议');
  // 触及异议时回应门槛仍生效（工作人员内部流程）
  await clearGate(rev);
  const pubSec = await req('POST', '/api/publish', { note: '保密段匿名化修订' }, rev);
  ok(pubSec.status === 201, '保密段修订按既有回应/发布规则发布成功');
  const newVid = pubSec.json.versionId;
  // 发布后参与者查看新版本：保密段依旧占位，版本备注仍不显示
  const pvNew = (await req('GET', `/api/versions/${newVid}`, null, par)).json;
  ok(pvNew.segments.find((s) => s.seg === 3).text === '【该段已保密】' && pvNew.note === '',
    `发布 v${newVid} 后：参与者见占位且不见版本备注；保密以段号为准立即作用于新版本`);
  const pvNewRev = (await req('GET', `/api/versions/${newVid}`, null, rev)).json;
  ok(pvNewRev.segments.find((s) => s.seg === 3).text.includes('李四（化名）'),
    `复核员 v${newVid}：保密段修订正文照常落版`);

  console.log('\n[段落保密：解除后参与者重新可见，留痕完整]');
  // 重复解除（当前仍保密中，先测对非保密段的重复解除：用第1段）
  await expectFail(req('POST', '/api/segments/1/reveal', {}, rev), 409, '不是保密', '对非保密段解除被拒绝');
  const rev3 = await req('POST', '/api/segments/3/reveal', {}, rev);
  assert.strictEqual(rev3.status, 200, `解密返回 200: ${JSON.stringify(rev3.json)}`);
  ok(rev3.json.log.seg === 3 && rev3.json.log.action === 'reveal' &&
     rev3.json.log.before_status === 'confidential' && rev3.json.log.after_status === 'normal' &&
     rev3.json.log.actor_user === 'reviewer',
    '解密留痕：操作人、时间与前后状态 confidential→normal');
  await expectFail(req('POST', '/api/segments/3/reveal', {}, rev), 409, '不是保密', '重复解密被拒绝');
  await expectFail(req('POST', '/api/segments/999/reveal', {}, rev), 404, '不存在', '未知段号解密');
  parBooth = (await req('GET', '/api/booth', null, par)).json;
  const parSeg3after = parBooth.segments.find((s) => s.seg === 3);
  ok(!parSeg3after.confidential && parSeg3after.text.includes('李四（化名）'),
    '解除后：参与者重新可见保密段当前正文');
  ok(parBooth.proposals.some((p) => p.seg === 3) && parBooth.objections.some((o) => o.seg === 3),
    '解除后：参与者重新可见该段提议与异议');
  const pvAfter = (await req('GET', '/api/versions/1', null, par)).json;
  ok(pvAfter.segments.find((s) => s.seg === 3).text.includes('2024年3月2日'),
    '解除后：参与者历史版本 v1 第3段原文重新可见（历史记录本身从未被改写）');
  // 留痕列表按时间倒序，含 conceal 与 reveal 两条
  const logList = (await req('GET', '/api/segments/confidential', null, rev)).json;
  const seg3logs = logList.logs.filter((l) => l.seg === 3);
  ok(seg3logs.length >= 2 && seg3logs[0].action === 'reveal' &&
     seg3logs.some((l) => l.action === 'conceal') &&
     seg3logs.every((l) => l.actorName && l.createdAt && l.beforeStatus && l.afterStatus),
    '保密清单：设密与解除两条留痕均可追溯（操作人、时间、前后状态齐全）');

  console.log(`\n全部通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
