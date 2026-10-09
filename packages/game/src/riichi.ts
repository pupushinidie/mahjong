/**
 * 立直麻将规则引擎。规则书：~/Desktop/游戏规则/立直麻将.md（雀魂段位战习惯）。
 *
 * 纯函数：apply 不改输入。抢牌窗口不会自己结束：服务端在所有人回应（或超时）并且过了固定停顿以后发 RESOLVE。
 * 王牌 14 张：dead[0–3] 岭上牌，dead[4–8] 宝牌指示牌，dead[9–13] 里宝牌指示牌。
 */
import { isThirteenOrphans } from "./hand.js";
import { createRng, type Rng } from "./rng.js";
import { isMenzen, payments, riichiWaits, scoreRiichiHand, type RiichiHandInput } from "./riichi-score.js";
import { countKinds, isHonor, isYaochu, kindOf, rankOf, sortTiles, suitIndexOf, type Kind, type Tile } from "./tiles.js";
import type {
  DrawResult,
  RiichiClaim,
  RiichiClaimAction,
  RiichiCommand,
  RiichiConfig,
  RiichiEvent,
  RiichiHandResult,
  RiichiMeld,
  RiichiOptions,
  RiichiPlayer,
  RiichiState,
  RiichiWin,
} from "./riichi-types.js";

export const RIICHI_HISTORY_LIMIT = 120;
export const DEFAULT_RIICHI_OPTIONS: RiichiOptions = { length: "hanchan", aka: true, kuitan: true };
const WIND_NAMES = ["东", "南", "西", "北"];

export function riichiConfig(options: Partial<RiichiOptions> = {}, overrides: Partial<RiichiConfig> = {}): RiichiConfig {
  return { ...DEFAULT_RIICHI_OPTIONS, ...options, startPoints: 25000, returnPoints: 30000, stepSec: 5, bankSec: 20, claimSec: 5, handEndSec: 30, ...overrides };
}

export interface RiichiNewPlayer {
  readonly id: string;
  readonly name: string;
  readonly bot?: boolean;
}

interface Ctx {
  readonly state: RiichiState;
  readonly rng: Rng;
  readonly events: RiichiEvent[];
}

const SEATS = [0, 1, 2, 3] as const;
function fail(message: string): never {
  throw new Error(message);
}
const emptyDeltas = (): [number, number, number, number] => [0, 0, 0, 0];

// ---------------------------------------------------------------------------
// 查询

/** 自风：庄家东，庄家的下家南…… */
export const seatWindOf = (state: Pick<RiichiState, "dealer">, seat: number) => (seat - state.dealer + 4) % 4;
export const roundLabel = (state: Pick<RiichiState, "roundWind" | "roundIndex" | "honba">) =>
  `${WIND_NAMES[state.roundWind]} ${state.roundIndex} 局${state.honba > 0 ? ` ${state.honba} 本场` : ""}`;
const totalKans = (state: RiichiState) => state.kans.reduce((sum, count) => sum + count, 0);
const riichiOn = (player: RiichiPlayer) => player.riichi !== null;

function removeTile(tiles: readonly Tile[], tile: Tile): Tile[] {
  const index = tiles.indexOf(tile);
  if (index < 0) fail("这张牌不在手里。");
  return [...tiles.slice(0, index), ...tiles.slice(index + 1)];
}

function handInput(state: RiichiState, seat: number, concealed: readonly Tile[], winTile: Tile, extra: Partial<RiichiHandInput>): RiichiHandInput {
  const player = state.players[seat]!;
  return {
    concealed,
    melds: player.melds,
    winTile,
    tsumo: false,
    seatWind: seatWindOf(state, seat),
    roundWind: state.roundWind,
    dealer: seat === state.dealer,
    riichi: player.riichi ? (player.riichi.double ? "double" : "riichi") : null,
    ippatsu: player.riichi?.ippatsu ?? false,
    doraIndicators: state.doraIndicators,
    uraIndicators: state.dead ? state.dead.slice(9, 9 + state.doraIndicators.length) : [],
    aka: state.config.aka,
    kuitan: state.config.kuitan,
    ...extra,
  };
}

function tsumoInput(state: RiichiState, seat: number): RiichiHandInput | null {
  const player = state.players[seat]!;
  if (state.stage !== "turn" || state.turn !== seat || state.turnMode !== "draw" || player.drawn === null) return null;
  const first = state.firstGoAround && player.draws === 1 && player.melds.length === 0;
  return handInput(state, seat, player.hand, player.drawn, {
    tsumo: true,
    rinshan: state.rinshan,
    haitei: state.lastDraw && !state.rinshan,
    tenhou: first && seat === state.dealer,
    chiihou: first && seat !== state.dealer,
  });
}

/** 自摸能不能和（牌型对、有役）。 */
export function canTsumo(state: RiichiState, seat: number): boolean {
  const input = tsumoInput(state, seat);
  return input !== null && scoreRiichiHand(input) !== null;
}

/** 能打的牌：立直后只能摸切；吃碰完不能打食替的牌。 */
export function riichiDiscardable(state: RiichiState, seat: number): Tile[] {
  if (state.stage !== "turn" || state.turn !== seat) return [];
  const player = state.players[seat]!;
  if (player.hand.length % 3 !== 2) return [];
  if (riichiOn(player)) return player.drawn !== null ? [player.drawn] : [];
  if (state.turnMode === "called") return player.hand.filter((tile) => !state.kuikae.includes(kindOf(tile)));
  return [...player.hand];
}

/** 宣告立直能打哪些牌：门清、打完听牌、点数 ≥ 1000、牌墙 ≥ 4 张。 */
export function riichiOptions(state: RiichiState, seat: number): Tile[] {
  if (state.stage !== "turn" || state.turn !== seat || state.turnMode !== "draw") return [];
  const player = state.players[seat]!;
  if (riichiOn(player) || !isMenzen(player.melds) || player.points < 1000 || state.wallCount < 4) return [];
  const result: Tile[] = [];
  const checked = new Map<Kind, boolean>();
  for (const tile of player.hand) {
    const kind = kindOf(tile);
    if (!checked.has(kind)) checked.set(kind, riichiWaits(removeTile(player.hand, tile), player.melds).length > 0);
    if (checked.get(kind)) result.push(tile);
  }
  return result;
}

/** 轮到自己时能开的杠（暗杠、加杠），每种一张代表。 */
export function riichiKanOptions(state: RiichiState, seat: number): { tile: Tile; type: "ankan" | "kakan" }[] {
  if (state.stage !== "turn" || state.turn !== seat || state.turnMode !== "draw" || state.wallCount === 0 || totalKans(state) >= 4) return [];
  const player = state.players[seat]!;
  const counts = countKinds(player.hand.map(kindOf));
  const result: { tile: Tile; type: "ankan" | "kakan" }[] = [];
  for (const tile of sortTiles(player.hand)) {
    const kind = kindOf(tile);
    if (result.some((option) => kindOf(option.tile) === kind)) continue;
    if (counts[kind] === 4) {
      if (riichiOn(player)) {
        // 立直后：只能杠刚摸到的那张，而且听的牌不变
        if (player.drawn === null || kindOf(player.drawn) !== kind) continue;
        const before = riichiWaits(removeTile(player.hand, player.drawn), player.melds);
        const after = riichiWaits(player.hand.filter((own) => kindOf(own) !== kind), [...player.melds, { type: "ankan", tiles: player.hand.filter((own) => kindOf(own) === kind) }]);
        if (before.length === 0 || before.join(",") !== after.join(",")) continue;
      }
      result.push({ tile, type: "ankan" });
    } else if (!riichiOn(player) && player.melds.some((meld) => meld.type === "pon" && kindOf(meld.tiles[0]!) === kind)) {
      result.push({ tile, type: "kakan" });
    }
  }
  return result;
}

/** 九种九牌：第一巡、自己第一次摸牌，手里 9 种以上幺九牌。 */
export function canKyuushu(state: RiichiState, seat: number): boolean {
  const player = state.players[seat]!;
  if (state.stage !== "turn" || state.turn !== seat || state.turnMode !== "draw" || !state.firstGoAround || player.draws !== 1) return false;
  return new Set(player.hand.map(kindOf).filter(isYaochu)).size >= 9;
}

/** 振听（舍张 / 同巡 / 立直）。 */
const isFuriten = (player: RiichiPlayer) => player.furiten.discard || player.furiten.temp || player.furiten.riichi;

function ronInput(state: RiichiState, seat: number, tile: Tile, kind: RiichiClaim["kind"], last: boolean): RiichiHandInput {
  const player = state.players[seat]!;
  return handInput(state, seat, [...player.hand, tile], tile, { chankan: kind !== "discard", houtei: last && kind === "discard" });
}

/** 吃的组合（用手里哪两张）：顺子在同一门，红五和普通五算不同的组合；吃完要有不是食替的牌能打。 */
function chiCombos(state: RiichiState, seat: number, tile: Tile): [Tile, Tile][] {
  const kind = kindOf(tile);
  if (isHonor(kind)) return [];
  const player = state.players[seat]!;
  const suit = suitIndexOf(kind);
  const result: [Tile, Tile][] = [];
  const seen = new Set<string>();
  for (const [da, db] of [[-2, -1], [-1, 1], [1, 2]] as const) {
    const ka = kind + da;
    const kb = kind + db;
    if (ka < 0 || kb > 26 || suitIndexOf(ka) !== suit || suitIndexOf(kb) !== suit) continue;
    for (const a of player.hand.filter((own) => kindOf(own) === ka)) {
      for (const b of player.hand.filter((own) => kindOf(own) === kb)) {
        const key = `${ka}:${a === 16 || a === 52 || a === 88}:${kb}:${b === 16 || b === 52 || b === 88}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const forbidden = kuikaeKinds(kind, [ka, kb]);
        const rest = removeTile(removeTile(player.hand, a), b);
        if (rest.some((own) => !forbidden.includes(kindOf(own)))) result.push([a, b]);
      }
    }
  }
  return result;
}

/** 食替：吃碰完这一手不能打的牌种。 */
function kuikaeKinds(taken: Kind, others: readonly Kind[]): Kind[] {
  if (others[0] === others[1]) return [taken];
  const low = Math.min(taken, ...others);
  const forbidden = [taken];
  if (taken === low && rankOf(low + 2) <= 8 && suitIndexOf(low + 3) === suitIndexOf(low)) forbidden.push(low + 3);
  if (taken === low + 2 && rankOf(low) >= 2) forbidden.push(low - 1);
  return forbidden;
}

function ponCombos(state: RiichiState, seat: number, tile: Tile): [Tile, Tile][] {
  const kind = kindOf(tile);
  const same = state.players[seat]!.hand.filter((own) => kindOf(own) === kind);
  if (same.length < 2) return [];
  const result: [Tile, Tile][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < same.length; i += 1) {
    for (let j = i + 1; j < same.length; j += 1) {
      const key = [same[i], same[j]].map((own) => (own === 16 || own === 52 || own === 88 ? "r" : "n")).sort().join("");
      if (seen.has(key)) continue;
      seen.add(key);
      const rest = removeTile(removeTile(state.players[seat]!.hand, same[i]!), same[j]!);
      if (rest.some((own) => kindOf(own) !== kind)) result.push([same[i]!, same[j]!]);
    }
  }
  return result;
}

function openClaim(ctx: Ctx, from: number, tile: Tile, kind: RiichiClaim["kind"], riichi: boolean): void {
  const { state } = ctx;
  const last = kind === "discard" && state.wallCount === 0;
  const options: Partial<Record<number, RiichiClaimAction[]>> = {};
  const chiOptions: Partial<Record<number, [Tile, Tile][]>> = {};
  const ponOptions: Partial<Record<number, [Tile, Tile][]>> = {};
  for (const seat of SEATS) {
    if (seat === from) continue;
    const player = state.players[seat]!;
    const actions: RiichiClaimAction[] = [];
    const waits = riichiWaits(player.hand, player.melds);
    const inWaits = waits.includes(kindOf(tile));
    const kokushiOnly = kind === "ankan";
    if (inWaits && !isFuriten(player)) {
      const counts = countKinds([...player.hand, tile].map(kindOf));
      if (!kokushiOnly || isThirteenOrphans(counts)) {
        if (scoreRiichiHand(ronInput(state, seat, tile, kind, last)) !== null) actions.push("ron");
      }
    }
    if (kind === "discard" && !last && !riichiOn(player)) {
      const same = player.hand.filter((own) => kindOf(own) === kindOf(tile)).length;
      if (same >= 3 && totalKans(state) < 4) actions.push("minkan");
      const pons = ponCombos(state, seat, tile);
      if (pons.length > 0) {
        actions.push("pon");
        ponOptions[seat] = pons;
      }
      if (seat === (from + 1) % 4) {
        const chis = chiCombos(state, seat, tile);
        if (chis.length > 0) {
          actions.push("chi");
          chiOptions[seat] = chis;
        }
      }
    }
    if (actions.length > 0) options[seat] = actions;
  }
  state.claim = { tile, from, kind, last, riichi, options, chiOptions, ponOptions, responses: {}, pending: Object.keys(options).length };
  state.stage = "claim";
  state.turn = -1;
  state.step += 1;
}

/**
 * 抢牌窗口可以结算了：所有人都回应了；或者优先级更高的人都回应了、已经有人要了（荣 > 碰杠 > 吃）。
 */
export function riichiClaimReady(state: RiichiState): boolean {
  const claim = state.claim;
  if (state.stage !== "claim" || !claim) return false;
  const seats = Object.keys(claim.options).map(Number);
  const responded = (seat: number) => claim.responses[seat] !== undefined;
  if (seats.every(responded)) return true;
  const chose = (action: RiichiClaimAction) => seats.some((seat) => claim.responses[seat]?.action === action);
  const capable = (actions: RiichiClaimAction[]) => seats.filter((seat) => claim.options[seat]!.some((action) => actions.includes(action)));
  if (chose("ron") && capable(["ron"]).every(responded)) return true;
  if ((chose("pon") || chose("minkan")) && capable(["ron"]).every(responded)) return true;
  if (chose("chi") && capable(["ron", "pon", "minkan"]).every(responded)) return true;
  return false;
}

export function riichiPendingSeats(state: RiichiState): number[] {
  if (state.phase === "finished") return [];
  switch (state.stage) {
    case "turn":
      return [state.turn];
    case "claim":
      if (riichiClaimReady(state)) return [];
      return Object.keys(state.claim!.options).map(Number).filter((seat) => state.claim!.responses[seat] === undefined);
    case "handEnd":
      return SEATS.filter((seat) => !state.ready.includes(state.players[seat]!.id));
  }
}

export function riichiStepSeconds(state: RiichiState): number {
  switch (state.stage) {
    case "turn":
      return state.config.stepSec;
    case "claim":
      return state.config.claimSec;
    case "handEnd":
      return state.config.handEndSec;
  }
}

// ---------------------------------------------------------------------------
// 开局

function blankHand(): Omit<RiichiPlayer, "id" | "name" | "bot" | "auto" | "timeouts" | "points"> {
  return {
    hand: [],
    handCount: 0,
    drawn: null,
    melds: [],
    river: [],
    riichi: null,
    riichiPending: false,
    furiten: { discard: false, temp: false, riichi: false },
    draws: 0,
    pao: null,
    handDelta: 0,
  };
}

export function createRiichi(players: readonly RiichiNewPlayer[], seed: number, options: Partial<RiichiOptions> = {}, overrides: Partial<RiichiConfig> = {}): RiichiState {
  if (players.length !== 4) throw new Error("立直麻将需要 4 个座位。");
  const rng = createRng(seed);
  const seated = rng.shuffle(players);
  const config = riichiConfig(options, overrides);
  const startDealer = rng.int(4);
  const state: RiichiState = {
    variant: "riichi",
    config,
    phase: "playing",
    players: seated.map((player) => ({ id: player.id, name: player.name, bot: player.bot === true, auto: false, timeouts: 0, points: config.startPoints, ...blankHand() })),
    startDealer,
    roundWind: 0,
    roundIndex: 1,
    dealer: startDealer,
    honba: 0,
    kyoutaku: 0,
    handNo: 0,
    stage: "turn",
    turn: startDealer,
    turnMode: "draw",
    kuikae: [],
    rinshan: false,
    lastDraw: false,
    firstGoAround: true,
    claim: null,
    wallCount: 0,
    doraIndicators: [],
    pendingKanDora: 0,
    kans: [0, 0, 0, 0],
    firstDiscards: [],
    suukanPending: false,
    result: null,
    ready: [],
    events: [],
    history: [],
    version: 0,
    step: 0,
    seed,
    log: [],
  };
  const ctx: Ctx = { state, rng, events: [] };
  startHand(ctx);
  return finish(ctx);
}

function startHand(ctx: Ctx, wallOverride?: Tile[]): void {
  const { state, rng } = ctx;
  state.handNo += 1;
  const tiles = wallOverride ?? rng.shuffle(Array.from({ length: 136 }, (_, tile) => tile));
  const wall = [...tiles];
  const dead = wall.splice(wall.length - 14, 14);
  for (const player of state.players) Object.assign(player, blankHand());
  for (let k = 0; k < 4; k += 1) {
    const seat = (state.dealer + k) % 4;
    state.players[seat]!.hand = sortTiles(wall.splice(0, 13));
  }
  state.wall = wall;
  state.dead = dead;
  state.rinshanUsed = 0;
  state.wallCount = wall.length;
  state.doraIndicators = [dead[4]!];
  state.pendingKanDora = 0;
  state.kans = [0, 0, 0, 0];
  state.firstDiscards = [];
  state.firstGoAround = true;
  state.suukanPending = false;
  state.claim = null;
  state.kuikae = [];
  state.rinshan = false;
  state.lastDraw = false;
  state.result = null;
  state.ready = [];
  ctx.events.push({ type: "HandStarted", label: roundLabel(state), dealer: state.dealer, honba: state.honba });
  draw(ctx, state.dealer);
}

/** 测试用：用指定的牌山重开当前这一局。tiles 的最后 14 张是王牌（[4] 是第一张宝牌指示牌）。 */
export function stackRiichiHand(state: RiichiState, tiles: Tile[], overrides: Partial<Pick<RiichiState, "dealer" | "roundWind" | "roundIndex" | "honba" | "kyoutaku">> = {}): RiichiState {
  const next = structuredClone(state);
  Object.assign(next, overrides);
  next.handNo -= 1;
  const ctx: Ctx = { state: next, rng: createRng(next.rng ?? 1), events: [] };
  startHand(ctx, [...tiles]);
  return finish(ctx);
}

// ---------------------------------------------------------------------------
// 动作

export function applyRiichi(input: RiichiState, playerId: string, command: RiichiCommand | { type: "RESOLVE" } | { type: "TIMEOUT"; seats?: readonly number[] }): RiichiState {
  if (input.phase === "finished" && command.type !== "AUTO") fail("对局已经结束。");
  const state = structuredClone(input);
  state.events = [];
  const ctx: Ctx = { state, rng: createRng(state.rng ?? 1), events: [] };
  if (command.type === "RESOLVE") {
    if (state.stage !== "claim") fail("现在没有抢牌窗口。");
    state.log?.push({ seat: -1, command });
    resolveClaim(ctx);
    return finish(ctx);
  }
  if (command.type === "TIMEOUT") {
    timeoutAll(ctx, command.seats);
    return finish(ctx);
  }
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0) fail("你不在这局里。");
  state.log?.push({ seat, command });
  act(ctx, seat, command);
  if (command.type !== "AUTO") state.players[seat]!.timeouts = 0;
  return finish(ctx);
}

function act(ctx: Ctx, seat: number, command: RiichiCommand): void {
  const { state } = ctx;
  switch (command.type) {
    case "DISCARD":
      return discard(ctx, seat, command.tile, command.riichi === true);
    case "TSUMO":
      if (!canTsumo(state, seat)) fail("现在不能自摸。");
      return settleTsumo(ctx, seat);
    case "KONG":
      return declareKan(ctx, seat, command.tile);
    case "KYUUSHU":
      if (!canKyuushu(state, seat)) fail("现在不能宣告九种九牌。");
      return abortiveDraw(ctx, "kyuushu");
    case "CLAIM":
      return respondClaim(ctx, seat, command.action, command.tiles);
    case "READY":
      return markReady(ctx, seat);
    case "AUTO": {
      const player = state.players[seat]!;
      if (player.auto !== command.on) {
        player.auto = command.on;
        player.timeouts = 0;
        ctx.events.push({ type: "AutoChanged", seat, on: command.on });
      }
      return;
    }
  }
}

function revealPendingDora(ctx: Ctx): void {
  const { state } = ctx;
  while (state.pendingKanDora > 0) {
    state.pendingKanDora -= 1;
    const indicator = state.dead![4 + state.doraIndicators.length]!;
    state.doraIndicators.push(indicator);
    ctx.events.push({ type: "DoraRevealed", indicator });
  }
}

function draw(ctx: Ctx, seat: number, rinshan = false): void {
  const { state } = ctx;
  const wall = state.wall!;
  if (!rinshan && wall.length === 0) {
    exhaustiveDraw(ctx);
    return;
  }
  let tile: Tile;
  if (rinshan) {
    tile = state.dead![state.rinshanUsed!]!;
    state.rinshanUsed! += 1;
    // 王牌保持 14 张：牌墙最后一张挪进王牌，能正常摸的少一张
    wall.pop();
  } else {
    tile = wall.shift()!;
  }
  state.wallCount = wall.length;
  const player = state.players[seat]!;
  player.hand = sortTiles([...player.hand, tile]);
  player.drawn = tile;
  player.draws += 1;
  // 有人摸第二张（庄家最先）：第一巡结束
  if (player.draws >= 2) state.firstGoAround = false;
  state.rinshan = rinshan;
  state.lastDraw = !rinshan && wall.length === 0;
  state.stage = "turn";
  state.turn = seat;
  state.turnMode = "draw";
  state.kuikae = [];
  state.claim = null;
  state.step += 1;
  ctx.events.push({ type: "Drew", seat, rinshan });
  // 立直后：不能和、不能暗杠时自动摸切
  if (riichiOn(player) && !canTsumo(state, seat) && riichiKanOptions(state, seat).length === 0) {
    discard(ctx, seat, tile, false, true);
  }
}

function updateDiscardFuriten(player: RiichiPlayer): void {
  const waits = riichiWaits(player.hand, player.melds);
  const river = new Set(player.river.map((entry) => kindOf(entry.tile)));
  player.furiten.discard = waits.some((kind) => river.has(kind));
}

function discard(ctx: Ctx, seat: number, tile: Tile, riichi: boolean, auto = false): void {
  const { state } = ctx;
  if (state.stage !== "turn" || state.turn !== seat) fail("还没轮到你打牌。");
  const player = state.players[seat]!;
  if (riichi) {
    if (!riichiOptions(state, seat).includes(tile)) fail("打这张不能立直（要门清、打完听牌、点数够 1000、牌墙还剩 4 张以上）。");
  } else if (!riichiDiscardable(state, seat).includes(tile)) {
    if (!player.hand.includes(tile)) fail("这张牌不在你手里。");
    if (riichiOn(player)) fail("立直以后只能打刚摸到的牌。");
    fail("吃碰以后不能马上打出同一种牌（食替）。");
  }
  const tsumogiri = tile === player.drawn;
  player.hand = removeTile(player.hand, tile);
  player.drawn = null;
  player.river.push({ tile, ...(riichi ? { riichi: true } : {}), ...(tsumogiri ? { tsumogiri: true } : {}) });
  // 立直后的下一次打牌：一发没了
  if (player.riichi?.ippatsu) player.riichi.ippatsu = false;
  if (riichi) {
    player.riichiPending = true;
    ctx.events.push({ type: "RiichiDeclared", seat, double: state.firstGoAround && player.draws === 1 });
  }
  player.furiten.temp = false;
  updateDiscardFuriten(player);
  ctx.events.push({ type: "Discarded", seat, tile, ...(riichi ? { riichi: true } : {}), ...(tsumogiri ? { tsumogiri: true } : {}), ...(auto ? { auto: true } : {}) });
  revealPendingDora(ctx);
  if (state.firstGoAround) state.firstDiscards.push(tile);
  state.rinshan = false;
  openClaim(ctx, seat, tile, "discard", riichi);
}

function respondClaim(ctx: Ctx, seat: number, action: RiichiClaimAction | "pass", tiles?: readonly [Tile, Tile]): void {
  const { state } = ctx;
  const claim = state.claim;
  if (state.stage !== "claim" || !claim) fail("现在没有可以抢的牌。");
  const options = claim.options[seat];
  if (!options) fail("这张牌你没有可以做的动作。");
  if (claim.responses[seat] !== undefined) fail("你已经选过了。");
  if (action !== "pass" && !options.includes(action)) fail("不能这样做。");
  let chosen: [Tile, Tile] | undefined;
  if (action === "chi" || action === "pon") {
    const combos = (action === "chi" ? claim.chiOptions[seat] : claim.ponOptions[seat]) ?? [];
    chosen = tiles ? combos.find((combo) => combo[0] === tiles[0] && combo[1] === tiles[1]) : combos[0];
    if (!chosen) fail("这两张不能这样吃 / 碰。");
  }
  claim.responses[seat] = { action, ...(chosen ? { tiles: chosen } : {}) };
  claim.pending = Object.keys(claim.options).filter((other) => claim.responses[Number(other)] === undefined).length;
}

const distance = (from: number, seat: number) => (seat - from + 4) % 4;

function markShapeFuriten(state: RiichiState, claim: RiichiClaim, ronSeats: number[]): void {
  // 放过了自己听的牌（只看牌型）：同巡振听；立直以后放过：立直振听
  for (const seat of SEATS) {
    if (seat === claim.from || ronSeats.includes(seat)) continue;
    const player = state.players[seat]!;
    if (!riichiWaits(player.hand, player.melds).includes(kindOf(claim.tile))) continue;
    player.furiten.temp = true;
    if (riichiOn(player)) player.furiten.riichi = true;
  }
}

function resolveClaim(ctx: Ctx): void {
  const { state } = ctx;
  const claim = state.claim!;
  const responses = claim.responses;
  const seats = Object.keys(claim.options).map(Number);
  const ronSeats = seats.filter((seat) => responses[seat]?.action === "ron").sort((a, b) => distance(claim.from, a) - distance(claim.from, b));
  const discarder = state.players[claim.from]!;
  if (ronSeats.length > 0) {
    if (claim.kind === "discard") discarder.river[discarder.river.length - 1]!.taken = true;
    discarder.riichiPending = false;
    settleRon(ctx, ronSeats, claim);
    return;
  }
  markShapeFuriten(state, claim, []);
  // 立直成立：交 1000 点供托
  if (claim.riichi && discarder.riichiPending) {
    discarder.riichiPending = false;
    discarder.points -= 1000;
    discarder.handDelta -= 1000;
    state.kyoutaku += 1000;
    const double = state.firstGoAround && discarder.draws === 1;
    discarder.riichi = { double, ippatsu: true };
    if (state.players.every((player) => player.riichi !== null)) {
      abortiveDraw(ctx, "suucha");
      return;
    }
  }
  if (claim.kind === "kakan") {
    completeKakan(ctx, claim.from, claim.tile);
    return;
  }
  if (claim.kind === "ankan") {
    completeAnkan(ctx, claim.from, claim.tile);
    return;
  }
  // 四杠散了：第 4 个杠（不是同一个人开的）之后打出的牌没人荣和
  if (state.suukanPending) {
    abortiveDraw(ctx, "suukan");
    return;
  }
  const taker = seats.find((seat) => responses[seat]?.action === "pon" || responses[seat]?.action === "minkan")
    ?? seats.find((seat) => responses[seat]?.action === "chi");
  if (taker !== undefined) {
    callTile(ctx, taker, claim, responses[taker]!.action as "pon" | "minkan" | "chi", responses[taker]!.tiles);
    return;
  }
  // 四风连打
  if (state.firstGoAround && state.firstDiscards.length === 4) {
    const kind = kindOf(state.firstDiscards[0]!);
    if (kind >= 27 && kind <= 30 && state.firstDiscards.every((tile) => kindOf(tile) === kind)) {
      abortiveDraw(ctx, "suufon");
      return;
    }
  }
  draw(ctx, (claim.from + 1) % 4);
}

function breakFirstGoAround(state: RiichiState): void {
  state.firstGoAround = false;
  for (const player of state.players) if (player.riichi) player.riichi.ippatsu = false;
}

function checkPao(state: RiichiState, seat: number, from: number): void {
  const player = state.players[seat]!;
  const sets = player.melds.filter((meld) => meld.type !== "chi").map((meld) => kindOf(meld.tiles[0]!));
  if ([31, 32, 33].every((kind) => sets.includes(kind))) player.pao = { yakuman: "daisangen", liable: from };
  if ([27, 28, 29, 30].every((kind) => sets.includes(kind))) player.pao = { yakuman: "daisuushii", liable: from };
}

function callTile(ctx: Ctx, seat: number, claim: RiichiClaim, action: "pon" | "minkan" | "chi", tiles?: [Tile, Tile]): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  const discarder = state.players[claim.from]!;
  discarder.river[discarder.river.length - 1]!.taken = true;
  breakFirstGoAround(state);
  if (action === "minkan") {
    const own = player.hand.filter((tile) => kindOf(tile) === kindOf(claim.tile)).slice(0, 3);
    player.hand = player.hand.filter((tile) => !own.includes(tile));
    const meld: RiichiMeld = { type: "minkan", tiles: sortTiles([...own, claim.tile]), taken: claim.tile, from: claim.from };
    player.melds.push(meld);
    ctx.events.push({ type: "Called", seat, meld });
    checkPao(state, seat, claim.from);
    addKan(ctx, seat);
    draw(ctx, seat, true);
    return;
  }
  const [a, b] = tiles!;
  player.hand = removeTile(removeTile(player.hand, a), b);
  const meld: RiichiMeld = { type: action, tiles: sortTiles([a, b, claim.tile]), taken: claim.tile, from: claim.from };
  player.melds.push(meld);
  ctx.events.push({ type: "Called", seat, meld });
  if (action === "pon") checkPao(state, seat, claim.from);
  state.stage = "turn";
  state.turn = seat;
  state.turnMode = "called";
  state.kuikae = kuikaeKinds(kindOf(claim.tile), [kindOf(a), kindOf(b)]);
  state.rinshan = false;
  state.lastDraw = false;
  state.claim = null;
  state.step += 1;
}

/** 开杠：先翻之前没翻的杠宝；第 4 个杠（不是一个人开的）记下来，看之后那张牌有没有人荣和。 */
function addKan(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  state.kans[seat]! += 1;
  if (totalKans(state) === 4 && !state.kans.includes(4)) state.suukanPending = true;
}

function declareKan(ctx: Ctx, seat: number, tile: Tile): void {
  const { state } = ctx;
  const option = riichiKanOptions(state, seat).find((candidate) => kindOf(candidate.tile) === kindOf(tile));
  if (!option) fail("现在不能杠这张牌。");
  const player = state.players[seat]!;
  revealPendingDora(ctx);
  const kind = kindOf(tile);
  if (option.type === "kakan") {
    const fourth = player.hand.find((own) => kindOf(own) === kind)!;
    player.hand = removeTile(player.hand, fourth);
    player.drawn = null;
    // 一律开抢杠窗口（统一停顿），没人抢就在 RESOLVE 时成立，别人看不出谁能抢
    openClaim(ctx, seat, fourth, "kakan", false);
    return;
  }
  const four = player.hand.filter((own) => kindOf(own) === kind);
  player.hand = player.hand.filter((own) => kindOf(own) !== kind);
  player.drawn = null;
  player.melds.push({ type: "ankan", tiles: four });
  // 暗杠只有国士能抢；同样一律开窗口
  openClaim(ctx, seat, four[0]!, "ankan", false);
}

function completeAnkan(ctx: Ctx, seat: number, tile: Tile): void {
  const { state } = ctx;
  const meld = state.players[seat]!.melds.find((candidate) => candidate.type === "ankan" && kindOf(candidate.tiles[0]!) === kindOf(tile))!;
  ctx.events.push({ type: "Called", seat, meld });
  breakFirstGoAround(state);
  addKan(ctx, seat);
  // 暗杠马上翻杠宝
  state.pendingKanDora += 1;
  revealPendingDora(ctx);
  draw(ctx, seat, true);
}

function completeKakan(ctx: Ctx, seat: number, tile: Tile): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  const index = player.melds.findIndex((meld) => meld.type === "pon" && kindOf(meld.tiles[0]!) === kindOf(tile));
  const pon = player.melds[index]!;
  const meld: RiichiMeld = { type: "kakan", tiles: sortTiles([...pon.tiles, tile]), taken: tile, ...(pon.from !== undefined ? { from: pon.from } : {}) };
  player.melds[index] = meld;
  ctx.events.push({ type: "Called", seat, meld });
  breakFirstGoAround(state);
  addKan(ctx, seat);
  // 明杠、加杠的杠宝在开杠的人打出下一张以后翻
  state.pendingKanDora += 1;
  draw(ctx, seat, true);
}

// ---------------------------------------------------------------------------
// 结算

/** 按点数从高到低排座位，同分时离起家近的在前。 */
export function rankSeats(state: Pick<RiichiState, "players" | "startDealer">): number[] {
  return [0, 1, 2, 3].sort((a, b) => state.players[b]!.points - state.players[a]!.points || distance(state.startDealer, a) - distance(state.startDealer, b));
}

function addDelta(state: RiichiState, deltas: number[], seat: number, value: number): void {
  deltas[seat]! += value;
  state.players[seat]!.points += value;
  state.players[seat]!.handDelta += value;
}

function makeWin(state: RiichiState, seat: number, how: "tsumo" | "ron", tile: Tile, from: number | undefined, input: RiichiHandInput, points: number): RiichiWin {
  const score = scoreRiichiHand(input)!;
  const player = state.players[seat]!;
  return {
    seat,
    how,
    ...(from !== undefined ? { from } : {}),
    tile,
    hand: sortTiles(input.concealed),
    melds: player.melds.map((meld) => ({ ...meld, tiles: [...meld.tiles] })),
    yaku: score.yaku,
    han: score.yakuman > 0 ? 0 : score.han,
    fu: score.fu,
    yakuman: score.yakuman,
    limit: score.limit,
    points,
    doraIndicators: [...state.doraIndicators],
    uraIndicators: player.riichi ? [...(input.uraIndicators ?? [])] : [],
    ...(player.pao ? { liable: player.pao.liable } : {}),
  };
}

function settleTsumo(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  const input = tsumoInput(state, seat)!;
  const score = scoreRiichiHand(input)!;
  const deltas = emptyDeltas();
  const dealer = seat === state.dealer;
  const honbaEach = state.honba * 100;
  const paoMult = player.pao ? score.paoYakuman[player.pao.yakuman] : 0;
  const restBase = paoMult > 0 ? 8000 * (score.yakuman - paoMult) : score.base;
  const restPay = payments(restBase, dealer);
  let received = 0;
  for (const other of SEATS) {
    if (other === seat) continue;
    const pay = dealer ? restPay.nonDealerPays : other === state.dealer ? restPay.dealerPays : restPay.nonDealerPays;
    const total = restBase > 0 ? pay : 0;
    addDelta(state, deltas, other, -total);
    received += total;
  }
  if (paoMult > 0) {
    // 包牌：负责的人一个人付包牌役满的全部（按荣和的点数），本场也由他付
    const paoTotal = payments(8000 * paoMult, dealer).ron;
    addDelta(state, deltas, player.pao!.liable, -(paoTotal + honbaEach * 3));
    received += paoTotal + honbaEach * 3;
  } else {
    for (const other of SEATS) if (other !== seat) {
      addDelta(state, deltas, other, -honbaEach);
      received += honbaEach;
    }
  }
  addDelta(state, deltas, seat, received + state.kyoutaku);
  const win = makeWin(state, seat, "tsumo", player.drawn!, undefined, input, received);
  state.kyoutaku = 0;
  ctx.events.push({ type: "Won", win });
  endHand(ctx, [win], null, deltas);
}

function settleRon(ctx: Ctx, ronSeats: number[], claim: RiichiClaim): void {
  const { state } = ctx;
  const deltas = emptyDeltas();
  const wins: RiichiWin[] = [];
  ronSeats.forEach((seat, order) => {
    const player = state.players[seat]!;
    const input = ronInput(state, seat, claim.tile, claim.kind, claim.last);
    const score = scoreRiichiHand(input)!;
    const dealer = seat === state.dealer;
    const honba = order === 0 ? state.honba * 300 : 0;
    const paoMult = player.pao ? score.paoYakuman[player.pao.yakuman] : 0;
    let received = 0;
    if (paoMult > 0) {
      const paoTotal = payments(8000 * paoMult, dealer).ron;
      const restTotal = score.yakuman > paoMult ? payments(8000 * (score.yakuman - paoMult), dealer).ron : 0;
      const liable = player.pao!.liable;
      if (liable === claim.from) {
        addDelta(state, deltas, claim.from, -(paoTotal + restTotal + honba));
      } else {
        addDelta(state, deltas, claim.from, -(paoTotal / 2 + restTotal + honba));
        addDelta(state, deltas, liable, -(paoTotal / 2));
      }
      received = paoTotal + restTotal + honba;
    } else {
      const total = payments(score.base, dealer).ron + honba;
      addDelta(state, deltas, claim.from, -total);
      received = total;
    }
    const stick = order === 0 ? state.kyoutaku : 0;
    addDelta(state, deltas, seat, received + stick);
    wins.push(makeWin(state, seat, "ron", claim.tile, claim.from, input, received));
  });
  state.kyoutaku = 0;
  for (const win of wins) ctx.events.push({ type: "Won", win });
  endHand(ctx, wins, null, deltas);
}

function exhaustiveDraw(ctx: Ctx): void {
  const { state } = ctx;
  const deltas = emptyDeltas();
  const tenpai = state.players.map((player) => riichiWaits(player.hand, player.melds).length > 0);
  const nagashi = SEATS.filter((seat) => {
    const river = state.players[seat]!.river;
    return river.length > 0 && river.every((entry) => isYaochu(kindOf(entry.tile)) && !entry.taken);
  });
  if (nagashi.length > 0) {
    for (const seat of nagashi) {
      const dealer = seat === state.dealer;
      const pay = payments(2000, dealer);
      for (const other of SEATS) {
        if (other === seat) continue;
        const amount = dealer ? pay.nonDealerPays : other === state.dealer ? pay.dealerPays : pay.nonDealerPays;
        addDelta(state, deltas, other, -amount);
        addDelta(state, deltas, seat, amount);
      }
    }
  } else {
    const count = tenpai.filter(Boolean).length;
    if (count > 0 && count < 4) {
      const receive = 3000 / count;
      const pay = 3000 / (4 - count);
      SEATS.forEach((seat) => addDelta(state, deltas, seat, tenpai[seat] ? receive : -pay));
    }
  }
  ctx.events.push({ type: "Draw", kind: "exhaustive" });
  endHand(ctx, [], { kind: "exhaustive", tenpai, nagashi }, deltas);
}

function abortiveDraw(ctx: Ctx, kind: DrawResult["kind"]): void {
  ctx.events.push({ type: "Draw", kind });
  endHand(ctx, [], { kind, tenpai: [false, false, false, false], nagashi: [] }, emptyDeltas());
}

/** 这一局打完：决定连庄、本场、下一局，或者半庄结束（规则书 7.1、7.2）。 */
function endHand(ctx: Ctx, wins: RiichiWin[], drawResult: DrawResult | null, deltas: [number, number, number, number]): void {
  const { state } = ctx;
  const label = roundLabel(state);
  const dealerWon = wins.some((win) => win.seat === state.dealer);
  const renchanByRule = dealerWon || (drawResult !== null && (drawResult.kind !== "exhaustive" || drawResult.tenpai[state.dealer]!));
  const lastWind = state.config.length === "hanchan" ? 1 : 0;
  const finalRound = state.roundWind === lastWind && state.roundIndex === 4;
  const extension = state.roundWind > lastWind;
  const anyAbove = state.players.some((player) => player.points >= state.config.returnPoints);
  const dealerTop = rankSeats(state)[0] === state.dealer && state.players[state.dealer]!.points >= state.config.returnPoints;
  let gameOver: string | null = null;
  if (state.players.some((player) => player.points < 0)) gameOver = "有人点数低于 0（击飞）";
  else if ((finalRound || extension) && renchanByRule && dealerTop) gameOver = dealerWon ? "庄家和牌后是第一名（和了止）" : "庄家连庄而且是第一名（听牌止）";
  else if (extension && anyAbove) gameOver = "加时局里有人到了 30000 点";
  else if (!renchanByRule && finalRound && anyAbove) gameOver = "最后一局打完，有人到了 30000 点";
  else if (!renchanByRule && extension && state.roundIndex === 4) gameOver = state.config.length === "hanchan" ? "西 4 局打完" : "南 4 局打完";
  const renchan = renchanByRule && gameOver === null;
  if (gameOver === null) {
    if (renchan) {
      state.honba += 1;
    } else {
      state.dealer = (state.dealer + 1) % 4;
      state.honba = wins.length > 0 ? 0 : state.honba + 1;
      state.roundIndex += 1;
      if (state.roundIndex > 4) {
        state.roundIndex = 1;
        state.roundWind += 1;
      }
    }
  }

  const result: RiichiHandResult = {
    roundLabel: label,
    wins,
    draw: drawResult,
    deltas,
    points: state.players.map((player) => player.points) as RiichiHandResult["points"],
    renchan,
    gameOver,
  };
  state.result = result;
  state.stage = "handEnd";
  state.turn = -1;
  state.claim = null;
  state.ready = [];
  state.step += 1;
  ctx.events.push({ type: "HandEnded", result });
  if (gameOver) finishGame(ctx);
}

function finishGame(ctx: Ctx): void {
  const { state } = ctx;
  const order = rankSeats(state);
  // 桌上剩下的供托给第一名
  if (state.kyoutaku > 0) {
    state.players[order[0]!]!.points += state.kyoutaku;
    state.kyoutaku = 0;
  }
  const finalOrder = rankSeats(state);
  const uma = [15, 5, -5, -15];
  const ranks = new Array<number>(4).fill(0);
  const scores = new Array<number>(4).fill(0);
  finalOrder.forEach((seat, index) => {
    ranks[seat] = index + 1;
    const oka = index === 0 ? (state.config.returnPoints - state.config.startPoints) * 4 / 1000 : 0;
    scores[seat] = Math.round(((state.players[seat]!.points - state.config.returnPoints) / 1000 + uma[index]! + oka) * 10) / 10;
  });
  state.phase = "finished";
  state.finalResult = { winners: [state.players[finalOrder[0]!]!.id], ranks, scores };
  ctx.events.push({ type: "GameEnded", winners: state.finalResult.winners });
}

function markReady(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  if (state.stage !== "handEnd") fail("现在不是结算画面。");
  const id = state.players[seat]!.id;
  if (!state.ready.includes(id)) state.ready.push(id);
  if (state.ready.length === 4) startHand(ctx);
}

// ---------------------------------------------------------------------------
// 超时

export function riichiTimeoutCommand(state: RiichiState, seat: number): RiichiCommand {
  const player = state.players[seat]!;
  switch (state.stage) {
    case "turn": {
      if (canTsumo(state, seat)) return { type: "TSUMO" };
      const options = riichiDiscardable(state, seat);
      const tile = player.drawn !== null && options.includes(player.drawn) ? player.drawn : options[options.length - 1]!;
      return { type: "DISCARD", tile };
    }
    case "claim":
      return { type: "CLAIM", action: state.claim?.options[seat]?.includes("ron") ? "ron" : "pass" };
    case "handEnd":
      return { type: "READY" };
  }
}

function timeoutAll(ctx: Ctx, only?: readonly number[]): void {
  const { state } = ctx;
  const seats = riichiPendingSeats(state).filter((seat) => !only || only.includes(seat));
  for (const seat of seats) {
    if (state.phase === "finished") return;
    if (!riichiPendingSeats(state).includes(seat)) continue;
    const command = riichiTimeoutCommand(state, seat);
    state.log?.push({ seat, command: { type: "TIMEOUT" } });
    ctx.events.push({ type: "TimedOut", seat });
    act(ctx, seat, command);
    const player = state.players[seat]!;
    if (command.type !== "READY") {
      player.timeouts += 1;
      if (player.timeouts >= 2 && !player.auto && !player.bot) {
        player.auto = true;
        ctx.events.push({ type: "AutoChanged", seat, on: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------

function finish(ctx: Ctx): RiichiState {
  const { state } = ctx;
  for (const player of state.players) player.handCount = player.hand.length;
  state.rng = ctx.rng.state;
  state.events = ctx.events;
  state.history = [...state.history, ...ctx.events].slice(-RIICHI_HISTORY_LIMIT);
  state.version += 1;
  return state;
}

/**
 * 给某位玩家看的状态：别人的手牌只给张数，牌墙、王牌只给张数和已翻开的指示牌，振听只给自己，
 * 抢牌窗口只给自己的选项。荒牌流局时听牌的人亮牌；和牌的人的手牌在和牌记录里。
 */
export function redactRiichi(state: RiichiState, viewerId: string): RiichiState {
  const view = structuredClone(state);
  delete view.wall;
  delete view.dead;
  delete view.rinshanUsed;
  delete view.rng;
  delete view.seed;
  delete view.log;
  const viewer = view.players.findIndex((player) => player.id === viewerId);
  const draw = view.stage === "handEnd" ? view.result?.draw : null;
  view.players.forEach((player, seat) => {
    if (seat === viewer) return;
    const showHand = draw?.kind === "exhaustive" && draw.tenpai[seat];
    if (!showHand) {
      player.hand = [];
      if (player.drawn !== null) player.drawn = -1;
    }
    player.furiten = { discard: false, temp: false, riichi: false };
    player.pao = null;
  });
  if (view.claim) {
    const own = view.claim.options[viewer];
    const response = view.claim.responses[viewer];
    view.claim.options = own ? { [viewer]: own } : {};
    view.claim.chiOptions = view.claim.chiOptions[viewer] ? { [viewer]: view.claim.chiOptions[viewer]! } : {};
    view.claim.ponOptions = view.claim.ponOptions[viewer] ? { [viewer]: view.claim.ponOptions[viewer]! } : {};
    view.claim.responses = response !== undefined ? { [viewer]: response } : {};
    view.claim.pending = own && response === undefined ? 1 : 0;
  }
  return view;
}
