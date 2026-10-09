import { describe, expect, it } from "vitest";
import { createRng } from "./rng.js";
import * as engine from "./engine.js";
import { decompositions, shanten, standardShanten } from "./hand.js";
import { canTsumo, createSichuan, discardable, kongOptions, SICHUAN_TILES } from "./sichuan.js";
import { evaluateHu, tingInfo } from "./sichuan-score.js";
import { countKinds, kindOf, parseKinds, parseTiles, suitOfTile, SUITS, type Suit, type Tile } from "./tiles.js";
import type { SichuanCommand, Meld, SichuanOptions, SichuanState } from "./types.js";

// 统一入口返回的是两种玩法的联合类型；这里只测四川，收窄一下。
const applyCommand = (state: SichuanState, id: string, command: SichuanCommand) => engine.applyCommand(state, id, command) as SichuanState;
const resolveClaim = (state: SichuanState) => engine.resolveClaim(state) as SichuanState;
const timeoutTurn = (state: SichuanState) => engine.timeoutTurn(state) as SichuanState;
const redactGameForViewer = (state: SichuanState, id: string) => engine.redactGameForViewer(state, id) as SichuanState;
const botCommand = (state: SichuanState, seat: number) => engine.botCommand(state, seat) as SichuanCommand;
const { claimReady, pendingSeats } = engine;

const PLAYERS = [
  { id: "A", name: "甲" },
  { id: "B", name: "乙" },
  { id: "C", name: "丙" },
  { id: "D", name: "丁" },
];
const IDS = ["A", "B", "C", "D"] as const;
const [A, B, C, D] = [0, 1, 2, 3];

interface MeldSpec {
  readonly seat: number;
  readonly type: Meld["type"];
  readonly tiles: string;
  readonly from?: number;
}

interface Spec {
  readonly hands: readonly string[];
  readonly voids?: readonly (Suit | undefined)[];
  readonly melds?: readonly MeldSpec[];
  readonly turn: number;
  readonly turnMode?: SichuanState["turnMode"];
  /** 轮到的人刚摸的那张（已经写在 hands 里）。 */
  readonly drawn?: string;
  readonly wallHead?: string;
  readonly wallTail?: string;
  /** 牌墙只留 wallHead / wallTail 里的牌（模拟快摸完）。 */
  readonly shortWall?: boolean;
  readonly options?: Partial<SichuanOptions>;
  readonly dealer?: number;
}

/** 按 A、B、C、D 的座位摆好一个打牌中的局面。 */
function build(spec: Spec): SichuanState {
  const base = createSichuan(PLAYERS, 7, { swap: false, ...spec.options });
  const state = structuredClone(base);
  state.players = IDS.map((id) => state.players.find((player) => player.id === id)!);
  const used = new Set<Tile>();
  state.players.forEach((player, seat) => {
    player.hand = parseTiles(spec.hands[seat] ?? "", used).sort((a, b) => a - b);
    player.melds = [];
    player.discards = [];
    player.draws = 5;
  });
  for (const meld of spec.melds ?? []) {
    const tiles = parseTiles(meld.tiles, used);
    state.players[meld.seat]!.melds.push({ type: meld.type, tiles, ...(meld.from !== undefined ? { from: meld.from } : {}) });
  }
  state.players.forEach((player, seat) => {
    const all = [...player.hand, ...player.melds.flatMap((meld) => meld.tiles)];
    const chosen = spec.voids?.[seat];
    const fallback = SUITS.map((suit) => ({ suit, count: all.filter((tile) => suitOfTile(tile) === suit).length })).sort((a, b) => a.count - b.count)[0]!.suit;
    player.void = chosen ?? fallback;
    player.voidChosen = true;
    player.swapChosen = true;
  });
  const head = spec.wallHead ? parseTiles(spec.wallHead, used) : [];
  const tail = spec.wallTail ? parseTiles(spec.wallTail, used) : [];
  const rest = spec.shortWall ? [] : Array.from({ length: SICHUAN_TILES }, (_, tile) => tile).filter((tile) => !used.has(tile));
  state.wall = [...head, ...rest, ...tail];
  state.wallCount = state.wall.length;
  state.stage = "turn";
  state.turn = spec.turn;
  state.turnMode = spec.turnMode ?? "draw";
  state.dealer = spec.dealer ?? A;
  state.anyCall = (spec.melds ?? []).length > 0;
  const turnPlayer = state.players[spec.turn]!;
  turnPlayer.drawn = spec.drawn ? turnPlayer.hand.find((tile) => kindOf(tile) === parseKinds(spec.drawn!)[0])! : null;
  state.players.forEach((player) => (player.handCount = player.hand.length));
  state.step += 1;
  return state;
}

const tileIn = (state: SichuanState, seat: number, code: string) => {
  const kind = parseKinds(code)[0]!;
  const tile = state.players[seat]!.hand.find((own) => kindOf(own) === kind);
  if (tile === undefined) throw new Error(`${IDS[seat]} 手里没有 ${code}`);
  return tile;
};
const run = (state: SichuanState, seat: number, command: SichuanCommand) => applyCommand(state, IDS[seat]!, command);
const discard = (state: SichuanState, seat: number, code: string) => run(state, seat, { type: "DISCARD", tile: tileIn(state, seat, code) });
const scores = (state: SichuanState) => state.players.map((player) => player.score);

describe("麻将内核", () => {
  it("拆解、七对、向听数", () => {
    expect(decompositions(countKinds(parseKinds("123m 456m 789m 234p 55p")), 4)).toHaveLength(1);
    expect(decompositions(countKinds(parseKinds("111222333m 456p 77s")), 4).length).toBe(2);
    expect(standardShanten(countKinds(parseKinds("123m 456m 789m 234p 5p")), 0)).toBe(0);
    expect(shanten(countKinds(parseKinds("11m 22m 33m 44m 55m 666m")), 0, { sevenPairs: "four-as-two" })).toBe(0);
    expect(standardShanten(countKinds(parseKinds("123m 456m 789m 234p 55p")), 0)).toBe(-1);
    expect(standardShanten(countKinds(parseKinds("7p")), 4)).toBe(0);
    expect(standardShanten(countKinds(parseKinds("1m 4m 7m 2p 5p 8p 3s 6s 9s 1z 2z 3z 4z")), 0)).toBe(8);
  });
});

describe("四川麻将规则书第 10 节", () => {
  it("T1 发牌数量", () => {
    const state = createSichuan(PLAYERS, 3);
    const counts = state.players.map((player) => player.hand.length);
    expect(counts[state.dealer]).toBe(14);
    expect(counts.filter((count) => count === 13)).toHaveLength(3);
    expect(state.wallCount).toBe(55);
    const all = [...state.wall!, ...state.players.flatMap((player) => player.hand)];
    expect(new Set(all).size).toBe(108);
    expect(countKinds(all.map(kindOf)).slice(0, 27).every((count) => count === 4)).toBe(true);
  });

  it("T2 换三张必须同一门，按方向交给别人", () => {
    let state = createSichuan(PLAYERS, 11);
    expect(state.stage).toBe("swap");
    const seatB = state.players.findIndex((player) => player.id === "B");
    const handB = state.players[seatB]!.hand;
    const mixed = [handB.find((tile) => suitOfTile(tile) === "m"), handB.find((tile) => suitOfTile(tile) === "p"), handB.find((tile) => suitOfTile(tile) === "s")];
    if (mixed.every((tile) => tile !== undefined)) {
      expect(() => applyCommand(state, "B", { type: "SWAP", tiles: mixed as Tile[] })).toThrow("同一门");
    }
    const picks: Tile[][] = [];
    for (const player of state.players) {
      const suit = SUITS.find((candidate) => player.hand.filter((tile) => suitOfTile(tile) === candidate).length >= 3)!;
      const tiles = player.hand.filter((tile) => suitOfTile(tile) === suit).slice(0, 3);
      picks.push(tiles);
      state = applyCommand(state, player.id, { type: "SWAP", tiles });
    }
    expect(state.stage).toBe("void");
    const offset = state.swapDirection === "next" ? 1 : state.swapDirection === "prev" ? 3 : 2;
    state.players.forEach((player, seat) => {
      expect(player.swapIn).toEqual(picks[(seat - offset + 4) % 4]);
      expect(player.hand.length).toBe(seat === state.dealer ? 14 : 13);
    });
    // 换完以后别人只知道自己交出、收到的牌。
    const view = redactGameForViewer(state, "A");
    for (const player of view.players) if (player.id !== "A") expect(player.swapIn).toEqual([]);
  });

  it("T3 缺门优先打", () => {
    const state = build({
      hands: ["1199m 1199p 13579s", "3s 9m 123m 456p 789p 1p 2p 3p", "2233m 6677p 4488m 9p", "1155s 2266s 3377s 4s"],
      voids: [undefined, "s"],
      turn: B,
      drawn: "9m",
    });
    expect(() => discard(state, B, "9m")).toThrow("缺门");
    const after = discard(state, B, "3s");
    expect(after.players[B]!.discards.at(-1)!.tile).toBe(tileIn(state, B, "3s"));
    expect(discardable(build({ hands: ["", "9m 123m 456p 789p 1p 2p 3p 4p"], voids: [undefined, "s"], turn: B }), B)).toHaveLength(14);
  });

  it("T4 缺门的牌不能碰，手里有缺门不能和", () => {
    let state = build({
      hands: ["7m 1199p 2233s 4455s 6s", "5566p 7788p 123p 9p 4p", "77m 456p 789p 11s 23s 9s", "2p 123m 456m 789m 123s"],
      voids: ["m", "m", "m", "p"],
      turn: A,
    });
    state = discard(state, A, "7m");
    expect(state.claim!.options[C]).toBeUndefined();
    state = build({
      hands: ["2p 1199s 3355s 6677s 4s", "4466m 5588m 9p 7p 8p 3p 1p", "1166p 2299m 44p 8s 8m 7s", "123m 456m 789m 123s 2p"],
      voids: ["p", "s", "s", "p"],
      turn: A,
    });
    state = discard(state, A, "2p");
    expect(state.claim!.options[D] ?? []).not.toContain("hu");
  });

  it("T5 平胡 0 番点炮", () => {
    let state = build({
      hands: ["1199m 1199p 13579s", "123m 456m 789m 234p 5p", "5p 2233m 6677p 4488m 9p", "1155s 2266s 3377s 4s"],
      voids: [undefined, "s", "s", "m"],
      turn: C,
    });
    state = discard(state, C, "5p");
    expect(state.claim!.options[B]).toEqual(["hu"]);
    state = run(state, B, { type: "CLAIM", action: "hu" });
    expect(claimReady(state)).toBe(true);
    state = resolveClaim(state);
    expect(scores(state)).toEqual([0, 1, -1, 0]);
    expect(state.players[B]!.wins[0]!.counted).toBe(0);
    expect(state.players[B]!.out).toBe(true);
    expect(state.stage).toBe("turn");
    expect(state.turn).toBe(C);
  });

  it("T6 清龙七对自摸，封顶 4 番", () => {
    const spec: Spec = {
      hands: ["778899m 11p 2233s 4s", "456789p 456789s 1p", "123p 99p 1155s 6677s", "11223344556666m"],
      voids: [undefined, undefined, undefined, "p"],
      turn: D,
      drawn: "6m",
    };
    let state = run(build(spec), D, { type: "TSUMO" });
    const win = state.players[D]!.wins[0]!;
    expect(win.fan).toBe(6);
    expect(win.title).toBe("清龙七对");
    expect(scores(state)).toEqual([-64, -64, -64, 192]);
    state = run(build({ ...spec, options: { cap: 4 } }), D, { type: "TSUMO" });
    expect(scores(state)).toEqual([-16, -16, -16, 48]);
  });

  it("T7 将对和断幺九不叠加", () => {
    let state = build({
      hands: ["5p 1199m 3377m 4466p 9p", "222m 555m 888p 222p 5p", "1133s 6699s 7788s 4s", "4466s 2255s 33p 9p 1p 7p"],
      voids: ["s", "s", "m", "m"],
      turn: A,
    });
    state = discard(state, A, "5p");
    state = resolveClaim(run(state, B, { type: "CLAIM", action: "hu" }));
    const win = state.players[B]!.wins[0]!;
    expect(win.fan).toBe(3);
    expect(win.items.map((item) => item.name)).toEqual(["对对胡", "将对"]);
    expect(scores(state)).toEqual([-8, 8, 0, 0]);
  });

  it("T8 金钩钓", () => {
    let state = build({
      hands: ["2233m 6677m 8899m 1p", "4455s 6677s 33s 99s 9p", "7p", "7p 1199m 4455m 1199s 5p"],
      melds: [
        { seat: C, type: "pung", tiles: "333p", from: A },
        { seat: C, type: "pung", tiles: "666p", from: B },
        { seat: C, type: "pung", tiles: "222s", from: D },
        { seat: C, type: "pung", tiles: "888s", from: A },
      ],
      voids: ["s", "m", "m", "p"],
      turn: D,
    });
    state = discard(state, D, "7p");
    state = resolveClaim(run(state, C, { type: "CLAIM", action: "hu" }));
    const win = state.players[C]!.wins[0]!;
    expect(win.fan).toBe(3);
    expect(win.items.map((item) => item.name)).toEqual(["金钩钓", "断幺九"]);
    expect(scores(state)).toEqual([0, 0, 8, -8]);
  });

  it("T9 刮风下雨和退税", () => {
    let state = build({
      hands: ["2468m 2468s 13579s", "5555p 1m 3m 7m 9m 1p 3p 7p 9p 2m 8m", "111m 999m 222p 33p 44p", "123s 456s 789s 6789p"],
      voids: ["p", "s", "s", "m"],
      turn: B,
      wallTail: "6m",
      shortWall: true,
    });
    state = run(state, B, { type: "KONG", tile: tileIn(state, B, "5p") });
    expect(scores(state)).toEqual([-2, 6, -2, -2]);
    expect(state.kongLedger).toHaveLength(3);
    expect(state.wallCount).toBe(0);
    state = discard(state, B, "6m");
    expect(state.claim!.last).toBe(true);
    state = resolveClaim(state);
    expect(state.stage).toBe("handEnd");
    const status = Object.fromEntries(state.summary!.status.map((item) => [item.seat, item]));
    expect(status[C]).toMatchObject({ ting: true, maxFan: 1 });
    expect(status[D]).toMatchObject({ ting: true, maxFan: 0 });
    expect(status[A]!.ting).toBe(false);
    expect(status[B]!.ting).toBe(false);
    expect(scores(state)).toEqual([-3, -3, 4, 2]);
  });

  it("T10 加杠被抢", () => {
    let state = build({
      hands: ["1199s 2288s 3377s 4s", "5m 11m 22m 33m 1p 3p 7p 9p", "6677m 8899m 4455s 6s", "234p 567p 789p 4m 6m 99p"],
      melds: [{ seat: B, type: "pung", tiles: "555m", from: A }],
      voids: ["m", "s", "p", "s"],
      turn: B,
      drawn: "5m",
    });
    expect(kongOptions(state, B).map((option) => option.type)).toEqual(["addedKong"]);
    state = run(state, B, { type: "KONG", tile: tileIn(state, B, "5m") });
    expect(state.stage).toBe("claim");
    expect(state.claim!.kind).toBe("robKong");
    expect(state.claim!.options[D]).toEqual(["hu"]);
    state = resolveClaim(run(state, D, { type: "CLAIM", action: "hu" }));
    expect(state.players[D]!.wins[0]).toMatchObject({ fan: 1, how: "robKong" });
    expect(scores(state)).toEqual([0, -2, 0, 2]);
    expect(state.players[B]!.melds[0]!.type).toBe("pung");
    expect(state.kongLedger).toHaveLength(0);
    expect(state.turn).toBe(A);
  });

  it("T11 杠上炮和呼叫转移", () => {
    let state = build({
      hands: ["111m 333m 444p 666p 2p", "5577m 6688m 99m 13p 5p", "9s 2p 12345s 678p 7s", "4455s 3366s 2s 77s 88s"],
      melds: [{ seat: C, type: "pung", tiles: "999s", from: D }],
      voids: ["s", "s", "m", "m"],
      turn: C,
      drawn: "9s",
      wallTail: "8p",
    });
    state = run(state, C, { type: "KONG", tile: tileIn(state, C, "9s") });
    expect(state.claim!.kind).toBe("robKong");
    state = resolveClaim(state);
    expect(scores(state)).toEqual([-1, -1, 3, -1]);
    expect(state.afterKong).toBe(true);
    state = discard(state, C, "2p");
    expect(state.claim!.afterKong).toBe(true);
    state = resolveClaim(run(state, A, { type: "CLAIM", action: "hu" }));
    expect(state.players[A]!.wins[0]!.items.map((item) => item.name)).toContain("杠上炮");
    expect(scores(state)).toEqual([6, -1, -4, -1]);
    expect(state.kongLedger.every((entry) => entry.transferred)).toBe(true);
  });

  it("T12 一炮多响和下一盘庄家", () => {
    let state = build({
      hands: ["6m 1188s 2299s 3377s 4s", "123m 456p 789p 234p 6m", "5566s 6677m 8899m 1m", "45m 789m 111p 999p 33m"],
      voids: ["p", "s", "p", "s"],
      turn: A,
      dealer: C,
    });
    state = discard(state, A, "6m");
    expect(state.claim!.options[C]).toEqual(["pung"]);
    state = run(state, B, { type: "CLAIM", action: "hu" });
    expect(claimReady(state)).toBe(false);
    state = run(state, D, { type: "CLAIM", action: "hu" });
    expect(claimReady(state)).toBe(true);
    state = resolveClaim(state);
    expect(state.players[B]!.out && state.players[D]!.out).toBe(true);
    expect(state.turn).toBe(A);
    expect(state.firstWin).toEqual({ winners: [B, D], from: A });
    // 牌墙摸空结束这一盘，庄家是放炮的 A。
    state = structuredClone(state);
    state.wall = [];
    state.wallCount = 0;
    state = discard(state, A, "1s");
    state = resolveClaim(state);
    expect(state.stage).toBe("handEnd");
    expect(state.summary!.nextDealer).toBe(A);
  });

  it("T13 过胡", () => {
    let state = build({
      hands: ["3p 2244s 5577s 6688s 1s", "6p 5p 7788p 1199p 99s 1s", "45p 111m 999m 789m 22p", "2233m 4455m 6677m 8m"],
      voids: ["m", "m", "s", "s"],
      turn: A,
      wallHead: "1p 6p",
    });
    state = discard(state, A, "3p");
    expect(state.claim!.options[C]).toEqual(["hu"]);
    state = resolveClaim(run(state, C, { type: "CLAIM", action: "pass" }));
    expect(state.turn).toBe(B);
    state = discard(state, B, "6p");
    expect(state.claim!.options[C]).toBeUndefined();
    state = resolveClaim(state);
    expect(state.turn).toBe(C);
    expect(canTsumo(state, C)).toBe(true);
    expect(state.players[C]!.passedHu).toBe(false);
  });

  it("T14 花猪和查大叫", () => {
    let state = build({
      hands: ["2233m 5577m 99p 33p 3s", "8s 123m 456m 789m 99m 2p", "111p 444p 666p 88p 55p", "1357m 2468s 1357s 9s 9p"],
      voids: ["s", "s", "m", "p"],
      turn: D,
      shortWall: true,
    });
    state.players[A]!.out = true;
    state.players[A]!.wins = [{ tile: 0, how: "zimo", fan: 0, counted: 0, items: [], title: "平胡", points: 1, payers: [], order: 1 }];
    state = discard(state, D, "9p");
    state = resolveClaim(state);
    expect(state.stage).toBe("handEnd");
    expect(scores(state)).toEqual([0, -40, 32, 8]);
  });

  it("T15 血战 3 家和牌即结束", () => {
    let state = build({
      hands: ["1199s 2288s 3377s 4s", "4466s 5566p 77p 8p 9p", "123m 456m 789m 22p 34p 5p", "1133m 5588m 2244p 3p"],
      voids: ["m", "m", "s", "s"],
      turn: C,
      drawn: "5p",
    });
    state.players[A]!.out = true;
    state.players[B]!.out = true;
    state = run(state, C, { type: "TSUMO" });
    expect(state.players[C]!.wins[0]!.payers).toEqual([D]);
    expect(scores(state)).toEqual([0, 0, 2, -2]);
    expect(state.stage).toBe("handEnd");
    expect(state.summary!.reason).toBe("allWon");
  });

  it("T16 血流成河锁定手牌", () => {
    const won = { tile: 0, how: "zimo" as const, fan: 0, counted: 0, items: [], title: "平胡", points: 1, payers: [], order: 1 };
    // B 听 6p、9p，摸到 3m 只能摸切。
    let state = build({
      hands: ["1199s 2288s 3377s 4s 5s", "234m 567m 11p 456p 78p", "1188m 99m 2233s 6s 5s 4s", "4466s 22p 33p 5p 9p 8m 77m"],
      voids: ["m", "s", "p", "m"],
      turn: A,
      wallHead: "3m 9p",
      options: { mode: "xueliu" },
    });
    state.players[B]!.wins = [won];
    state = discard(state, A, "5s");
    state = resolveClaim(state);
    expect(state.stage).toBe("claim");
    expect(state.claim!.from).toBe(B);
    expect(kindOf(state.claim!.tile)).toBe(parseKinds("3m")[0]);
    expect(state.claim!.options[C]).toBeUndefined();

    // C 锁定只听 2p，摸到 8m 可以暗杠；D 听 4p 7p 8p，摸到 9p 不能杠。
    state = build({
      hands: ["1199s 2288s 3377s 4s 5s", "1133s 4466s 7p 1p 3p 9s", "234m 567m 888m 456p 2p 8m", "234m 567m 4567p 999p"],
      voids: ["m", "m", "s", "s"],
      turn: C,
      drawn: "8m",
      options: { mode: "xueliu" },
    });
    state.players[C]!.wins = [won];
    expect(kongOptions(state, C).map((option) => option.type)).toEqual(["concealedKong"]);
    state = run(state, C, { type: "KONG", tile: tileIn(state, C, "8m") });
    expect(scores(state)).toEqual([-2, -2, 6, -2]);

    state = build({
      hands: ["1199s 2288s 3377s 4s 5s", "1133s 4466s 7p 1p 3p 6s", "1155m 2266m 88p 7s 6s", "234m 567m 4567p 999p 9p"],
      voids: ["p", "m", "s", "s"],
      turn: D,
      drawn: "9p",
      options: { mode: "xueliu" },
    });
    state.players[D]!.wins = [won];
    expect(tingInfo(state.players[D]!.hand.filter((tile) => tile !== state.players[D]!.drawn), [], "s", state.config).kinds.length).toBe(3);
    expect(kongOptions(state, D)).toEqual([]);
    expect(discardable(state, D)).toEqual([state.players[D]!.drawn]);
  });
});

describe("隐藏信息", () => {
  it("别人的暗杠在事件里也不给牌面；抢牌窗口不给别人的选项和待回应人数", () => {
    let state = build({
      hands: ["2468m 2468s 13579s", "5555p 1m 3m 7m 9m 1p 3p 7p 9p 2m 8m", "111m 999m 222p 33p 44p", "123s 456s 789s 6789p"],
      voids: ["p", "s", "s", "m"],
      turn: B,
      wallTail: "6m",
    });
    state = run(state, B, { type: "KONG", tile: tileIn(state, B, "5p") });
    const forA = redactGameForViewer(state, "A");
    const kongEvent = [...forA.events, ...forA.history].find((event) => event.type === "Kong");
    expect(kongEvent && kongEvent.type === "Kong" ? kongEvent.tile : 0).toBe(-1);
    expect(forA.players[B]!.melds[0]!.tiles).toEqual([-1, -1, -1, -1]);
    const forB = redactGameForViewer(state, "B");
    const ownKong = forB.events.find((event) => event.type === "Kong");
    expect(ownKong && ownKong.type === "Kong" ? ownKong.tile : -1).toBeGreaterThanOrEqual(0);
    // C 能碰 B 打出的三筒：A 看不到 C 的选项，也看不到「还有 1 人没回应」
    state = discard(state, B, "3p");
    expect(state.claim!.options[C]).toContain("pung");
    const claimForA = redactGameForViewer(state, "A").claim!;
    expect(claimForA.options).toEqual({});
    expect(claimForA.pending).toBe(0);
    expect(redactGameForViewer(state, "C").claim!.pending).toBe(1);
  });
});

describe("算番补充", () => {
  it("带幺九、断幺九、对对胡", () => {
    const yaojiu = evaluateHu(parseKinds("123m 789m 111p 999p 11m"), [], "s", { how: "ron" }, { zimo: "fan", cap: null })!;
    expect(yaojiu.items.map((item) => item.name)).toEqual(["平胡", "带幺九"]);
    expect(yaojiu.title).toBe("带幺九");
    const tanyao = evaluateHu(parseKinds("234m 567m 345p 678p 22m"), [], "s", { how: "ron" }, { zimo: "fan", cap: null })!;
    expect(tanyao.fan).toBe(1);
    expect(evaluateHu(parseKinds("234m 567m 345p 678p 2s 2s"), [], "s", { how: "ron" }, { zimo: "fan", cap: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 随机对局：不变量（分数总和为 0、牌数守恒、隐藏信息不泄露）

function totalTiles(state: SichuanState): number {
  let count = state.wall!.length;
  for (const player of state.players) {
    count += player.hand.length;
    count += player.melds.reduce((sum, meld) => sum + meld.tiles.length, 0);
    count += player.discards.filter((entry) => !entry.taken).length;
    count += player.wins.length;
  }
  if (state.claim?.kind === "robKong" && state.stage === "claim") count += 1;
  // 一炮多响：同一张牌被几个人和，只算一张。
  const multi = new Map<string, number>();
  for (const player of state.players) for (const win of player.wins) if (win.how !== "zimo") multi.set(`${win.order}:${win.tile}`, (multi.get(`${win.order}:${win.tile}`) ?? 0) + 1);
  for (const n of multi.values()) count -= n - 1;
  return count;
}

function randomCommand(state: SichuanState, seat: number, rng: ReturnType<typeof createRng>): SichuanCommand {
  if (state.stage === "turn") {
    if (canTsumo(state, seat) && rng.next() < 0.7) return { type: "TSUMO" };
    const kongs = kongOptions(state, seat);
    if (kongs.length > 0 && rng.next() < 0.5) return { type: "KONG", tile: kongs[0]!.tile };
    return { type: "DISCARD", tile: rng.pick(discardable(state, seat)) };
  }
  if (state.stage === "claim") {
    const options = state.claim!.options[seat] ?? [];
    const choices = [...options, "pass" as const];
    return { type: "CLAIM", action: options.includes("hu") && rng.next() < 0.8 ? "hu" : rng.pick(choices) };
  }
  return botCommand(state, seat);
}

function playOut(seed: number, options: Partial<SichuanOptions>, useBots: boolean, check: (state: SichuanState) => void): SichuanState {
  let state = createSichuan(PLAYERS, seed, options);
  const rng = createRng(seed * 31 + 7);
  for (let guard = 0; guard < 20_000 && state.phase === "playing"; guard += 1) {
    const pending = pendingSeats(state);
    if (pending.length === 0) {
      if (state.stage === "claim") state = resolveClaim(state);
      else throw new Error(`卡住了：${state.stage}`);
    } else if (rng.next() < 0.03) {
      state = timeoutTurn(state);
    } else {
      const seat = rng.pick(pending);
      const command = useBots ? botCommand(state, seat) : randomCommand(state, seat, rng);
      state = applyCommand(state, state.players[seat]!.id, command);
    }
    check(state);
  }
  expect(state.phase).toBe("finished");
  return state;
}

describe("随机对局", () => {
  const invariants = (state: SichuanState) => {
    const sum = state.players.reduce((total, player) => total + player.score, 0);
    if (sum !== 0) throw new Error(`分数总和 ${sum}`);
    if (state.phase === "playing" && state.wall && totalTiles(state) !== 108) throw new Error(`牌数 ${totalTiles(state)}（${state.stage}）`);
    for (const player of state.players) {
      if (player.hand.length + player.melds.length * 3 > 14) throw new Error("手牌太多");
    }
  };

  it("300 局随机合法动作（血战 / 血流 / 封顶 / 加底）", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const options: Partial<SichuanOptions> = {
        mode: seed % 2 === 0 ? "xueliu" : "xuezhan",
        swap: seed % 3 !== 0,
        cap: seed % 5 === 0 ? 3 : null,
        zimo: seed % 7 === 0 ? "base" : "fan",
        hands: 4,
      };
      playOut(seed, options, false, invariants);
    }
  }, 240_000);

  it("机器人对局能打完，隐藏信息不泄露", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      playOut(seed, { mode: seed % 2 ? "xuezhan" : "xueliu", hands: 4 }, true, (state) => {
        invariants(state);
        if (state.stage === "handEnd" || state.phase === "finished") return;
        const view = redactGameForViewer(state, "A");
        const json = JSON.stringify(view);
        expect(json).not.toContain('"wall"');
        expect(json).not.toContain('"seed"');
        view.players.forEach((player) => {
          if (player.id === "A" || player.wins.length > 0) return;
          expect(player.hand).toEqual([]);
          expect(player.swapIn).toEqual([]);
          for (const meld of player.melds) if (meld.type === "concealedKong") expect(meld.tiles.every((tile) => tile === -1)).toBe(true);
        });
        if (view.claim) for (const seat of Object.keys(view.claim.options)) expect(view.players[Number(seat)]!.id).toBe("A");
        if (state.stage === "void" && !state.players.every((player) => player.voidChosen)) {
          view.players.forEach((player) => player.id !== "A" && expect(player.void).toBeNull());
        }
      });
    }
  }, 120_000);
});
