import { HttpError, nowOf, audit, dateOf } from './store.mjs';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const get = (obj, key) => (has(obj, key) ? obj[key] : undefined);
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isIso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));

export function mustActor(actor) {
  if (!actor) throw new HttpError(401, '缺少 X-Actor-Id 操作人');
  return actor;
}

export function requireRole(actor, roles) {
  mustActor(actor);
  if (!roles.includes(actor.role)) throw new HttpError(403, `角色 ${actor.role} 无权执行该操作`);
}

export function must(value, message) {
  if (value === undefined || value === null) throw new HttpError(404, message);
  return value;
}

function validId(id, what) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || FORBIDDEN_IDS.has(id)) {
    throw new HttpError(400, `${what}编号不符`);
  }
  return id;
}

const teamOf = (state, id) => must(get(state.teams, id), `球队 ${id} 不存在`);
const playerOf = (state, id) => must(get(state.players, id), `球员 ${id} 不存在`);
const matchOf = (state, id) => must(get(state.matches, id), `比赛 ${id} 不存在`);
const registrationOf = (state, id) => must(get(state.registrations, id), `报名 ${id} 不存在`);
const proofOf = (state, id) => must(get(state.proofs, id), `资格证明 ${id} 不存在`);

function markHandled(state, source, action, actor, { soft = false } = {}) {
  if (!source) return;
  const item = state.inbox.find(entry => entry.id === source);
  if (!item) throw new HttpError(400, `来源资料 ${source} 不在收件箱`);
  if (item.status === 'handled') {
    if (soft) return;
    throw new HttpError(409, `来源资料 ${source} 已被处理`, { handledBy: item.handledBy });
  }
  item.status = 'handled';
  item.handledBy = { action, actor: actor?.id ?? 'system', at: nowOf(state) };
}

// ---------------------------------------------------------------------------
// 资格与停赛推导
// ---------------------------------------------------------------------------

// 球员当前仍有效的球队：已批准且未被释放的报名。一个赛季至多一个。
export function currentTeamOf(state, playerId) {
  const approved = Object.values(state.registrations)
    .filter(reg => reg.player === playerId && reg.status === 'approved')
    .sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt)));
  return approved.length ? approved[approved.length - 1].team : null;
}

// 证明的当前有效窗口（更正会覆盖原始日期，不抹掉原记录）。
export function proofWindow(proof) {
  let { validFrom, until } = proof;
  for (const correction of proof.corrections) {
    if (correction.validFrom) validFrom = correction.validFrom;
    if (correction.until) until = correction.until;
  }
  return { validFrom, until };
}

// 证明在某个日历日是否有效：窗口包含端点；撤销自 effectiveDate 起生效。
export function proofValidityAt(proof, date) {
  const { validFrom, until } = proofWindow(proof);
  if (date < validFrom) return { valid: false, reason: `有效期自 ${validFrom} 起` };
  if (date > until) return { valid: false, reason: `有效期至 ${until} 止` };
  if (proof.revocation && date >= proof.revocation.effectiveDate) {
    return { valid: false, reason: `自 ${proof.revocation.effectiveDate} 起被撤销：${proof.revocation.reason}` };
  }
  return { valid: true };
}

// 从已确认事件重算全部停赛。停赛键稳定，重算保留已消化场次；
// 更正事件（superseded）不再参与推导，但旧事实留在事件流里。
export function recomputeSuspensions(state) {
  const previous = new Map(state.suspensions.map(item => [item.key, item]));
  const next = [];
  const started = Object.values(state.matches)
    .filter(match => match.startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const yellowTotal = {};
  for (const match of started) {
    const byPlayer = {};
    for (const event of state.events[match.id] ?? []) {
      if (event.status !== 'confirmed') continue;
      (byPlayer[event.player] ??= []).push(event);
    }
    for (const [player, list] of Object.entries(byPlayer)) {
      const yellows = list.filter(event => event.kind === 'yellow').sort((a, b) => a.minute - b.minute);
      const reds = list.filter(event => event.kind === 'red');
      for (const yellow of yellows) {
        yellowTotal[player] = (yellowTotal[player] ?? 0) + 1;
        if (yellowTotal[player] % state.rules.yellowThreshold === 0) {
          next.push({
            key: `acc:${player}:${yellowTotal[player]}`,
            player,
            kind: 'accumulated-yellow',
            matches: state.rules.accumulatedYellowMatches,
            sourceMatch: match.id,
            sourceEvents: [yellow.id],
            createdAt: yellow.at
          });
        }
      }
      if (yellows.length >= 2) {
        next.push({
          key: `dy:${match.id}:${player}`,
          player,
          kind: 'double-yellow',
          matches: state.rules.doubleYellowMatches,
          sourceMatch: match.id,
          sourceEvents: yellows.slice(0, 2).map(event => event.id),
          createdAt: yellows[1].at
        });
      }
      for (const red of reds) {
        next.push({
          key: `red:${match.id}:${player}:${red.id}`,
          player,
          kind: 'direct-red',
          matches: state.rules.directRedMatches,
          sourceMatch: match.id,
          sourceEvents: [red.id],
          createdAt: red.at
        });
      }
    }
  }
  state.suspensions = next.map(item => ({ ...item, served: previous.get(item.key)?.served ?? [] }));
}

export const suspensionRemaining = item => item.matches - item.served.length;

// 球员在某一时刻仍未消化的停赛。
export function activeSuspensions(state, playerId, at) {
  return state.suspensions.filter(item => item.player === playerId && item.createdAt <= at && suspensionRemaining(item) > 0);
}

// 比赛实际开赛时消化停赛：只计处罚生效后、本队（球员当前有效球队）实际开赛的比赛；
// 轮空没有比赛、取消的比赛从未开赛，都不消化。
function consumeSuspensions(state, match) {
  const consumed = [];
  for (const teamId of [match.home, match.away]) {
    for (const item of state.suspensions) {
      if (suspensionRemaining(item) <= 0) continue;
      if (!(item.createdAt < match.startedAt)) continue;
      if (item.served.includes(match.id)) continue;
      if (currentTeamOf(state, item.player) !== teamId) continue;
      item.served.push(match.id);
      consumed.push({ player: item.player, suspension: item.key, match: match.id, remaining: suspensionRemaining(item) });
    }
  }
  return consumed;
}

// 某球员代表某球队在某一时刻能否上场；返回缺的手续，供队务与开赛判断共用。
export function eligibility(state, playerId, teamId, at) {
  const problems = [];
  const registration = Object.values(state.registrations)
    .find(reg => reg.player === playerId && reg.team === teamId && reg.status === 'approved');
  if (!registration) {
    problems.push({ code: 'no-approved-registration', message: `球员 ${playerId} 没有 ${teamId} 已批准的报名` });
  } else {
    const proof = get(state.proofs, registration.proof);
    const validity = proof ? proofValidityAt(proof, dateOf(at)) : { valid: false, reason: '证明不存在' };
    if (!validity.valid) {
      problems.push({ code: 'proof-invalid', message: `资格证明 ${registration.proof} 在 ${dateOf(at)} 无效：${validity.reason}` });
    }
  }
  for (const item of activeSuspensions(state, playerId, at)) {
    problems.push({
      code: 'suspension-active',
      message: `停赛未消化：${item.kind} 剩余 ${suspensionRemaining(item)} 场（来源比赛 ${item.sourceMatch}）`
    });
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 晋级与争议
// ---------------------------------------------------------------------------

const winnerOf = (state, match) => {
  if (!match.result) return null;
  const score = match.result.ruling ?? match.result;
  if (score.homeGoals > score.awayGoals) return match.home;
  if (score.awayGoals > score.homeGoals) return match.away;
  return null;
};

function openIssues(state, matchId) {
  const issues = [];
  for (const appeal of Object.values(state.appeals)) {
    if (appeal.match === matchId && (appeal.status === 'filed' || appeal.status === 'accepted')) {
      issues.push(`申诉 ${appeal.id}（${appeal.status}）`);
    }
  }
  for (const dispute of Object.values(state.disputes)) {
    if (dispute.match === matchId && dispute.status === 'open') issues.push(`争议 ${dispute.id}（${dispute.kind}）`);
  }
  return issues;
}

function openDispute(state, kind, matchId, cause, openedBy) {
  const existing = Object.values(state.disputes).find(
    dispute => dispute.status === 'open' && dispute.kind === kind && dispute.match === matchId
      && JSON.stringify(dispute.cause) === JSON.stringify(cause)
  );
  if (existing) return existing;
  const dispute = {
    id: `D-${state.counters.dispute++}`,
    kind,
    match: matchId,
    status: 'open',
    cause,
    openedBy: openedBy ?? 'system',
    openedAt: nowOf(state),
    resolution: null
  };
  state.disputes[dispute.id] = dispute;
  audit(state, openedBy ?? 'system', 'dispute-opened', matchId, { dispute: dispute.id, kind, cause });
  return dispute;
}

// 晋级被正式确认：结果已公示、公示期已满、无未结申诉或争议、有效比分有胜者。
// 确认后把胜者填入下游席位（自动推进）。
function tryConfirm(state, match) {
  if (match.advancement.status === 'confirmed') return false;
  if (!match.result || match.result.status !== 'published') {
    match.advancement = { status: 'pending', winner: null, reason: '赛果未公示' };
    return false;
  }
  const issues = openIssues(state, match.id);
  if (issues.length) {
    match.advancement = { status: 'blocked', winner: null, blockedReason: `存在未结事项：${issues.join('、')}` };
    return false;
  }
  const windowEnd = Date.parse(match.result.publishedAt) + state.rules.appealMinutes * 60000;
  if (Date.parse(nowOf(state)) < windowEnd) {
    match.advancement = { status: 'pending', winner: null, reason: `公示期至 ${new Date(windowEnd).toISOString()}` };
    return false;
  }
  const winner = winnerOf(state, match);
  if (!winner) {
    match.advancement = { status: 'blocked', winner: null, blockedReason: '有效比分持平，需赛事裁定' };
    return false;
  }
  match.advancement = { status: 'confirmed', winner, confirmedAt: nowOf(state) };
  audit(state, 'system', 'advancement-confirmed', match.id, { winner });
  propagateWinner(state, match);
  return true;
}

// 把胜者传入下游：未开赛比赛更新席位（留审计）；已开赛比赛绝不静默替换，
// 停止该分叉的自动推进并挂出争议，等待有原因的处置。
function propagateWinner(state, source) {
  const winner = winnerOf(state, source);
  for (const match of Object.values(state.matches)) {
    for (const side of ['home', 'away']) {
      const sourceId = side === 'home' ? match.homeWinnerOf : match.awayWinnerOf;
      if (sourceId !== source.id) continue;
      if (match.status === 'scheduled') {
        if (match[side] !== winner) {
          const before = match[side];
          match[side] = winner;
          audit(state, 'system', 'slot-updated', match.id, { side, before, after: winner, source: source.id });
        }
      } else if ((match.status === 'started' || match.status === 'finished') && match[side] !== winner && !match.halt) {
        match.halt = {
          reason: `上游 ${source.id} 晋级变更为 ${winner}，本分叉停止自动推进，等待有原因的处置`,
          at: nowOf(state),
          cause: source.id
        };
        openDispute(state, 'branch-halt', match.id, { source: source.id, expected: winner, actual: match[side] }, 'system');
        audit(state, 'system', 'branch-halted', match.id, { source: source.id, expected: winner, actual: match[side] });
      }
    }
  }
}

// 出现未决争议时暂停该场晋级的可用性；下游未开赛比赛因来源不再是 confirmed 而无法开赛。
function suspendAdvancement(state, match, reason) {
  if (match.advancement.status !== 'confirmed') return;
  match.advancement = { status: 'blocked', winner: match.advancement.winner, blockedReason: reason };
  audit(state, 'system', 'advancement-suspended', match.id, { reason });
}

// 每个请求都会调用：按当前时间重估各场晋级状态（公示期届满自动确认）。
export function refresh(state) {
  let changed = false;
  for (const match of Object.values(state.matches)) changed = tryConfirm(state, match) || changed;
  return changed;
}

// 申诉或争议的处置结果：维持原结果或写入裁定结果。裁定与场上比分分开保存。
function applyOutcome(state, match, decision, ruling, reason, actor) {
  const now = nowOf(state);
  if (decision === 'change') {
    if (!ruling || !Number.isInteger(ruling.homeGoals) || !Number.isInteger(ruling.awayGoals)
      || ruling.homeGoals < 0 || ruling.awayGoals < 0) {
      throw new HttpError(400, '变更裁定需给出非负整数裁定比分 ruling.homeGoals / ruling.awayGoals');
    }
    if (!match.result) throw new HttpError(409, '比赛尚无结果可裁定');
    match.result.ruling = { homeGoals: ruling.homeGoals, awayGoals: ruling.awayGoals, note: reason ?? null, by: actor.id, at: now };
    audit(state, actor.id, 'ruling-applied', match.id, { ruling, reason });
    if (match.advancement.status === 'confirmed') {
      const winner = winnerOf(state, match);
      if (winner !== match.advancement.winner) {
        match.advancement = { status: 'confirmed', winner, confirmedAt: match.advancement.confirmedAt, revisedAt: now };
        audit(state, actor.id, 'advancement-revised', match.id, { winner });
        propagateWinner(state, match);
      }
    }
  } else {
    audit(state, actor.id, 'result-upheld', match.id, { reason });
  }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export function advancementUsable(state, match) {
  const advancement = match.advancement;
  if (advancement.status === 'confirmed') {
    return { usable: true, winner: advancement.winner, confirmedAt: advancement.confirmedAt, revisedAt: advancement.revisedAt ?? null };
  }
  return { usable: false, reason: advancement.blockedReason ?? advancement.reason ?? '晋级未确认' };
}

export function resultView(state, match) {
  const result = match.result;
  if (!result) return null;
  return {
    status: result.status,
    fieldScore: { homeGoals: result.homeGoals, awayGoals: result.awayGoals },
    ruling: result.ruling,
    effectiveScore: result.ruling
      ? { homeGoals: result.ruling.homeGoals, awayGoals: result.ruling.awayGoals }
      : { homeGoals: result.homeGoals, awayGoals: result.awayGoals },
    publishedAt: result.publishedAt,
    advancementUsable: advancementUsable(state, match)
  };
}

export function matchView(state, match) {
  const slot = (team, sourceId) => {
    if (!sourceId) return { team, official: Boolean(team) };
    const source = get(state.matches, sourceId);
    return {
      team,
      source: `winnerOf:${sourceId}`,
      official: source?.advancement.status === 'confirmed' && source.advancement.winner === team
    };
  };
  return {
    id: match.id,
    startsAt: match.startsAt,
    status: match.status,
    home: match.home,
    away: match.away,
    slots: { home: slot(match.home, match.homeWinnerOf), away: slot(match.away, match.awayWinnerOf) },
    startedAt: match.startedAt,
    finishedAt: match.finishedAt,
    cancelled: match.cancelled,
    halt: match.halt,
    advancement: match.advancement,
    result: resultView(state, match)
  };
}

function registrationView(state, reg) {
  return {
    id: reg.id,
    player: reg.player,
    team: reg.team,
    proof: reg.proof,
    status: reg.status,
    submittedBy: reg.submittedBy,
    submittedAt: reg.submittedAt,
    reviewedBy: reg.reviewedBy,
    reviewedAt: reg.reviewedAt,
    reviewNote: reg.reviewNote,
    identityCheck: reg.identityCheck
  };
}

function proofView(state, proof) {
  const now = nowOf(state);
  return {
    id: proof.id,
    player: proof.player,
    window: proofWindow(proof),
    original: { validFrom: proof.validFrom, until: proof.until },
    corrections: proof.corrections,
    revocation: proof.revocation,
    validAt: { date: dateOf(now), ...proofValidityAt(proof, dateOf(now)) }
  };
}

function suspensionView(item) {
  return { ...item, remaining: suspensionRemaining(item) };
}

function rosterView(roster) {
  if (!roster) return { status: 'missing' };
  return {
    status: roster.status,
    players: roster.players,
    version: roster.version,
    receivedAt: roster.receivedAt,
    lockedAt: roster.lockedAt,
    history: roster.history
  };
}

// 开赛 readiness：名单被接收不等于获准开赛；此处汇总全部阻断原因。
export function readiness(state, match) {
  const blockedBy = [];
  if (match.status !== 'scheduled') blockedBy.push({ code: 'status', message: `比赛状态为 ${match.status}，不能开赛` });
  if (match.halt) blockedBy.push({ code: 'branch-halted', message: match.halt.reason });
  for (const [side, sourceId] of [['home', match.homeWinnerOf], ['away', match.awayWinnerOf]]) {
    const team = side === 'home' ? match.home : match.away;
    if (sourceId) {
      const source = get(state.matches, sourceId);
      const official = source?.advancement.status === 'confirmed' && source.advancement.winner === team;
      if (!official) {
        blockedBy.push({
          code: 'slot-not-official',
          side,
          source: sourceId,
          message: `${side} 席位来源 ${sourceId} 的晋级未正式确认（${source?.advancement.status ?? '未知'}），暂定胜者不能当作正式参赛者`
        });
      }
    } else if (!team) {
      blockedBy.push({ code: 'slot-empty', side, message: `${side} 席位未定` });
    }
  }
  for (const teamId of [match.home, match.away].filter(Boolean)) {
    const roster = get(state.rosters, match.id)?.[teamId];
    if (!roster || roster.status === 'draft') {
      blockedBy.push({ code: 'roster-not-submitted', team: teamId, message: `${teamId} 的比赛名单尚未被接收` });
      continue;
    }
    if (match.status === 'scheduled') {
      for (const playerId of roster.players) {
        const check = eligibility(state, playerId, teamId, nowOf(state));
        if (!check.ok) blockedBy.push({ code: 'player-ineligible', team: teamId, player: playerId, problems: check.problems });
      }
    }
  }
  return { canStart: blockedBy.length === 0, blockedBy };
}

// ---------------------------------------------------------------------------
// 操作人
// ---------------------------------------------------------------------------

export function createActor(state, actor, body) {
  requireRole(actor, ['competition']);
  const { id, role, team = null, region = null } = body ?? {};
  validId(id, '操作人');
  if (get(state.actors, id)) throw new HttpError(409, `操作人 ${id} 已存在`);
  if (!['team', 'region', 'referee', 'competition'].includes(role)) throw new HttpError(400, '角色须为 team/region/referee/competition');
  if (role === 'team') teamOf(state, team);
  if (role === 'region' && (typeof region !== 'string' || !region)) throw new HttpError(400, '赛区角色需给出 region');
  state.actors[id] = { id, role, team: role === 'team' ? team : null, region: role === 'region' ? region : null };
  audit(state, actor.id, 'actor-created', id, { role, team, region });
  return { status: 201, body: { actor: state.actors[id] } };
}

// ---------------------------------------------------------------------------
// 报名与审核
// ---------------------------------------------------------------------------

export function createPlayer(state, actor, body) {
  requireRole(actor, ['competition']);
  const { id, name } = body ?? {};
  validId(id, '球员');
  if (get(state.players, id)) throw new HttpError(409, `球员 ${id} 已存在`);
  state.players[id] = { id, name: typeof name === 'string' ? name : id };
  audit(state, actor.id, 'player-created', id, { name });
  return { status: 201, body: { player: state.players[id] } };
}

export function createProof(state, actor, body) {
  requireRole(actor, ['competition', 'region']);
  const { id, player, validFrom, until } = body ?? {};
  validId(id, '证明');
  if (get(state.proofs, id)) throw new HttpError(409, `证明 ${id} 已存在`);
  playerOf(state, player);
  if (!isDate(validFrom) || !isDate(until) || validFrom > until) throw new HttpError(400, '有效期须为 YYYY-MM-DD 且起不晚于止');
  state.proofs[id] = { id, player, validFrom, until, corrections: [], revocation: null };
  audit(state, actor.id, 'proof-created', id, { player, validFrom, until });
  return { status: 201, body: { proof: proofView(state, state.proofs[id]) } };
}

export function submitRegistration(state, actor, teamId, body) {
  requireRole(actor, ['team']);
  const team = teamOf(state, teamId);
  if (actor.team !== teamId) throw new HttpError(403, '队务只能为本队提交报名');
  const { player, proof } = body ?? {};
  playerOf(state, player);
  const proofRow = proofOf(state, proof);
  if (proofRow.player !== player) throw new HttpError(400, `证明 ${proof} 不属于球员 ${player}`);
  const duplicate = Object.values(state.registrations).find(
    reg => reg.player === player && reg.team === teamId && (reg.status === 'submitted' || reg.status === 'approved')
  );
  if (duplicate) throw new HttpError(409, `球员 ${player} 在 ${teamId} 已有 ${duplicate.status} 的报名 ${duplicate.id}`);
  const id = `RG-N${state.counters.registration++}`;
  const now = nowOf(state);
  state.registrations[id] = {
    id, player, team: teamId, proof,
    status: 'submitted', submittedBy: actor.id, submittedAt: now,
    reviewedBy: null, reviewedAt: null, reviewNote: null, identityCheck: null
  };
  markHandled(state, body?.source, 'registration-submitted', actor);
  audit(state, actor.id, 'registration-submitted', id, { player, team: teamId, proof, region: team.region });
  return { status: 201, body: { registration: registrationView(state, state.registrations[id]) } };
}

export function reviewRegistration(state, actor, id, body) {
  requireRole(actor, ['region']);
  const reg = registrationOf(state, id);
  const team = teamOf(state, reg.team);
  if (actor.region !== team.region) throw new HttpError(403, `赛区审核人不能跨赛区审核（本赛区 ${actor.region}，报名所属 ${team.region}）`);
  if (reg.status !== 'submitted') throw new HttpError(409, `报名状态为 ${reg.status}，不能重复审核`);
  if (reg.submittedBy === actor.id) throw new HttpError(403, '资料申请人不能批准自己的资格');
  const { decision, reason } = body ?? {};
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision 须为 approve 或 reject');
  if (decision === 'approve') {
    const other = Object.values(state.registrations).find(
      item => item.player === reg.player && item.id !== reg.id && item.status === 'approved' && item.team !== reg.team
    );
    if (other) {
      throw new HttpError(409, `球员 ${reg.player} 本赛季已代表 ${other.team}（报名 ${other.id}），一个赛季只能代表一支仍有效的球队`);
    }
  }
  reg.status = decision === 'approve' ? 'approved' : 'rejected';
  reg.reviewedBy = actor.id;
  reg.reviewedAt = nowOf(state);
  reg.reviewNote = reason ?? null;
  audit(state, actor.id, `registration-${reg.status}`, id, { player: reg.player, team: reg.team, reason });
  return { status: 200, body: { registration: registrationView(state, reg) } };
}

// 身份核验方只回答材料状态；核对结果留在报名上供参考，不决定当场名单和晋级。
export async function identityCheck(state, actor, id, partnerUrl) {
  requireRole(actor, ['team', 'region', 'competition']);
  const reg = registrationOf(state, id);
  if (!partnerUrl) throw new HttpError(503, '未配置身份核验方地址（PARTNER_URL）');
  const checkId = `reg-${id}`;
  const response = await fetch(`${partnerUrl}/registry/checks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Key': checkId },
    body: JSON.stringify({ checks: [{ checkId, reference: reg.proof, player: reg.player, team: reg.team }] }),
    signal: AbortSignal.timeout(5000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, `身份核验方返回 ${response.status}`, { partner: payload });
  const result = payload.results?.[0];
  reg.identityCheck = {
    checkId,
    status: result?.status ?? 'unknown',
    checkedAt: nowOf(state),
    note: '核验方状态仅说明身份材料收件状态，不代表资格通过、可上场或可晋级'
  };
  audit(state, actor.id, 'identity-checked', id, reg.identityCheck);
  return { status: 200, body: { registration: registrationView(state, reg) } };
}

// ---------------------------------------------------------------------------
// 资格证明的撤销与更正
// ---------------------------------------------------------------------------

function canTouchProof(state, actor, proof) {
  if (actor.role === 'competition') return;
  if (actor.role === 'region') {
    const inRegion = Object.values(state.registrations).some(
      reg => reg.player === proof.player && get(state.teams, reg.team)?.region === actor.region
    );
    if (inRegion) return;
    throw new HttpError(403, '赛区只能处理本赛区球员的资格证明');
  }
  throw new HttpError(403, `角色 ${actor.role} 无权处理资格证明`);
}

// 撤销或更正只影响“名单锁定时证明已无效”的比赛：那些场次的资格进入争议，
// 历史赛果不自动重算，由赛事复核后处置。
function scanProofImpact(state, proof, actor) {
  const affected = [];
  for (const match of Object.values(state.matches)) {
    if (!match.startedAt) continue;
    for (const teamId of [match.home, match.away]) {
      const roster = get(state.rosters, match.id)?.[teamId];
      if (!roster || roster.status !== 'locked' || !roster.players.includes(proof.player)) continue;
      const registration = Object.values(state.registrations).find(
        reg => reg.player === proof.player && reg.team === teamId && reg.proof === proof.id
      );
      if (!registration) continue;
      const validity = proofValidityAt(proof, dateOf(match.startedAt));
      if (!validity.valid) {
        affected.push({ match: match.id, team: teamId, lockedAt: match.startedAt, reason: validity.reason });
      }
    }
  }
  for (const item of affected) {
    const dispute = openDispute(state, 'eligibility-review', item.match, {
      proof: proof.id, player: proof.player, team: item.team, lockedAt: item.lockedAt, reason: item.reason
    }, actor.id);
    suspendAdvancement(state, get(state.matches, item.match), `资格证明 ${proof.id} 争议 ${dispute.id} 待处置`);
  }
  return affected;
}

export function revokeProof(state, actor, id, body) {
  const proof = proofOf(state, id);
  mustActor(actor);
  canTouchProof(state, actor, proof);
  const { effectiveDate, reason } = body ?? {};
  if (!isDate(effectiveDate)) throw new HttpError(400, 'effectiveDate 须为 YYYY-MM-DD');
  if (!reason) throw new HttpError(400, '撤销必须说明原因');
  if (proof.revocation) throw new HttpError(409, `证明 ${id} 已撤销，如需变更请用更正`);
  proof.revocation = { effectiveDate, reason, by: actor.id, at: nowOf(state) };
  markHandled(state, body?.source, 'proof-revoked', actor);
  audit(state, actor.id, 'proof-revoked', id, { effectiveDate, reason });
  const affected = scanProofImpact(state, proof, actor);
  return { status: 200, body: { proof: proofView(state, proof), affectedMatches: affected } };
}

export function correctProof(state, actor, id, body) {
  const proof = proofOf(state, id);
  mustActor(actor);
  canTouchProof(state, actor, proof);
  const { validFrom, until, reason } = body ?? {};
  if (!validFrom && !until) throw new HttpError(400, '更正需给出 validFrom 或 until');
  if (validFrom && !isDate(validFrom)) throw new HttpError(400, 'validFrom 须为 YYYY-MM-DD');
  if (until && !isDate(until)) throw new HttpError(400, 'until 须为 YYYY-MM-DD');
  if (!reason) throw new HttpError(400, '更正必须说明原因');
  const correction = { validFrom: validFrom ?? null, until: until ?? null, reason, by: actor.id, at: nowOf(state) };
  proof.corrections.push(correction);
  const window = proofWindow(proof);
  if (window.validFrom > window.until) {
    proof.corrections.pop();
    throw new HttpError(400, `更正后有效期起 ${window.validFrom} 晚于止 ${window.until}`);
  }
  markHandled(state, body?.source, 'proof-corrected', actor);
  audit(state, actor.id, 'proof-corrected', id, correction);
  const affected = scanProofImpact(state, proof, actor);
  return { status: 200, body: { proof: proofView(state, proof), affectedMatches: affected } };
}

// ---------------------------------------------------------------------------
// 转队：原队释放 + 新队赛区审核；释放不抹出场事实，停赛随球员走
// ---------------------------------------------------------------------------

export function requestTransfer(state, actor, body) {
  mustActor(actor);
  const { player, fromTeam, toTeam, reason } = body ?? {};
  playerOf(state, player);
  teamOf(state, fromTeam);
  teamOf(state, toTeam);
  if (fromTeam === toTeam) throw new HttpError(400, '转出与转入球队相同');
  if (actor.role === 'team' && actor.team !== fromTeam && actor.team !== toTeam) {
    throw new HttpError(403, '队务只能为本队发起转队');
  }
  if (!['team', 'competition'].includes(actor.role)) throw new HttpError(403, `角色 ${actor.role} 无权发起转队`);
  if (currentTeamOf(state, player) !== fromTeam) throw new HttpError(409, `球员 ${player} 当前不在 ${fromTeam}`);
  const open = Object.values(state.transfers).find(
    item => item.player === player && (item.status === 'requested' || item.status === 'released')
  );
  if (open) throw new HttpError(409, `球员 ${player} 已有进行中的转队 ${open.id}`);
  const id = `TR-${state.counters.transfer++}`;
  state.transfers[id] = {
    id, player, fromTeam, toTeam, reason: reason ?? null,
    status: 'requested', requestedBy: actor.id, requestedAt: nowOf(state),
    releasedBy: null, releasedAt: null, reviewedBy: null, reviewedAt: null, reviewNote: null
  };
  markHandled(state, body?.source, 'transfer-requested', actor);
  audit(state, actor.id, 'transfer-requested', id, { player, fromTeam, toTeam, reason });
  return { status: 201, body: { transfer: state.transfers[id] } };
}

export function releaseTransfer(state, actor, id) {
  const transfer = must(get(state.transfers, id), `转队 ${id} 不存在`);
  mustActor(actor);
  if (actor.role === 'team' && actor.team !== transfer.fromTeam) throw new HttpError(403, '只有原队队务可以释放');
  if (!['team', 'competition'].includes(actor.role)) throw new HttpError(403, `角色 ${actor.role} 无权释放`);
  if (transfer.status !== 'requested') throw new HttpError(409, `转队状态为 ${transfer.status}，不能释放`);
  transfer.status = 'released';
  transfer.releasedBy = actor.id;
  transfer.releasedAt = nowOf(state);
  // 释放是事实：原报名失效，但历史出场与纪律记录全部保留。
  const registration = Object.values(state.registrations).find(
    reg => reg.player === transfer.player && reg.team === transfer.fromTeam && reg.status === 'approved'
  );
  if (registration) registration.status = 'released';
  audit(state, actor.id, 'transfer-released', id, { player: transfer.player, fromTeam: transfer.fromTeam });
  return { status: 200, body: { transfer } };
}

export function reviewTransfer(state, actor, id, body) {
  requireRole(actor, ['region']);
  const transfer = must(get(state.transfers, id), `转队 ${id} 不存在`);
  const toTeam = teamOf(state, transfer.toTeam);
  if (actor.region !== toTeam.region) throw new HttpError(403, `转入球队属于赛区 ${toTeam.region}，本审核人赛区 ${actor.region}`);
  if (transfer.status !== 'released') throw new HttpError(409, `转队状态为 ${transfer.status}，需原队先释放`);
  if (transfer.requestedBy === actor.id) throw new HttpError(403, '资料申请人不能批准自己的转队');
  const { decision, reason } = body ?? {};
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision 须为 approve 或 reject');
  transfer.reviewedBy = actor.id;
  transfer.reviewedAt = nowOf(state);
  transfer.reviewNote = reason ?? null;
  if (decision === 'reject') {
    transfer.status = 'rejected';
    audit(state, actor.id, 'transfer-rejected', id, { reason });
    return { status: 200, body: { transfer } };
  }
  transfer.status = 'approved';
  const old = Object.values(state.registrations).find(
    reg => reg.player === transfer.player && reg.team === transfer.fromTeam
  );
  const registrationId = `RG-TR-${state.counters.registration++}`;
  state.registrations[registrationId] = {
    id: registrationId,
    player: transfer.player,
    team: transfer.toTeam,
    proof: old?.proof ?? null,
    status: 'approved',
    submittedBy: actor.id,
    submittedAt: nowOf(state),
    reviewedBy: actor.id,
    reviewedAt: nowOf(state),
    reviewNote: `自 ${transfer.fromTeam} 转入（${id}）`,
    identityCheck: null
  };
  audit(state, actor.id, 'transfer-approved', id, { player: transfer.player, toTeam: transfer.toTeam, registration: registrationId });
  return { status: 200, body: { transfer, registration: registrationView(state, state.registrations[registrationId]) } };
}

// ---------------------------------------------------------------------------
// 比赛名单：接收（submitted）≠ 获准开赛（started）
// ---------------------------------------------------------------------------

function rosterOf(state, matchId, teamId) {
  return get(state.rosters, matchId)?.[teamId];
}

export function putRoster(state, actor, matchId, teamId, body) {
  requireRole(actor, ['team']);
  const match = matchOf(state, matchId);
  teamOf(state, teamId);
  if (actor.team !== teamId) throw new HttpError(403, '队务只能改本队名单');
  if (match.status !== 'scheduled') throw new HttpError(409, `比赛状态为 ${match.status}，名单已锁定，不能修改`);
  if (match.home !== teamId && match.away !== teamId) throw new HttpError(409, `${teamId} 不是 ${matchId} 的参赛球队`);
  const players = body?.players;
  if (!Array.isArray(players) || !players.length || players.length > 30) throw new HttpError(400, 'players 须为 1 至 30 人的数组');
  if (new Set(players).size !== players.length) throw new HttpError(400, '名单内有重复球员');
  for (const playerId of players) playerOf(state, playerId);
  const now = nowOf(state);
  const previous = rosterOf(state, matchId, teamId);
  const version = (previous?.version ?? 0) + 1;
  const roster = {
    players: [...players],
    version,
    status: previous?.status === 'submitted' ? 'submitted' : 'draft',
    receivedAt: previous?.receivedAt ?? null,
    lockedAt: null,
    history: [...(previous?.history ?? []), { version, players: [...players], at: now, by: actor.id }]
  };
  state.rosters[matchId][teamId] = roster;
  audit(state, actor.id, 'roster-updated', matchId, { team: teamId, version, players });
  return { status: 200, body: { roster: rosterView(roster), note: '草稿已保存；需提交后才算被接收，接收不等于获准开赛' } };
}

export function submitRoster(state, actor, matchId, teamId) {
  requireRole(actor, ['team']);
  const match = matchOf(state, matchId);
  if (actor.team !== teamId) throw new HttpError(403, '队务只能提交本队名单');
  if (match.status !== 'scheduled') throw new HttpError(409, `比赛状态为 ${match.status}，名单已锁定`);
  const roster = rosterOf(state, matchId, teamId);
  if (!roster) throw new HttpError(409, '尚无名单草稿，请先 PUT 名单');
  if (roster.status === 'submitted') return { status: 200, body: { roster: rosterView(roster), note: '名单此前已被接收' } };
  roster.status = 'submitted';
  roster.receivedAt = nowOf(state);
  audit(state, actor.id, 'roster-received', matchId, { team: teamId, version: roster.version });
  return { status: 200, body: { roster: rosterView(roster), note: '名单已被接收；接收不等于获准开赛，纪律与资格在开赛时再判定' } };
}

export function startMatch(state, actor, id) {
  requireRole(actor, ['referee']);
  const match = matchOf(state, id);
  const check = readiness(state, match);
  if (!check.canStart) throw new HttpError(409, '比赛不能开赛', { blockedBy: check.blockedBy });
  const now = nowOf(state);
  match.status = 'started';
  match.startedAt = now;
  match.startedBy = actor.id;
  const locked = {};
  for (const teamId of [match.home, match.away]) {
    const roster = state.rosters[id][teamId];
    roster.status = 'locked';
    roster.lockedAt = now;
    locked[teamId] = [...roster.players];
    audit(state, actor.id, 'roster-locked', id, { team: teamId, players: roster.players });
  }
  const consumed = consumeSuspensions(state, match);
  audit(state, actor.id, 'match-started', id, { locked, consumedSuspensions: consumed });
  return { status: 200, body: { match: matchView(state, match), lockedRosters: locked, consumedSuspensions: consumed } };
}

export function cancelMatch(state, actor, id, body) {
  requireRole(actor, ['competition']);
  const match = matchOf(state, id);
  if (match.status !== 'scheduled') throw new HttpError(409, `比赛状态为 ${match.status}，不能取消；已开赛比赛的事实只能经争议处置`);
  if (!body?.reason) throw new HttpError(400, '取消必须说明原因');
  match.status = 'cancelled';
  match.cancelled = { reason: body.reason, by: actor.id, at: nowOf(state) };
  match.advancement = { status: 'blocked', winner: null, blockedReason: `比赛已取消：${body.reason}` };
  audit(state, actor.id, 'match-cancelled', id, { reason: body.reason });
  return { status: 200, body: { match: matchView(state, match) } };
}

export function createMatch(state, actor, body) {
  requireRole(actor, ['competition']);
  const { id, home = null, away = null, homeWinnerOf = null, awayWinnerOf = null, startsAt } = body ?? {};
  validId(id, '比赛');
  if (get(state.matches, id)) throw new HttpError(409, `比赛 ${id} 已存在`);
  if (!isIso(startsAt)) throw new HttpError(400, 'startsAt 须为完整时间（UTC）');
  for (const team of [home, away]) if (team) teamOf(state, team);
  for (const source of [homeWinnerOf, awayWinnerOf]) if (source) matchOf(state, source);
  if ((home && homeWinnerOf) || (away && awayWinnerOf)) throw new HttpError(400, '席位球队与席位来源只能二选一');
  state.matches[id] = {
    id, home, away, homeWinnerOf, awayWinnerOf, startsAt,
    status: 'scheduled', startedAt: null, startedBy: null, finishedAt: null, cancelled: null,
    result: null, advancement: { status: 'pending', winner: null, reason: '赛果未公示' }, halt: null
  };
  state.events[id] = [];
  state.rosters[id] = {};
  audit(state, actor.id, 'match-created', id, { home, away, homeWinnerOf, awayWinnerOf, startsAt });
  return { status: 201, body: { match: matchView(state, state.matches[id]) } };
}

// ---------------------------------------------------------------------------
// 裁判记录：同一事实不重复累计；终场产生待确认赛果
// ---------------------------------------------------------------------------

export function addEvent(state, actor, matchId, body) {
  requireRole(actor, ['referee']);
  const match = matchOf(state, matchId);
  if (!['started', 'finished'].includes(match.status)) {
    throw new HttpError(409, `比赛状态为 ${match.status}，不能录入裁判记录`);
  }
  const { eventId, player, kind, minute } = body ?? {};
  validId(eventId, '事件');
  playerOf(state, player);
  if (!['goal', 'yellow', 'red'].includes(kind)) throw new HttpError(400, 'kind 须为 goal/yellow/red');
  if (!Number.isInteger(minute) || minute < 0 || minute > 130) throw new HttpError(400, 'minute 须为 0 至 130 的整数');
  const events = (state.events[matchId] ??= []);
  const byId = events.find(event => event.id === eventId);
  if (byId) {
    if (byId.player === player && byId.kind === kind && byId.minute === minute) {
      markHandled(state, body?.source, 'event-recorded', actor, { soft: true });
      return { status: 200, body: { event: byId, deduplicated: 'same-id' } };
    }
    throw new HttpError(409, `事件编号 ${eventId} 已对应不同资料`);
  }
  // 两名裁判同时录入同一事实（同人、同种、同分钟）只记一次，不重复累计。
  if (!body?.distinct) {
    const same = events.find(event => event.status === 'confirmed'
      && event.player === player && event.kind === kind && event.minute === minute);
    if (same) {
      markHandled(state, body?.source, 'event-recorded', actor, { soft: true });
      return { status: 200, body: { event: same, deduplicated: 'same-fact', message: '同一事实已录入，未重复累计' } };
    }
  }
  const event = {
    id: eventId, match: matchId, player, kind, minute,
    detail: body?.detail ?? null, by: actor.id, at: nowOf(state), status: 'confirmed'
  };
  events.push(event);
  recomputeSuspensions(state);
  markHandled(state, body?.source, 'event-recorded', actor);
  audit(state, actor.id, 'event-recorded', matchId, { event });
  return { status: 201, body: { event } };
}

export function finishMatch(state, actor, id, body) {
  requireRole(actor, ['referee']);
  const match = matchOf(state, id);
  if (match.status !== 'started') throw new HttpError(409, `比赛状态为 ${match.status}，不能终场`);
  const { homeGoals, awayGoals } = body ?? {};
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) {
    throw new HttpError(400, '终场比分须为非负整数');
  }
  const now = nowOf(state);
  match.status = 'finished';
  match.finishedAt = now;
  match.result = { homeGoals, awayGoals, status: 'pending', publishedAt: null, ruling: null };
  markHandled(state, body?.source, 'match-finished', actor);
  audit(state, actor.id, 'match-finished', id, { homeGoals, awayGoals });
  return { status: 200, body: { match: matchView(state, match), note: '已产生待确认赛果，公示后才进入申诉期' } };
}

export function publishResult(state, actor, id) {
  requireRole(actor, ['competition']);
  const match = matchOf(state, id);
  if (!match.result || match.result.status !== 'pending') {
    throw new HttpError(409, `赛果状态为 ${match.result?.status ?? '无'}，不能公示`);
  }
  match.result.status = 'published';
  match.result.publishedAt = nowOf(state);
  audit(state, actor.id, 'result-published', id, { publishedAt: match.result.publishedAt });
  refresh(state);
  return { status: 200, body: { result: resultView(state, match), appealMinutes: state.rules.appealMinutes } };
}

export function confirmAdvancement(state, actor, id) {
  requireRole(actor, ['competition']);
  const match = matchOf(state, id);
  refresh(state);
  if (match.advancement.status !== 'confirmed') {
    throw new HttpError(409, '晋级尚不能正式确认', { advancement: match.advancement });
  }
  return { status: 200, body: { advancement: match.advancement } };
}

// ---------------------------------------------------------------------------
// 申诉
// ---------------------------------------------------------------------------

export function fileAppeal(state, actor, matchId, body) {
  requireRole(actor, ['team']);
  const match = matchOf(state, matchId);
  if (match.home !== actor.team && match.away !== actor.team) throw new HttpError(403, '只有参赛队务能对本场申诉');
  if (!match.result || match.result.status !== 'published') throw new HttpError(409, '赛果未公示，不能申诉');
  const windowEnd = Date.parse(match.result.publishedAt) + state.rules.appealMinutes * 60000;
  if (Date.parse(nowOf(state)) > windowEnd) {
    throw new HttpError(409, `超出申诉时限（公示后 ${state.rules.appealMinutes} 分钟，至 ${new Date(windowEnd).toISOString()}）`);
  }
  const open = Object.values(state.appeals).find(
    appeal => appeal.match === matchId && appeal.team === actor.team && (appeal.status === 'filed' || appeal.status === 'accepted')
  );
  if (open) throw new HttpError(409, `本队已有未结申诉 ${open.id}`);
  if (!body?.reason) throw new HttpError(400, '申诉必须说明原因');
  const id = `AP-${state.counters.appeal++}`;
  state.appeals[id] = {
    id, match: matchId, team: actor.team, reason: body.reason,
    by: actor.id, at: nowOf(state), status: 'filed',
    decidedBy: null, decidedAt: null, resolution: null, disputeId: null
  };
  markHandled(state, body?.source, 'appeal-filed', actor);
  audit(state, actor.id, 'appeal-filed', matchId, { appeal: id, team: actor.team, reason: body.reason });
  return { status: 201, body: { appeal: state.appeals[id] } };
}

export function reviewAppeal(state, actor, id, body) {
  requireRole(actor, ['competition']);
  const appeal = must(get(state.appeals, id), `申诉 ${id} 不存在`);
  if (appeal.status !== 'filed') throw new HttpError(409, `申诉状态为 ${appeal.status}，不能受理`);
  const { decision, reason } = body ?? {};
  if (!['accept', 'reject'].includes(decision)) throw new HttpError(400, 'decision 须为 accept 或 reject');
  appeal.decidedBy = actor.id;
  appeal.decidedAt = nowOf(state);
  const match = matchOf(state, appeal.match);
  if (decision === 'reject') {
    appeal.status = 'rejected';
    appeal.resolution = { reason: reason ?? null, by: actor.id, at: appeal.decidedAt };
    audit(state, actor.id, 'appeal-rejected', appeal.match, { appeal: id, reason });
    return { status: 200, body: { appeal } };
  }
  appeal.status = 'accepted';
  // 受理后相关晋级席位处于争议中：下一轮不能把暂定胜者当成正式参赛者。
  const dispute = openDispute(state, 'appeal', appeal.match, { appeal: id, team: appeal.team, reason: appeal.reason }, actor.id);
  appeal.disputeId = dispute.id;
  suspendAdvancement(state, match, `申诉 ${id} 已受理，晋级席位处于争议中`);
  audit(state, actor.id, 'appeal-accepted', appeal.match, { appeal: id, dispute: dispute.id });
  return { status: 200, body: { appeal, dispute, advancement: match.advancement } };
}

export function resolveAppeal(state, actor, id, body) {
  requireRole(actor, ['competition']);
  const appeal = must(get(state.appeals, id), `申诉 ${id} 不存在`);
  if (appeal.status !== 'accepted') throw new HttpError(409, `申诉状态为 ${appeal.status}，不能了结`);
  const { decision, ruling, reason } = body ?? {};
  if (!['uphold', 'change'].includes(decision)) throw new HttpError(400, 'decision 须为 uphold 或 change');
  if (!reason) throw new HttpError(400, '了结申诉必须说明原因');
  const match = matchOf(state, appeal.match);
  applyOutcome(state, match, decision, ruling, reason, actor);
  appeal.status = 'resolved';
  appeal.resolution = { decision, ruling: ruling ?? null, reason, by: actor.id, at: nowOf(state) };
  const dispute = get(state.disputes, appeal.disputeId);
  if (dispute && dispute.status === 'open') {
    dispute.status = 'resolved';
    dispute.resolution = { decision, reason, by: actor.id, at: nowOf(state), via: `appeal:${id}` };
  }
  audit(state, actor.id, 'appeal-resolved', appeal.match, { appeal: id, decision, ruling, reason });
  refresh(state);
  return { status: 200, body: { appeal, match: matchView(state, match) } };
}

// ---------------------------------------------------------------------------
// 更正：误录身份或处罚须经赛事复核并说明影响；申请人不能批准自己的纠正
// ---------------------------------------------------------------------------

export function requestCorrection(state, actor, body) {
  requireRole(actor, ['referee', 'team', 'region', 'competition']);
  const { subjectType, subjectId, changes, reason } = body ?? {};
  if (!['event', 'registration'].includes(subjectType)) throw new HttpError(400, 'subjectType 须为 event 或 registration');
  if (!reason) throw new HttpError(400, '纠正必须说明原因');
  if (!changes || typeof changes !== 'object') throw new HttpError(400, 'changes 须为对象');
  if (subjectType === 'event') {
    const [matchId, eventId] = String(subjectId ?? '').split('/');
    const match = matchOf(state, matchId);
    const event = (state.events[matchId] ?? []).find(item => item.id === eventId && item.status === 'confirmed');
    if (!event) throw new HttpError(404, `比赛 ${matchId} 没有已确认事件 ${eventId}`);
    if (changes.player) playerOf(state, changes.player);
    if (changes.kind && !['goal', 'yellow', 'red'].includes(changes.kind)) throw new HttpError(400, 'changes.kind 须为 goal/yellow/red');
  } else {
    const reg = registrationOf(state, subjectId);
    if (changes.player) playerOf(state, changes.player);
    if (!changes.player) throw new HttpError(400, '报名纠正目前仅支持 changes.player（误录身份）');
    if (reg.status !== 'approved' && reg.status !== 'submitted') throw new HttpError(409, `报名状态为 ${reg.status}，不能纠正`);
  }
  const id = `C-${state.counters.correction++}`;
  state.corrections[id] = {
    id, subjectType, subjectId, changes, reason,
    by: actor.id, at: nowOf(state), status: 'pending',
    reviewedBy: null, reviewedAt: null, impact: null, reviewNote: null
  };
  markHandled(state, body?.source, 'correction-requested', actor);
  audit(state, actor.id, 'correction-requested', id, { subjectType, subjectId, changes, reason });
  return { status: 201, body: { correction: state.corrections[id] } };
}

function affectedMatchesOf(state, sourceMatchId, playerIds) {
  const source = matchOf(state, sourceMatchId);
  const affected = new Set();
  if (source.startedAt) affected.add(source.id);
  for (const match of Object.values(state.matches)) {
    if (!match.startedAt || match.id === sourceMatchId) continue;
    if (match.startedAt <= source.startedAt) continue;
    for (const playerId of playerIds.filter(Boolean)) {
      const appeared = Object.values(get(state.rosters, match.id) ?? {})
        .some(roster => roster.status === 'locked' && roster.players.includes(playerId));
      const served = state.suspensions.some(item => item.player === playerId && item.served.includes(match.id));
      if (appeared || served) {
        affected.add(match.id);
        break;
      }
    }
  }
  return [...affected];
}

function applyCorrection(state, correction, actor) {
  const now = nowOf(state);
  if (correction.subjectType === 'event') {
    const [matchId, eventId] = correction.subjectId.split('/');
    const events = state.events[matchId] ?? [];
    const old = events.find(item => item.id === eventId && item.status === 'confirmed');
    if (!old) throw new HttpError(409, `事件 ${eventId} 已不再是已确认状态`);
    old.status = 'superseded';
    old.correctionId = correction.id;
    let created = null;
    if (!correction.changes.withdraw) {
      created = {
        id: `EV-${state.counters.event++}`,
        match: matchId,
        player: correction.changes.player ?? old.player,
        kind: correction.changes.kind ?? old.kind,
        minute: correction.changes.minute ?? old.minute,
        detail: correction.changes.detail ?? old.detail,
        by: old.by,
        at: now,
        status: 'confirmed',
        correctionOf: old.id
      };
      old.supersededBy = created.id;
      events.push(created);
    }
    recomputeSuspensions(state);
    // 已开始比赛的名单不删改；可能影响的已赛比赛进入争议处理。
    const affected = affectedMatchesOf(state, matchId, [old.player, created?.player]);
    for (const affectedId of affected) {
      const dispute = openDispute(state, 'correction-impact', affectedId, {
        correction: correction.id, impact: correction.impact, sourceMatch: matchId
      }, actor.id);
      suspendAdvancement(state, get(state.matches, affectedId), `纠正 ${correction.id} 影响待处置（争议 ${dispute.id}）`);
    }
    return { superseded: old, created, affectedMatches: affected };
  }
  const reg = registrationOf(state, correction.subjectId);
  const before = reg.player;
  reg.player = correction.changes.player;
  audit(state, actor.id, 'registration-identity-corrected', reg.id, { before, after: reg.player, correction: correction.id });
  const affected = [];
  for (const match of Object.values(state.matches)) {
    if (!match.startedAt) continue;
    const roster = get(state.rosters, match.id)?.[reg.team];
    if (roster?.status === 'locked' && roster.players.includes(before)) affected.push(match.id);
  }
  for (const affectedId of affected) {
    const dispute = openDispute(state, 'correction-impact', affectedId, {
      correction: correction.id, impact: correction.impact, registration: reg.id
    }, actor.id);
    suspendAdvancement(state, get(state.matches, affectedId), `纠正 ${correction.id} 影响待处置（争议 ${dispute.id}）`);
  }
  return { registration: registrationView(state, reg), affectedMatches: affected };
}

export function reviewCorrection(state, actor, id, body) {
  requireRole(actor, ['competition']);
  const correction = must(get(state.corrections, id), `纠正 ${id} 不存在`);
  if (correction.status !== 'pending') throw new HttpError(409, `纠正状态为 ${correction.status}，不能重复复核`);
  if (correction.by === actor.id) throw new HttpError(403, '资料申请人不能批准自己的纠正');
  const { decision, impact, reason } = body ?? {};
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision 须为 approve 或 reject');
  if (decision === 'approve' && !impact) throw new HttpError(400, '批准纠正必须说明影响（impact）');
  correction.reviewedBy = actor.id;
  correction.reviewedAt = nowOf(state);
  correction.impact = impact ?? null;
  correction.reviewNote = reason ?? null;
  if (decision === 'reject') {
    correction.status = 'rejected';
    audit(state, actor.id, 'correction-rejected', id, { reason });
    return { status: 200, body: { correction } };
  }
  correction.status = 'approved';
  const applied = applyCorrection(state, correction, actor);
  audit(state, actor.id, 'correction-approved', id, { impact, affectedMatches: applied.affectedMatches });
  return { status: 200, body: { correction, applied } };
}

// ---------------------------------------------------------------------------
// 争议处置：有原因的处置后才继续
// ---------------------------------------------------------------------------

export function resolveDispute(state, actor, id, body) {
  requireRole(actor, ['competition']);
  const dispute = must(get(state.disputes, id), `争议 ${id} 不存在`);
  if (dispute.status !== 'open') throw new HttpError(409, `争议状态为 ${dispute.status}，不能重复处置`);
  const { decision, ruling, reason } = body ?? {};
  if (!['uphold', 'change'].includes(decision)) throw new HttpError(400, 'decision 须为 uphold 或 change');
  if (!reason) throw new HttpError(400, '处置必须说明原因');
  const match = matchOf(state, dispute.match);
  if (dispute.kind === 'branch-halt') {
    // 已开赛分叉：处置只记录决定与原因，不撤掉已发生的出场和处罚，不静默替换球队。
    match.halt = null;
    if (decision === 'change' && ruling && match.result) {
      applyOutcome(state, match, 'change', ruling, reason, actor);
    }
    audit(state, actor.id, 'branch-resumed', match.id, { dispute: id, decision, reason });
  } else {
    applyOutcome(state, match, decision, ruling, reason, actor);
  }
  dispute.status = 'resolved';
  dispute.resolution = { decision, ruling: ruling ?? null, reason, by: actor.id, at: nowOf(state) };
  audit(state, actor.id, 'dispute-resolved', dispute.match, { dispute: id, decision, ruling, reason });
  refresh(state);
  return { status: 200, body: { dispute, match: matchView(state, match) } };
}

// ---------------------------------------------------------------------------
// 查询：按球员、比赛或争议查回决定的依据
// ---------------------------------------------------------------------------

export function playerRecord(state, id) {
  const player = playerOf(state, id);
  const appearances = [];
  for (const match of Object.values(state.matches)) {
    if (!match.startedAt) continue;
    for (const [teamId, roster] of Object.entries(get(state.rosters, match.id) ?? {})) {
      if (roster.status === 'locked' && roster.players.includes(id)) {
        appearances.push({ match: match.id, team: teamId, lockedAt: roster.lockedAt });
      }
    }
  }
  const events = [];
  for (const [matchId, list] of Object.entries(state.events)) {
    for (const event of list) if (event.player === id) events.push({ match: matchId, ...event });
  }
  return {
    player,
    currentTeam: currentTeamOf(state, id),
    registrations: Object.values(state.registrations).filter(reg => reg.player === id).map(reg => registrationView(state, reg)),
    proofs: Object.values(state.proofs).filter(proof => proof.player === id).map(proof => proofView(state, proof)),
    appearances,
    events,
    suspensions: state.suspensions.filter(item => item.player === id).map(suspensionView),
    transfers: Object.values(state.transfers).filter(item => item.player === id)
  };
}

export function matchRecord(state, id) {
  const match = matchOf(state, id);
  return {
    match: matchView(state, match),
    readiness: readiness(state, match),
    rosters: Object.fromEntries(Object.entries(get(state.rosters, id) ?? {}).map(([team, roster]) => [team, rosterView(roster)])),
    events: state.events[id] ?? [],
    appeals: Object.values(state.appeals).filter(appeal => appeal.match === id),
    disputes: Object.values(state.disputes).filter(dispute => dispute.match === id),
    audit: state.audit.filter(entry => entry.subject === id)
  };
}

export function teamView(state, id) {
  const team = teamOf(state, id);
  return {
    ...team,
    registrations: Object.values(state.registrations).filter(reg => reg.team === id).map(reg => registrationView(state, reg)),
    matches: Object.values(state.matches).filter(match => match.home === id || match.away === id).map(match => match.id)
  };
}

export function eligibilityView(state, matchId, teamId) {
  const match = matchOf(state, matchId);
  const teams = teamId ? [teamId] : [match.home, match.away].filter(Boolean);
  const now = nowOf(state);
  const out = {};
  for (const team of teams) {
    teamOf(state, team);
    const roster = rosterOf(state, matchId, team);
    const involved = new Set(roster?.players ?? []);
    for (const reg of Object.values(state.registrations)) if (reg.team === team) involved.add(reg.player);
    out[team] = [...involved].sort().map(playerId => {
      const check = eligibility(state, playerId, team, now);
      const registration = Object.values(state.registrations).find(reg => reg.player === playerId && reg.team === team);
      return {
        player: playerId,
        onRoster: roster?.players.includes(playerId) ?? false,
        ok: check.ok,
        missing: check.problems,
        registration: registration ? { id: registration.id, status: registration.status, identityCheck: registration.identityCheck } : null
      };
    });
  }
  return { match: matchId, at: now, teams: out };
}

export function disputeView(state, id) {
  const dispute = must(get(state.disputes, id), `争议 ${id} 不存在`);
  return {
    ...dispute,
    match: matchView(state, matchOf(state, dispute.match)),
    relatedAudit: state.audit.filter(entry => entry.subject === dispute.match)
  };
}

// ---------------------------------------------------------------------------
// 本地演练控制：虚拟时钟
// ---------------------------------------------------------------------------

export function setClock(state, body) {
  const at = body?.now;
  if (!isIso(at)) throw new HttpError(400, '需要 ISO 时间 now');
  state.clockNow = at;
  audit(state, 'control', 'clock-set', 'clock', { now: state.clockNow });
  return { status: 200, body: { now: state.clockNow } };
}

export function resetClock(state) {
  state.clockNow = null;
  audit(state, 'control', 'clock-reset', 'clock', { now: nowOf(state) });
  return { status: 200, body: { now: nowOf(state) } };
}
