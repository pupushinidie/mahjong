/**
 * 新手教程的剧本（站内统一做法，见 ~/projects/pipeline/handbook/tutorial-notes.md）。四川麻将、立直麻将各一份，互不相干。
 *
 * 座位固定：你坐 0，右边下家咕噜一号（1），对面咕噜二号（2），左边上家咕噜三号（3）；出牌顺序 0 → 1 → 2 → 3。
 * 牌墙全部按剧本摆好（不洗牌），剧本里用到的随机数（换三张的方向）也定死。
 *
 * 四川（一盘血战到底）：你坐庄 → 换三张（给对家，换来两张筒子凑成 222 筒、88 筒）→ 定缺万 → 先打缺门 →
 *   碰咕噜三号的 8 筒 → 打完缺门听 5 条、6 条 → 摸到第 4 张 3 条暗杠（下雨，每家付 2）→ 咕噜二号自摸下桌（血战到底）→
 *   咕噜三号打 6 条你点炮胡（对对胡 + 断幺九 + 根 = 3 番 8 分）→ 快进到牌摸完：咕噜三号是花猪、没听牌，赔给听牌的咕噜一号。
 * 立直（两局）：东 1 局咕噜三号坐庄：吃上家的红 5 万 → 碰中（役牌）→ 荣和咕噜一号的 4 索（3 番 30 符 3900）；
 *   东 2 局你坐庄，直接快进到中盘：门清听 3-6 索立直，但 6 索自己打过（振听），咕噜二号打 3 索不能荣和；
 *   下一巡自摸 6 索：立直、一发、门前清自摸和、平和、里宝牌 = 5 番满贯，每家付 4000。
 * 练习局：四川一场 1 盘、立直一场东风战，你和三个人机，座位、发牌都随机。
 */
import { applyCommand, botCommand, claimReady, legalCommands, pendingSeats, redactGameForViewer, resolveClaim } from "./engine.js";
import { createRng } from "./rng.js";
import { canTsumo as sichuanCanTsumo, createSichuan, kongOptions, SICHUAN_TILES, stackSichuanHand } from "./sichuan.js";
import { tingInfo } from "./sichuan-score.js";
import { canTsumo as riichiCanTsumo, createRiichi, riichiKanOptions, riichiOptions, stackRiichiHand } from "./riichi.js";
import { riichiWaits } from "./riichi-score.js";
import { kindOf, parseKinds, parseTiles, sortTiles, suitOfTile, type Suit, type Tile } from "./tiles.js";
import type { GameCommand, GameState, SichuanCommand, SichuanState } from "./types.js";
import type { RiichiCommand, RiichiState } from "./riichi-types.js";

export type TutorialFace = "base" | "happy" | "surprised" | "think";
export type TutorialVariant = "sichuan" | "riichi";
/** 剧本里多出来的一种「命令」：四川最后快进到牌摸完（1 摆好残局，2 咕噜三号打出最后一张）。 */
export type TutorialCommand = GameCommand | { readonly type: "FAST_FORWARD"; readonly phase: 1 | 2 };

interface StepBase {
  readonly id: string;
  /** 侧栏进度里的课名（只有几步带）。 */
  readonly lesson?: string;
  /** 主句（24px），一句话。 */
  readonly say: string;
  /** 补充（12px），最多两句。 */
  readonly note?: string;
  /** 触屏上换的说法。 */
  readonly noteTouch?: string;
  /** 高亮哪个元素（data-tutorial）。 */
  readonly anchor?: string;
  readonly face?: TutorialFace;
}

export type TutorialStep =
  | (StepBase & { readonly kind: "info"; readonly finale?: boolean })
  | (StepBase & {
      readonly kind: "do";
      readonly expect: TutorialCommand;
      /** 先选再确认：牌桌报上来的选择（selectionKey）是 sel 时，高亮挪到 anchor。 */
      readonly then?: readonly { readonly sel: string; readonly anchor: string }[];
    })
  | (StepBase & { readonly kind: "watch"; readonly moves: readonly TutorialCommand[] });

/** 自己的玩家 id。 */
export const TUTORIAL_SELF = "p1";
const NAMES = ["咕噜一号", "咕噜二号", "咕噜三号"];
const SICHUAN_SEED = 20261011;
const RIICHI_SEED = 20261012;

function seatPlayers(selfName: string) {
  return [
    { id: TUTORIAL_SELF, name: selfName, bot: false },
    { id: "g1", name: NAMES[0]!, bot: true },
    { id: "g2", name: NAMES[1]!, bot: true },
    { id: "g3", name: NAMES[2]!, bot: true },
  ];
}
const IDS = ["p1", "g1", "g2", "g3"] as const;

/** 牌桌上「先选再确认」报上来的选择：四川定缺 void:m，选中的牌 t:<牌>，立直模式 riichi、riichi:t:<牌>。 */
export const selectionKey = (parts: { readonly voidPick?: Suit | null; readonly riichiMode?: boolean; readonly selected?: Tile | null }): string => {
  if (parts.voidPick) return `void:${parts.voidPick}`;
  const tile = parts.selected !== null && parts.selected !== undefined ? `t:${parts.selected}` : "";
  if (parts.riichiMode) return tile ? `riichi:${tile}` : "riichi";
  return tile;
};

// ---------------------------------------------------------------------------
// 四川麻将

/** 发牌（换三张之前）：你是庄家 14 张，其他三家 13 张。 */
const SC_DEAL = ["12589m 28p 3335566s", "146m 25p 146s 25789s", "235578m 22468p 19s", "1379m 38p 479p 2789s"];
/** 三个咕噜换出去的牌（方向是给对家：你 ↔ 咕噜二号，咕噜一号 ↔ 咕噜三号）。 */
const SC_SWAP_BOTS = ["146s", "228p", "479p"];
/** 三个咕噜的缺门。 */
const SC_VOIDS: Suit[] = ["m", "s", "p"];
/** 牌墙头部按摸牌顺序：咕噜一号、二号、三号、（你碰了不摸）一号、二号、三号、你、一号、二号、三号。 */
const SC_HEAD = "6p 5p 6m 8s 9p 4m 3s 7m 9p 5m";
/** 开杠补的第一张（牌墙尾部）。 */
const SC_TAIL = "1p";

const sc = (() => {
  const used = new Set<Tile>();
  const hands = SC_DEAL.map((text) => parseTiles(text, used));
  const head = parseTiles(SC_HEAD, used);
  const tail = parseTiles(SC_TAIL, used);
  const pick = (seat: number, text: string) => {
    const kinds = parseKinds(text);
    const pool = [...hands[seat]!];
    return kinds.map((kind) => {
      const at = pool.findIndex((tile) => kindOf(tile) === kind);
      if (at < 0) throw new Error(`教程剧本：座位 ${seat} 没有 ${text}`);
      return pool.splice(at, 1)[0]!;
    });
  };
  const mySwap = pick(0, "159m");
  const botSwaps = SC_SWAP_BOTS.map((text, index) => pick(index + 1, text));
  const rest = createRng(7).shuffle(Array.from({ length: SICHUAN_TILES }, (_, tile) => tile).filter((tile) => !used.has(tile)));
  // 开杠从尾部 pop：tail[0] 放最后
  const wall = [...hands.flat(), ...head, ...rest, ...[...tail].reverse()];
  return { hands, head, tail, mySwap, botSwaps, wall };
})();

/** 换三张方向用的随机数状态：找一个第一下就抽到「给对家」的。 */
const SC_SWAP_RNG = (() => {
  for (let seed = 1; ; seed += 1) if (createRng(seed).pick(["next", "prev", "across"] as const) === "across") return seed;
})();

/** 剧本局面里某个座位手里的这种牌（按写法找）。 */
function tileOf(state: GameState, seat: number, code: string): Tile {
  const kind = parseKinds(code)[0]!;
  const tile = state.players[seat]!.hand.find((own) => kindOf(own) === kind);
  if (tile === undefined) throw new Error(`教程剧本：座位 ${seat} 手里没有 ${code}`);
  return tile;
}
/** 剧本写死的牌：在摆好的牌里找第一张这种牌。 */
function scTile(seat: number | "head" | "tail", code: string): Tile {
  const kind = parseKinds(code)[0]!;
  const list = seat === "head" ? sc.head : seat === "tail" ? sc.tail : sc.hands[seat]!;
  const tile = list.find((own) => kindOf(own) === kind);
  if (tile === undefined) throw new Error(`教程剧本：没有 ${code}`);
  return tile;
}

/** 四川剧本开局：一场 8 盘的第 1 盘，你坐庄，三个咕噜已经选好换出的牌。 */
export function createSichuanTutorial(selfName = "你"): SichuanState {
  const players = seatPlayers(selfName);
  let state = createSichuan(players, SICHUAN_SEED, { mode: "xuezhan", swap: true, cap: null, zimo: "fan", hands: 8 });
  state.players = players.map((player) => state.players.find((seated) => seated.id === player.id)!);
  state = stackSichuanHand(state, [...sc.wall], { dealer: 0 });
  sc.botSwaps.forEach((tiles, index) => {
    state = applyCommand(state, IDS[index + 1]!, { type: "SWAP", tiles }) as SichuanState;
  });
  state.rng = SC_SWAP_RNG;
  return state;
}

const scDiscard = (seat: number | "head" | "tail", code: string): SichuanCommand => ({ type: "DISCARD", tile: scTile(seat, code) });

/** 快进：你胡了以后，剩下咕噜一号、咕噜三号直接摆到牌墙摸空前的最后一手（牌一张不少，只是挪了位置）。 */
const FF_G1 = "44p 66p 77p 99p 55s 77s 8s";
function sichuanFastForward(input: SichuanState): SichuanState {
  const state = structuredClone(input);
  const [g1, g3] = [state.players[1]!, state.players[3]!];
  const pool = sortTiles([...g1.hand, ...g3.hand, ...state.wall!]);
  const take = (kinds: number[]) => kinds.map((kind) => {
    const at = pool.findIndex((tile) => kindOf(tile) === kind);
    if (at < 0) throw new Error("教程快进：牌不够");
    return pool.splice(at, 1)[0]!;
  });
  g1.hand = sortTiles(take(parseKinds(FF_G1)));
  // 咕噜三号缺筒，手里还留着两张筒子（花猪）；其余从剩下的万子、条子里拿
  const voids = take(parseKinds("1p 3p"));
  const others = pool.filter((tile) => suitOfTile(tile) !== "p").slice(0, 12);
  for (const tile of others) pool.splice(pool.indexOf(tile), 1);
  g3.hand = sortTiles([...others, ...voids]);
  g1.drawn = null;
  g3.drawn = voids[1]!;
  // 剩下的牌按顺序进两家的牌河
  pool.forEach((tile, index) => (index % 2 === 0 ? g1 : g3).discards.push({ tile }));
  g1.passedHu = false;
  g3.passedHu = false;
  state.wall = [];
  state.wallCount = 0;
  state.lastDraw = true;
  state.afterKong = false;
  state.stage = "turn";
  state.turn = 3;
  state.turnMode = "draw";
  state.claim = null;
  state.players.forEach((player) => (player.handCount = player.hand.length));
  state.step += 1;
  state.version += 1;
  state.events = [];
  return state;
}

export const SICHUAN_STEPS: readonly TutorialStep[] = [
  {
    id: "sc-goal",
    kind: "info",
    lesson: "目标",
    say: "四川麻将只有万、筒、条三门，先凑成「4 组 + 1 对」就能胡。",
    note: "一组是同一门连着的三张（顺子），或者三张一样（刻子）；一对叫「将」。",
    anchor: "hand",
    face: "happy",
  },
  {
    id: "sc-seats",
    kind: "info",
    say: "你坐庄，先拿 14 张；按 你 → 咕噜一号 → 咕噜二号 → 咕噜三号 轮流。",
    note: "咕噜一号在右边（下家），咕噜二号在对面，咕噜三号在左边（上家）。",
  },
  {
    id: "sc-swap",
    kind: "info",
    lesson: "换三张",
    say: "开局先「换三张」：每人挑 3 张同一门的牌交出去。",
    note: "我替你选好了 3 张万子（牌上标着「换」），想换别的可以点牌改选。",
    anchor: "hand",
  },
  {
    id: "sc-swap-do",
    kind: "do",
    say: "点「换出这 3 张」。",
    note: "四家选好以后同时交换，方向随机：给下家、给上家或者给对家。",
    anchor: "btn-swap",
    expect: { type: "SWAP", tiles: sc.mySwap },
  },
  {
    id: "sc-swap-done",
    kind: "info",
    say: "这次是「给对家」：你和咕噜二号互换了 3 张。",
    note: "换来的两张 2 筒、一张 8 筒，正好凑成三张 2 筒和一对 8 筒。",
    anchor: "hand",
    face: "happy",
  },
  {
    id: "sc-void",
    kind: "info",
    lesson: "定缺",
    say: "接着「定缺」：选一门，这一盘不要它。",
    note: "胡牌时手里不能有这门；手里有这门的牌，必须先打掉。一般选张数最少的那门。",
    face: "think",
  },
  {
    id: "sc-void-do",
    kind: "do",
    say: "你的万子只剩 2 张：点「缺万」，再点「确定缺万」。",
    anchor: "btn-void-m",
    then: [{ sel: "void:m", anchor: "btn-void-ok" }],
    expect: { type: "VOID", suit: "m" },
  },
  {
    id: "sc-voids",
    kind: "info",
    say: "四家同时亮出缺门，写在名牌上，整盘都看得见。",
    note: "咕噜一号缺万、咕噜二号缺条、咕噜三号缺筒。",
    anchor: "void-me",
  },
  {
    id: "sc-first",
    kind: "do",
    lesson: "出牌",
    say: "缺门的牌要先打：点一下 2 万选中，再点一次打出去。",
    note: "牌抬起来就是选中了，也可以点「打出」；点错了按「取消」。",
    anchor: `tile:${scTile(0, "2m")}`,
    expect: scDiscard(0, "2m"),
  },
  {
    id: "sc-watch-1",
    kind: "watch",
    say: "咕噜们轮流摸一张、打一张。",
    moves: [scDiscard(1, "4m"), scDiscard(2, "1s"), scDiscard(3, "8p")],
  },
  {
    id: "sc-pung",
    kind: "do",
    lesson: "碰",
    say: "咕噜三号打出 8 筒，你手里正好有一对：点「碰」！",
    note: "别人打出的牌，你有两张一样的就能「碰」过来凑成三张。四川麻将不能「吃」。",
    anchor: "btn-pung",
    face: "happy",
    expect: { type: "CLAIM", action: "pung" },
  },
  {
    id: "sc-pung-discard",
    kind: "do",
    say: "碰完不摸牌，直接打一张：打掉最后一张万子 8 万。",
    note: "8 万标着「听」：打出去你就「听牌」了。",
    anchor: `tile:${scTile(0, "8m")}`,
    expect: scDiscard(0, "8m"),
  },
  {
    id: "sc-ting",
    kind: "info",
    say: "听牌了：再来一张 5 条或 6 条就能胡。",
    note: "这一行写着你听哪几张、按你看得到的牌算还剩几张。",
    anchor: "ting",
    face: "happy",
  },
  {
    id: "sc-watch-2",
    kind: "watch",
    say: "又轮了一圈。",
    moves: [scDiscard(1, "6m"), scDiscard(2, "9s"), scDiscard(3, "3p")],
  },
  {
    id: "sc-kong",
    kind: "do",
    lesson: "杠",
    say: "你摸到第 4 张 3 条：点「暗杠」。",
    note: "四张一样就能「杠」，杠完从牌墙尾部补一张。缺门的牌不能碰也不能杠。",
    anchor: "btn-kong-self",
    expect: { type: "KONG", tile: scTile("head", "3s") },
  },
  {
    id: "sc-rain",
    kind: "info",
    say: "开杠马上收分：暗杠叫「下雨」，另外三家各付你 2 分。",
    note: "明杠（杠别人打的牌）由打牌的人付 2 分；碰过再补一张叫加杠，每家付 1 分，这两种叫「刮风」。",
    anchor: "plate-me",
    face: "happy",
  },
  {
    id: "sc-kong-discard",
    kind: "do",
    say: "补到的 1 筒用不上，打掉它，还是听 5 条、6 条。",
    anchor: `tile:${scTile("tail", "1p")}`,
    expect: scDiscard("tail", "1p"),
  },
  {
    id: "sc-watch-3",
    kind: "watch",
    say: "轮到咕噜们……",
    moves: [scDiscard(1, "1m"), { type: "TSUMO" }],
  },
  {
    id: "sc-out",
    kind: "info",
    lesson: "血战到底",
    say: "咕噜二号自摸了！自摸由还在桌上的每家各付他一份。",
    note: "血战到底：胡了的人下桌，剩下的人接着打，直到三家都胡了或者牌摸完。",
    anchor: "plate-across",
    face: "surprised",
  },
  {
    id: "sc-watch-4",
    kind: "watch",
    say: "咕噜三号出牌……",
    moves: [scDiscard(1, "6s")],
  },
  {
    id: "sc-hu",
    kind: "do",
    lesson: "胡和番数",
    say: "咕噜三号打出 6 条，正是你要的：点「胡」！",
    note: "胡别人打的牌叫「点炮」，只有打这张的人付分。",
    anchor: "btn-hu",
    face: "happy",
    expect: { type: "CLAIM", action: "hu" },
  },
  {
    id: "sc-fan",
    kind: "info",
    say: "你这把是对对胡 1 番 + 断幺九 1 番 + 根 1 番 = 3 番。",
    note: "全是三张一样叫对对胡，没有 1 和 9 叫断幺九，四张一样（杠）算 1 根。分数是 2 的番数次方：3 番 8 分。",
    anchor: "plate-me",
  },
  {
    id: "sc-fans",
    kind: "info",
    say: "常见的番：清一色、七对各 2 番，对对胡 1 番，自摸也加 1 番。",
    note: "杠上开花、抢杠胡、海底捞月各加 1 番；全部番种在右上角「规则」里。",
    face: "think",
  },
  {
    id: "sc-ff-info",
    kind: "info",
    lesson: "牌摸完",
    say: "你也下桌了。剩下两家接着打，我们直接快进到牌摸完。",
  },
  {
    id: "sc-ff",
    kind: "watch",
    say: "最后一张牌……",
    moves: [{ type: "FAST_FORWARD", phase: 1 }, { type: "FAST_FORWARD", phase: 2 }],
  },
  {
    id: "sc-pig",
    kind: "info",
    say: "牌摸完时手里还有缺门牌的叫「花猪」，赔给每个不是花猪的人 16 分。",
    note: "咕噜三号缺筒，手里还留着筒子，赔给咕噜一号。",
    anchor: "summary-lines",
    face: "surprised",
  },
  {
    id: "sc-dajiao",
    kind: "info",
    say: "没听牌的人还要「查大叫」：按听牌的人最多能胡几番赔他。",
    note: "没听牌的人这盘收的杠分也要退回去（退税）。已经下桌的人不参加。",
    anchor: "summary-lines",
    face: "think",
  },
  {
    id: "sc-total",
    kind: "info",
    say: "这一盘你：下雨 +6、被自摸 −2、胡牌 +8，一共 +12。",
    anchor: "summary-me",
    face: "happy",
  },
  {
    id: "sc-site",
    kind: "info",
    lesson: "本站设定",
    say: "打满约定的盘数（默认 8 盘），累计积分最高的人赢。",
    note: "出牌限时 15 秒，连续超时 2 次进入托管，就是人机替你打；空座和掉线的座位也由人机代打。",
  },
  {
    id: "sc-finale",
    kind: "info",
    finale: true,
    say: "学会了！和三个人机打一盘练练吧。",
    note: "拿不准就点「问咕噜嘎」，我告诉你我会怎么打、为什么。",
    face: "happy",
  },
];

// ---------------------------------------------------------------------------
// 立直麻将

/** 东 1 局（咕噜三号坐庄）：发牌顺序 咕噜三号、你、咕噜一号、咕噜二号，各 13 张。 */
const RC1_DEAL = { me: "34m 678p 23s 99s 4z 77z 1p", g1: "159m 159p 19s 23456z", g2: "268m 379p 1268s 467z", g3: "0379m 248p 37s 2356z" };
/** 摸牌顺序：咕噜三号（庄）、（你吃了不摸）咕噜一号、咕噜二号、（你碰了不摸）咕噜一号。 */
const RC1_HEAD = "1m 8p 9s 4s";
/** 王牌 14 张：[4] 是宝牌指示牌 5 筒（宝牌 6 筒）。 */
const RC1_DEAD = "1s 2s 7s 8s 5p 3m 4m 6m 7m 2m 2p 3p 4p 5s";

const rc1 = (() => {
  const used = new Set<Tile>();
  const me = parseTiles(RC1_DEAL.me, used);
  const g1 = parseTiles(RC1_DEAL.g1, used);
  const g2 = parseTiles(RC1_DEAL.g2, used);
  const g3 = parseTiles(RC1_DEAL.g3, used);
  const head = parseTiles(RC1_HEAD, used);
  const dead = parseTiles(RC1_DEAD, used);
  const rest = createRng(11).shuffle(Array.from({ length: 136 }, (_, tile) => tile).filter((tile) => !used.has(tile)));
  return { me, g1, g2, g3, head, tiles: [...g3, ...me, ...g1, ...g2, ...head, ...rest, ...dead] };
})();

/** 东 2 局（你坐庄）快进到第 6 巡：每家牌河 5 张，你刚摸了 9 索。 */
const RC2 = {
  me: "123m 567m 345p 66p 45s 9s",
  meRiver: "1z 9p 6s 8m 2z",
  g1: "147m 258p 369s 3457z",
  g2: "258m 369p 147s 1246z",
  g3: "369m 147p 258s 1567z",
  /** 摸牌顺序：咕噜一号、二号、三号、你。 */
  head: "9m 3s 1p 6s",
  /** 宝牌指示牌 8 筒（宝牌 9 筒）、里宝牌指示牌 1 万（里宝 2 万）。 */
  dora: "8p",
  ura: "1m",
};

function riichiHandTwo(base: RiichiState): RiichiState {
  const state = structuredClone(base);
  const used = new Set<Tile>();
  const hands = [RC2.me, RC2.g1, RC2.g2, RC2.g3].map((text) => parseTiles(text, used));
  const myRiver = parseTiles(RC2.meRiver, used);
  const head = parseTiles(RC2.head, used);
  const dora = parseTiles(RC2.dora, used)[0]!;
  const ura = parseTiles(RC2.ura, used)[0]!;
  const rest = createRng(23).shuffle(Array.from({ length: 136 }, (_, tile) => tile).filter((tile) => !used.has(tile)));
  const dead = rest.splice(0, 12);
  state.dead = [...dead.slice(0, 4), dora, ...dead.slice(4, 8), ura, ...dead.slice(8, 12)];
  const rivers = [myRiver, rest.splice(0, 5), rest.splice(0, 5), rest.splice(0, 5)];
  state.wall = [...head, ...rest];
  state.wallCount = state.wall.length;
  state.rinshanUsed = 0;
  state.doraIndicators = [dora];
  state.pendingKanDora = 0;
  state.kans = [0, 0, 0, 0];
  state.firstDiscards = [];
  state.firstGoAround = false;
  state.suukanPending = false;
  state.players.forEach((player, seat) => {
    player.hand = sortTiles(hands[seat]!);
    player.handCount = player.hand.length;
    player.melds = [];
    player.river = rivers[seat]!.map((tile) => ({ tile }));
    player.riichi = null;
    player.riichiPending = false;
    player.furiten = { discard: false, temp: false, riichi: false };
    player.draws = 6;
    player.drawn = null;
  });
  const me = state.players[0]!;
  me.drawn = hands[0]!.find((tile) => kindOf(tile) === parseKinds("9s")[0])!;
  state.stage = "turn";
  state.turn = 0;
  state.turnMode = "draw";
  state.kuikae = [];
  state.rinshan = false;
  state.lastDraw = false;
  state.claim = null;
  state.result = null;
  state.ready = [];
  state.step += 1;
  state.events = [];
  return state;
}

/** 立直剧本开局：半庄战东 1 局，咕噜三号坐庄。 */
export function createRiichiTutorial(selfName = "你"): RiichiState {
  const players = seatPlayers(selfName);
  let state = createRiichi(players, RIICHI_SEED, { length: "hanchan", aka: true, kuitan: true });
  state.players = players.map((player) => state.players.find((seated) => seated.id === player.id)!);
  (state as { startDealer: number }).startDealer = 3;
  state = stackRiichiHand(state, [...rc1.tiles], { dealer: 3, roundWind: 0, roundIndex: 1, honba: 0, kyoutaku: 0 });
  return state;
}

const rcTile = (list: Tile[], code: string): Tile => {
  const kind = parseKinds(code)[0]!;
  const tile = code === "0m" ? 16 : list.find((own) => kindOf(own) === kind);
  if (tile === undefined) throw new Error(`教程剧本：没有 ${code}`);
  return tile;
};
const rc2Tile = (seat: number | "head", code: string): Tile => {
  const used = new Set<Tile>();
  const lists = [RC2.me, RC2.g1, RC2.g2, RC2.g3].map((text) => parseTiles(text, used));
  parseTiles(RC2.meRiver, used);
  const head = parseTiles(RC2.head, used);
  return rcTile(seat === "head" ? head : lists[seat]!, code);
};
const rcDiscard = (tile: Tile, riichi = false): RiichiCommand => ({ type: "DISCARD", tile, ...(riichi ? { riichi: true } : {}) });

export const RIICHI_STEPS: readonly TutorialStep[] = [
  {
    id: "rc-goal",
    kind: "info",
    lesson: "目标",
    say: "立直麻将四人各 25000 点起，打完东、南两圈，点数最多的人赢。",
    note: "一样是凑「4 组 + 1 对」；多了字牌（东南西北、白发中），还可以「吃」。",
    face: "happy",
  },
  {
    id: "rc-yaku",
    kind: "info",
    lesson: "役",
    say: "最重要的一条：和牌必须有「役」，没有役凑齐了也不能和。",
    note: "役是规定的牌型或条件。最常见的三个：立直、断幺九（没有 1、9 和字牌）、役牌（三张中、发、白，或者自己的风）。",
    face: "think",
  },
  {
    id: "rc-dora",
    kind: "info",
    lesson: "宝牌",
    say: "这是宝牌指示牌：它的下一张就是宝牌，这里 5 筒 → 宝牌是 6 筒。",
    note: "手里每有一张宝牌加 1 番，红色的 5 也是宝牌。宝牌不算役。",
    anchor: "dora",
  },
  {
    id: "rc-hand",
    kind: "info",
    say: "你有一对中：再碰一张中，就有「役牌」这个役了。",
    note: "另外 3 万 4 万在等 2 万或 5 万。",
    anchor: "hand",
  },
  {
    id: "rc-watch-1",
    kind: "watch",
    say: "庄家咕噜三号先摸先打。",
    moves: [rcDiscard(16)],
  },
  {
    id: "rc-chi",
    kind: "do",
    lesson: "吃和碰",
    say: "咕噜三号打出红 5 万：点「吃」，和 3 万 4 万凑成顺子。",
    note: "只能吃上家（左边）打的牌。吃、碰过以后就不是「门清」了，不能再立直。",
    anchor: "btn-chi",
    expect: { type: "CLAIM", action: "chi", tiles: [rcTile(rc1.me, "3m"), rcTile(rc1.me, "4m")] },
  },
  {
    id: "rc-chi-discard",
    kind: "do",
    say: "吃完直接打一张：打掉北。",
    note: "刚吃进来的 5 万、能接上的 2 万，这一手不能打（叫「食替」）。",
    anchor: `tile:${rcTile(rc1.me, "4z")}`,
    expect: rcDiscard(rcTile(rc1.me, "4z")),
  },
  {
    id: "rc-watch-2",
    kind: "watch",
    say: "咕噜一号、咕噜二号出牌……",
    moves: [rcDiscard(rcTile(rc1.g1, "2z")), rcDiscard(rcTile(rc1.g2, "7z"))],
  },
  {
    id: "rc-pon",
    kind: "do",
    say: "咕噜二号打出中：点「碰」！三张中就是役牌。",
    note: "碰谁打的牌都可以。碰完轮到你直接打牌，中间的人被跳过。",
    anchor: "btn-pon",
    face: "happy",
    expect: { type: "CLAIM", action: "pon", tiles: [rcTile(rc1.me, "7z"), rc1.me.filter((tile) => kindOf(tile) === parseKinds("7z")[0])[1]!] },
  },
  {
    id: "rc-pon-discard",
    kind: "do",
    say: "打掉 1 筒就听牌了：等 1 索或 4 索。",
    anchor: `tile:${rcTile(rc1.me, "1p")}`,
    expect: rcDiscard(rcTile(rc1.me, "1p")),
  },
  {
    id: "rc-watch-3",
    kind: "watch",
    say: "咕噜一号摸牌……",
    moves: [rcDiscard(rcTile(rc1.head, "4s"))],
  },
  {
    id: "rc-ron",
    kind: "do",
    lesson: "荣和",
    say: "咕噜一号打出 4 索，正是你要的：点「荣和」！",
    note: "和别人打的牌叫荣和，打这张的人一个人付；自己摸到叫自摸，三家一起付。",
    anchor: "btn-ron",
    face: "happy",
    expect: { type: "CLAIM", action: "ron" },
  },
  {
    id: "rc-score",
    kind: "info",
    say: "役牌 中 1 番 + 宝牌 1 番 + 红宝牌 1 番 = 3 番。",
    note: "点数由番和符一起算，程序会算好：3 番 30 符，咕噜一号付你 3900 点。",
    anchor: "summary-yaku",
  },
  {
    id: "rc-next",
    kind: "do",
    say: "点「下一局」。",
    note: "庄家转到你了（东 2 局）。我们直接快进到这一局的中盘。",
    anchor: "btn-ready",
    expect: { type: "READY" },
  },
  {
    id: "rc-h2",
    kind: "info",
    lesson: "立直",
    say: "这一局你没吃没碰（门清），打掉 9 索就听 3 索、6 索。",
    anchor: "hand",
  },
  {
    id: "rc-riichi-intro",
    kind: "info",
    say: "门清听牌时可以「立直」：押 1000 点，多一个役，和牌时还能翻里宝牌。",
    note: "代价是立直以后不能换牌：摸到的牌不能和，就自动打出去。",
    face: "think",
  },
  {
    id: "rc-riichi",
    kind: "do",
    say: "点「立直」，再点两下 9 索打出去。",
    note: "立直模式下只有打出去还听牌的牌能选。",
    anchor: "btn-riichi",
    then: [
      { sel: "riichi", anchor: `tile:${rc2Tile(0, "9s")}` },
      { sel: `riichi:t:${rc2Tile(0, "9s")}`, anchor: `tile:${rc2Tile(0, "9s")}` },
    ],
    expect: rcDiscard(rc2Tile(0, "9s"), true),
  },
  {
    id: "rc-furiten",
    kind: "info",
    lesson: "振听",
    say: "看这里写着「振听」：你听的 6 索，自己早先打过一张。",
    note: "自己打过的牌里有你要和的牌，就是振听：不能荣和别人打的牌，只能自摸。",
    anchor: "ting",
    face: "surprised",
  },
  {
    id: "rc-watch-4",
    kind: "watch",
    say: "咕噜们出牌……",
    moves: [rcDiscard(rc2Tile("head", "9m")), rcDiscard(rc2Tile("head", "3s"))],
  },
  {
    id: "rc-furiten-2",
    kind: "info",
    say: "咕噜二号打出 3 索，可你振听，不能荣和。",
    note: "放过能和的牌也会振听到你下次打牌；立直以后放过，这一局都只能自摸。",
    anchor: "river-across",
    face: "think",
  },
  {
    id: "rc-watch-5",
    kind: "watch",
    say: "咕噜三号出牌，然后轮到你摸牌……",
    moves: [rcDiscard(rc2Tile("head", "1p"))],
  },
  {
    id: "rc-tsumo",
    kind: "do",
    lesson: "自摸",
    say: "摸到 6 索：点「自摸」！",
    anchor: "btn-tsumo",
    face: "happy",
    expect: { type: "TSUMO" },
  },
  {
    id: "rc-ura",
    kind: "info",
    say: "立直、一发、门前清自摸和、平和、里宝牌，一共 5 番：满贯！",
    note: "立直后到下次摸牌前和牌叫「一发」；立直的人和牌，再翻开里宝牌指示牌，下一张也是宝牌。",
    anchor: "summary-yaku",
    face: "happy",
  },
  {
    id: "rc-points",
    kind: "info",
    say: "你是庄家，满贯自摸三家各付 4000，一共 12000 点。",
    note: "庄家和牌比闲家多拿一半；你押的 1000 点立直棒也拿回来了。",
    anchor: "summary-points",
  },
  {
    id: "rc-draw",
    kind: "info",
    lesson: "流局",
    say: "牌摸完还没人和叫「流局」：没听牌的人一共付 3000 点给听牌的人。",
    note: "庄家听牌就连庄（接着坐庄），没听就换下一家坐庄。",
    face: "think",
  },
  {
    id: "rc-site",
    kind: "info",
    lesson: "本站设定",
    say: "每手限时 5 秒，另有每局 20 秒备用时间；连续超时 2 次进入托管，就是人机替你打。",
    note: "空座由人机补上；掉线了人机先代打，用原昵称和房间码回来就能接着打。",
  },
  {
    id: "rc-finale",
    kind: "info",
    finale: true,
    say: "学会了！和三个人机打一场东风战练练吧。",
    note: "拿不准就点「问咕噜嘎」，我告诉你我会怎么打、为什么。",
    face: "happy",
  },
];

// ---------------------------------------------------------------------------
// 共用：开局、走一步、轮到谁

export const tutorialSteps = (variant: TutorialVariant) => (variant === "riichi" ? RIICHI_STEPS : SICHUAN_STEPS);
export function createTutorialGame(variant: TutorialVariant, selfName = "你"): GameState {
  return variant === "riichi" ? createRiichiTutorial(selfName) : createSichuanTutorial(selfName);
}

/** 练习局：四川一场 1 盘（血战到底、换三张），立直一场东风战；你和三个人机，座位、发牌随机。 */
export function createPracticeGame(variant: TutorialVariant, selfName = "你", seed = 1): GameState {
  const players = seatPlayers(selfName);
  if (variant === "riichi") return createRiichi(players, seed, { length: "tonpuu", aka: true, kuitan: true });
  return createSichuan(players, seed, { mode: "xuezhan", swap: true, cap: null, zimo: "fan" }, { hands: 1 as 4 });
}

/** 局面是不是剧本（剧本里的定缺、换第二局按剧本来；练习局交给人机）。 */
const isScript = (state: GameState) => state.seed === SICHUAN_SEED || state.seed === RIICHI_SEED;

/**
 * 教程里走一步：规则引擎 + 几件服务器本来会做的事：抢牌窗口所有人回应完就结算；你点「下一盘」时人机也点；
 * 剧本里的定缺按剧本选，立直剧本第二局换成摆好的中盘。
 */
export function tutorialApply(input: GameState, playerId: string, command: TutorialCommand): GameState {
  if (command.type === "FAST_FORWARD") {
    if (input.variant !== "sichuan") throw new Error("只有四川剧本能快进。");
    if (command.phase === 1) return sichuanFastForward(input);
    const g3 = input.players[3]!;
    const tile = g3.hand.find((own) => suitOfTile(own) === g3.void)!;
    return settle(applyCommand(input, g3.id, { type: "DISCARD", tile }));
  }
  if (playerId === "__resolve") return settle(input);
  let state = applyCommand(input, playerId, command);
  if (command.type === "READY" && state.phase === "playing" && state.stage === "handEnd") {
    for (const player of state.players) if (player.bot && !state.ready.includes(player.id)) state = applyCommand(state, player.id, { type: "READY" });
    if (isScript(state) && state.variant === "riichi" && state.handNo === 2) state = riichiHandTwo(state);
  }
  if (isScript(state) && state.variant === "sichuan" && state.stage === "void") {
    state.players.forEach((player, seat) => {
      if (seat > 0 && !player.voidChosen) state = applyCommand(state, player.id, { type: "VOID", suit: SC_VOIDS[seat - 1]! });
    });
  }
  return settle(state);
}

/** 抢牌窗口：所有人回应完（或者没人能要）就马上结算。 */
function settle(input: GameState): GameState {
  let state = input;
  for (let guard = 0; guard < 8 && state.phase === "playing" && state.stage === "claim" && claimReady(state); guard += 1) state = resolveClaim(state);
  return state;
}

/** 两条命令是不是同一步（打牌按牌种比；换三张按牌种集合比）。 */
export function sameCommand(a: TutorialCommand, b: TutorialCommand): boolean {
  if (a.type !== b.type) return false;
  const kinds = (tiles: readonly Tile[]) => tiles.map(kindOf).sort((x, y) => x - y).join(",");
  switch (a.type) {
    case "DISCARD":
      return b.type === "DISCARD" && kindOf(a.tile) === kindOf(b.tile) && ((a as RiichiCommand & { riichi?: boolean }).riichi === true) === ((b as RiichiCommand & { riichi?: boolean }).riichi === true);
    case "SWAP":
      return b.type === "SWAP" && kinds(a.tiles) === kinds(b.tiles);
    case "VOID":
      return b.type === "VOID" && a.suit === b.suit;
    case "KONG":
      return b.type === "KONG" && kindOf(a.tile) === kindOf(b.tile);
    case "CLAIM": {
      if (b.type !== "CLAIM" || a.action !== b.action) return false;
      const at = (a as { tiles?: readonly Tile[] }).tiles;
      const bt = (b as { tiles?: readonly Tile[] }).tiles;
      return !at || !bt || kinds(at) === kinds(bt);
    }
    case "AUTO":
      return b.type === "AUTO" && a.on === b.on;
    case "FAST_FORWARD":
      return b.type === "FAST_FORWARD" && a.phase === b.phase;
    default:
      return true;
  }
}

/**
 * 现在轮到谁：出牌是轮到的人；抢牌窗口先问你、再问人机；换三张 / 定缺先让人机选；结算画面等你点「下一盘」。
 * 抢牌窗口已经能结算时返回 "__resolve"（tutorialApply 认它）。一场结束返回 null。
 */
export function tutorialActor(state: GameState): string | null {
  if (state.phase === "finished") return null;
  const id = (seat: number) => state.players[seat]!.id;
  if (state.stage === "turn") return id(state.turn);
  if (state.stage === "handEnd") {
    if (!state.ready.includes(TUTORIAL_SELF)) return TUTORIAL_SELF;
    const bot = state.players.find((player) => !state.ready.includes(player.id));
    return bot?.id ?? null;
  }
  const pending = pendingSeats(state);
  const self = state.players.findIndex((player) => player.id === TUTORIAL_SELF);
  if (state.stage === "claim") {
    if (pending.length === 0) return "__resolve";
    return pending.includes(self) ? TUTORIAL_SELF : id(pending[0]!);
  }
  const bot = pending.find((seat) => seat !== self);
  if (bot !== undefined) return id(bot);
  return pending.length > 0 ? TUTORIAL_SELF : null;
}

/** 练习局里自己现在能不能发命令（换三张、定缺不用等人机先选）。 */
export function tutorialCanAct(state: GameState, playerId: string): boolean {
  return legalCommands(state, playerId).length > 0;
}

/** 人机替 playerId 走一步（只给它看自己能看到的那份）。 */
export function tutorialBot(state: GameState, playerId: string): GameCommand | null {
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0) return null;
  if (state.stage === "handEnd") return state.ready.includes(playerId) ? null : { type: "READY" };
  return botCommand(redactGameForViewer(state, playerId), seat);
}

/**
 * 锚点在这个局面下应该看得见（剧本单测用；和网页上 data-tutorial 的出现条件一致）。viewer 是自己的座位。
 * 相对位置：plate-next 下家（右）、plate-across 对家（上）、plate-prev 上家（左）。
 */
export function anchorVisible(state: GameState, anchor: string, viewer = 0): boolean {
  const me = state.players[viewer]!;
  const live = state.phase === "playing";
  const myTurn = live && state.stage === "turn" && state.turn === viewer;
  if (/^plate-(me|next|across|prev)$/.test(anchor) || /^river-(me|next|across|prev)$/.test(anchor) || anchor === "center") return true;
  if (anchor === "hand") return me.hand.length > 0;
  const tile = /^tile:(\d+)$/.exec(anchor);
  if (tile) return me.hand.includes(Number(tile[1]));
  if (anchor === "btn-discard") return myTurn;
  if (anchor === "btn-ready" || anchor.startsWith("summary-")) {
    if (!live || state.stage !== "handEnd") return false;
    if (state.variant === "sichuan") return state.summary !== null;
    if (anchor === "summary-yaku") return (state.result?.wins.length ?? 0) > 0;
    return state.result !== null;
  }
  if (state.variant === "sichuan") {
    const me = state.players[viewer]!;
    const claim = state.stage === "claim" && state.claim?.responses[viewer] === undefined ? state.claim?.options[viewer] ?? [] : [];
    if (anchor === "btn-swap") return live && state.stage === "swap" && !me.swapChosen;
    if (/^btn-void-(m|p|s|ok)$/.test(anchor)) return live && state.stage === "void" && !me.voidChosen;
    if (anchor === "void-me") return state.players.every((player) => player.voidChosen) && me.void !== null;
    if (anchor === "swap-dir") return state.swapDirection !== null && state.stage !== "swap";
    if (anchor === "btn-hu") return claim.includes("hu");
    if (anchor === "btn-pung") return claim.includes("pung");
    if (anchor === "btn-kong") return claim.includes("kong");
    if (anchor === "btn-pass") return claim.length > 0;
    if (anchor === "btn-tsumo") return myTurn && sichuanCanTsumo(state, viewer);
    if (anchor === "btn-kong-self") return myTurn && kongOptions(state, viewer).length > 0;
    if (anchor === "ting") {
      if (me.hand.length % 3 !== 1 || me.out) return false;
      return tingInfo(me.hand, me.melds, me.void, state.config).kinds.length > 0;
    }
    return false;
  }
  const rme = state.players[viewer]!;
  const claim = state.stage === "claim" && state.claim?.responses[viewer] === undefined ? state.claim?.options[viewer] ?? [] : [];
  if (anchor === "dora") return true;
  if (anchor === "btn-ron") return claim.includes("ron");
  if (anchor === "btn-pon") return claim.includes("pon");
  if (anchor === "btn-chi") return claim.includes("chi");
  if (anchor === "btn-minkan") return claim.includes("minkan");
  if (anchor === "btn-pass") return claim.length > 0;
  if (anchor === "btn-tsumo") return myTurn && riichiCanTsumo(state, viewer);
  if (anchor === "btn-kong-self") return myTurn && riichiKanOptions(state, viewer).length > 0;
  if (anchor === "btn-riichi") return myTurn && riichiOptions(state, viewer).length > 0;
  if (anchor === "ting") return rme.hand.length % 3 === 1 && riichiWaits(rme.hand, rme.melds).length > 0;
  return false;
}
