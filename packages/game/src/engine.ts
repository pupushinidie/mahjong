/**
 * 麻将系列的统一入口：服务端和网页只调这里，按 state.variant 分给各玩法的引擎。
 */
import {
  applyRiichi,
  canKyuushu,
  canTsumo as riichiCanTsumo,
  createRiichi,
  redactRiichi,
  riichiClaimReady,
  riichiDiscardable,
  riichiKanOptions,
  riichiOptions,
  riichiPendingSeats,
  riichiStepSeconds,
  riichiTimeoutCommand,
} from "./riichi.js";
import { riichiBotCommand } from "./riichi-bot.js";
import {
  applySichuan,
  canTsumo as sichuanCanTsumo,
  claimReady as sichuanClaimReady,
  createSichuan,
  discardable,
  kongOptions,
  pendingSeats as sichuanPending,
  pickSwapTiles,
  redactSichuan,
  stepSeconds as sichuanStepSeconds,
  timeoutCommand as sichuanTimeoutCommand,
  type NewPlayer,
} from "./sichuan.js";
import { sichuanBotCommand } from "./sichuan-bot.js";
import type { RiichiCommand, RiichiOptions, RiichiState } from "./riichi-types.js";
import type { GameCommand, GameState, SichuanCommand, SichuanOptions, SichuanState } from "./types.js";

export type { NewPlayer };

export type GameOptions = ({ readonly variant: "sichuan" } & Partial<SichuanOptions>) | ({ readonly variant: "riichi" } & Partial<RiichiOptions>);

export function createGame(players: readonly NewPlayer[], seed: number, options: GameOptions): GameState {
  if (options.variant === "riichi") {
    const { variant: _variant, ...rest } = options;
    return createRiichi(players, seed, rest);
  }
  const { variant: _variant, ...rest } = options;
  return createSichuan(players, seed, rest);
}

/** 玩家（或机器人）的操作。不合法时抛出带中文说明的错误。 */
export function applyCommand(state: GameState, playerId: string, command: GameCommand): GameState {
  if (state.variant === "riichi") return applyRiichi(state, playerId, command as RiichiCommand);
  return applySichuan(state, playerId, command as SichuanCommand).state;
}

/** 系统操作：抢牌窗口结算（所有人回应、过了固定停顿以后）。 */
export function resolveClaim(state: GameState): GameState {
  if (state.variant === "riichi") return applyRiichi(state, "", { type: "RESOLVE" });
  return applySichuan(state, "", { type: "RESOLVE" }).state;
}

/** 系统操作：到时间了，给还没决定的真人（seats 只给这些座位）套用默认动作（连续超时 2 次转托管）。 */
export function timeoutTurn(state: GameState, seats?: readonly number[]): GameState {
  if (state.variant === "riichi") return applyRiichi(state, "", { type: "TIMEOUT", ...(seats ? { seats } : {}) });
  return applySichuan(state, "", { type: "TIMEOUT" }).state;
}

export const claimReady = (state: GameState) => (state.variant === "riichi" ? riichiClaimReady(state) : sichuanClaimReady(state));
/** 现在要做决定的座位。 */
export const pendingSeats = (state: GameState) => (state.variant === "riichi" ? riichiPendingSeats(state) : sichuanPending(state));
/** 当前这一步的限时（秒）。立直另有每局的备用时间（config.bankSec，服务端扣）。 */
export const stepSeconds = (state: GameState) => (state.variant === "riichi" ? riichiStepSeconds(state) : sichuanStepSeconds(state));
export const botCommand = (state: GameState, seat: number): GameCommand =>
  state.variant === "riichi" ? riichiBotCommand(state, seat) : sichuanBotCommand(state, seat);
export const timeoutCommand = (state: GameState, seat: number): GameCommand =>
  state.variant === "riichi" ? riichiTimeoutCommand(state, seat) : sichuanTimeoutCommand(state, seat);
export const redactGameForViewer = (state: GameState, viewerId: string): GameState =>
  state.variant === "riichi" ? redactRiichi(state, viewerId) : redactSichuan(state, viewerId);

/** 决定点的标识；变了就重新计时。 */
export const timerKey = (state: GameState) => `${state.handNo}:${state.step}`;

/** 列表、日志里显示的分数：四川是积分，立直是点数。 */
export const scoreOf = (state: GameState, seat: number): number =>
  state.variant === "riichi" ? state.players[seat]!.points : state.players[seat]!.score;

/**
 * 这位玩家现在能发的操作（网页按钮、测试用）。换三张和定缺只给一个默认选择；打牌给出每张能打的牌。
 * 只用到自己能看到的信息，所以在 redactGameForViewer 之后的状态上也能用。
 */
export function legalCommands(state: GameState, playerId: string): GameCommand[] {
  return state.variant === "riichi" ? riichiLegal(state, playerId) : sichuanLegal(state, playerId);
}

function riichiLegal(state: RiichiState, playerId: string): RiichiCommand[] {
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0 || state.phase === "finished") return [];
  switch (state.stage) {
    case "turn": {
      if (state.turn !== seat) return [];
      const commands: RiichiCommand[] = [];
      if (riichiCanTsumo(state, seat)) commands.push({ type: "TSUMO" });
      if (canKyuushu(state, seat)) commands.push({ type: "KYUUSHU" });
      for (const option of riichiKanOptions(state, seat)) commands.push({ type: "KONG", tile: option.tile });
      for (const tile of riichiOptions(state, seat)) commands.push({ type: "DISCARD", tile, riichi: true });
      for (const tile of riichiDiscardable(state, seat)) commands.push({ type: "DISCARD", tile });
      return commands;
    }
    case "claim": {
      const claim = state.claim!;
      const options = claim.options[seat];
      if (!options || claim.responses[seat] !== undefined) return [];
      const commands: RiichiCommand[] = [];
      for (const action of options) {
        if (action === "chi") for (const tiles of claim.chiOptions[seat] ?? []) commands.push({ type: "CLAIM", action, tiles });
        else if (action === "pon") for (const tiles of claim.ponOptions[seat] ?? []) commands.push({ type: "CLAIM", action, tiles });
        else commands.push({ type: "CLAIM", action });
      }
      commands.push({ type: "CLAIM", action: "pass" });
      return commands;
    }
    case "handEnd":
      return state.ready.includes(playerId) ? [] : [{ type: "READY" }];
  }
}

function sichuanLegal(state: SichuanState, playerId: string): SichuanCommand[] {
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
      const commands: SichuanCommand[] = [];
      if (sichuanCanTsumo(state, seat)) commands.push({ type: "TSUMO" });
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
