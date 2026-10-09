/**
 * 麻将系列的对局状态。每种玩法一个 state 类型，用 variant 区分；现在有四川麻将（sichuan），立直麻将之后加。
 * 座位 0–3 按逆时针（出牌顺序）排列：i 的下家是 i+1，对家是 i+2，上家是 i+3。
 */
import type { Suit, Tile } from "./tiles.js";

export type Variant = "sichuan";

export interface SichuanOptions {
  /** 血战到底（和了下桌）/ 血流成河（和了接着打）。 */
  readonly mode: "xuezhan" | "xueliu";
  /** 换三张。 */
  readonly swap: boolean;
  /** 封顶番数；null 不封顶。 */
  readonly cap: 3 | 4 | 6 | null;
  /** 自摸加番（+1 番）还是加底（每家多付 1 分）。 */
  readonly zimo: "fan" | "base";
  /** 一场打几盘。 */
  readonly hands: 4 | 8 | 16;
}

export interface SichuanConfig extends SichuanOptions {
  /** 各阶段限时（秒），超时自动处理，见 timeoutCommand。 */
  readonly swapSec: number;
  readonly voidSec: number;
  readonly discardSec: number;
  readonly claimSec: number;
  readonly handEndSec: number;
}

export interface Meld {
  readonly type: "pung" | "kong" | "addedKong" | "concealedKong";
  /** 具体的牌；别人的暗杠在一盘结束前是 4 个 -1。 */
  readonly tiles: Tile[];
  /** 碰、明杠：牌是谁打的（座位）。 */
  readonly from?: number;
}

export interface FanItem {
  readonly name: string;
  readonly fan: number;
}

export interface Win {
  /** 和的那张牌。 */
  readonly tile: Tile;
  readonly how: "zimo" | "ron" | "robKong";
  /** 点炮 / 被抢杠的人。 */
  readonly from?: number;
  /** 番数（封顶前）和实际按多少番算。 */
  readonly fan: number;
  readonly counted: number;
  readonly items: FanItem[];
  /** 显示用的牌型名：清龙七对、清对、金钩钓…… */
  readonly title: string;
  /** 每个付款人付多少分。 */
  readonly points: number;
  readonly payers: number[];
  /** 这一盘第几次和牌（一炮多响算同一次）。 */
  readonly order: number;
}

/** 一笔结算：本盘每个人的得失（下标是座位）。 */
export interface SettleLine {
  readonly kind: "kong" | "hu" | "transfer" | "refund" | "pig" | "noTing";
  readonly text: string;
  readonly deltas: [number, number, number, number];
}

export interface KongEntry {
  readonly id: number;
  readonly payer: number;
  readonly payee: number;
  readonly amount: number;
  transferred: boolean;
  refunded: boolean;
}

export type ClaimAction = "hu" | "kong" | "pung";

export interface ClaimWindow {
  readonly tile: Tile;
  /** 打牌 / 加杠的人。 */
  readonly from: number;
  readonly kind: "discard" | "robKong";
  /** 牌墙已经空了：只能和，不能碰杠。 */
  readonly last: boolean;
  /** 这张是开杠补牌后打出的（和了算杠上炮，呼叫转移）。 */
  readonly afterKong: boolean;
  /** 每个座位能做的动作（没有选项的座位不出现）。发给玩家时只留自己的。 */
  options: Partial<Record<number, ClaimAction[]>>;
  /** 已经回应的座位：动作或 pass。发给玩家时只留自己的。 */
  responses: Partial<Record<number, ClaimAction | "pass">>;
  /** 有选项、还没回应的人数（所有人都能看到，用来显示「等待其他玩家」）。 */
  pending: number;
}

export interface SichuanPlayer {
  readonly id: string;
  readonly name: string;
  /** 空座位上的机器人。 */
  readonly bot: boolean;
  /** 托管：连续超时 2 次自动打开，点「取消托管」关掉。 */
  auto: boolean;
  /** 连续超时次数。 */
  timeouts: number;
  /** 累计积分。 */
  score: number;
  /** 本盘得失。 */
  handDelta: number;

  /** 手牌（不含亮出的面子）。发给别人时是空数组，张数看 handCount。 */
  hand: Tile[];
  handCount: number;
  /** 刚摸到的那张（在 hand 里）；发给别人时是 -1（只表示「刚摸了一张」）。 */
  drawn: Tile | null;
  melds: Meld[];
  /** 牌河；taken 表示被别人碰、杠、和走了。 */
  discards: { readonly tile: Tile; taken?: boolean }[];
  /** 定缺；所有人选好之前发给别人是 null。 */
  void: Suit | null;
  voidChosen: boolean;
  /** 换三张：选好的 3 张（只有自己看得到），和换完之后交出 / 收到的牌（只有自己看得到）。 */
  swapPick: Tile[] | null;
  swapChosen: boolean;
  swapOut: Tile[];
  swapIn: Tile[];
  /** 和牌记录（血战最多一条）。 */
  wins: Win[];
  /** 血战到底：已经和牌下桌。 */
  out: boolean;
  /** 过胡：放过了能和的牌，到自己下次摸牌前不能和别人的牌（只发给自己）。 */
  passedHu: boolean;
  /** 本盘自己摸过几次牌（地胡判断）。 */
  draws: number;
}

export type SichuanStage = "swap" | "void" | "turn" | "claim" | "handEnd";

export interface HandSummary {
  readonly reason: "allWon" | "exhausted";
  readonly lines: SettleLine[];
  readonly deltas: [number, number, number, number];
  /** 流局时每个还在局中的人：听不听、最大番、是不是花猪。 */
  readonly status: { readonly seat: number; readonly ting: boolean; readonly maxFan: number; readonly pig: boolean }[];
  readonly nextDealer: number;
}

export type GameCommand =
  /** 换三张：3 张同一门。 */
  | { readonly type: "SWAP"; readonly tiles: readonly Tile[] }
  | { readonly type: "VOID"; readonly suit: Suit }
  | { readonly type: "DISCARD"; readonly tile: Tile }
  /** 自摸和牌。 */
  | { readonly type: "TSUMO" }
  /** 暗杠 / 加杠（按手里的牌判断是哪种），tile 是这种牌里的任意一张。 */
  | { readonly type: "KONG"; readonly tile: Tile }
  /** 抢牌窗口里的回应。 */
  | { readonly type: "CLAIM"; readonly action: ClaimAction | "pass" }
  /** 结算画面：准备好下一盘。 */
  | { readonly type: "READY" }
  /** 托管开关。 */
  | { readonly type: "AUTO"; readonly on: boolean };

export type GameEvent =
  | { readonly type: "HandStarted"; readonly handNo: number; readonly dealer: number }
  | { readonly type: "Swapped"; readonly direction: "next" | "prev" | "across" }
  | { readonly type: "VoidsRevealed"; readonly voids: (Suit | null)[] }
  | { readonly type: "Drew"; readonly seat: number; readonly fromTail: boolean }
  | { readonly type: "Discarded"; readonly seat: number; readonly tile: Tile; readonly auto?: boolean }
  | { readonly type: "Pung"; readonly seat: number; readonly from: number; readonly tile: Tile }
  | { readonly type: "Kong"; readonly seat: number; readonly kongType: "kong" | "addedKong" | "concealedKong"; readonly tile: Tile; readonly from?: number; readonly gain: number }
  | { readonly type: "KongRobbed"; readonly seat: number; readonly tile: Tile }
  | { readonly type: "Hu"; readonly seat: number; readonly win: Win }
  | { readonly type: "Transfer"; readonly from: number; readonly to: number; readonly amount: number }
  | { readonly type: "HandEnded"; readonly handNo: number; readonly summary: HandSummary }
  | { readonly type: "TimedOut"; readonly seat: number }
  | { readonly type: "AutoChanged"; readonly seat: number; readonly on: boolean }
  | { readonly type: "GameEnded"; readonly winners: readonly string[] };

export interface FinalResult {
  readonly winners: string[];
  /** 名次（并列同名次），下标是座位。 */
  readonly ranks: number[];
}

export interface SichuanState {
  readonly variant: "sichuan";
  readonly config: SichuanConfig;
  phase: "playing" | "finished";
  players: SichuanPlayer[];
  /** 第几盘，从 1 开始。 */
  handNo: number;
  dealer: number;
  stage: SichuanStage;
  /** turn 阶段轮到谁（座位）；其他阶段是 -1。 */
  turn: number;
  /**
   * turn 阶段的情形：draw 刚摸了牌（可以自摸、杠）；start 庄家第一手（同 draw，可以天胡）；
   * claimed 刚碰完（只能打牌）。
   */
  turnMode: "draw" | "start" | "claimed";
  /** 当前这手是开杠补牌得来的（自摸算杠上花，打出的牌被和算杠上炮）。 */
  afterKong: boolean;
  /** 当前这手摸的是牌墙最后一张（自摸算海底捞月）。 */
  lastDraw: boolean;
  /** 本盘有没有人碰过、杠过（地胡判断）。 */
  anyCall: boolean;
  claim: ClaimWindow | null;
  /** 牌墙剩余张数（顺序只在服务端，见 wall）。 */
  wallCount: number;
  /** 换牌方向（换完以后公开）。 */
  swapDirection: "next" | "prev" | "across" | null;
  kongLedger: KongEntry[];
  /** 最近一次成立的杠：谁杠的、杠分账里的编号（呼叫转移用）。 */
  lastKong: { readonly seat: number; readonly id: number } | null;
  /** 本盘第几次和牌（一炮多响算一次）。 */
  winOrder: number;
  /** 本盘第一次和牌：和牌的人、放炮的人（决定下一盘庄家）。 */
  firstWin: { readonly winners: number[]; readonly from?: number } | null;
  /** 本盘的每一笔结算。 */
  lines: SettleLine[];
  summary: HandSummary | null;
  /** 结算画面里点了「下一盘」的玩家 id。 */
  ready: string[];
  events: GameEvent[];
  history: GameEvent[];
  finalResult?: FinalResult;
  version: number;
  /** 每到一个新的决定点（换阶段、轮到下一个人、开抢牌窗口）+1；服务端据此重置计时。 */
  step: number;
  /** 以下只在服务端。 */
  wall?: Tile[];
  rng?: number;
  seed?: number;
  log?: { seat: number; command: GameCommand | { type: "TIMEOUT" } | { type: "RESOLVE" } }[];
}

export type GameState = SichuanState;
