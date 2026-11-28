import { readFileSync } from 'node:fs';

// 把 fixtures/records.json 的合成登记资料装入初始业务状态。
// registration 仅表示待审核资料；refereeDrafts 与 sourceChanges 进入收件箱，
// 不自动导入成已批准决定，须由有权限的角色通过业务接口处理。
export function seedFrom(fixtures) {
  const state = {
    version: 1,
    season: fixtures.rules.season,
    rules: {
      yellowThreshold: fixtures.rules.yellowThreshold,
      directRedMatches: fixtures.rules.directRedMatches,
      doubleYellowMatches: fixtures.rules.doubleYellowMatches,
      appealMinutes: fixtures.rules.appealMinutes,
      accumulatedYellowMatches: fixtures.rules.accumulatedYellowMatches ?? 1
    },
    clockNow: null,
    teams: {},
    players: {},
    actors: {},
    registrations: {},
    proofs: {},
    transfers: {},
    rosters: {},
    matches: {},
    events: {},
    suspensions: [],
    appeals: {},
    corrections: {},
    disputes: {},
    inbox: [],
    audit: [],
    counters: { transfer: 1, appeal: 1, correction: 1, dispute: 1, event: 1, registration: 1 }
  };
  for (const team of fixtures.teams) state.teams[team.id] = { id: team.id, region: team.region };
  for (const player of fixtures.players) state.players[player.id] = { id: player.id, name: player.name };
  for (const actor of fixtures.actors) {
    state.actors[actor.id] = { id: actor.id, role: actor.role, team: actor.team ?? null, region: actor.region ?? null };
  }
  for (const reg of fixtures.registrations) {
    state.registrations[reg.id] = {
      id: reg.id,
      player: reg.player,
      team: reg.team,
      proof: reg.proof,
      status: 'submitted',
      submittedBy: 'source',
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      identityCheck: null
    };
  }
  for (const proof of fixtures.proofs) {
    state.proofs[proof.id] = {
      id: proof.id,
      player: proof.player,
      validFrom: proof.validFrom,
      until: proof.until,
      corrections: [],
      revocation: null
    };
  }
  for (const match of fixtures.matches) {
    state.matches[match.id] = {
      id: match.id,
      home: match.home ?? null,
      away: match.away ?? null,
      homeWinnerOf: match.homeWinnerOf ?? null,
      awayWinnerOf: match.awayWinnerOf ?? null,
      startsAt: match.startsAt,
      status: 'scheduled',
      startedAt: null,
      startedBy: null,
      finishedAt: null,
      cancelled: null,
      result: null,
      advancement: { status: 'pending', winner: null, reason: '赛果未公示' },
      halt: null
    };
    state.events[match.id] = [];
    state.rosters[match.id] = {};
  }
  for (const draft of fixtures.refereeDrafts ?? []) {
    state.inbox.push({ id: draft.id, type: 'referee-draft', status: 'received', data: draft, handledBy: null });
  }
  for (const change of fixtures.sourceChanges ?? []) {
    state.inbox.push({ id: change.id, type: 'source-change', status: 'received', data: change, handledBy: null });
  }
  state.audit.push({ seq: 1, at: new Date(0).toISOString(), actor: 'system', action: 'seeded', subject: state.season, details: { note: '合成登记资料装入，报名均为待审核' } });
  return state;
}

export function seedFromFixtures() {
  const fixtures = JSON.parse(readFileSync(new URL('../fixtures/records.json', import.meta.url), 'utf8'));
  return seedFrom(fixtures);
}
