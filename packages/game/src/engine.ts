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
import { canTsumo, discardable, kongOptions, pickSwapTiles } from "./sichuan.js";
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

/**
 * 这位玩家现在能发的操作（网页按钮、测试用）。换三张和定缺只给一个默认选择；打牌给出每张能打的牌。
 * 只用到自己能看到的信息，所以在 redactGameForViewer 之后的状态上也能用。
 */
export function legalCommands(state: GameState, playerId: string): GameCommand[] {
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0 || state.phase === "finished") return [];
  const player = state.players[seat]!;
  switch (state.stage) {
    case "swap":
      return player.swapChosen ? [] : [{ type: "SWAP", tiles: pickSwapTiles(player.hand) }];
    case "void":
      return player.voidChosen ? [] : (["m", "p", "s"] as const).map((suit) => ({ type: "VOID", suit }));
    case "turn": {
      if (state.turn !== seat) return [];
      const commands: GameCommand[] = [];
      if (canTsumo(state, seat)) commands.push({ type: "TSUMO" });
      for (const option of kongOptions(state, seat)) commands.push({ type: "KONG", tile: option.tile });
      for (const tile of discardable(state, seat)) commands.push({ type: "DISCARD", tile });
      return commands;
    }
    case "claim": {
      const options = state.claim?.options[seat];
      if (!options || state.claim?.responses[seat] !== undefined) return [];
      return [...options.map((action) => ({ type: "CLAIM" as const, action })), { type: "CLAIM", action: "pass" }];
    }
    case "handEnd":
      return state.ready.includes(playerId) ? [] : [{ type: "READY" }];
  }
}
