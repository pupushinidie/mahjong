import { useEffect, useRef } from "react";
import type { GameEvent, RiichiState, SichuanState } from "@mahjong/game";
import { sfx, synth, type SfxName } from "./gm-sound.js";

/**
 * 麻将（四川、立直）的动作音效：对比前后两次对局快照（version、这一步的 events，四川的换三张 / 定缺还看谁「已选好」），
 * 把刚发生的动作配上声音。自己的动作响亮，别人的减半（观战时都算别人的）。
 * 第一次拿到快照（进房间、重连、观战刚进来）不出声；version 一下跳了好几步（又不是超时代打）、或者换了一局，动作不补响。
 *
 * 两种玩法共用：
 * - 洗牌开局 HandStarted：招牌「洗牌」（一大把牌哗啦啦）+ 新一盘提示音
 * - 摸牌 Drew：招牌「摸牌」（轻轻一擦 + 一声清脆的「嗒」）；自己摸到时再加一声轻的「叮」当轮到你
 * - 打牌 Discarded：招牌「啪」（牌拍在桌上，闷响 + 脆响）
 * - 碰 / 吃：三张牌「嗒嗒嗒」+ 一声短促的上扬；杠：四张牌更沉，杠到钱（四川刮风下雨）再响一声进账
 * - 和牌：招牌「锣」（一声低沉的锣 + 亮晶晶的琶音 + 大的得分声）；点炮 / 被抢杠的人响 bust
 * - 流局：招牌「流局」（几声往下走的木鱼似的音）
 * - 超时：自己的响 timeout；终局 gameOver(赢/输)；抢牌窗口里轮到你能碰 / 杠 / 和，响 yourTurn
 * 四川另有：换三张（自己选好 = 三张牌推出去；大家换完 = 牌滑过来）、定缺（自己选好 = 木头标记落下；大家亮出 = 揭晓）、
 *   呼叫转移（拿到钱的人进账、给钱的人 bust）。
 * 立直另有：招牌「立直」（立直棒落桌的木头声 + 一串往上走的亮音，两立直更长）、翻宝牌（揭晓声）、九种九牌等途中流局（流局声）。
 */

function log(name: string) {
  if (import.meta.env.DEV) {
    const w = window as unknown as { __sfxLog?: string[] };
    (w.__sfxLog ??= []).push(name);
  }
}

function play<K extends SfxName>(name: K, ...args: Parameters<(typeof sfx)[K]>) {
  log(name);
  (sfx[name] as (...a: Parameters<(typeof sfx)[K]>) => void)(...args);
}

const later = (ms: number, fn: () => void) => (ms <= 0 ? fn() : window.setTimeout(fn, ms));

// ---------- 招牌声音 ----------

/** 洗牌：一大把牌哗啦啦地碰在一起。 */
function wash() {
  log("wash");
  for (let i = 0; i < 16; i += 1) {
    const at = i * 0.04 + Math.random() * 0.03;
    const p = 0.8 + Math.random() * 0.6;
    synth.noise({ at, duration: 0.025, volume: 0.13, freq: 3000 * p, q: 2 });
    synth.tone(1100 * p, { at, duration: 0.04, volume: 0.04, type: "triangle" });
  }
  synth.noise({ duration: 0.7, volume: 0.05, filter: "lowpass", freq: 1200 });
}

/** 摸牌：从牌墙上轻轻一擦，再「嗒」一声立到手里。 */
function drawTile(mine: boolean) {
  log("drawTile");
  const v = synth.level(mine) * 0.8;
  synth.noise({ duration: 0.06, volume: 0.14 * v, freq: 2600, freqTo: 4200, q: 0.9 });
  sfx.tile(mine, 1, 1.25);
  if (mine) synth.tone(988, { at: 0.1, duration: 0.14, volume: 0.06, type: "triangle" });
}

/** 打牌：牌拍在桌上的「啪」——一声闷响加一声脆响。 */
function slap(mine: boolean) {
  log("slap");
  const v = synth.level(mine);
  synth.noise({ duration: 0.045, volume: 0.4 * v, filter: "lowpass", freq: 900 });
  synth.noise({ duration: 0.02, volume: 0.3 * v, freq: 3600 * synth.jitter(0.1), q: 2.5 });
  synth.tone(1400 * synth.jitter(0.08), { duration: 0.05, volume: 0.14 * v, type: "triangle" });
  synth.tone(180, { duration: 0.08, volume: 0.16 * v, type: "triangle" });
}

/** 碰 / 吃（3 张）、杠（4 张，更沉）：亮牌「嗒嗒嗒」+ 一声短促的上扬。 */
function meld(mine: boolean, count: 3 | 4, light = false) {
  log(count === 4 ? "kong" : light ? "chi" : "pung");
  const v = synth.level(mine);
  sfx.tile(mine, count, count === 4 ? 0.85 : light ? 1.15 : 1);
  const at = count * 0.06;
  synth.tone(light ? 784 : 659, { at, duration: 0.12, volume: 0.1 * v, type: "square", glideTo: light ? 1047 : 988 });
  if (count === 4) synth.tone(110, { at, duration: 0.3, volume: 0.18 * v, glideTo: 70 });
}

/** 和牌：一声低沉的锣，接亮晶晶的琶音和大的得分声。 */
function gong(mine: boolean) {
  log("gong");
  const v = synth.level(mine);
  synth.tone(147, { duration: 1.4, volume: 0.22 * v });
  synth.tone(294 * 1.01, { duration: 1.0, volume: 0.09 * v, type: "triangle" });
  synth.tone(441 * 0.99, { duration: 0.7, volume: 0.05 * v });
  synth.noise({ duration: 0.12, volume: 0.12 * v, filter: "lowpass", freq: 1500 });
  window.setTimeout(() => sfx.sparkle(mine), 250);
  window.setTimeout(() => sfx.score(mine, true), 650);
}

/** 流局：几声往下走、像木鱼的短音。 */
function exhausted() {
  log("exhausted");
  [523, 440, 349].forEach((f, i) => {
    synth.tone(f, { at: i * 0.16, duration: 0.14, volume: 0.12, type: "triangle" });
    synth.noise({ at: i * 0.16, duration: 0.03, volume: 0.08, filter: "lowpass", freq: 900 });
  });
}

/** 立直：立直棒「嗒」地落在桌上，接一串往上走的亮音；两立直更长。 */
function riichi(mine: boolean, double: boolean) {
  log("riichi");
  const v = synth.level(mine);
  sfx.place(mine);
  const notes = double ? [659, 880, 1175, 1568, 2093] : [784, 1175, 1568];
  notes.forEach((f, i) => synth.tone(f, { at: 0.08 + i * 0.07, duration: 0.3, volume: 0.11 * v, type: "square" }));
  synth.tone(notes[notes.length - 1]! * 2, { at: 0.08 + notes.length * 0.07, duration: 0.5, volume: 0.04 * v });
}

// ---------- 共用的推断 ----------

type Seat = number;

interface Ctx {
  mineSeat: (seat: Seat | undefined) => boolean;
  t: number;
  step: (gap: number, fn: () => void) => void;
}

function context(mySeat: Seat): Ctx {
  const ctx: Ctx = {
    mineSeat: (seat) => seat !== undefined && mySeat >= 0 && seat === mySeat,
    t: 0,
    step: (gap, fn) => {
      later(ctx.t, fn);
      ctx.t += gap;
    },
  };
  return ctx;
}

/** 两次快照之间是不是该出声：第一次、同一版本、换了一局（version 变小）、一下跳了好几步（又不是超时代打）都不响。 */
function fresh(prev: { version: number } | null, game: { version: number; events: readonly GameEvent[] }): boolean {
  if (!prev || prev.version === game.version) return false;
  if (game.version < prev.version) return false;
  const timedOut = game.events.some((event) => event.type === "TimedOut");
  return game.version - prev.version <= 2 || timedOut;
}

/** 抢牌窗口里新出现了自己能做的选择。 */
function claimOpened(prevOptions: unknown, nowOptions: unknown): boolean {
  return !prevOptions && Boolean(nowOptions);
}

/** 四川麻将。mySeat：自己的座位，观战传 -1。 */
export function useSichuanSfx(game: SichuanState, mySeat: Seat) {
  const previous = useRef<SichuanState | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = game;
    if (!fresh(prev, game) || !prev) return;
    const ctx = context(mySeat);
    const { mineSeat, step } = ctx;
    // 一次超时可能替好几个人做（换三张 / 定缺一起超时），自己的超时只响一次
    let timeoutPlayed = false;
    let ended: string[] | null = null;
    let handOver = false;
    // 换三张 / 定缺：选好时没有事件（要等所有人选完），看「已选好」变了；先响这个，再响「大家换完 / 亮出」
    if (game.handNo === prev.handNo) {
      game.players.forEach((player, seat) => {
        const before = prev.players[seat];
        if (!before) return;
        const mine = mineSeat(seat);
        if (!before.swapChosen && player.swapChosen) step(150, () => play("tile", mine, 3, 1.05));
        if (!before.voidChosen && player.voidChosen) step(150, () => play("place", mine));
      });
    }
    for (const event of game.events as readonly GameEvent[]) {
      switch (event.type) {
        case "TimedOut":
          if (mineSeat(event.seat) && !timeoutPlayed) {
            timeoutPlayed = true;
            step(350, () => play("timeout"));
          }
          break;
        case "HandStarted":
          step(150, () => play("roundStart"));
          step(800, wash);
          break;
        case "Swapped":
          step(300, () => play("draw", true, 3));
          step(250, () => play("tile", true, 3, 1.1));
          break;
        case "VoidsRevealed":
          step(350, () => play("reveal", true));
          break;
        case "Drew": {
          const mine = mineSeat(event.seat);
          step(220, () => drawTile(mine));
          break;
        }
        case "Discarded": {
          const mine = mineSeat(event.seat);
          step(260, () => slap(mine));
          break;
        }
        case "Pung": {
          const mine = mineSeat(event.seat);
          step(380, () => meld(mine, 3));
          break;
        }
        case "Kong": {
          const mine = mineSeat(event.seat);
          step(450, () => meld(mine, 4));
          if (event.gain > 0) step(250, () => play("coin", mine));
          break;
        }
        case "KongRobbed": {
          const mine = mineSeat(event.seat);
          step(300, () => play("hit", mine));
          break;
        }
        case "Hu": {
          const mine = mineSeat(event.seat);
          const from = event.win.from;
          step(900, () => gong(mine));
          if (from !== undefined && mineSeat(from)) step(400, () => play("bust", true));
          break;
        }
        case "Transfer": {
          const to = mineSeat(event.to);
          const from = mineSeat(event.from);
          if (to) step(250, () => play("coin", true));
          else if (from) step(350, () => play("bust", true));
          break;
        }
        case "HandEnded":
          handOver = true;
          if ("summary" in event && event.summary.reason === "exhausted") step(500, exhausted);
          break;
        case "GameEnded":
          ended = [...event.winners];
          break;
        default:
          break;
      }
    }
    finish(ctx, game, prev, mySeat, ended, handOver);
  }, [game, mySeat]);
}

/** 立直麻将。mySeat：自己的座位，观战传 -1。 */
export function useRiichiSfx(game: RiichiState, mySeat: Seat) {
  const previous = useRef<RiichiState | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = game;
    if (!fresh(prev, game) || !prev) return;
    const ctx = context(mySeat);
    const { mineSeat, step } = ctx;
    let timeoutPlayed = false;
    let ended: string[] | null = null;
    let handOver = false;
    for (const event of game.events as readonly GameEvent[]) {
      switch (event.type) {
        case "TimedOut":
          if (mineSeat(event.seat) && !timeoutPlayed) {
            timeoutPlayed = true;
            step(350, () => play("timeout"));
          }
          break;
        case "HandStarted":
          step(150, () => play("roundStart"));
          step(800, wash);
          break;
        case "Drew": {
          const mine = mineSeat(event.seat);
          step(220, () => drawTile(mine));
          break;
        }
        case "Discarded": {
          const mine = mineSeat(event.seat);
          step(260, () => slap(mine));
          break;
        }
        case "RiichiDeclared": {
          const mine = mineSeat(event.seat);
          step(500, () => riichi(mine, event.double));
          break;
        }
        case "Called": {
          const mine = mineSeat(event.seat);
          const type = event.meld.type;
          if (type === "chi") step(380, () => meld(mine, 3, true));
          else if (type === "pon") step(380, () => meld(mine, 3));
          else step(450, () => meld(mine, 4));
          break;
        }
        case "DoraRevealed":
          step(300, () => play("flip", true));
          break;
        case "Won": {
          const mine = mineSeat(event.win.seat);
          const from = event.win.from;
          step(900, () => gong(mine));
          if (from !== undefined && mineSeat(from)) step(400, () => play("bust", true));
          break;
        }
        case "Draw":
          step(500, exhausted);
          break;
        case "HandEnded":
          handOver = true;
          break;
        case "GameEnded":
          ended = [...event.winners];
          break;
        default:
          break;
      }
    }
    finish(ctx, game, prev, mySeat, ended, handOver);
  }, [game, mySeat]);
}

/** 收尾：终局输赢；抢牌窗口里轮到自己能碰 / 杠 / 和、换三张 / 定缺开始等自己选时，响「轮到你」。 */
function finish(
  ctx: Ctx,
  game: SichuanState | RiichiState,
  prev: SichuanState | RiichiState,
  mySeat: Seat,
  ended: string[] | null,
  handOver: boolean,
) {
  if (ended) {
    const myId = mySeat >= 0 ? game.players[mySeat]?.id : undefined;
    const won = myId !== undefined && ended.includes(myId);
    later(ctx.t + 600, () => play("gameOver", won));
    return;
  }
  if (mySeat < 0 || handOver || game.phase !== "playing") return;
  const me = game.players[mySeat]!;
  const claimNow = game.stage === "claim" && game.claim?.responses[mySeat] === undefined ? game.claim?.options[mySeat] : undefined;
  const claimBefore = prev.stage === "claim" && prev.claim?.responses[mySeat] === undefined ? prev.claim?.options[mySeat] : undefined;
  let prompt = claimOpened(claimBefore, claimNow);
  if (game.variant === "sichuan") {
    const sMe = me as SichuanState["players"][number];
    if (game.stage === "void" && prev.stage !== "void" && !sMe.voidChosen) prompt = true;
    if (game.stage === "swap" && prev.stage !== "swap" && !sMe.swapChosen) prompt = true;
  }
  // 轮到自己打牌但不是摸牌来的（庄家第一手）：响「轮到你」。自己摸牌的「叮」、自己碰 / 吃 / 杠的声音已经是确认，不再响
  const myTurnNow = game.stage === "turn" && game.turn === mySeat;
  const myTurnBefore = prev.stage === "turn" && prev.turn === mySeat;
  const byMe = (game.events as readonly GameEvent[]).some((event) => "seat" in event && event.seat === mySeat && ["Drew", "Pung", "Kong", "Called"].includes(event.type));
  if (myTurnNow && !myTurnBefore && !byMe) prompt = true;
  if (prompt) later(Math.max(ctx.t, 300), () => play("yourTurn"));
}
