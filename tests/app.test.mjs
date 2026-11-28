import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFrom } from '../src/seed.mjs';
import { loadState, makeSaver } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';
import { createPeer } from '../support/peer.mjs';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/records.json', import.meta.url)));
const partnerConfig = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

async function boot(t, { partnerUrl } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'app-'));
  const stateFile = join(dir, 'app.json');
  const state = seedFrom(fixtures);
  const save = makeSaver(stateFile, state);
  const server = createApp(state, { partnerUrl, save });
  const base = await listen(server);
  t.after(async () => { await close(server); await rm(dir, { recursive: true, force: true }); });
  const api = async (method, path, { actor, body } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { api, state, stateFile, dir, base };
}

async function approveAll(api) {
  for (const id of ['RG-1', 'RG-3', 'RG-10', 'RG-12']) {
    assert.equal((await api('POST', `/registrations/${id}/review`, { actor: 'review-a', body: { decision: 'approve' } })).status, 200, id);
  }
  for (const id of ['RG-2', 'RG-11', 'RG-13']) {
    assert.equal((await api('POST', `/registrations/${id}/review`, { actor: 'review-b', body: { decision: 'approve' } })).status, 200, id);
  }
}

async function ensureActors(api) {
  for (const [id, team] of [['coach-b', 'T-B'], ['coach-c', 'T-C'], ['coach-d', 'T-D']]) {
    await api('POST', '/actors', { actor: 'board', body: { id, role: 'team', team } });
  }
  await api('POST', '/actors', { actor: 'board', body: { id: 'ref-b', role: 'referee' } });
  await api('POST', '/actors', { actor: 'board', body: { id: 'board-2', role: 'competition' } });
}

const coachOf = { 'T-A': 'coach-a', 'T-B': 'coach-b', 'T-C': 'coach-c', 'T-D': 'coach-d' };

async function submitRoster(api, match, team, players) {
  const put = await api('PUT', `/matches/${match}/rosters/${team}`, { actor: coachOf[team], body: { players } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const submit = await api('POST', `/matches/${match}/rosters/${team}/submit`, { actor: coachOf[team] });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  return submit.body.roster;
}

async function playMatch(api, { id, home, away, homePlayers, awayPlayers, homeGoals, awayGoals, at, events = [] }) {
  await api('POST', '/control/clock', { body: { now: at } });
  await submitRoster(api, id, home, homePlayers);
  await submitRoster(api, id, away, awayPlayers);
  const start = await api('POST', `/matches/${id}/start`, { actor: 'ref-a' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  for (const event of events) {
    const added = await api('POST', `/matches/${id}/events`, { actor: 'ref-a', body: event });
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }
  const finish = await api('POST', `/matches/${id}/finish`, { actor: 'ref-a', body: { homeGoals, awayGoals } });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  const publish = await api('POST', `/matches/${id}/publish`, { actor: 'board' });
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
}

test('报名审核：跨赛区拒绝、重复审核拒绝、一人一队、未识别操作人', async t => {
  const { api } = await boot(t);
  assert.equal((await api('GET', '/health')).status, 200);
  assert.equal((await api('POST', '/registrations/RG-1/review', { body: { decision: 'approve' } })).status, 401);
  assert.equal((await api('POST', '/registrations/RG-1/review', { actor: 'nobody', body: { decision: 'approve' } })).status, 401);

  const cross = await api('POST', '/registrations/RG-2/review', { actor: 'review-a', body: { decision: 'approve' } });
  assert.equal(cross.status, 403);
  assert.match(cross.body.error, /跨赛区/);

  assert.equal((await api('POST', '/registrations/RG-2/review', { actor: 'review-b', body: { decision: 'approve' } })).status, 200);
  assert.equal((await api('POST', '/registrations/RG-2/review', { actor: 'review-b', body: { decision: 'approve' } })).status, 409);

  assert.equal((await api('POST', '/registrations/RG-1/review', { actor: 'review-a', body: { decision: 'approve' } })).status, 200);
  // P-1 已代表 T-A，同赛季不能再代表 T-C。
  await api('POST', '/actors', { actor: 'board', body: { id: 'coach-c', role: 'team', team: 'T-C' } });
  const submitted = await api('POST', '/teams/T-C/registrations', { actor: 'coach-c', body: { player: 'P-1', proof: 'PR-1' } });
  assert.equal(submitted.status, 201);
  const oneTeam = await api('POST', `/registrations/${submitted.body.registration.id}/review`, { actor: 'review-a', body: { decision: 'approve' } });
  assert.equal(oneTeam.status, 409);
  assert.match(oneTeam.body.error, /一个赛季只能代表一支/);
});

test('名单被接收不等于获准开赛：缺手续阻断并说明原因，开赛后名单锁定', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  // 只批准 P-1、P-2、P-11，P-10 的报名仍未审。
  for (const id of ['RG-1', 'RG-3', 'RG-12']) await api('POST', `/registrations/${id}/review`, { actor: 'review-a', body: { decision: 'approve' } });
  for (const id of ['RG-2', 'RG-11']) await api('POST', `/registrations/${id}/review`, { actor: 'review-b', body: { decision: 'approve' } });

  // 队务不能改别队名单。
  assert.equal((await api('PUT', '/matches/G-1/rosters/T-B', { actor: 'coach-a', body: { players: ['P-2'] } })).status, 403);
  // 名单提交只做浅校验：球员存在即可被接收。
  const roster = await submitRoster(api, 'G-1', 'T-A', ['P-1', 'P-10']);
  assert.equal(roster.status, 'submitted');
  assert.ok(roster.receivedAt);
  await submitRoster(api, 'G-1', 'T-B', ['P-2', 'P-11']);

  // 队务能查到谁还缺什么手续。
  const eligibility = await api('GET', '/matches/G-1/eligibility?team=T-A');
  const p10 = eligibility.body.teams['T-A'].find(row => row.player === 'P-10');
  assert.equal(p10.ok, false);
  assert.equal(p10.missing[0].code, 'no-approved-registration');

  // 开赛动作被阻断并解释原因。
  const blocked = await api('POST', '/matches/G-1/start', { actor: 'ref-a' });
  assert.equal(blocked.status, 409);
  const problem = blocked.body.blockedBy.find(item => item.code === 'player-ineligible' && item.player === 'P-10');
  assert.ok(problem, JSON.stringify(blocked.body));
  assert.match(problem.problems[0].message, /没有 T-A 已批准的报名/);

  // 补齐手续后获准开赛，名单锁定。
  await api('POST', '/registrations/RG-10/review', { actor: 'review-a', body: { decision: 'approve' } });
  const started = await api('POST', '/matches/G-1/start', { actor: 'ref-a' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body.lockedRosters['T-A'], ['P-1', 'P-10']);
  assert.equal((await api('PUT', '/matches/G-1/rosters/T-A', { actor: 'coach-a', body: { players: ['P-1'] } })).status, 409);

  // 三种状态分明：名单已接收、比赛已开赛、晋级未确认。
  const match = (await api('GET', '/matches/G-1')).body.match;
  assert.equal(match.status, 'started');
  assert.equal(match.advancement.status, 'pending');
});

test('纪律决定晚于名单提交：开赛时阻断并说明原因；停赛只由实际开赛的本队比赛消化', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);

  await playMatch(api, {
    id: 'G-1', home: 'T-A', away: 'T-B',
    homePlayers: ['P-1', 'P-10'], awayPlayers: ['P-2', 'P-11'],
    homeGoals: 2, awayGoals: 1, at: '2026-12-01T07:55:00Z',
    events: [{ eventId: 'E-1', player: 'P-1', kind: 'yellow', minute: 12, source: 'E-1' }]
  });
  await playMatch(api, {
    id: 'G-2', home: 'T-C', away: 'T-D',
    homePlayers: ['P-3', 'P-12'], awayPlayers: ['P-13'],
    homeGoals: 1, awayGoals: 0, at: '2026-12-01T09:55:00Z'
  });

  // 公示期过后晋级自动确认，G-3 席位成为正式参赛者。
  await api('POST', '/control/clock', { body: { now: '2026-12-02T12:30:00Z' } });
  const g3 = (await api('GET', '/matches/G-3')).body.match;
  assert.equal(g3.slots.home.team, 'T-A');
  assert.equal(g3.slots.home.official, true);
  assert.equal(g3.slots.away.team, 'T-C');

  // 名单提交成功（被接收）。
  await submitRoster(api, 'G-3', 'T-A', ['P-1', 'P-10']);
  await submitRoster(api, 'G-3', 'T-C', ['P-3', 'P-12']);

  // 纪律决定迟到：G-1 的红牌在 G-3 开赛当天才录入。
  await api('POST', '/control/clock', { body: { now: '2026-12-03T07:45:00Z' } });
  const late = await api('POST', '/matches/G-1/events', { actor: 'ref-a', body: { eventId: 'CARD-LATE-1', player: 'P-1', kind: 'red', minute: 60, source: 'CARD-LATE' } });
  assert.equal(late.status, 201);

  // 提交成功不等于能开赛：开赛动作判断未消化的处罚并解释阻断原因。
  await api('POST', '/control/clock', { body: { now: '2026-12-03T08:00:00Z' } });
  const blocked = await api('POST', '/matches/G-3/start', { actor: 'ref-a' });
  assert.equal(blocked.status, 409);
  const suspension = blocked.body.blockedBy.find(item => item.code === 'player-ineligible' && item.player === 'P-1');
  assert.match(suspension.problems[0].message, /停赛未消化：direct-red 剩余 2 场/);

  // 队务改名单后获准开赛；P-1 的停赛由实际开赛的 G-3 消化一场。
  await api('PUT', '/matches/G-3/rosters/T-A', { actor: 'coach-a', body: { players: ['P-10'] } });
  const started = await api('POST', '/matches/G-3/start', { actor: 'ref-a' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body.consumedSuspensions, [{ player: 'P-1', suspension: 'red:G-1:P-1:CARD-LATE-1', match: 'G-3', remaining: 1 }]);

  // 取消的比赛不消化停赛。
  await api('POST', '/matches', { actor: 'board', body: { id: 'G-4', home: 'T-A', away: 'T-B', startsAt: '2026-12-04T08:00:00Z' } });
  await api('POST', '/matches/G-4/cancel', { actor: 'board', body: { reason: '场地积水' } });
  let record = (await api('GET', '/players/P-1/record')).body;
  assert.equal(record.suspensions[0].remaining, 1);

  // 再实际开赛一场本队比赛后消化完毕。
  await api('POST', '/matches', { actor: 'board', body: { id: 'G-5', home: 'T-A', away: 'T-B', startsAt: '2026-12-05T08:00:00Z' } });
  await api('POST', '/control/clock', { body: { now: '2026-12-05T08:00:00Z' } });
  await submitRoster(api, 'G-5', 'T-A', ['P-10']);
  await submitRoster(api, 'G-5', 'T-B', ['P-2']);
  assert.equal((await api('POST', '/matches/G-5/start', { actor: 'ref-a' })).status, 200);
  record = (await api('GET', '/players/P-1/record')).body;
  assert.equal(record.suspensions[0].remaining, 0);
});

test('两名裁判同时录入同一事实不重复累计一张牌', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  await api('POST', '/control/clock', { body: { now: '2026-12-01T07:55:00Z' } });
  await submitRoster(api, 'G-1', 'T-A', ['P-1']);
  await submitRoster(api, 'G-1', 'T-B', ['P-2']);
  await api('POST', '/matches/G-1/start', { actor: 'ref-a' });

  assert.equal((await api('POST', '/matches/G-1/events', { actor: 'ref-a', body: { eventId: 'R-1', player: 'P-1', kind: 'yellow', minute: 12 } })).status, 201);
  const dup = await api('POST', '/matches/G-1/events', { actor: 'ref-b', body: { eventId: 'R-2', player: 'P-1', kind: 'yellow', minute: 12 } });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.deduplicated, 'same-fact');
  assert.equal((await api('GET', '/matches/G-1/events')).body.events.length, 1);

  // 同编号不同资料冲突；第二张不同分钟的黄牌才形成两黄停赛。
  assert.equal((await api('POST', '/matches/G-1/events', { actor: 'ref-a', body: { eventId: 'R-1', player: 'P-1', kind: 'yellow', minute: 13 } })).status, 409);
  assert.equal((await api('POST', '/matches/G-1/events', { actor: 'ref-b', body: { eventId: 'R-3', player: 'P-1', kind: 'yellow', minute: 70 } })).status, 201);
  const record = (await api('GET', '/players/P-1/record')).body;
  assert.equal(record.suspensions.length, 1);
  assert.equal(record.suspensions[0].kind, 'double-yellow');
  assert.equal(record.suspensions[0].matches, 1);
});

test('转队要原队释放且新队赛区审核；停赛随球员走，旧队出场事实保留', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  await api('POST', '/control/clock', { body: { now: '2026-12-01T07:55:00Z' } });
  await submitRoster(api, 'G-1', 'T-A', ['P-1', 'P-10']);
  await submitRoster(api, 'G-1', 'T-B', ['P-2']);
  await api('POST', '/matches/G-1/start', { actor: 'ref-a' });
  await api('POST', '/matches/G-1/events', { actor: 'ref-a', body: { eventId: 'RED-1', player: 'P-1', kind: 'red', minute: 60 } });

  const requested = await api('POST', '/transfers', { actor: 'coach-c', body: { player: 'P-1', fromTeam: 'T-A', toTeam: 'T-C', source: 'TRANSFER' } });
  assert.equal(requested.status, 201);
  const transferId = requested.body.transfer.id;
  assert.equal((await api('POST', `/transfers/${transferId}/release`, { actor: 'coach-b' })).status, 403);
  assert.equal((await api('POST', `/transfers/${transferId}/release`, { actor: 'coach-a' })).status, 200);
  assert.equal((await api('POST', `/transfers/${transferId}/review`, { actor: 'review-b', body: { decision: 'approve' } })).status, 403);
  assert.equal((await api('POST', `/transfers/${transferId}/review`, { actor: 'review-a', body: { decision: 'approve' } })).status, 200);

  const record = (await api('GET', '/players/P-1/record')).body;
  assert.equal(record.currentTeam, 'T-C');
  assert.equal(record.suspensions[0].remaining, 2, '转队不清零停赛');
  assert.deepEqual(record.appearances, [{ match: 'G-1', team: 'T-A', lockedAt: '2026-12-01T07:55:00Z' }], '释放不抹旧队出场事实');
  const inbox = (await api('GET', '/inbox')).body.inbox;
  assert.equal(inbox.find(item => item.id === 'TRANSFER').status, 'handled');
});

test('资格证明更正按名单锁定时的资格影响比赛，不简单重算历史', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  // G-1 在 11-29 开赛（证明当时有效）。
  await playMatch(api, {
    id: 'G-1', home: 'T-A', away: 'T-B',
    homePlayers: ['P-1', 'P-10'], awayPlayers: ['P-2'],
    homeGoals: 2, awayGoals: 1, at: '2026-11-29T10:00:00Z'
  });
  // G-4 在 12-01 开赛（更正后证明在锁定时已失效）。
  await api('POST', '/matches', { actor: 'board', body: { id: 'G-4', home: 'T-A', away: 'T-B', startsAt: '2026-12-01T10:00:00Z' } });
  await playMatch(api, {
    id: 'G-4', home: 'T-A', away: 'T-B',
    homePlayers: ['P-1', 'P-10'], awayPlayers: ['P-2'],
    homeGoals: 3, awayGoals: 0, at: '2026-12-01T10:00:00Z'
  });

  const corrected = await api('POST', '/proofs/PR-1/correct', { actor: 'review-a', body: { until: '2026-11-30', reason: '合成资料有效期更正', source: 'PROOF-CHANGE' } });
  assert.equal(corrected.status, 200);
  assert.deepEqual(corrected.body.affectedMatches.map(item => item.match), ['G-4'], '只影响锁定时证明已无效的比赛');

  // G-1 的历史赛果不被重算；G-4 进入争议等待处置。
  const g1 = (await api('GET', '/matches/G-1/record')).body;
  assert.equal(g1.disputes.length, 0);
  assert.equal(g1.match.result.fieldScore.homeGoals, 2);
  const g4 = (await api('GET', '/matches/G-4/record')).body;
  assert.equal(g4.disputes[0].kind, 'eligibility-review');
  assert.equal(g4.match.result.fieldScore.homeGoals, 3, '赛果不自动改判');
  assert.equal(g4.match.advancement.status, 'blocked');
});

test('申诉受理后晋级席位处于争议中；裁定变更更新未开赛下游席位', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  await playMatch(api, {
    id: 'G-1', home: 'T-A', away: 'T-B',
    homePlayers: ['P-1'], awayPlayers: ['P-2'],
    homeGoals: 2, awayGoals: 1, at: '2026-12-01T07:55:00Z'
  });

  // 公示期内由参赛队务发起；超时限的申诉被拒绝。
  await api('POST', '/control/clock', { body: { now: '2026-12-02T07:00:00Z' } });
  const filed = await api('POST', '/matches/G-1/appeals', { actor: 'coach-b', body: { reason: '球员资格材料需复核', source: 'APPEAL-1' } });
  assert.equal(filed.status, 201);
  const accepted = await api('POST', `/appeals/${filed.body.appeal.id}/review`, { actor: 'board', body: { decision: 'accept' } });
  assert.equal(accepted.status, 200);

  // 公示期届满但申诉未结，晋级仍不能确认；下一轮不能把暂定胜者当正式参赛者。
  await api('POST', '/control/clock', { body: { now: '2026-12-02T12:00:00Z' } });
  const readiness = (await api('GET', '/matches/G-3/readiness')).body;
  assert.equal(readiness.canStart, false);
  assert.equal(readiness.blockedBy.find(item => item.code === 'slot-not-official').source, 'G-1');
  assert.equal((await api('POST', '/matches/G-3/start', { actor: 'ref-a' })).status, 409);

  // 裁定变更：胜者改判 T-B，未开赛的 G-3 席位随之更新并留审计。
  const resolved = await api('POST', `/appeals/${filed.body.appeal.id}/resolve`, {
    actor: 'board', body: { decision: 'change', ruling: { homeGoals: 0, awayGoals: 3 }, reason: '资格材料复核不通过' }
  });
  assert.equal(resolved.status, 200);
  const g3 = (await api('GET', '/matches/G-3')).body.match;
  assert.equal(g3.slots.home.team, 'T-B');
  assert.equal(g3.slots.home.official, true);
  const g1 = (await api('GET', '/matches/G-1')).body.match;
  assert.equal(g1.advancement.status, 'confirmed');
  assert.equal(g1.advancement.winner, 'T-B');
  const audit = (await api('GET', '/audit?subject=G-3')).body.audit;
  assert.ok(audit.some(entry => entry.action === 'slot-updated' && entry.details.after === 'T-B'));

  // 超出申诉时限的申诉不予受理。
  const late = await api('POST', '/matches/G-1/appeals', { actor: 'coach-a', body: { reason: '太晚' } });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /超出申诉时限/);
});

test('下一轮已开赛时上轮裁决变更：不静默替换、停分支、有原因处置后继续', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  await playMatch(api, {
    id: 'G-1', home: 'T-A', away: 'T-B',
    homePlayers: ['P-1', 'P-10'], awayPlayers: ['P-2'],
    homeGoals: 2, awayGoals: 1, at: '2026-12-01T07:55:00Z'
  });
  await playMatch(api, {
    id: 'G-2', home: 'T-C', away: 'T-D',
    homePlayers: ['P-3'], awayPlayers: ['P-13'],
    homeGoals: 1, awayGoals: 0, at: '2026-12-01T09:55:00Z'
  });
  await api('POST', '/control/clock', { body: { now: '2026-12-02T12:30:00Z' } });
  await submitRoster(api, 'G-3', 'T-A', ['P-1', 'P-10']);
  await submitRoster(api, 'G-3', 'T-C', ['P-3']);
  await api('POST', '/control/clock', { body: { now: '2026-12-03T08:00:00Z' } });
  assert.equal((await api('POST', '/matches/G-3/start', { actor: 'ref-a' })).status, 200);

  // 证明更正使 G-1 资格进入争议；裁定变更后 G-1 胜者改为 T-B。
  await api('POST', '/proofs/PR-1/correct', { actor: 'review-a', body: { until: '2026-11-30', reason: '有效期更正' } });
  const disputes = (await api('GET', '/disputes')).body.disputes;
  const eligibilityDispute = disputes.find(item => item.kind === 'eligibility-review' && item.match === 'G-1');
  const resolved = await api('POST', `/disputes/${eligibilityDispute.id}/resolve`, {
    actor: 'board', body: { decision: 'change', ruling: { homeGoals: 0, awayGoals: 3 }, reason: '锁定时资格无效，改判' }
  });
  assert.equal(resolved.status, 200);

  // G-3 已开赛：参赛球队不被替换，已发生的出场保留，分叉停止自动推进。
  const g3 = (await api('GET', '/matches/G-3')).body.match;
  assert.equal(g3.home, 'T-A');
  assert.ok(g3.halt, '分支应停止自动推进');
  const appearances = (await api('GET', '/players/P-1/record')).body.appearances;
  assert.ok(appearances.some(item => item.match === 'G-3' && item.team === 'T-A'), '已发生的出场不撤掉');
  const haltDispute = (await api('GET', '/disputes')).body.disputes.find(item => item.kind === 'branch-halt');
  assert.equal(haltDispute.match, 'G-3');

  // 未受影响的对阵不受影响；组织者作出有原因的处置后分支继续。
  assert.equal((await api('GET', '/matches/G-2')).body.match.advancement.status, 'confirmed');
  const noReason = await api('POST', `/disputes/${haltDispute.id}/resolve`, { actor: 'board', body: { decision: 'uphold' } });
  assert.equal(noReason.status, 400);
  const resumed = await api('POST', `/disputes/${haltDispute.id}/resolve`, {
    actor: 'board', body: { decision: 'uphold', reason: 'G-3 已赛事实保留，后续席位由 T-B 递补，择期安排' }
  });
  assert.equal(resumed.status, 200);
  assert.equal((await api('GET', '/matches/G-3')).body.match.halt, null);
});

test('误录纠正须经赛事复核并说明影响；申请人不能批准自己的纠正；已赛比赛进争议', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  await api('POST', '/control/clock', { body: { now: '2026-12-01T07:55:00Z' } });
  await submitRoster(api, 'G-1', 'T-A', ['P-1', 'P-10']);
  await submitRoster(api, 'G-1', 'T-B', ['P-2']);
  await api('POST', '/matches/G-1/start', { actor: 'ref-a' });
  await api('POST', '/matches/G-1/events', { actor: 'ref-a', body: { eventId: 'EV-A', player: 'P-1', kind: 'red', minute: 60 } });
  assert.equal((await api('GET', '/players/P-1/record')).body.suspensions.length, 1);

  // 申请人不能批准自己的纠正。
  const own = await api('POST', '/corrections', { actor: 'board', body: { subjectType: 'event', subjectId: 'G-1/EV-A', changes: { withdraw: true }, reason: '误录身份' } });
  assert.equal(own.status, 201);
  const selfReview = await api('POST', `/corrections/${own.body.correction.id}/review`, { actor: 'board', body: { decision: 'approve', impact: 'x' } });
  assert.equal(selfReview.status, 403);
  assert.match(selfReview.body.error, /不能批准自己的纠正/);

  // 批准必须说明影响；批准后事件被取代、停赛重算、已赛比赛进争议，名单不删改。
  const noImpact = await api('POST', `/corrections/${own.body.correction.id}/review`, { actor: 'board-2', body: { decision: 'approve' } });
  assert.equal(noImpact.status, 400);
  const approved = await api('POST', `/corrections/${own.body.correction.id}/review`, {
    actor: 'board-2', body: { decision: 'approve', impact: 'P-1 红牌撤销，G-1 已赛事实保留，资格争议复核' }
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.body.applied.affectedMatches, ['G-1']);
  const events = (await api('GET', '/matches/G-1/events')).body.events;
  assert.equal(events.find(event => event.id === 'EV-A').status, 'superseded');
  assert.equal((await api('GET', '/players/P-1/record')).body.suspensions.length, 0);
  const record = (await api('GET', '/matches/G-1/record')).body;
  assert.equal(record.disputes[0].kind, 'correction-impact');
  assert.deepEqual(record.rosters['T-A'].players, ['P-1', 'P-10'], '已开始比赛的名单不删改');
});

test('公布的结果区分场上比分、裁定结果及当前能否用于晋级', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  await playMatch(api, {
    id: 'G-1', home: 'T-A', away: 'T-B',
    homePlayers: ['P-1'], awayPlayers: ['P-2'],
    homeGoals: 2, awayGoals: 1, at: '2026-12-01T07:55:00Z'
  });
  let result = (await api('GET', '/matches/G-1/result')).body.result;
  assert.deepEqual(result.fieldScore, { homeGoals: 2, awayGoals: 1 });
  assert.equal(result.ruling, null);
  assert.equal(result.advancementUsable.usable, false, '公示期内不能用于晋级');

  await api('POST', '/control/clock', { body: { now: '2026-12-02T08:06:00Z' } });
  result = (await api('GET', '/matches/G-1/result')).body.result;
  assert.equal(result.advancementUsable.usable, true);
  assert.equal(result.advancementUsable.winner, 'T-A');

  const filed = await api('POST', '/matches/G-1/appeals', { actor: 'coach-b', body: { reason: '比分争议' } });
  assert.equal(filed.status, 409, '公示期已满不能申诉');
});

test('累计黄牌达到赛事阈值产生停赛', async t => {
  const { api } = await boot(t);
  await ensureActors(api);
  await approveAll(api);
  await api('POST', '/matches', { actor: 'board', body: { id: 'G-4', home: 'T-A', away: 'T-B', startsAt: '2026-12-02T08:00:00Z' } });
  await api('POST', '/matches', { actor: 'board', body: { id: 'G-5', home: 'T-A', away: 'T-B', startsAt: '2026-12-03T08:00:00Z' } });
  const yellow = (id, minute) => ({ eventId: `Y-${id}`, player: 'P-10', kind: 'yellow', minute });
  await playMatch(api, { id: 'G-1', home: 'T-A', away: 'T-B', homePlayers: ['P-10'], awayPlayers: ['P-2'], homeGoals: 1, awayGoals: 0, at: '2026-12-01T08:00:00Z', events: [yellow('G-1', 10)] });
  await playMatch(api, { id: 'G-4', home: 'T-A', away: 'T-B', homePlayers: ['P-10'], awayPlayers: ['P-2'], homeGoals: 1, awayGoals: 0, at: '2026-12-02T08:00:00Z', events: [yellow('G-4', 20)] });
  assert.equal((await api('GET', '/players/P-10/record')).body.suspensions.length, 0);
  await playMatch(api, { id: 'G-5', home: 'T-A', away: 'T-B', homePlayers: ['P-10'], awayPlayers: ['P-2'], homeGoals: 1, awayGoals: 0, at: '2026-12-03T08:00:00Z', events: [yellow('G-5', 30)] });
  const suspensions = (await api('GET', '/players/P-10/record')).body.suspensions;
  assert.equal(suspensions.length, 1);
  assert.equal(suspensions[0].kind, 'accumulated-yellow');
  assert.equal(suspensions[0].sourceMatch, 'G-5');
});

test('持久化：同一状态文件重启后保留业务状态', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'app-persist-'));
  const stateFile = join(dir, 'app.json');
  t.after(async () => rm(dir, { recursive: true, force: true }));

  let state = seedFrom(fixtures);
  let server = createApp(state, { save: makeSaver(stateFile, state) });
  let base = await listen(server);
  const review = await fetch(`${base}/registrations/RG-1/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'review-a' }, body: JSON.stringify({ decision: 'approve' })
  });
  assert.equal(review.status, 200);
  await close(server);

  const loaded = loadState(stateFile, () => { throw new Error('不应重新种子'); });
  server = createApp(loaded.state, { save: makeSaver(stateFile, loaded.state) });
  base = await listen(server);
  const registration = await (await fetch(`${base}/registrations/RG-1`)).json();
  assert.equal(registration.registration.status, 'approved');
  assert.equal(registration.registration.reviewedBy, 'review-a');
  await close(server);
});

test('身份核验方只回答身份材料状态，不决定当场名单和晋级', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'peer-'));
  const peer = createPeer(partnerConfig, join(dir, 'partner.json'));
  const peerBase = await listen(peer);
  t.after(async () => { await close(peer); await rm(dir, { recursive: true, force: true }); });

  const { api } = await boot(t, { partnerUrl: peerBase });
  const checked = await api('POST', '/registrations/RG-1/identity-check', { actor: 'coach-a' });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.registration.identityCheck.status, 'accepted');

  // 核验方已受理，但报名未审批准，球员仍不能上场。
  const eligibility = await api('GET', '/matches/G-1/eligibility?team=T-A');
  const p1 = eligibility.body.teams['T-A'].find(row => row.player === 'P-1');
  assert.equal(p1.ok, false);
  assert.equal(p1.missing[0].code, 'no-approved-registration');
  assert.equal(p1.registration.identityCheck.status, 'accepted');
});
