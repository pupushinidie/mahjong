/**
 * 四川麻将（血战到底 / 血流成河）规则引擎。规则书：~/Desktop/游戏规则/四川麻将.md。
 *
 * 纯函数：apply 不改输入，返回新状态和事件。所有随机（洗牌、座位、庄家、换牌方向）都用状态里的种子随机数。
 * 抢牌窗口不会自己结束：服务端在所有人回应（或超时）并且过了固定停顿以后发 RESOLVE（见 claimReady）。
 */
import { createRng, type Rng } from "./rng.js";
import { evaluateHu, tingInfo, cappedFan, type HuSituation } from "./sichuan-score.js";
import { countTiles, kindOf, rankOf, sortTiles, suitOfTile, SUITS, type Suit, type Tile } from "./tiles.js";
import type {
  ClaimAction,
  ClaimWindow,
  GameCommand,
  GameEvent,
  HandSummary,
  Meld,
  SettleLine,
  SichuanConfig,
  SichuanOptions,
  SichuanPlayer,
  SichuanState,
  Win,
} from "./types.js";

export const HISTORY_LIMIT = 120;
export const SICHUAN_TILES = 108;

export const DEFAULT_SICHUAN_OPTIONS: SichuanOptions = { mode: "xuezhan", swap: true, cap: null, zimo: "fan", hands: 8 };

export function sichuanConfig(options: Partial<SichuanOptions> = {}, overrides: Partial<SichuanConfig> = {}): SichuanConfig {
  return {
    ...DEFAULT_SICHUAN_OPTIONS,
    ...options,
    swapSec: 20,
    voidSec: 10,
    discardSec: 15,
    claimSec: 8,
    handEndSec: 30,
    ...overrides,
  };
}

export interface NewPlayer {
  readonly id: string;
  readonly name: string;
  readonly bot?: boolean;
}

interface Ctx {
  readonly state: SichuanState;
  readonly rng: Rng;
  readonly events: GameEvent[];
}

const SEATS = [0, 1, 2, 3] as const;
const emptyDeltas = (): [number, number, number, number] => [0, 0, 0, 0];

function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// 查询

/** 这个座位还在局中（血战：没和牌下桌；血流：所有人）。 */
export const inPlay = (state: Pick<SichuanState, "players">, seat: number) => !state.players[seat]!.out;

/** 从 from 的下一位开始逆时针数，下一个还在局中的座位。 */
export function nextActive(state: Pick<SichuanState, "players">, from: number): number {
  for (let k = 1; k <= 4; k += 1) {
    const seat = (from + k) % 4;
    if (inPlay(state, seat)) return seat;
  }
  return from;
}

const hasVoidTiles = (player: Pick<SichuanPlayer, "hand" | "void">) =>
  player.void !== null && player.hand.some((tile) => suitOfTile(tile) === player.void);

/** 血流成河里和过牌的人手牌锁定。 */
export const isLocked = (state: Pick<SichuanState, "config">, player: Pick<SichuanPlayer, "wins">) =>
  state.config.mode === "xueliu" && player.wins.length > 0;

function huSituation(state: SichuanState, seat: number): HuSituation {
  const player = state.players[seat]!;
  const start = state.turnMode === "start";
  return {
    how: "zimo",
    afterKongDraw: state.afterKong,
    haidi: state.lastDraw && !state.afterKong,
    tianhu: start && seat === state.dealer,
    dihu: !start && seat !== state.dealer && player.draws === 1 && !state.anyCall && !state.afterKong && player.wins.length === 0,
  };
}

/** 自摸能不能和（轮到自己、刚摸了牌或庄家第一手）。 */
export function canTsumo(state: SichuanState, seat: number): boolean {
  if (state.stage !== "turn" || state.turn !== seat || state.turnMode === "claimed") return false;
  const player = state.players[seat]!;
  if (player.hand.length % 3 !== 2) return false;
  return evaluateHu(player.hand.map(kindOf), player.melds, player.void, huSituation(state, seat), state.config) !== null;
}

/** 能不能和别人打的这张牌（点炮 / 抢杠）。 */
function canRon(state: SichuanState, seat: number, tile: Tile, how: "ron" | "robKong", afterKong: boolean): boolean {
  const player = state.players[seat]!;
  if (!inPlay(state, seat) || player.passedHu) return false;
  return evaluateHu([...player.hand.map(kindOf), kindOf(tile)], player.melds, player.void, { how, afterKongDiscard: afterKong }, state.config) !== null;
}

/** 血流锁定的手牌：杠完以后听的牌要完全不变。 */
function kongKeepsWaits(state: SichuanState, seat: number, kind: number, type: "concealedKong" | "addedKong"): boolean {
  const player = state.players[seat]!;
  const thirteen = player.drawn !== null ? removeOne(player.hand, player.drawn) : player.hand;
  const before = tingInfo(thirteen, player.melds, player.void, state.config).kinds;
  const afterHand = player.hand.filter((tile) => kindOf(tile) !== kind);
  const afterMelds: Pick<Meld, "type" | "tiles">[] = type === "concealedKong"
    ? [...player.melds, { type: "concealedKong", tiles: player.hand.filter((tile) => kindOf(tile) === kind) }]
    : player.melds.map((meld) => (meld.type === "pung" && kindOf(meld.tiles[0]!) === kind ? { type: "addedKong" as const, tiles: [...meld.tiles, 0] } : meld));
  if (afterHand.length % 3 !== 1) return false;
  const after = tingInfo(afterHand, afterMelds, player.void, state.config).kinds;
  return before.length > 0 && before.length === after.length && before.every((k, i) => after[i] === k);
}

/** 轮到自己时能杠的牌（每种一张代表）：暗杠和加杠。 */
export function kongOptions(state: SichuanState, seat: number): { tile: Tile; type: "concealedKong" | "addedKong" }[] {
  if (state.stage !== "turn" || state.turn !== seat || state.turnMode === "claimed" || state.wallCount === 0) return [];
  const player = state.players[seat]!;
  const counts = countTiles(player.hand);
  const result: { tile: Tile; type: "concealedKong" | "addedKong" }[] = [];
  for (const tile of sortTiles(player.hand)) {
    const kind = kindOf(tile);
    if (result.some((option) => kindOf(option.tile) === kind)) continue;
    if (suitOfTile(tile) === player.void) continue;
    let type: "concealedKong" | "addedKong" | null = null;
    if (counts[kind] === 4) type = "concealedKong";
    else if (player.melds.some((meld) => meld.type === "pung" && kindOf(meld.tiles[0]!) === kind)) type = "addedKong";
    if (!type) continue;
    if (isLocked(state, player) && !kongKeepsWaits(state, seat, kind, type)) continue;
    result.push({ tile, type });
  }
  return result;
}

/** 现在能打哪些牌：有缺门牌只能打缺门；血流锁定只能打刚摸的那张。 */
export function discardable(state: SichuanState, seat: number): Tile[] {
  if (state.stage !== "turn" || state.turn !== seat) return [];
  const player = state.players[seat]!;
  if (player.hand.length % 3 !== 2) return [];
  if (isLocked(state, player)) return player.drawn !== null ? [player.drawn] : [];
  if (hasVoidTiles(player)) return player.hand.filter((tile) => suitOfTile(tile) === player.void);
  return [...player.hand];
}

/** 抢牌窗口里谁能做什么（规则书 4.6、5.4）。 */
function claimOptionsFor(state: SichuanState, from: number, tile: Tile, kind: "discard" | "robKong", last: boolean, afterKong: boolean): Partial<Record<number, ClaimAction[]>> {
  const options: Partial<Record<number, ClaimAction[]>> = {};
  const tileKind = kindOf(tile);
  for (const seat of SEATS) {
    if (seat === from || !inPlay(state, seat)) continue;
    const player = state.players[seat]!;
    const actions: ClaimAction[] = [];
    if (canRon(state, seat, tile, kind === "robKong" ? "robKong" : "ron", afterKong)) actions.push("hu");
    if (kind === "discard" && !last && !isLocked(state, player) && suitOfTile(tile) !== player.void) {
      const same = player.hand.filter((own) => kindOf(own) === tileKind).length;
      if (same >= 3 && state.wallCount > 0) actions.push("kong");
      if (same >= 2) actions.push("pung");
    }
    if (actions.length > 0) options[seat] = actions;
  }
  return options;
}

/**
 * 抢牌窗口可以结算了：所有人都回应了；或者有人要和、能和的人都回应了；或者有人要碰杠、能和的人都过了。
 * 服务端还要保证窗口至少开了固定的停顿时间再结算。
 */
export function claimReady(state: SichuanState): boolean {
  const claim = state.claim;
  if (state.stage !== "claim" || !claim) return false;
  const seats = Object.keys(claim.options).map(Number);
  const responded = (seat: number) => claim.responses[seat] !== undefined;
  if (seats.every(responded)) return true;
  const huSeats = seats.filter((seat) => claim.options[seat]!.includes("hu"));
  if (!huSeats.every(responded)) return false;
  return seats.some((seat) => claim.responses[seat] !== undefined && claim.responses[seat] !== "pass");
}

/** 现在要做决定的座位。 */
export function pendingSeats(state: SichuanState): number[] {
  if (state.phase === "finished") return [];
  switch (state.stage) {
    case "swap":
      return SEATS.filter((seat) => !state.players[seat]!.swapChosen);
    case "void":
      return SEATS.filter((seat) => !state.players[seat]!.voidChosen);
    case "turn":
      return [state.turn];
    case "claim":
      if (claimReady(state)) return [];
      return Object.keys(state.claim!.options).map(Number).filter((seat) => state.claim!.responses[seat] === undefined);
    case "handEnd":
      return SEATS.filter((seat) => !state.ready.includes(state.players[seat]!.id));
  }
}

/** 当前这一步的限时（秒）。claim 阶段只对有选项的人计时。 */
export function stepSeconds(state: SichuanState): number {
  const config = state.config;
  switch (state.stage) {
    case "swap":
      return config.swapSec;
    case "void":
      return config.voidSec;
    case "turn":
      return config.discardSec;
    case "claim":
      return config.claimSec;
    case "handEnd":
      return config.handEndSec;
  }
}

// ---------------------------------------------------------------------------
// 开局

function blankHandFields(): Omit<SichuanPlayer, "id" | "name" | "bot" | "auto" | "timeouts" | "score"> {
  return {
    handDelta: 0,
    hand: [],
    handCount: 0,
    drawn: null,
    melds: [],
    discards: [],
    void: null,
    voidChosen: false,
    swapPick: null,
    swapChosen: false,
    swapOut: [],
    swapIn: [],
    wins: [],
    out: false,
    passedHu: false,
    draws: 0,
  };
}

export function createSichuan(players: readonly NewPlayer[], seed: number, options: Partial<SichuanOptions> = {}, overrides: Partial<SichuanConfig> = {}): SichuanState {
  if (players.length !== 4) throw new Error("四川麻将需要 4 个座位。");
  const rng = createRng(seed);
  const seated = rng.shuffle(players);
  const state: SichuanState = {
    variant: "sichuan",
    config: sichuanConfig(options, overrides),
    phase: "playing",
    players: seated.map((player) => ({ id: player.id, name: player.name, bot: player.bot === true, auto: false, timeouts: 0, score: 0, ...blankHandFields() })),
    handNo: 0,
    dealer: rng.int(4),
    stage: "swap",
    turn: -1,
    turnMode: "draw",
    afterKong: false,
    lastDraw: false,
    anyCall: false,
    claim: null,
    wallCount: 0,
    swapDirection: null,
    kongLedger: [],
    lastKong: null,
    winOrder: 0,
    firstWin: null,
    lines: [],
    summary: null,
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
  const wall = wallOverride ?? rng.shuffle(Array.from({ length: SICHUAN_TILES }, (_, tile) => tile));
  for (const player of state.players) Object.assign(player, blankHandFields());
  for (let k = 0; k < 4; k += 1) {
    const seat = (state.dealer + k) % 4;
    const count = k === 0 ? 14 : 13;
    state.players[seat]!.hand = sortTiles(wall.splice(0, count));
  }
  state.wall = wall;
  state.wallCount = wall.length;
  state.stage = state.config.swap ? "swap" : "void";
  state.turn = -1;
  state.turnMode = "draw";
  state.afterKong = false;
  state.lastDraw = false;
  state.anyCall = false;
  state.claim = null;
  state.swapDirection = null;
  state.kongLedger = [];
  state.lastKong = null;
  state.winOrder = 0;
  state.firstWin = null;
  state.lines = [];
  state.summary = null;
  state.ready = [];
  state.step += 1;
  ctx.events.push({ type: "HandStarted", handNo: state.handNo, dealer: state.dealer });
}

/** 测试用：用指定的牌墙重开当前这一盘（前 53 张按庄家开始的顺序发牌）。 */
export function stackSichuanHand(state: SichuanState, wall: Tile[], overrides: Partial<Pick<SichuanState, "dealer">> = {}): SichuanState {
  const next = structuredClone(state);
  Object.assign(next, overrides);
  next.handNo -= 1;
  const ctx: Ctx = { state: next, rng: createRng(next.rng ?? 1), events: [] };
  startHand(ctx, [...wall]);
  return finish(ctx);
}

// ---------------------------------------------------------------------------
// 动作

export function applySichuan(input: SichuanState, playerId: string, command: GameCommand | { type: "RESOLVE" } | { type: "TIMEOUT" }): { state: SichuanState; events: GameEvent[] } {
  if (input.phase === "finished" && command.type !== "AUTO") fail("对局已经结束。");
  const state = structuredClone(input);
  delete (state as { events?: unknown }).events;
  state.events = [];
  const ctx: Ctx = { state, rng: createRng(state.rng ?? 1), events: [] };
  const seat = state.players.findIndex((player) => player.id === playerId);

  if (command.type === "RESOLVE") {
    if (state.stage !== "claim") fail("现在没有抢牌窗口。");
    state.log?.push({ seat: -1, command });
    resolveClaim(ctx);
    return { state: finish(ctx), events: ctx.events };
  }
  if (command.type === "TIMEOUT") {
    timeoutAll(ctx);
    return { state: finish(ctx), events: ctx.events };
  }
  if (seat < 0) fail("你不在这局里。");
  state.log?.push({ seat, command });
  if (command.type === "AUTO") {
    setAuto(ctx, seat, command.on === true);
    return { state: finish(ctx), events: ctx.events };
  }
  act(ctx, seat, command);
  state.players[seat]!.timeouts = 0;
  return { state: finish(ctx), events: ctx.events };
}

function setAuto(ctx: Ctx, seat: number, on: boolean): void {
  const player = ctx.state.players[seat]!;
  if (player.auto === on) return;
  player.auto = on;
  player.timeouts = 0;
  ctx.events.push({ type: "AutoChanged", seat, on });
}

function act(ctx: Ctx, seat: number, command: GameCommand): void {
  const { state } = ctx;
  switch (command.type) {
    case "SWAP":
      return chooseSwap(ctx, seat, command.tiles);
    case "VOID":
      return chooseVoid(ctx, seat, command.suit);
    case "DISCARD":
      return discard(ctx, seat, command.tile);
    case "TSUMO":
      if (!canTsumo(state, seat)) fail("现在不能自摸。");
      return settleTsumo(ctx, seat);
    case "KONG":
      return declareKong(ctx, seat, command.tile);
    case "CLAIM":
      return respondClaim(ctx, seat, command.action);
    case "READY":
      return markReady(ctx, seat);
    case "AUTO":
      return setAuto(ctx, seat, command.on);
  }
}

function chooseSwap(ctx: Ctx, seat: number, tiles: readonly Tile[]): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  if (state.stage !== "swap") fail("现在不是换三张。");
  if (player.swapChosen) fail("你已经选好了。");
  if (!Array.isArray(tiles) || tiles.length !== 3 || new Set(tiles).size !== 3) fail("要选 3 张牌。");
  if (!tiles.every((tile) => player.hand.includes(tile))) fail("这些牌不在你手里。");
  if (new Set(tiles.map(suitOfTile)).size !== 1) fail("换三张要选同一门花色。");
  player.swapPick = [...tiles];
  player.swapChosen = true;
  if (state.players.every((other) => other.swapChosen)) performSwap(ctx);
}

function performSwap(ctx: Ctx): void {
  const { state, rng } = ctx;
  const direction = rng.pick(["next", "prev", "across"] as const);
  const offset = direction === "next" ? 1 : direction === "prev" ? 3 : 2;
  const picks = state.players.map((player) => player.swapPick!);
  state.players.forEach((player, seat) => {
    player.hand = player.hand.filter((tile) => !picks[seat]!.includes(tile));
    player.swapOut = picks[seat]!;
  });
  state.players.forEach((_, seat) => {
    const receiver = state.players[(seat + offset) % 4]!;
    receiver.swapIn = picks[seat]!;
    receiver.hand = sortTiles([...receiver.hand, ...picks[seat]!]);
  });
  state.swapDirection = direction;
  state.stage = "void";
  state.step += 1;
  ctx.events.push({ type: "Swapped", direction });
}

function chooseVoid(ctx: Ctx, seat: number, suit: Suit): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  if (state.stage !== "void") fail("现在不是定缺。");
  if (player.voidChosen) fail("你已经定缺了。");
  if (!SUITS.includes(suit)) fail("缺门要选万、筒、条之一。");
  player.void = suit;
  player.voidChosen = true;
  if (state.players.every((other) => other.voidChosen)) {
    ctx.events.push({ type: "VoidsRevealed", voids: state.players.map((other) => other.void) });
    beginTurn(ctx, state.dealer, "start");
  }
}

function beginTurn(ctx: Ctx, seat: number, mode: SichuanState["turnMode"]): void {
  const { state } = ctx;
  state.stage = "turn";
  state.turn = seat;
  state.turnMode = mode;
  state.claim = null;
  state.step += 1;
}

/** 从牌墙头部（或开杠后从尾部）摸一张；牌墙空了就流局。 */
function draw(ctx: Ctx, seat: number, fromTail = false): void {
  const { state } = ctx;
  const wall = state.wall!;
  if (wall.length === 0) {
    endHand(ctx, "exhausted");
    return;
  }
  const tile = fromTail ? wall.pop()! : wall.shift()!;
  state.wallCount = wall.length;
  const player = state.players[seat]!;
  player.hand = sortTiles([...player.hand, tile]);
  player.drawn = tile;
  player.draws += 1;
  player.passedHu = false;
  state.lastDraw = wall.length === 0;
  state.afterKong = fromTail;
  ctx.events.push({ type: "Drew", seat, fromTail });
  beginTurn(ctx, seat, "draw");
  // 血流成河锁定的手牌：不能和、不能杠时自动摸切。
  if (isLocked(state, player) && !canTsumo(state, seat) && kongOptions(state, seat).length === 0) {
    discard(ctx, seat, tile, true);
  }
}

function removeOne(tiles: readonly Tile[], tile: Tile): Tile[] {
  const index = tiles.indexOf(tile);
  if (index < 0) fail("这张牌不在手里。");
  return [...tiles.slice(0, index), ...tiles.slice(index + 1)];
}

function discard(ctx: Ctx, seat: number, tile: Tile, auto = false): void {
  const { state } = ctx;
  if (state.stage !== "turn" || state.turn !== seat) fail("还没轮到你打牌。");
  if (!discardable(state, seat).includes(tile)) {
    const player = state.players[seat]!;
    if (!player.hand.includes(tile)) fail("这张牌不在你手里。");
    if (isLocked(state, player)) fail("和牌以后手牌锁定，只能打刚摸到的牌。");
    fail("手里还有缺门的牌，要先打缺门。");
  }
  const player = state.players[seat]!;
  // 血流锁定时放弃自摸，同样进入过胡。
  if (isLocked(state, player) && canTsumo(state, seat)) player.passedHu = true;
  player.hand = removeOne(player.hand, tile);
  player.drawn = null;
  player.discards.push({ tile });
  ctx.events.push({ type: "Discarded", seat, tile, ...(auto ? { auto: true } : {}) });
  const last = state.wallCount === 0;
  const afterKong = state.afterKong;
  state.afterKong = false;
  openClaim(ctx, { tile, from: seat, kind: "discard", last, afterKong });
}

function openClaim(ctx: Ctx, base: Pick<ClaimWindow, "tile" | "from" | "kind" | "last" | "afterKong">): void {
  const { state } = ctx;
  const options = claimOptionsFor(state, base.from, base.tile, base.kind, base.last, base.afterKong);
  state.claim = { ...base, options, responses: {}, pending: Object.keys(options).length };
  state.stage = "claim";
  state.turn = -1;
  state.step += 1;
}

function respondClaim(ctx: Ctx, seat: number, action: ClaimAction | "pass"): void {
  const { state } = ctx;
  const claim = state.claim;
  if (state.stage !== "claim" || !claim) fail("现在没有可以抢的牌。");
  const options = claim.options[seat];
  if (!options) fail("这张牌你没有可以做的动作。");
  if (claim.responses[seat] !== undefined) fail("你已经选过了。");
  if (action !== "pass" && !options.includes(action)) fail("不能这样做。");
  claim.responses[seat] = action;
  claim.pending = Object.keys(claim.options).filter((other) => claim.responses[Number(other)] === undefined).length;
  // 过胡：放过了能和的牌。
  if (action !== "hu" && options.includes("hu")) state.players[seat]!.passedHu = true;
}

/** 按逆时针从 from 数起的距离（1–3）。 */
const distance = (from: number, seat: number) => (seat - from + 4) % 4;

function resolveClaim(ctx: Ctx): void {
  const { state } = ctx;
  const claim = state.claim!;
  const responses = claim.responses;
  const huSeats = Object.keys(claim.options).map(Number).filter((seat) => responses[seat] === "hu").sort((a, b) => distance(claim.from, a) - distance(claim.from, b));
  const markTaken = () => {
    if (claim.kind !== "discard") return;
    const river = state.players[claim.from]!.discards;
    river[river.length - 1]!.taken = true;
  };

  if (huSeats.length > 0) {
    markTaken();
    if (claim.kind === "robKong") ctx.events.push({ type: "KongRobbed", seat: claim.from, tile: claim.tile });
    state.winOrder += 1;
    for (const seat of huSeats) settleRon(ctx, seat, claim);
    if (claim.kind === "discard" && claim.afterKong) transferKong(ctx, claim.from, huSeats[0]!);
    if (!state.firstWin) state.firstWin = { winners: huSeats, from: claim.from };
    state.claim = null;
    if (checkAllWon(ctx)) return;
    const farthest = huSeats[huSeats.length - 1]!;
    draw(ctx, nextActive(state, farthest));
    return;
  }

  const taker = Object.keys(claim.options).map(Number).find((seat) => responses[seat] === "kong" || responses[seat] === "pung");
  if (taker !== undefined && claim.kind === "discard") {
    markTaken();
    const player = state.players[taker]!;
    const kind = kindOf(claim.tile);
    state.anyCall = true;
    state.claim = null;
    if (responses[taker] === "kong") {
      const own = player.hand.filter((tile) => kindOf(tile) === kind).slice(0, 3);
      player.hand = player.hand.filter((tile) => !own.includes(tile));
      player.melds.push({ type: "kong", tiles: [...own, claim.tile], from: claim.from });
      const gain = payKong(ctx, taker, [claim.from], 2, `${player.name} 明杠`);
      ctx.events.push({ type: "Kong", seat: taker, kongType: "kong", tile: claim.tile, from: claim.from, gain });
      draw(ctx, taker, true);
      return;
    }
    const own = player.hand.filter((tile) => kindOf(tile) === kind).slice(0, 2);
    player.hand = player.hand.filter((tile) => !own.includes(tile));
    player.melds.push({ type: "pung", tiles: [...own, claim.tile], from: claim.from });
    ctx.events.push({ type: "Pung", seat: taker, from: claim.from, tile: claim.tile });
    beginTurn(ctx, taker, "claimed");
    return;
  }

  state.claim = null;
  if (claim.kind === "robKong") {
    completeAddedKong(ctx, claim.from, claim.tile);
    return;
  }
  draw(ctx, nextActive(state, claim.from));
}

function declareKong(ctx: Ctx, seat: number, tile: Tile): void {
  const { state } = ctx;
  const option = kongOptions(state, seat).find((candidate) => kindOf(candidate.tile) === kindOf(tile));
  if (!option) fail("现在不能杠这张牌。");
  const player = state.players[seat]!;
  const kind = kindOf(tile);
  player.drawn = null;
  if (option.type === "concealedKong") {
    const four = player.hand.filter((own) => kindOf(own) === kind);
    player.hand = player.hand.filter((own) => kindOf(own) !== kind);
    player.melds.push({ type: "concealedKong", tiles: four });
    state.anyCall = true;
    const payers = SEATS.filter((other) => other !== seat && inPlay(state, other));
    const gain = payKong(ctx, seat, payers, 2, `${player.name} 暗杠`);
    ctx.events.push({ type: "Kong", seat, kongType: "concealedKong", tile: four[0]!, gain });
    draw(ctx, seat, true);
    return;
  }
  // 加杠：先开抢杠窗口。
  const fourth = player.hand.find((own) => kindOf(own) === kind)!;
  player.hand = removeOne(player.hand, fourth);
  state.anyCall = true;
  openClaim(ctx, { tile: fourth, from: seat, kind: "robKong", last: false, afterKong: false });
}

function completeAddedKong(ctx: Ctx, seat: number, tile: Tile): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  const index = player.melds.findIndex((meld) => meld.type === "pung" && kindOf(meld.tiles[0]!) === kindOf(tile));
  const pung = player.melds[index]!;
  player.melds[index] = { type: "addedKong", tiles: [...pung.tiles, tile], ...(pung.from !== undefined ? { from: pung.from } : {}) };
  const payers = SEATS.filter((other) => other !== seat && inPlay(state, other));
  const gain = payKong(ctx, seat, payers, 1, `${player.name} 加杠`);
  ctx.events.push({ type: "Kong", seat, kongType: "addedKong", tile, gain });
  draw(ctx, seat, true);
}

/** 刮风下雨：杠分马上结算，记进杠分账。返回开杠的人收到的总分。 */
function payKong(ctx: Ctx, payee: number, payers: readonly number[], amount: number, text: string): number {
  const { state } = ctx;
  const id = state.kongLedger.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  const deltas = emptyDeltas();
  for (const payer of payers) {
    state.kongLedger.push({ id, payer, payee, amount, transferred: false, refunded: false });
    deltas[payer]! -= amount;
    deltas[payee]! += amount;
  }
  addLine(ctx, { kind: "kong", text, deltas });
  state.lastKong = { seat: payee, id };
  return amount * payers.length;
}

/** 呼叫转移：杠上炮时，这次杠收到的分转给和牌的人。 */
function transferKong(ctx: Ctx, kongSeat: number, winner: number): void {
  const { state } = ctx;
  const last = state.lastKong;
  if (!last || last.seat !== kongSeat) return;
  const entries = state.kongLedger.filter((entry) => entry.id === last.id && !entry.transferred && !entry.refunded);
  const amount = entries.reduce((sum, entry) => sum + entry.amount, 0);
  if (amount === 0) return;
  for (const entry of entries) entry.transferred = true;
  const deltas = emptyDeltas();
  deltas[kongSeat]! -= amount;
  deltas[winner]! += amount;
  addLine(ctx, { kind: "transfer", text: `呼叫转移：${state.players[kongSeat]!.name} 的杠分转给 ${state.players[winner]!.name}`, deltas });
  ctx.events.push({ type: "Transfer", from: kongSeat, to: winner, amount });
}

function addLine(ctx: Ctx, line: SettleLine): void {
  const { state } = ctx;
  state.lines.push(line);
  line.deltas.forEach((delta, seat) => {
    state.players[seat]!.score += delta;
    state.players[seat]!.handDelta += delta;
  });
}

function recordWin(ctx: Ctx, seat: number, win: Win): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  player.wins.push(win);
  if (state.config.mode === "xuezhan") player.out = true;
  ctx.events.push({ type: "Hu", seat, win });
}

function settleTsumo(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  const winTile = player.drawn ?? player.hand[player.hand.length - 1]!;
  const situation = huSituation(state, seat);
  const result = evaluateHu(player.hand.map(kindOf), player.melds, player.void, situation, state.config)!;
  const payers = SEATS.filter((other) => other !== seat && inPlay(state, other));
  const points = result.points + (state.config.zimo === "base" ? 1 : 0);
  const deltas = emptyDeltas();
  for (const payer of payers) {
    deltas[payer]! -= points;
    deltas[seat]! += points;
  }
  state.winOrder += 1;
  addLine(ctx, { kind: "hu", text: `${player.name} 自摸 ${result.title} ${result.counted} 番`, deltas });
  player.hand = removeOne(player.hand, winTile);
  player.drawn = null;
  recordWin(ctx, seat, { tile: winTile, how: "zimo", fan: result.fan, counted: result.counted, items: result.items, title: result.title, points, payers, order: state.winOrder });
  if (!state.firstWin) state.firstWin = { winners: [seat] };
  state.afterKong = false;
  if (checkAllWon(ctx)) return;
  draw(ctx, nextActive(state, seat));
}

function settleRon(ctx: Ctx, seat: number, claim: ClaimWindow): void {
  const { state } = ctx;
  const player = state.players[seat]!;
  const how = claim.kind === "robKong" ? "robKong" : "ron";
  const result = evaluateHu([...player.hand.map(kindOf), kindOf(claim.tile)], player.melds, player.void, { how, afterKongDiscard: claim.afterKong }, state.config)!;
  const deltas = emptyDeltas();
  deltas[claim.from]! -= result.points;
  deltas[seat]! += result.points;
  const verb = how === "robKong" ? "抢杠胡" : "点炮胡";
  addLine(ctx, { kind: "hu", text: `${player.name} ${verb}（${state.players[claim.from]!.name} 放炮）${result.title} ${result.counted} 番`, deltas });
  recordWin(ctx, seat, { tile: claim.tile, how, from: claim.from, fan: result.fan, counted: result.counted, items: result.items, title: result.title, points: result.points, payers: [claim.from], order: state.winOrder });
}

/** 血战到底：第 3 个人和牌，这一盘马上结束。 */
function checkAllWon(ctx: Ctx): boolean {
  const { state } = ctx;
  if (state.config.mode !== "xuezhan") return false;
  if (state.players.filter((player) => player.out).length < 3) return false;
  endHand(ctx, "allWon");
  return true;
}

function endHand(ctx: Ctx, reason: HandSummary["reason"]): void {
  const { state } = ctx;
  const status: HandSummary["status"][number][] = [];
  if (reason === "exhausted") {
    const active = SEATS.filter((seat) => inPlay(state, seat));
    for (const seat of active) {
      const player = state.players[seat]!;
      const pig = hasVoidTiles(player);
      const info = pig ? null : tingInfo(player.hand, player.melds, player.void, state.config);
      const ting = player.wins.length > 0 || (info?.kinds.length ?? 0) > 0;
      status.push({ seat, ting, maxFan: ting ? info?.maxFan ?? 0 : 0, pig });
    }
    // 1. 退税：没听牌的人退还还没转移的杠分。
    for (const entry of status.filter((item) => !item.ting)) {
      const entries = state.kongLedger.filter((ledger) => ledger.payee === entry.seat && !ledger.transferred && !ledger.refunded);
      if (entries.length === 0) continue;
      const deltas = emptyDeltas();
      for (const ledger of entries) {
        ledger.refunded = true;
        deltas[ledger.payee]! -= ledger.amount;
        deltas[ledger.payer]! += ledger.amount;
      }
      addLine(ctx, { kind: "refund", text: `退税：${state.players[entry.seat]!.name} 没听牌，退还杠分`, deltas });
    }
    // 2. 查花猪。
    const pigPay = state.config.cap === null ? 16 : Math.min(16, 2 ** state.config.cap);
    for (const pig of status.filter((item) => item.pig)) {
      const deltas = emptyDeltas();
      for (const other of status.filter((item) => !item.pig)) {
        deltas[pig.seat]! -= pigPay;
        deltas[other.seat]! += pigPay;
      }
      if (deltas.some((delta) => delta !== 0)) addLine(ctx, { kind: "pig", text: `查花猪：${state.players[pig.seat]!.name} 手里还有缺门牌`, deltas });
    }
    // 3. 查大叫。
    const tingSeats = status.filter((item) => item.ting);
    for (const loser of status.filter((item) => !item.ting)) {
      const deltas = emptyDeltas();
      for (const winner of tingSeats) {
        const amount = 2 ** cappedFan(winner.maxFan, state.config.cap);
        deltas[loser.seat]! -= amount;
        deltas[winner.seat]! += amount;
      }
      if (deltas.some((delta) => delta !== 0)) addLine(ctx, { kind: "noTing", text: `查大叫：${state.players[loser.seat]!.name} 没听牌`, deltas });
    }
  }
  const first = state.firstWin;
  const nextDealer = first ? (first.winners.length === 1 ? first.winners[0]! : first.from ?? state.dealer) : state.dealer;
  const summary: HandSummary = {
    reason,
    lines: state.lines.map((line) => ({ ...line, deltas: [...line.deltas] as SettleLine["deltas"] })),
    deltas: state.players.map((player) => player.handDelta) as HandSummary["deltas"],
    status,
    nextDealer,
  };
  state.summary = summary;
  state.stage = "handEnd";
  state.turn = -1;
  state.claim = null;
  state.ready = [];
  state.step += 1;
  ctx.events.push({ type: "HandEnded", handNo: state.handNo, summary });
  if (state.handNo >= state.config.hands) finishGame(ctx);
}

function finishGame(ctx: Ctx): void {
  const { state } = ctx;
  const scores = state.players.map((player) => player.score);
  const ranks = scores.map((score) => 1 + scores.filter((other) => other > score).length);
  const top = Math.max(...scores);
  const winners = state.players.filter((player) => player.score === top).map((player) => player.id);
  state.phase = "finished";
  state.finalResult = { winners, ranks };
  ctx.events.push({ type: "GameEnded", winners });
}

function markReady(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  if (state.stage !== "handEnd") fail("现在不是结算画面。");
  const id = state.players[seat]!.id;
  if (!state.ready.includes(id)) state.ready.push(id);
  if (state.ready.length === 4) nextHand(ctx);
}

function nextHand(ctx: Ctx): void {
  const { state } = ctx;
  state.dealer = state.summary?.nextDealer ?? state.dealer;
  startHand(ctx);
}

// ---------------------------------------------------------------------------
// 超时（规则书 9.4）

/** 超时的默认动作：换三张按机器人、定缺选最少的一门、能和就和、有缺门打缺门（离 5 最远）否则摸切、碰杠一律过。 */
export function timeoutCommand(state: SichuanState, seat: number): GameCommand {
  const player = state.players[seat]!;
  switch (state.stage) {
    case "swap":
      return { type: "SWAP", tiles: pickSwapTiles(player.hand) };
    case "void":
      return { type: "VOID", suit: fewestSuit(player.hand) };
    case "turn": {
      if (canTsumo(state, seat)) return { type: "TSUMO" };
      const options = discardable(state, seat);
      if (hasVoidTiles(player)) {
        const best = [...options].sort((a, b) => Math.abs(rankOf(kindOf(b)) - 5) - Math.abs(rankOf(kindOf(a)) - 5) || b - a)[0]!;
        return { type: "DISCARD", tile: best };
      }
      const drawn = player.drawn !== null && options.includes(player.drawn) ? player.drawn : options[options.length - 1]!;
      return { type: "DISCARD", tile: drawn };
    }
    case "claim":
      return { type: "CLAIM", action: state.claim?.options[seat]?.includes("hu") ? "hu" : "pass" };
    case "handEnd":
      return { type: "READY" };
  }
}

function timeoutAll(ctx: Ctx): void {
  const { state } = ctx;
  const seats = pendingSeats(state);
  for (const seat of seats) {
    if (state.phase === "finished") return;
    // 前一个人的超时动作可能已经让局面往前走了（比如定缺最后一人）。
    if (!pendingSeats(state).includes(seat)) continue;
    const command = timeoutCommand(state, seat);
    state.log?.push({ seat, command: { type: "TIMEOUT" } });
    ctx.events.push({ type: "TimedOut", seat });
    act(ctx, seat, command);
    const player = state.players[seat]!;
    if (state.stage !== "handEnd" && command.type !== "READY") {
      player.timeouts += 1;
      if (player.timeouts >= 2 && !player.auto && !player.bot) setAuto(ctx, seat, true);
    }
  }
}

// ---------------------------------------------------------------------------
// 换三张、定缺的默认选择（机器人和超时共用）

/** 张数最少、但不少于 3 张的那门里，最孤立的 3 张（左右两格内没有同门牌的优先）。 */
export function pickSwapTiles(hand: readonly Tile[]): Tile[] {
  const bySuit = SUITS.map((suit) => hand.filter((tile) => suitOfTile(tile) === suit));
  const candidates = bySuit.filter((tiles) => tiles.length >= 3).sort((a, b) => a.length - b.length);
  const tiles = candidates[0]!;
  const ranks = tiles.map((tile) => rankOf(kindOf(tile)));
  const isolation = (tile: Tile) => {
    const rank = rankOf(kindOf(tile));
    return ranks.filter((other) => other !== rank && Math.abs(other - rank) <= 2).length * 10 + ranks.filter((other) => other === rank).length * 6 - Math.abs(rank - 5);
  };
  return [...tiles].sort((a, b) => isolation(a) - isolation(b) || a - b).slice(0, 3);
}

/** 张数最少的那门；一样多时按 条 → 筒 → 万 的顺序取第一个。 */
export function fewestSuit(hand: readonly Tile[]): Suit {
  const order: Suit[] = ["s", "p", "m"];
  let best: Suit = "s";
  let bestCount = Infinity;
  for (const suit of order) {
    const count = hand.filter((tile) => suitOfTile(tile) === suit).length;
    if (count < bestCount) {
      best = suit;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------

function finish(ctx: Ctx): SichuanState {
  const { state } = ctx;
  for (const player of state.players) player.handCount = player.hand.length;
  state.rng = ctx.rng.state;
  state.events = ctx.events;
  state.history = [...state.history, ...ctx.events].slice(-HISTORY_LIMIT);
  state.version += 1;
  return state;
}

/**
 * 给某位玩家看的状态：别人的手牌只给张数，牌墙只给张数，换三张和定缺在所有人选好前保密，
 * 抢牌窗口只给自己的选项；和牌下桌的人、一盘结束时所有人的手牌公开。viewerId 为空串时只有公开信息。
 */
export function redactSichuan(state: SichuanState, viewerId: string): SichuanState {
  const view = structuredClone(state);
  delete view.wall;
  delete view.rng;
  delete view.seed;
  delete view.log;
  const viewer = view.players.findIndex((player) => player.id === viewerId);
  const allVoids = view.players.every((player) => player.voidChosen);
  const showAll = view.stage === "handEnd" || view.phase === "finished";
  view.players.forEach((player, seat) => {
    if (seat === viewer) return;
    const revealed = showAll || player.wins.length > 0;
    if (!revealed) {
      player.hand = [];
      if (player.drawn !== null) player.drawn = -1;
    }
    if (!showAll) {
      player.melds = player.melds.map((meld) => (meld.type === "concealedKong" ? { ...meld, tiles: meld.tiles.map(() => -1) } : meld));
    }
    player.swapPick = null;
    player.swapOut = [];
    player.swapIn = [];
    player.passedHu = false;
    if (!allVoids) player.void = null;
  });
  if (view.claim) {
    const own = view.claim.options[viewer];
    const response = view.claim.responses[viewer];
    view.claim.options = own ? { [viewer]: own } : {};
    view.claim.responses = response !== undefined ? { [viewer]: response } : {};
    // 还有几人没回应也不能给：会暴露别人能不能碰、能不能和。
    view.claim.pending = own && response === undefined ? 1 : 0;
  }
  // 别人的暗杠：一盘结束前事件里也不给牌面。
  const hideKong = (event: GameEvent): GameEvent =>
    event.type === "Kong" && event.kongType === "concealedKong" && event.seat !== viewer && !showAll ? { ...event, tile: -1 } : event;
  view.events = view.events.map(hideKong);
  view.history = view.history.map(hideKong);
  return view;
}
