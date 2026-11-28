// 本地演练：把合成资料的故事线完整走一遍，验证三种状态可分辨——
// 名单被接收 ≠ 比赛获准开赛 ≠ 晋级被正式确认。
// 运行：npm run demo
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFrom } from '../src/seed.mjs';
import { makeSaver } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';
import { createPeer } from '../support/peer.mjs';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/records.json', import.meta.url)));
const partnerConfig = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

const dir = await mkdtemp(join(tmpdir(), 'demo-'));
const peer = createPeer(partnerConfig, join(dir, 'partner.json'));
const partnerBase = await listen(peer);
const state = seedFrom(fixtures);
const app = createApp(state, { partnerUrl: partnerBase, save: makeSaver(join(dir, 'app.json'), state) });
const base = await listen(app);

let step = 0;
const say = message => console.log(`\n${String(++step).padStart(2, '0')}. ${message}`);
const show = value => console.log('   ' + JSON.stringify(value));
const api = async (method, path, { actor, body } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
};
const clock = async now => {
  const { body } = await api('POST', '/control/clock', { body: { now } });
  console.log(`   ⏱  演练时钟 → ${body.now}`);
};

try {
  say('赛区审核报名（注册核验方只回答材料状态，不决定资格）');
  await clock('2026-11-30T09:00:00Z');
  const checked = await api('POST', '/registrations/RG-1/identity-check', { actor: 'coach-a' });
  show({ 核验方状态: checked.body.registration.identityCheck.status, 说明: checked.body.registration.identityCheck.note });
  for (const id of ['RG-1', 'RG-3', 'RG-10', 'RG-12']) await api('POST', `/registrations/${id}/review`, { actor: 'review-a', body: { decision: 'approve' } });
  for (const id of ['RG-2', 'RG-11', 'RG-13']) await api('POST', `/registrations/${id}/review`, { actor: 'review-b', body: { decision: 'approve' } });
  const cross = await api('POST', '/registrations/RG-2/review', { actor: 'review-a', body: { decision: 'approve' } });
  show({ 跨赛区审核: `${cross.status} ${cross.body.error}` });
  for (const [id, team] of [['coach-b', 'T-B'], ['coach-c', 'T-C'], ['coach-d', 'T-D']]) {
    await api('POST', '/actors', { actor: 'board', body: { id, role: 'team', team } });
  }
  await api('POST', '/actors', { actor: 'board', body: { id: 'ref-b', role: 'referee' } });

  say('队务提交比赛名单：名单被接收（状态一）');
  const roster = async (match, team, players, actor) => {
    await api('PUT', `/matches/${match}/rosters/${team}`, { actor, body: { players } });
    const submitted = await api('POST', `/matches/${match}/rosters/${team}/submit`, { actor });
    return submitted.body;
  };
  const received = await roster('G-1', 'T-A', ['P-1', 'P-10'], 'coach-a');
  show({ 名单: received.roster.status, receivedAt: received.roster.receivedAt, 提示: received.note });
  await roster('G-1', 'T-B', ['P-2', 'P-11'], 'coach-b');
  await roster('G-2', 'T-C', ['P-3', 'P-12'], 'coach-c');
  await roster('G-2', 'T-D', ['P-13'], 'coach-d');

  say('裁判确认开赛：比赛获准开赛（状态二），名单锁定');
  await clock('2026-12-01T07:55:00Z');
  const start1 = await api('POST', '/matches/G-1/start', { actor: 'ref-a' });
  show({ 状态: start1.body.match.status, 锁定名单: start1.body.lockedRosters });
  await api('POST', '/matches/G-1/events', { actor: 'ref-a', body: { eventId: 'E-1', player: 'P-1', kind: 'yellow', minute: 12, source: 'E-1' } });
  await api('POST', '/matches/G-1/finish', { actor: 'ref-a', body: { homeGoals: 2, awayGoals: 1, source: 'RESULT-1' } });
  await api('POST', '/matches/G-1/publish', { actor: 'board' });
  await clock('2026-12-01T09:55:00Z');
  await api('POST', '/matches/G-2/start', { actor: 'ref-a' });
  await api('POST', '/matches/G-2/finish', { actor: 'ref-a', body: { homeGoals: 1, awayGoals: 0 } });
  await api('POST', '/matches/G-2/publish', { actor: 'board' });
  show({ G1: 'T-A 2:1 T-B 已公示', G2: 'T-C 1:0 T-D 已公示' });

  say('公示期内 T-B 申诉被受理：晋级席位进入争议，下一轮不能以暂定胜者开赛');
  await clock('2026-12-02T07:00:00Z');
  const appeal = await api('POST', '/matches/G-1/appeals', { actor: 'coach-b', body: { reason: '球员资格材料需复核', source: 'APPEAL-1' } });
  await api('POST', `/appeals/${appeal.body.appeal.id}/review`, { actor: 'board', body: { decision: 'accept' } });
  const blockedReadiness = (await api('GET', '/matches/G-3/readiness')).body;
  show({ G3可开赛: blockedReadiness.canStart, 阻断: blockedReadiness.blockedBy.map(item => item.message) });

  say('申诉复核维持原结果，公示期届满：晋级被正式确认（状态三），G-3 席位落位');
  await api('POST', `/appeals/${appeal.body.appeal.id}/resolve`, { actor: 'board', body: { decision: 'uphold', reason: '材料复核通过，维持场上比分' } });
  await clock('2026-12-02T12:30:00Z');
  const g3 = (await api('GET', '/matches/G-3')).body.match;
  show({ G3主场: g3.slots.home, G3客场: g3.slots.away });
  await roster('G-3', 'T-A', ['P-1', 'P-10'], 'coach-a');
  await roster('G-3', 'T-C', ['P-3', 'P-12'], 'coach-c');

  say('纪律决定晚于名单提交：G-1 的红牌在开赛当天才补录');
  await clock('2026-12-03T07:45:00Z');
  await api('POST', '/matches/G-1/events', { actor: 'ref-a', body: { eventId: 'CARD-LATE-1', player: 'P-1', kind: 'red', minute: 60, source: 'CARD-LATE' } });
  const lateDup = await api('POST', '/matches/G-1/events', { actor: 'ref-b', body: { eventId: 'E-2', player: 'P-1', kind: 'red', minute: 60, source: 'E-2' } });
  show({ 另一裁判补录同一红牌: `${lateDup.status} ${lateDup.body.message}` });

  say('提交成功不等于能开赛：开赛动作判断未消化的处罚并解释阻断原因');
  await clock('2026-12-03T08:00:00Z');
  const blocked = await api('POST', '/matches/G-3/start', { actor: 'ref-a' });
  show({ 状态: blocked.status, 阻断原因: blocked.body.blockedBy.flatMap(item => item.problems ?? []).map(item => item.message) });
  await api('PUT', '/matches/G-3/rosters/T-A', { actor: 'coach-a', body: { players: ['P-10'] } });
  const started = await api('POST', '/matches/G-3/start', { actor: 'ref-a' });
  show({ 状态: started.body.match.status, 停赛消化: started.body.consumedSuspensions });

  say('转队：原队释放 + 新队赛区审核；停赛随球员走，旧队出场事实保留');
  const transfer = await api('POST', '/transfers', { actor: 'coach-c', body: { player: 'P-1', fromTeam: 'T-A', toTeam: 'T-C', source: 'TRANSFER' } });
  await api('POST', `/transfers/${transfer.body.transfer.id}/release`, { actor: 'coach-a' });
  await api('POST', `/transfers/${transfer.body.transfer.id}/review`, { actor: 'review-a', body: { decision: 'approve' } });
  const p1 = (await api('GET', '/players/P-1/record')).body;
  show({ 现球队: p1.currentTeam, 停赛剩余: p1.suspensions.map(item => `${item.kind}:${item.remaining}`), 出场: p1.appearances });

  say('资格证明更正：只影响名单锁定时证明已无效的比赛，历史不自动重算');
  await clock('2026-12-03T12:00:00Z');
  const corrected = await api('POST', '/proofs/PR-1/correct', { actor: 'review-a', body: { until: '2026-11-30', reason: '合成资料有效期更正', source: 'PROOF-CHANGE' } });
  show({ 受影响比赛: corrected.body.affectedMatches });
  const g1Result = (await api('GET', '/matches/G-1/result')).body.result;
  show({ G1场上比分: g1Result.fieldScore, 裁定: g1Result.ruling, 可用于晋级: g1Result.advancementUsable });

  say('下一轮已开赛时上轮裁决变更：不静默替换，停分支等待有原因的处置');
  const disputes = (await api('GET', '/disputes')).body.disputes;
  const eligibilityDispute = disputes.find(item => item.kind === 'eligibility-review');
  await api('POST', `/disputes/${eligibilityDispute.id}/resolve`, { actor: 'board', body: { decision: 'change', ruling: { homeGoals: 0, awayGoals: 3 }, reason: '锁定时资格无效，改判 T-B 胜' } });
  const g3Halted = (await api('GET', '/matches/G-3')).body.match;
  show({ G3主场仍为: g3Halted.home, 分支停办: g3Halted.halt?.reason });
  const haltDispute = (await api('GET', '/disputes')).body.disputes.find(item => item.kind === 'branch-halt');
  await api('POST', `/disputes/${haltDispute.id}/resolve`, { actor: 'board', body: { decision: 'uphold', reason: 'G-3 已赛事实保留，后续席位由 T-B 递补，择期重排' } });
  const g1Final = (await api('GET', '/matches/G-1/result')).body.result;
  show({ G1场上比分: g1Final.fieldScore, 裁定结果: g1Final.ruling, 当前可用于晋级: g1Final.advancementUsable });

  say('按球员、比赛、争议查回决定的依据');
  const record = (await api('GET', '/players/P-1/record')).body;
  show({ 球员: 'P-1', 事件: record.events.map(event => `${event.match}/${event.id}/${event.kind}@${event.minute}'`), 停赛: record.suspensions.map(item => `${item.kind} 余${item.remaining}`), 转队: record.transfers.map(item => item.status) });
  const inbox = (await api('GET', '/inbox')).body.inbox;
  show({ 来源资料: inbox.map(item => `${item.id}:${item.status}`) });

  console.log('\n本地演练完成：名单被接收、比赛获准开赛、晋级被正式确认是三件不同的事。');
} finally {
  await new Promise(resolve => app.close(resolve));
  await new Promise(resolve => peer.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
