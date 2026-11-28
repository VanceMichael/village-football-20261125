import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 业务错误：status 为 HTTP 状态码，extra 会并入响应体（如阻断原因）。
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// 读取持久状态；文件不存在时用 seedFn 建立初始状态。
export function loadState(stateFile, seedFn) {
  try {
    return { state: JSON.parse(readFileSync(stateFile, 'utf8')), seeded: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { state: seedFn(), seeded: true };
  }
}

// 原子写入（临时文件 + 改名），与合作方服务同一做法。
export function makeSaver(stateFile, state) {
  return () => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile + '.tmp', JSON.stringify(state));
    renameSync(stateFile + '.tmp', stateFile);
  };
}

// 虚拟时钟：演练时可用 /control/clock 冻结在指定时刻，否则用真实时间。
export const nowOf = state => state.clockNow ?? new Date().toISOString();

// 审计流水：每次状态变化都记录操作人、动作、对象与细节，供按球员/比赛/争议查回依据。
export function audit(state, actor, action, subject, details) {
  state.audit.push({
    seq: state.audit.length + 1,
    at: nowOf(state),
    actor: actor ?? 'system',
    action,
    subject,
    details: details ?? {}
  });
}

// proof 日期为包含端点的日历有效期；完整时间取 UTC 日期部分参与比较。
export const dateOf = iso => String(iso).slice(0, 10);
