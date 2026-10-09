import { describe, expect, it } from "vitest";
import * as engine from "./engine.js";
import { createRng } from "./rng.js";
import { canTsumo, createRiichi, riichiDiscardable, riichiKanOptions, riichiOptions } from "./riichi.js";
import { countKinds, kindOf, parseKinds, parseTiles, type Tile } from "./tiles.js";
import type { RiichiCommand, RiichiMeld, RiichiOptions, RiichiState } from "./riichi-types.js";

const apply = (state: RiichiState, seat: number, command: RiichiCommand) => engine.applyCommand(state, IDS[seat]!, command) as RiichiState;
const resolve = (state: RiichiState) => engine.resolveClaim(state) as RiichiState;
const redact = (state: RiichiState, id: string) => engine.redactGameForViewer(state, id) as RiichiState;

const PLAYERS = [
  { id: "A", name: "甲" },
  { id: "B", name: "乙" },
  { id: "C", name: "丙" },
  { id: "D", name: "丁" },
];
const IDS = ["A", "B", "C", "D"] as const;
const [A, B, C, D] = [0, 1, 2, 3];

interface Spec {
  readonly hands: readonly string[];
  readonly melds?: readonly { seat: number; type: RiichiMeld["type"]; tiles: string; from?: number }[];
  readonly turn: number;
  readonly turnMode?: "draw" | "called";
  readonly drawn?: string;
  readonly wallHead?: string;
  /** 能正常摸的牌只留 wallHead（模拟快摸完）。 */
  readonly shortWall?: boolean;
  readonly dora?: string;
  readonly ura?: string;
  readonly options?: Partial<RiichiOptions>;
  readonly dealer?: number;
  readonly roundWind?: number;
  readonly roundIndex?: number;
  readonly honba?: number;
  readonly kyoutaku?: number;
  readonly points?: readonly number[];
  readonly firstGoAround?: boolean;
}

function build(spec: Spec): RiichiState {
  const state = structuredClone(createRiichi(PLAYERS, 9, spec.options));
  state.players = IDS.map((id) => state.players.find((player) => player.id === id)!);
  (state as { startDealer: number }).startDealer = 0;
  const used = new Set<Tile>();
  state.players.forEach((player, seat) => {
    player.hand = parseTiles(spec.hands[seat] ?? "", used).sort((a, b) => a - b);
    player.melds = [];
    player.river = [];
    player.draws = spec.firstGoAround ? (seat === (spec.dealer ?? A) ? 1 : 0) : 5;
    player.points = spec.points?.[seat] ?? 25000;
    player.riichi = null;
    player.drawn = null;
  });
  for (const meld of spec.melds ?? []) {
    const tiles = parseTiles(meld.tiles, used);
    const taken = meld.type === "ankan" ? undefined : tiles[2];
    state.players[meld.seat]!.melds.push({ type: meld.type, tiles, ...(taken !== undefined ? { taken } : {}), ...(meld.from !== undefined ? { from: meld.from } : {}) });
  }
  const head = spec.wallHead ? parseTiles(spec.wallHead, used) : [];
  const rest = Array.from({ length: 136 }, (_, tile) => tile).filter((tile) => !used.has(tile));
  const deadFill = rest.splice(rest.length - 12, 12);
  // 宝牌、里宝牌指示牌默认都是「南」（宝牌是西），测试里的和牌都不带西
  const doraTile = parseTilesSafe(spec.dora ?? "2z");
  const uraTile = parseTilesSafe(spec.ura ?? "2z");
  state.dead = [...deadFill.slice(0, 4), doraTile ?? deadFill[4]!, ...deadFill.slice(5, 8), uraTile ?? deadFill[8]!, ...deadFill.slice(9, 12), deadFill[0]!, deadFill[1]!].slice(0, 14);
  state.wall = spec.shortWall ? [...head] : [...head, ...rest];
  state.wallCount = state.wall.length;
  state.rinshanUsed = 0;
  state.doraIndicators = [state.dead[4]!];
  state.stage = "turn";
  state.turn = spec.turn;
  state.turnMode = spec.turnMode ?? "draw";
  state.dealer = spec.dealer ?? A;
  state.roundWind = spec.roundWind ?? 0;
  state.roundIndex = spec.roundIndex ?? 1;
  state.honba = spec.honba ?? 0;
  state.kyoutaku = spec.kyoutaku ?? 0;
  state.firstGoAround = spec.firstGoAround ?? false;
  state.firstDiscards = [];
  state.kans = [0, 0, 0, 0];
  state.claim = null;
  state.result = null;
  const turnPlayer = state.players[spec.turn]!;
  turnPlayer.drawn = spec.drawn ? turnPlayer.hand.find((tile) => kindOf(tile) === parseKinds(spec.drawn!)[0])! : null;
  state.players.forEach((player) => (player.handCount = player.hand.length));
  state.step += 1;
  return state;

  function parseTilesSafe(text: string | undefined): Tile | null {
    if (!text) return null;
    const kind = parseKinds(text)[0]!;
    const tile = rest.find((candidate) => kindOf(candidate) === kind) ?? deadFill.find((candidate) => kindOf(candidate) === kind);
    if (tile === undefined) return null;
    rest.splice(rest.indexOf(tile), 1);
    return tile;
  }
}

const tileIn = (state: RiichiState, seat: number, code: string) => {
  const kind = parseKinds(code)[0]!;
  const tile = state.players[seat]!.hand.find((own) => kindOf(own) === kind);
  if (tile === undefined) throw new Error(`${IDS[seat]} 手里没有 ${code}`);
  return tile;
};
const discard = (state: RiichiState, seat: number, code: string, riichi = false) => apply(state, seat, { type: "DISCARD", tile: tileIn(state, seat, code), ...(riichi ? { riichi: true } : {}) });
const points = (state: RiichiState) => state.players.map((player) => player.points);

describe("立直麻将流程（规则书第 10 节）", () => {
  it("T1 配牌", () => {
    const state = createRiichi(PLAYERS, 4);
    const all = [...state.wall!, ...state.dead!, ...state.players.flatMap((player) => player.hand)];
    expect(new Set(all).size).toBe(136);
    expect(countKinds(all.map(kindOf)).every((count) => count === 4)).toBe(true);
    expect(all).toEqual(expect.arrayContaining([16, 52, 88]));
    expect(state.dead).toHaveLength(14);
    expect(state.doraIndicators).toHaveLength(1);
    expect(state.players.map((player) => player.hand.length).sort()).toEqual([13, 13, 13, 14]);
    expect(state.wallCount + 1).toBe(70);
  });

  it("T10 大三元包牌：自摸由负责的人全付；别人放铳两人各付一半", () => {
    const base: Spec = {
      hands: ["1199m 1199p 1199s 1z", "77z 234m 1p 9s", "2345678m 2345p 5s", "7z 3456p 345678s"],
      melds: [{ seat: B, type: "pon", tiles: "555z", from: A }, { seat: B, type: "pon", tiles: "666z", from: C }],
      turn: D,
      drawn: "7z",
      wallHead: "8z 1p",
    };
    let state = build(base);
    state = discard(state, D, "7z");
    expect(state.claim!.options[B]).toContain("pon");
    state = resolve(apply(state, B, { type: "CLAIM", action: "pon" }));
    expect(state.players[B]!.pao).toEqual({ yakuman: "daisangen", liable: D });
    state = resolve(discard(state, B, "9s"));
    // C 摸到 8z 打掉，D 摸到 1p……这里改成让 B 自己摸 1p：直接把 C 的回合交给 B
    state = structuredClone(state);
    state.stage = "turn";
    state.turn = B;
    state.turnMode = "draw";
    state.claim = null;
    const onePin = state.wall!.find((tile) => kindOf(tile) === parseKinds("1p")[0])!;
    state.wall = state.wall!.filter((tile) => tile !== onePin);
    state.players[B]!.hand.push(onePin);
    state.players[B]!.drawn = onePin;
    const before = points(state);
    state = apply(state, B, { type: "TSUMO" });
    const after = points(state);
    expect(after[B]! - before[B]!).toBe(32000);
    expect(after[D]! - before[D]!).toBe(-32000);
    expect(after[A]).toBe(before[A]);
    expect(after[C]).toBe(before[C]);

    // 换成 C 打出 1p，B 荣和：C 和 D 各付 16000
    state = build({ ...base });
    state = discard(state, D, "7z");
    state = resolve(apply(state, B, { type: "CLAIM", action: "pon" }));
    state = resolve(discard(state, B, "9s"));
    expect(state.turn).toBe(C);
    state = structuredClone(state);
    const pin = state.players[A]!.hand.find((tile) => kindOf(tile) === parseKinds("1p")[0])!;
    state.players[A]!.hand = state.players[A]!.hand.filter((tile) => tile !== pin);
    state.players[C]!.hand.push(pin);
    state.players[C]!.drawn = pin;
    const beforeRon = points(state);
    state = discard(state, C, "1p");
    expect(state.claim!.options[B]).toContain("ron");
    state = resolve(apply(state, B, { type: "CLAIM", action: "ron" }));
    const afterRon = points(state);
    expect(afterRon[C]! - beforeRon[C]!).toBe(-16000);
    expect(afterRon[D]! - beforeRon[D]!).toBe(-16000);
    expect(afterRon[B]! - beforeRon[B]!).toBe(32000);
  });

  it("T11 两家和、上家取本场和供托", () => {
    let state = build({
      hands: ["1199m 1188s 13579p", "234m 567m 78p 345s 66s", "9p 2468m 2468s 1357z 1z", "234m 567p 999s 9p"],
      melds: [{ seat: D, type: "pon", tiles: "777z", from: A }],
      turn: C,
      drawn: "9p",
      roundWind: 1,
      honba: 1,
      kyoutaku: 2000,
      points: [25000, 24000, 25000, 24000],
    });
    state.players[B]!.riichi = { double: false, ippatsu: false };
    state = discard(state, C, "9p");
    expect(state.claim!.options[B]).toEqual(["ron"]);
    expect(state.claim!.options[D]).toEqual(["ron"]);
    state = apply(state, B, { type: "CLAIM", action: "ron" });
    state = resolve(apply(state, D, { type: "CLAIM", action: "ron" }));
    expect(points(state)).toEqual([25000, 26000, 21400, 27600]);
    expect(state.kyoutaku).toBe(0);
    expect(state.result!.wins.map((win) => [win.seat, win.points])).toEqual([[D, 1600], [B, 2000]]);
    expect([state.roundWind, state.roundIndex, state.dealer, state.honba]).toEqual([1, 2, B, 0]);
  });

  it("T12 振听：舍张振听只能自摸；同巡振听到自己打牌为止", () => {
    let state = build({ hands: ["2468s 1357z 13579p", "3p 2468m 1357s 1357z 2z", "45p 111m 999m 789m 22p", "2468p 1357s 1357m"], turn: B, drawn: "3p", wallHead: "3p" });
    state.players[C]!.river = [{ tile: parseTiles("6p", new Set([4 * 14, 4 * 14 + 1, 4 * 14 + 2]))[0]! }];
    state.players[C]!.furiten.discard = true;
    state = discard(state, B, "3p");
    expect(state.claim!.options[C] ?? []).not.toContain("ron");
    state = resolve(state);
    expect(state.turn).toBe(C);
    expect(canTsumo(state, C)).toBe(true);

    state = build({ hands: ["2s 1199m 1199p 1357z 6z", "2468m 2468p 1357z 6z", "1199m 1199p 1357z 6z", "234m 567m 345p 34s 99s"], turn: A, drawn: "2s", wallHead: "5s 6z 7m" });
    state = discard(state, A, "2s");
    expect(state.claim!.options[D]).toContain("ron");
    state = resolve(apply(state, D, { type: "CLAIM", action: "pass" }));
    expect(state.players[D]!.furiten.temp).toBe(true);
    state = resolve(discard(state, B, "5s"));
    expect(state.stage).toBe("turn");
    expect(state.turn).toBe(C);
  });

  it("T13 立直的条件；立直那张被荣和不交供托", () => {
    const hands = ["1199m 1199s 1357z 7z", "234m 567m 78p 345s 66s 1z", "2468m 2468s 1357p", "2468p 1357s 1357m"];
    expect(riichiOptions(build({ hands, turn: B, drawn: "1z" }), B).map(kindOf)).toEqual([parseKinds("1z")[0]]);
    expect(riichiOptions(build({ hands, turn: B, drawn: "1z", points: [25000, 900, 25000, 49100] }), B)).toEqual([]);
    expect(riichiOptions(build({ hands, turn: B, drawn: "1z", wallHead: "8m 8m 8m", shortWall: true }), B)).toEqual([]);
    let state = build({ hands, turn: B, drawn: "1z", wallHead: "9p 9p 8p 8p", shortWall: true, points: [25000, 1000, 25000, 49000] });
    expect(riichiOptions(state, B)).toHaveLength(1);
    state = resolve(discard(state, B, "1z", true));
    expect(state.players[B]!.points).toBe(0);
    expect(state.players[B]!.riichi).not.toBeNull();
    expect(state.phase).toBe("playing");
    const opened = build({ hands: ["1199m 1199s 1357z 7z", "234m 78p 345s 66s 1z", "2468m 2468s 1357p", "2468p 1357s 1357m"], melds: [{ seat: B, type: "chi", tiles: "567m", from: A }], turn: B, drawn: "1z" });
    expect(riichiOptions(opened, B)).toEqual([]);
    // 立直宣告牌被荣和：不交 1000
    state = build({ hands: ["1199m 1199s 1357z 7z", "234m 567m 78p 345s 66s 9p", "2468m 2468s 1357p", "234m 567m 78p 345s 99s"], turn: B, drawn: "9p", wallHead: "1z" });
    state = discard(state, B, "9p", true);
    expect(state.claim!.options[D]).toContain("ron");
    state = resolve(apply(state, D, { type: "CLAIM", action: "ron" }));
    expect(state.kyoutaku).toBe(0);
    expect(state.players[B]!.riichi).toBeNull();
    expect(state.result!.deltas[B]).toBe(-1000);
  });

  it("T14 食替", () => {
    let state = build({ hands: ["2m 1199p 1199s 1357z 6z", "345m 34m 789p 55s 99s 1z", "2468m 2468s 1357p", "2468p 1357s 1357m"], turn: A, drawn: "2m" });
    state = discard(state, A, "2m");
    expect(state.claim!.options[B]).toContain("chi");
    const combo = state.claim!.chiOptions[B]!.find((pair) => pair.every((tile) => [parseKinds("3m")[0], parseKinds("4m")[0]].includes(kindOf(tile))))!;
    state = resolve(apply(state, B, { type: "CLAIM", action: "chi", tiles: combo }));
    const banned = riichiDiscardable(state, B).map(kindOf);
    expect(banned).not.toContain(parseKinds("2m")[0]);
    expect(banned).not.toContain(parseKinds("5m")[0]);
    expect(banned).toContain(parseKinds("1z")[0]);
    expect(() => discard(state, B, "5m")).toThrow("食替");
  });

  it("T15 荒牌流局罚符和连庄", () => {
    let state = build({
      hands: ["2468m 2468s 1357p 77z", "234m 567m 78p 345s 66s", "2468p 1357s 1357m", "234p 567p 78s 345m 99s"],
      turn: A,
      drawn: "7z",
      dealer: B,
      roundIndex: 2,
      shortWall: true,
    });
    // 打中张（只打一张幺九会凑成流局满贯）
    state = resolve(discard(state, A, "2m"));
    expect(state.stage).toBe("handEnd");
    expect(state.result!.draw!.tenpai).toEqual([false, true, false, true]);
    expect(state.result!.deltas).toEqual([-1500, 1500, -1500, 1500]);
    expect([state.roundIndex, state.dealer, state.honba]).toEqual([2, B, 1]);
  });

  it("T16 四风连打", () => {
    let state = build({
      hands: ["4z 1199m 1199s 1357p 2z", "4z 2468m 2468s 135p 2z", "4z 2468p 1357s 135m 3z", "4z 3579p 3579s 79m 3z 5z"],
      dora: "6z",
      ura: "6z",
      turn: A,
      drawn: "4z",
      firstGoAround: true,
      wallHead: "1m 2m 3m",
    });
    state = resolve(discard(state, A, "4z"));
    state = resolve(discard(state, B, "4z"));
    state = resolve(discard(state, C, "4z"));
    state = resolve(discard(state, D, "4z"));
    expect(state.stage).toBe("handEnd");
    expect(state.result!.draw!.kind).toBe("suufon");
    expect(state.result!.deltas).toEqual([0, 0, 0, 0]);
    expect([state.dealer, state.honba]).toEqual([A, 1]);
  });

  it("T17 击飞", () => {
    const spec = (win: string): Spec => ({
      hands: ["234m 567m 67p 345s 66s", "1199m 1199s 1357z", "2468m 2468s 1357z", `${win} 1199p 1357s 1357m 9m`],
      turn: D,
      drawn: win,
      points: [36000, 31000, 31000, 2000],
    });
    let state = build(spec("8p"));
    state = resolve(apply(discard(state, D, "8p"), A, { type: "CLAIM", action: "ron" }));
    expect(state.players[D]!.points).toBe(-900);
    expect(state.phase).toBe("finished");
    expect(state.finalResult!.ranks[D]).toBe(4);
    // 1 番 30 符：只付 1500，继续打（这里用不是断幺的和法）
    state = build({ ...spec("9p"), hands: ["234m 567m 78p 345s 66s", "1199m 1199s 1357z", "2468m 2468s 1357z", "9p 1199p 1357s 1357m 9m"] });
    state = resolve(apply(discard(state, D, "9p"), A, { type: "CLAIM", action: "ron" }));
    expect(state.players[D]!.points).toBe(500);
    expect(state.phase).toBe("playing");
  });

  it("T18 西入：南 4 局打完没人到 30000 进西 1 局；西场有人到 30000 马上结束", () => {
    let state = build({
      hands: ["2468m 2468s 1357p 77z", "2468p 1357s 1357m", "1357m 2468p 13z 79s 5z", "2468s 1357p 1357z"],
      turn: A,
      drawn: "7z",
      dealer: D,
      roundWind: 1,
      roundIndex: 4,
      shortWall: true,
      points: [29000, 27000, 23000, 21000],
    });
    state = resolve(discard(state, A, "2m"));
    expect(state.phase).toBe("playing");
    expect([state.roundWind, state.roundIndex, state.dealer]).toEqual([2, 1, A]);
    // 西 1 局：A（庄）和牌到 30000 以上 → 结束
    state = build({ hands: ["234m 567m 78p 345s 66s", "1199m 1199s 1357z", "2468m 2468s 1357z", "9p 1199p 1357s 1357m 9m"], turn: D, drawn: "9p", dealer: A, roundWind: 2, roundIndex: 1, points: [29000, 27000, 23000, 21000] });
    state = resolve(apply(discard(state, D, "9p"), A, { type: "CLAIM", action: "ron" }));
    expect(state.phase).toBe("finished");
    expect(state.result!.gameOver).not.toBeNull();
  });

  it("T19 南 4 局庄家一位自动结束；不是一位照常连庄", () => {
    const hands = ["2468m 2468s 1357z 99p", "1199m 1199s 1357p 5z", "2468p 1357s 1357m", "234m 567m 78p 345s 66s"];
    let state = build({ hands, turn: A, drawn: "9p", dealer: D, roundWind: 1, roundIndex: 4, points: [30000, 20000, 17000, 33000] });
    state = resolve(apply(discard(state, A, "9p"), D, { type: "CLAIM", action: "ron" }));
    expect(state.phase).toBe("finished");
    expect(state.result!.gameOver).toContain("和了止");
    state = build({ hands, turn: A, drawn: "9p", dealer: D, roundWind: 1, roundIndex: 4, points: [40000, 20000, 15000, 25000] });
    state = resolve(apply(discard(state, A, "9p"), D, { type: "CLAIM", action: "ron" }));
    expect(state.phase).toBe("playing");
    expect([state.roundWind, state.roundIndex, state.dealer, state.honba]).toEqual([1, 4, D, 1]);
  });
});

// ---------------------------------------------------------------------------
// 随机对局

function totalTiles(state: RiichiState): number {
  let count = state.wall!.length + 14;
  for (const player of state.players) {
    count += player.hand.length + player.melds.reduce((sum, meld) => sum + meld.tiles.length, 0) + player.river.filter((entry) => !entry.taken).length;
  }
  if (state.stage === "claim" && state.claim?.kind === "kakan") count += 1;
  return count;
}

function randomCommand(state: RiichiState, seat: number, rng: ReturnType<typeof createRng>): RiichiCommand {
  const legal = engine.legalCommands(state, state.players[seat]!.id) as RiichiCommand[];
  const ron = legal.find((command) => command.type === "TSUMO" || (command.type === "CLAIM" && command.action === "ron"));
  if (ron && rng.next() < 0.85) return ron;
  const riichi = legal.filter((command) => command.type === "DISCARD" && command.riichi);
  if (riichi.length > 0 && rng.next() < 0.5) return rng.pick(riichi);
  if (state.stage === "turn") {
    const kans = legal.filter((command) => command.type === "KONG");
    if (kans.length > 0 && rng.next() < 0.3) return kans[0]!;
    const discards = legal.filter((command) => command.type === "DISCARD" && !command.riichi);
    return rng.pick(discards);
  }
  return rng.pick(legal);
}

function playOut(seed: number, options: Partial<RiichiOptions>, useBots: boolean, check: (state: RiichiState) => void): RiichiState {
  let state = createRiichi(PLAYERS, seed, options);
  const rng = createRng(seed * 7 + 3);
  for (let guard = 0; guard < 60_000 && state.phase === "playing"; guard += 1) {
    const pending = engine.pendingSeats(state);
    if (pending.length === 0) state = resolve(state);
    else if (rng.next() < 0.02) state = engine.timeoutTurn(state) as RiichiState;
    else {
      const seat = rng.pick(pending);
      const command = useBots ? (engine.botCommand(state, seat) as RiichiCommand) : randomCommand(state, seat, rng);
      state = engine.applyCommand(state, state.players[seat]!.id, command) as RiichiState;
    }
    check(state);
  }
  expect(state.phase).toBe("finished");
  return state;
}

describe("立直麻将随机对局", () => {
  const invariants = (state: RiichiState) => {
    const sum = state.players.reduce((total, player) => total + player.points, 0) + state.kyoutaku;
    if (sum !== 100000) throw new Error(`点数总和 ${sum}`);
    if (state.phase === "playing" && state.stage !== "handEnd" && totalTiles(state) !== 136) throw new Error(`牌数 ${totalTiles(state)}（${state.stage}）`);
  };

  it("60 场随机合法动作（半庄 / 东风 / 无红 / 无食断）", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      playOut(seed, { length: seed % 2 ? "tonpuu" : "hanchan", aka: seed % 3 !== 0, kuitan: seed % 5 !== 0 }, false, invariants);
    }
  }, 300_000);

  it("机器人对局能打完，隐藏信息不泄露", () => {
    let step = 0;
    for (let seed = 1; seed <= 4; seed += 1) {
      playOut(seed, { length: "tonpuu" }, true, (state) => {
        invariants(state);
        step += 1;
        if (step % 5 !== 0) return;
        const view = redact(state, "A");
        const json = JSON.stringify(view);
        expect(json).not.toContain('"wall"');
        expect(json).not.toContain('"dead"');
        view.players.forEach((player) => {
          if (player.id === "A") return;
          if (!(view.stage === "handEnd" && view.result?.draw?.tenpai)) expect(player.hand).toEqual([]);
          expect(player.furiten).toEqual({ discard: false, temp: false, riichi: false });
        });
        if (view.claim) for (const seat of Object.keys(view.claim.options)) expect(view.players[Number(seat)]!.id).toBe("A");
      });
    }
  }, 300_000);
});

void riichiKanOptions;
