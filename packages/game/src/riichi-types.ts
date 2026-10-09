/**
 * 立直麻将（日本麻将）的状态类型。规则书：~/Desktop/游戏规则/立直麻将.md（按雀魂段位战习惯：25000 点起、30000 点返、3 张红五、有食断）。
 * 座位 0–3 按逆时针（出牌顺序）排列：i 的下家是 i+1，对家是 i+2，上家是 i+3。
 */
import type { Tile } from "./tiles.js";

export interface RiichiOptions {
  /** 半庄（东南战）/ 东风战。 */
  readonly length: "hanchan" | "tonpuu";
  /** 3 张红五。 */
  readonly aka: boolean;
  /** 食断（副露也算断幺九）。 */
  readonly kuitan: boolean;
}

export interface RiichiConfig extends RiichiOptions {
  /** 起始点数、返点。 */
  readonly startPoints: number;
  readonly returnPoints: number;
  /** 每一步的基本限时（秒）+ 每局的备用时间（秒，服务端扣）。 */
  readonly stepSec: number;
  readonly bankSec: number;
  readonly claimSec: number;
  readonly handEndSec: number;
}

export type RiichiMeldType = "chi" | "pon" | "minkan" | "kakan" | "ankan";

export interface RiichiMeld {
  readonly type: RiichiMeldType;
  /** 具体的牌（吃、碰、明杠里拿来的那张是 taken）。暗杠对别人也公开（规则书 ⚠️8：公开牌种）。 */
  readonly tiles: Tile[];
  /** 吃、碰、明杠拿来的那张、加杠加上去的那张。 */
  readonly taken?: Tile;
  /** 吃、碰、明杠：牌是谁打的（座位）。加杠沿用原来碰的来源。 */
  readonly from?: number;
}

export interface RiverTile {
  readonly tile: Tile;
  /** 宣告立直打出的那张（横放）。 */
  readonly riichi?: boolean;
  /** 被别人吃碰杠拿走了（还留在牌河里显示，振听也算它）。 */
  taken?: boolean;
  /** 摸切（刚摸的那张直接打出）。 */
  readonly tsumogiri?: boolean;
}

export interface YakuItem {
  readonly name: string;
  /** 番数；役满的话是役满倍数（yakuman 为 true）。 */
  readonly han: number;
  readonly yakuman?: boolean;
}

export interface RiichiWin {
  readonly seat: number;
  readonly how: "tsumo" | "ron";
  readonly from?: number;
  readonly tile: Tile;
  /** 和牌时的手牌（含和的那张）和副露，结算画面显示。 */
  readonly hand: Tile[];
  readonly melds: RiichiMeld[];
  readonly yaku: YakuItem[];
  /** 普通役 + 宝牌的总番数（役满时是 0）。 */
  readonly han: number;
  readonly fu: number;
  /** 役满倍数（0 = 不是役满）。 */
  readonly yakuman: number;
  /** 满贯、跳满……的名字（没有就是空串）。 */
  readonly limit: string;
  /** 这家和牌一共收到多少（不含供托）。 */
  readonly points: number;
  /** 宝牌、里宝牌指示牌（里宝只在立直和牌时有）。 */
  readonly doraIndicators: Tile[];
  readonly uraIndicators: Tile[];
  /** 包牌的人。 */
  readonly liable?: number;
}

export interface RiichiPlayer {
  readonly id: string;
  readonly name: string;
  readonly bot: boolean;
  auto: boolean;
  timeouts: number;
  /** 点数。 */
  points: number;

  hand: Tile[];
  handCount: number;
  drawn: Tile | null;
  melds: RiichiMeld[];
  river: RiverTile[];
  /** 立直：第几巡宣告的、是不是双立直、一发还在不在。 */
  riichi: { readonly double: boolean; ippatsu: boolean } | null;
  /** 宣告立直、正在等那张牌有没有人荣和（成立之前）。 */
  riichiPending: boolean;
  /** 振听（只发给自己）：舍张振听、同巡振听、立直振听。 */
  furiten: { discard: boolean; temp: boolean; riichi: boolean };
  /** 本局摸过几次牌（第一巡判断）。 */
  draws: number;
  /** 包牌：谁负责（大三元 / 大四喜），给自己记。 */
  pao: { readonly yakuman: "daisangen" | "daisuushii"; readonly liable: number } | null;
  /** 本局得失（结算显示）。 */
  handDelta: number;
}

export type RiichiStage = "turn" | "claim" | "handEnd";

export type RiichiClaimAction = "ron" | "pon" | "minkan" | "chi";

export interface RiichiClaim {
  readonly tile: Tile;
  readonly from: number;
  readonly kind: "discard" | "kakan" | "ankan";
  /** 这张是牌墙空了以后打出的（只能荣和，算河底）。 */
  readonly last: boolean;
  /** 打出这张时宣告了立直。 */
  readonly riichi: boolean;
  /** 每个座位能做的动作；chi 的组合（用手里哪两张）另给。发给玩家时只留自己的。 */
  options: Partial<Record<number, RiichiClaimAction[]>>;
  chiOptions: Partial<Record<number, [Tile, Tile][]>>;
  /** 碰也可能有两种（红五和普通五）。 */
  ponOptions: Partial<Record<number, [Tile, Tile][]>>;
  responses: Partial<Record<number, { action: RiichiClaimAction | "pass"; tiles?: [Tile, Tile] }>>;
  pending: number;
}

export type RiichiCommand =
  | { readonly type: "DISCARD"; readonly tile: Tile; readonly riichi?: boolean }
  | { readonly type: "TSUMO" }
  /** 暗杠 / 加杠（按手里的牌判断是哪种）。 */
  | { readonly type: "KONG"; readonly tile: Tile }
  /** 九种九牌流局。 */
  | { readonly type: "KYUUSHU" }
  | { readonly type: "CLAIM"; readonly action: RiichiClaimAction | "pass"; readonly tiles?: readonly [Tile, Tile] }
  | { readonly type: "READY" }
  | { readonly type: "AUTO"; readonly on: boolean };

export interface DrawResult {
  readonly kind: "exhaustive" | "kyuushu" | "suufon" | "suucha" | "suukan";
  /** 荒牌流局：每个座位听不听牌、流局满贯。 */
  readonly tenpai: boolean[];
  readonly nagashi: number[];
}

export interface RiichiHandResult {
  readonly roundLabel: string;
  readonly wins: RiichiWin[];
  readonly draw: DrawResult | null;
  /** 每个座位本局的点数变化（含立直棒、供托）。 */
  readonly deltas: [number, number, number, number];
  /** 结算后每家的点数。 */
  readonly points: [number, number, number, number];
  readonly renchan: boolean;
  /** 这局完了以后半庄是否结束、为什么。 */
  readonly gameOver: string | null;
}

export type RiichiEvent =
  | { readonly type: "HandStarted"; readonly label: string; readonly dealer: number; readonly honba: number }
  | { readonly type: "Drew"; readonly seat: number; readonly rinshan: boolean }
  | { readonly type: "Discarded"; readonly seat: number; readonly tile: Tile; readonly riichi?: boolean; readonly tsumogiri?: boolean; readonly auto?: boolean }
  | { readonly type: "RiichiDeclared"; readonly seat: number; readonly double: boolean }
  | { readonly type: "Called"; readonly seat: number; readonly meld: RiichiMeld }
  | { readonly type: "DoraRevealed"; readonly indicator: Tile }
  | { readonly type: "Won"; readonly win: RiichiWin }
  | { readonly type: "Draw"; readonly kind: DrawResult["kind"] }
  | { readonly type: "HandEnded"; readonly result: RiichiHandResult }
  | { readonly type: "TimedOut"; readonly seat: number }
  | { readonly type: "AutoChanged"; readonly seat: number; readonly on: boolean }
  | { readonly type: "GameEnded"; readonly winners: readonly string[] };

export interface RiichiFinal {
  readonly winners: string[];
  /** 名次（1–4，不并列：同分按起家顺序），下标是座位。 */
  readonly ranks: number[];
  /** 最终得分（千点）：(点数 − 返点) / 1000 + 马 + 1 位加成。 */
  readonly scores: number[];
}

export interface RiichiState {
  readonly variant: "riichi";
  readonly config: RiichiConfig;
  phase: "playing" | "finished";
  players: RiichiPlayer[];
  /** 起家（第一局的庄家）。 */
  readonly startDealer: number;
  /** 场风：0 东、1 南、2 西。 */
  roundWind: number;
  /** 第几局（1–4，东 1 局 = 1）。 */
  roundIndex: number;
  dealer: number;
  honba: number;
  /** 桌上的供托（点数）。 */
  kyoutaku: number;
  /** 第几局（从 1 开始累计，用来区分局）。 */
  handNo: number;
  stage: RiichiStage;
  turn: number;
  /** draw 刚摸了牌；called 刚吃碰完（只能打牌，有食替限制）。 */
  turnMode: "draw" | "called";
  /** 刚吃碰的那组（食替限制）。 */
  kuikae: number[];
  /** 当前这手是岭上牌。 */
  rinshan: boolean;
  /** 当前这手摸的是牌墙最后一张。 */
  lastDraw: boolean;
  /** 第一巡还没被打断（没人吃碰杠，暗杠也算打断）。 */
  firstGoAround: boolean;
  claim: RiichiClaim | null;
  /** 能正常摸的牌还剩几张。 */
  wallCount: number;
  /** 已翻开的宝牌指示牌。 */
  doraIndicators: Tile[];
  /** 明杠、加杠后等开杠的人打牌再翻的杠宝数。 */
  pendingKanDora: number;
  /** 每个座位开了几个杠（四杠散了的判断）。 */
  kans: number[];
  /** 第一巡 4 个人打出的第一张（四风连打）。 */
  firstDiscards: Tile[];
  /** 最近一次杠以后打出的牌是不是第 4 个杠后的（四杠散了）。 */
  suukanPending: boolean;
  result: RiichiHandResult | null;
  ready: string[];
  events: RiichiEvent[];
  history: RiichiEvent[];
  finalResult?: RiichiFinal;
  version: number;
  step: number;
  /** 以下只在服务端：牌墙、王牌、随机数、种子、动作记录。 */
  wall?: Tile[];
  dead?: Tile[];
  rinshanUsed?: number;
  rng?: number;
  seed?: number;
  log?: { seat: number; command: RiichiCommand | { type: "TIMEOUT" } | { type: "RESOLVE" } }[];
}
