/**
 * 麻将系列的统一入口：服务端和网页只调这里，按 state.variant 分给各玩法的引擎。
 */
import {
  applySichuan,
  claimReady as sichuanClaimReady,
  createSichuan,
  pendingSeats as sichuanPending,
  redactSichuan,
  stepSeconds as sichuanStepSeconds,
  timeoutCommand as sichuanTimeoutCommand,
  type NewPlayer,
} from "./sichuan.js";
import { sichuanBotCommand } from "./sichuan-bot.js";
import type { GameCommand, GameState, SichuanOptions, Variant } from "./types.js";

export type { NewPlayer };

export interface VariantInfo {
  readonly id: Variant;
  readonly name: string;
  readonly ready: boolean;
}

export type GameOptions = { readonly variant: "sichuan" } & Partial<SichuanOptions>;

export function createGame(players: readonly NewPlayer[], seed: number, options: GameOptions): GameState {
  switch (options.variant) {
    case "sichuan": {
      const { variant: _variant, ...rest } = options;
      return createSichuan(players, seed, rest);
    }
  }
}

/** 玩家（或机器人）的操作。不合法时抛出带中文说明的错误。 */
export function applyCommand(state: GameState, playerId: string, command: GameCommand): GameState {
  return applySichuan(state, playerId, command).state;
}

/** 系统操作：抢牌窗口结算（所有人回应、过了固定停顿以后）。 */
export function resolveClaim(state: GameState): GameState {
  return applySichuan(state, "", { type: "RESOLVE" }).state;
}

/** 系统操作：到时间了，给所有还没决定的真人套用默认动作（连续超时 2 次转托管）。 */
export function timeoutTurn(state: GameState): GameState {
  return applySichuan(state, "", { type: "TIMEOUT" }).state;
}

export const claimReady = (state: GameState) => sichuanClaimReady(state);
/** 现在要做决定的座位。 */
export const pendingSeats = (state: GameState) => sichuanPending(state);
/** 当前这一步的限时（秒）。 */
export const stepSeconds = (state: GameState) => sichuanStepSeconds(state);
export const botCommand = (state: GameState, seat: number): GameCommand => sichuanBotCommand(state, seat);
export const timeoutCommand = (state: GameState, seat: number): GameCommand => sichuanTimeoutCommand(state, seat);
export const redactGameForViewer = (state: GameState, viewerId: string): GameState => redactSichuan(state, viewerId);

/** 决定点的标识；变了就重新计时。 */
export const timerKey = (state: GameState) => `${state.handNo}:${state.step}`;
