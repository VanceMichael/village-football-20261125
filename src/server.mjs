import { createServer } from 'node:http';
import { HttpError } from './store.mjs';
import * as dom from './domain.mjs';

// 业务接口服务。操作人经 X-Actor-Id 请求头识别；变更类接口都需要操作人。
// GET 查询不强制操作人（本地演练），持久化由 save 回调完成。
export function createApp(state, { partnerUrl, save } = {}) {
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };

  const routes = [
    ['GET', '/health', () => ({ status: 200, body: { status: 'ok', service: 'village-football', season: state.season } })],
    ['GET', '/', () => ({ status: 200, body: { service: '跨赛区球队名单锁定与争议赛果发布', endpoints: routes.filter(([, path]) => typeof path === 'string').map(([method, path]) => `${method} ${path}`) } })],

    // 本地演练控制
    ['POST', '/control/clock', ({ body }) => dom.setClock(state, body)],
    ['DELETE', '/control/clock', () => dom.resetClock(state)],

    // 操作人与基础资料
    ['POST', '/actors', ({ actor, body }) => dom.createActor(state, actor, body)],
    ['GET', '/actors', () => ({ status: 200, body: { actors: Object.values(state.actors) } })],
    ['POST', '/players', ({ actor, body }) => dom.createPlayer(state, actor, body)],
    ['GET', '/players', () => ({ status: 200, body: { players: Object.values(state.players) } })],
    ['POST', '/proofs', ({ actor, body }) => dom.createProof(state, actor, body)],

    // 报名与审核
    ['POST', '/teams/:team/registrations', ({ actor, params, body }) => dom.submitRegistration(state, actor, params.team, body)],
    ['GET', '/teams', () => ({ status: 200, body: { teams: Object.values(state.teams).map(team => dom.teamView(state, team.id)) } })],
    ['GET', '/registrations/:id', ({ params }) => {
      const reg = Object.values(state.registrations).find(item => item.id === params.id);
      if (!reg) throw new HttpError(404, `报名 ${params.id} 不存在`);
      return { status: 200, body: { registration: reg } };
    }],
    ['POST', '/registrations/:id/review', ({ actor, params, body }) => dom.reviewRegistration(state, actor, params.id, body)],
    ['POST', '/registrations/:id/identity-check', ({ actor, params }) => dom.identityCheck(state, actor, params.id, partnerUrl)],

    // 资格证明
    ['GET', '/proofs/:id', ({ params }) => {
      const proof = Object.values(state.proofs).find(item => item.id === params.id);
      if (!proof) throw new HttpError(404, `证明 ${params.id} 不存在`);
      return { status: 200, body: { proof } };
    }],
    ['POST', '/proofs/:id/revoke', ({ actor, params, body }) => dom.revokeProof(state, actor, params.id, body)],
    ['POST', '/proofs/:id/correct', ({ actor, params, body }) => dom.correctProof(state, actor, params.id, body)],

    // 转队
    ['POST', '/transfers', ({ actor, body }) => dom.requestTransfer(state, actor, body)],
    ['GET', '/transfers/:id', ({ params }) => {
      const transfer = state.transfers[params.id];
      if (!transfer) throw new HttpError(404, `转队 ${params.id} 不存在`);
      return { status: 200, body: { transfer } };
    }],
    ['POST', '/transfers/:id/release', ({ actor, params }) => dom.releaseTransfer(state, actor, params.id)],
    ['POST', '/transfers/:id/review', ({ actor, params, body }) => dom.reviewTransfer(state, actor, params.id, body)],

    // 比赛与名单
    ['POST', '/matches', ({ actor, body }) => dom.createMatch(state, actor, body)],
    ['GET', '/matches', () => ({ status: 200, body: { matches: Object.values(state.matches).map(match => dom.matchView(state, match)) } })],
    ['PUT', '/matches/:id/rosters/:team', ({ actor, params, body }) => dom.putRoster(state, actor, params.id, params.team, body)],
    ['POST', '/matches/:id/rosters/:team/submit', ({ actor, params }) => dom.submitRoster(state, actor, params.id, params.team)],
    ['GET', '/matches/:id/rosters', ({ params }) => {
      if (!state.matches[params.id]) throw new HttpError(404, `比赛 ${params.id} 不存在`);
      return { status: 200, body: { rosters: state.rosters[params.id] ?? {} } };
    }],
    ['GET', '/matches/:id/eligibility', ({ params, url }) => ({ status: 200, body: dom.eligibilityView(state, params.id, url.searchParams.get('team')) })],
    ['GET', '/matches/:id/readiness', ({ params }) => {
      const match = state.matches[params.id];
      if (!match) throw new HttpError(404, `比赛 ${params.id} 不存在`);
      return { status: 200, body: { match: params.id, ...dom.readiness(state, match) } };
    }],
    ['POST', '/matches/:id/start', ({ actor, params }) => dom.startMatch(state, actor, params.id)],
    ['POST', '/matches/:id/cancel', ({ actor, params, body }) => dom.cancelMatch(state, actor, params.id, body)],
    ['POST', '/matches/:id/events', ({ actor, params, body }) => dom.addEvent(state, actor, params.id, body)],
    ['GET', '/matches/:id/events', ({ params }) => {
      if (!state.matches[params.id]) throw new HttpError(404, `比赛 ${params.id} 不存在`);
      return { status: 200, body: { events: state.events[params.id] ?? [] } };
    }],
    ['POST', '/matches/:id/finish', ({ actor, params, body }) => dom.finishMatch(state, actor, params.id, body)],
    ['POST', '/matches/:id/publish', ({ actor, params }) => dom.publishResult(state, actor, params.id)],
    ['GET', '/matches/:id/result', ({ params }) => {
      const match = state.matches[params.id];
      if (!match) throw new HttpError(404, `比赛 ${params.id} 不存在`);
      if (!match.result) throw new HttpError(404, `比赛 ${params.id} 尚无赛果`);
      return { status: 200, body: { result: dom.resultView(state, match) } };
    }],
    ['POST', '/matches/:id/advancement/confirm', ({ actor, params }) => dom.confirmAdvancement(state, actor, params.id)],
    ['GET', '/matches/:id/record', ({ params }) => ({ status: 200, body: dom.matchRecord(state, params.id) })],
    ['POST', '/matches/:id/appeals', ({ actor, params, body }) => dom.fileAppeal(state, actor, params.id, body)],
    ['GET', '/matches/:id', ({ params }) => {
      const match = state.matches[params.id];
      if (!match) throw new HttpError(404, `比赛 ${params.id} 不存在`);
      return { status: 200, body: { match: dom.matchView(state, match) } };
    }],

    // 申诉
    ['GET', '/appeals/:id', ({ params }) => {
      const appeal = state.appeals[params.id];
      if (!appeal) throw new HttpError(404, `申诉 ${params.id} 不存在`);
      return { status: 200, body: { appeal } };
    }],
    ['POST', '/appeals/:id/review', ({ actor, params, body }) => dom.reviewAppeal(state, actor, params.id, body)],
    ['POST', '/appeals/:id/resolve', ({ actor, params, body }) => dom.resolveAppeal(state, actor, params.id, body)],

    // 更正
    ['POST', '/corrections', ({ actor, body }) => dom.requestCorrection(state, actor, body)],
    ['GET', '/corrections/:id', ({ params }) => {
      const correction = state.corrections[params.id];
      if (!correction) throw new HttpError(404, `纠正 ${params.id} 不存在`);
      return { status: 200, body: { correction } };
    }],
    ['POST', '/corrections/:id/review', ({ actor, params, body }) => dom.reviewCorrection(state, actor, params.id, body)],

    // 争议
    ['GET', '/disputes', () => ({ status: 200, body: { disputes: Object.values(state.disputes) } })],
    ['GET', '/disputes/:id', ({ params }) => ({ status: 200, body: { dispute: dom.disputeView(state, params.id) } })],
    ['POST', '/disputes/:id/resolve', ({ actor, params, body }) => dom.resolveDispute(state, actor, params.id, body)],

    // 查询依据
    ['GET', '/players/:id/record', ({ params }) => ({ status: 200, body: dom.playerRecord(state, params.id) })],
    ['GET', '/teams/:id', ({ params }) => ({ status: 200, body: { team: dom.teamView(state, params.id) } })],
    ['GET', '/inbox', () => ({ status: 200, body: { inbox: state.inbox } })],
    ['GET', '/audit', ({ url }) => {
      const subject = url.searchParams.get('subject');
      const entries = subject ? state.audit.filter(entry => entry.subject === subject) : state.audit;
      return { status: 200, body: { audit: entries } };
    }]
  ];

  // 把 '/matches/:id/start' 形式的路径编译成正则。
  const compiled = routes.map(([method, path, handler]) => {
    const names = [];
    const pattern = path.replace(/:[^/]+/g, segment => {
      names.push(segment.slice(1));
      return '([^/]+)';
    });
    return [method, new RegExp(`^${pattern}$`), names, handler];
  });

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024 * 1024) return send(res, 413, { error: '资料过大' });
      }
      const body = raw ? JSON.parse(raw) : {};
      // 每个请求先按当前时间重估晋级状态（公示期届满自动确认）。
      dom.refresh(state);
      const actorId = req.headers['x-actor-id'];
      const actor = actorId ? state.actors[actorId] ?? null : null;
      if (actorId && !actor) return send(res, 401, { error: `未识别的操作人 ${actorId}` });
      for (const [method, pattern, names, handler] of compiled) {
        if (method !== req.method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
        const result = await handler({ state, body, actor, params, url });
        save?.();
        return send(res, result.status ?? 200, result.body);
      }
      return send(res, 404, { error: '没有对应的业务接口' });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, ...error.extra });
      if (error instanceof SyntaxError) return send(res, 400, { error: 'JSON 格式不符' });
      return send(res, 500, { error: '业务服务保存失败', detail: String(error?.message ?? error) });
    }
  });
}
