/**
 * 麻将和教程有关的部分（共用的 tutorial/ 文件夹之外，每款游戏自己写的）：
 * 本机记录用的 id（四川、立直分开记）、「问咕噜嘎」怎么说、「第一次遇到」小贴士什么时候出。
 */
import {
  botCommand,
  riichiOptions,
  riichiWaits,
  SUIT_NAMES,
  suitOfTile,
  tingInfo,
  type GameCommand,
  type GameState,
  type RiichiState,
  type SichuanState,
  type Tile,
  type TutorialVariant,
} from "@mahjong/game";
import { tileLabel } from "./tiles.js";

/** 本机记录（gm-tutorial-<id>、gm-tips-<id>）用的 id：两种玩法分开。 */
export const gameIdOf = (variant: TutorialVariant) => (variant === "riichi" ? "mahjong-riichi" : "mahjong-sichuan");

export interface Hint {
  readonly say: string;
  readonly note?: string;
  /** 高亮哪个元素（data-tutorial）；null 不指。 */
  readonly anchor: string | null;
  /** 建议的操作（牌桌会替你选好牌，再点一次就打出）。 */
  readonly command?: GameCommand;
}

const riichiName = (tile: Tile) => tileLabel(tile, { s: "索" });

/** 「问咕噜嘎」：让人机从你的位置算一步（界面拿到的本来就是你能看到的那份），配一句原因。 */
export function hintFor(game: GameState, playerId: string): Hint {
  if (game.phase === "finished") return { say: "这一场已经结束了。", anchor: null };
  const seat = game.players.findIndex((player) => player.id === playerId);
  if (seat < 0) return { say: "现在不用你做决定，等一下。", anchor: null };
  if (game.stage === "handEnd") return { say: "看完结算，点「下一盘」接着打。", anchor: "btn-ready" };
  const command = botCommand(game, seat);
  return game.variant === "riichi" ? riichiHint(game, seat, command) : sichuanHint(game, seat, command);
}

function sichuanHint(game: SichuanState, seat: number, command: GameCommand): Hint {
  const me = game.players[seat]!;
  switch (command.type) {
    case "SWAP": {
      const suit = suitOfTile(command.tiles[0]!)!;
      return { say: `我会换出这 3 张${SUIT_NAMES[suit]}子。`, note: "挑张数少、和别的牌连不上的那门，换出去不心疼。", anchor: "btn-swap", command };
    }
    case "VOID":
      return { say: `我会缺${SUIT_NAMES[command.suit]}。`, note: "这门张数最少，最快打完。", anchor: `btn-void-${command.suit}`, command };
    case "DISCARD": {
      const tile = command.tile;
      if (me.void && suitOfTile(tile) === me.void) return { say: `先打缺门：${tileLabel(tile)}。`, note: "手里有缺门的牌，只能先打它们。", anchor: `tile:${tile}`, command };
      const rest = [...me.hand];
      rest.splice(rest.indexOf(tile), 1);
      const ting = tingInfo(rest, me.melds, me.void, game.config);
      const note = ting.kinds.length > 0 ? "打完就听牌了。" : "它和别的牌最连不上，留下的牌更容易凑成组。";
      return { say: `我会打${tileLabel(tile)}。`, note, anchor: `tile:${tile}`, command };
    }
    case "TSUMO":
      return { say: "自摸！能胡就胡。", anchor: "btn-tsumo", command };
    case "KONG":
      return { say: "我会开杠：马上收分，听的牌也不变。", anchor: "btn-kong-self", command };
    case "CLAIM":
      if (command.action === "hu") return { say: "胡！能胡就胡。", anchor: "btn-hu", command };
      if (command.action === "pung") return { say: "我会碰：离胡牌更近一步。", anchor: "btn-pung", command };
      if (command.action === "kong") return { say: "我会杠：打牌的人马上付 2 分。", anchor: "btn-kong", command };
      return { say: "我会过：这张拿过来没好处。", anchor: "btn-pass", command };
    default:
      return { say: "现在不用你做决定，等一下。", anchor: null };
  }
}

function riichiHint(game: RiichiState, seat: number, command: GameCommand): Hint {
  const me = game.players[seat]!;
  switch (command.type) {
    case "DISCARD": {
      const tile = command.tile;
      if ("riichi" in command && command.riichi) return { say: `听牌了，我会立直，打${riichiName(tile)}。`, note: "立直多一个役，和牌时还能翻里宝牌。", anchor: "btn-riichi", command };
      const rest = [...me.hand];
      rest.splice(rest.indexOf(tile), 1);
      const waits = riichiWaits(rest, me.melds);
      const note = me.riichi ? "立直以后只能打摸到的牌。" : waits.length > 0 ? "打完就听牌了。" : "它最没用，留下的牌离和牌最近。";
      return { say: `我会打${riichiName(tile)}。`, note, anchor: `tile:${tile}`, command };
    }
    case "TSUMO":
      return { say: "自摸！能和就和。", anchor: "btn-tsumo", command };
    case "KONG":
      return { say: "我会开杠：多摸一张，还多翻一张宝牌指示牌。", anchor: "btn-kong-self", command };
    case "KYUUSHU":
      return { say: "九种九牌：这手牌太散，可以流局重来。", anchor: "btn-kyuushu", command };
    case "CLAIM":
      if (command.action === "ron") return { say: "荣和！能和就和。", anchor: "btn-ron", command };
      if (command.action === "pon") return { say: "我会碰：碰了以后还有役，离和牌也更近。", anchor: "btn-pon", command };
      if (command.action === "chi") return { say: "我会吃：吃了以后还有役，离和牌也更近。", anchor: "btn-chi", command };
      if (command.action === "minkan") return { say: "我会杠。", anchor: "btn-minkan", command };
      return { say: "我会过：吃碰了没有役，或者离和牌没有更近。", note: "门清还能立直，别随便吃碰。", anchor: "btn-pass", command };
    default:
      return { say: "现在不用你做决定，等一下。", anchor: null };
  }
}

/** 「第一次遇到」小贴士的内容（四川、立直各一套，按玩法分开记看过没有）。 */
export const SICHUAN_TIPS = {
  swap: { title: "换三张", text: "选 3 张同一门的牌交出去，大家同时换，方向随机。一般换掉张数少、连不上的那门。" },
  void: { title: "定缺", text: "选一门不要：胡牌时不能有这门，手里有就要先打掉。一般选张数最少的那门。" },
  pung: { title: "碰", text: "别人打的牌你有两张一样的就能碰。碰了不摸牌、直接打一张。四川麻将不能吃。" },
  kong: { title: "刮风下雨", text: "开杠马上收分：暗杠每家付 2，明杠由打牌的人付 2，加杠每家付 1。" },
  out: { title: "血战到底", text: "胡了的人下桌，剩下的人接着打，直到三家胡牌或者牌摸完。" },
  passHu: { title: "过胡", text: "放过一张能胡的牌，到你下次摸牌之前都不能胡别人打的牌，自摸不受影响。" },
  exhausted: { title: "查花猪、查大叫", text: "牌摸完时：手里还有缺门的是花猪，赔每家 16 分；没听牌的人按听牌的人最大番数赔他，还要退回杠分。" },
  auto: { title: "托管中", text: "托管就是人机替你打。点「取消托管」就能自己接着打。" },
} as const;

export const RIICHI_TIPS = {
  riichi: { title: "可以立直", text: "门清听牌了：点「立直」再选一张打出，押 1000 点多一个役。立直以后不能换牌。" },
  furiten: { title: "振听", text: "你听的牌自己打过（或者刚放过一张能和的牌），现在不能荣和别人的牌，只能自摸。" },
  chi: { title: "吃", text: "只能吃上家打的牌。吃、碰以后不能立直，和牌还得另外有役（比如役牌、断幺九）。" },
  called: { title: "鸣牌以后", text: "吃碰过就不是门清了：不能立直，要靠役牌、断幺九这些役才能和。" },
  ryuukyoku: { title: "流局", text: "牌摸完没人和：没听牌的人一共付 3000 点给听牌的人，庄家听牌就连庄。" },
  kandora: { title: "杠宝牌", text: "开杠会多翻一张宝牌指示牌，大家的宝牌都变多了。" },
  auto: { title: "托管中", text: "托管就是人机替你打。点「取消托管」就能自己接着打。" },
} as const;

/** 这一步该出哪些小贴士（按优先顺序；只出第一条没看过的）。 */
export function detectTips(game: GameState, selfId: string): string[] {
  const ids: string[] = [];
  const self = game.players.findIndex((player) => player.id === selfId);
  if (self < 0) return ids;
  if (game.variant === "sichuan") {
    const me = game.players[self]!;
    for (const event of game.events) {
      if (event.type === "AutoChanged" && event.seat === self && event.on) ids.push("auto");
      if (event.type === "Kong") ids.push("kong");
      if (event.type === "Hu" && event.seat !== self && game.config.mode === "xuezhan") ids.push("out");
      if (event.type === "HandEnded" && event.summary.reason === "exhausted") ids.push("exhausted");
    }
    if (me.passedHu) ids.push("passHu");
    if (game.stage === "swap" && !me.swapChosen) ids.push("swap");
    if (game.stage === "void" && !me.voidChosen) ids.push("void");
    if (game.stage === "claim" && game.claim?.options[self]?.includes("pung")) ids.push("pung");
    return ids;
  }
  const me = game.players[self]!;
  for (const event of game.events) {
    if (event.type === "AutoChanged" && event.seat === self && event.on) ids.push("auto");
    if (event.type === "Draw" && event.kind === "exhaustive") ids.push("ryuukyoku");
    if (event.type === "DoraRevealed" && game.doraIndicators.length > 1) ids.push("kandora");
    if (event.type === "Called" && event.seat === self && event.meld.type !== "ankan") ids.push("called");
  }
  if (me.furiten.discard || me.furiten.temp || me.furiten.riichi) ids.push("furiten");
  if (game.stage === "turn" && game.turn === self && !me.riichi && riichiOptions(game, self).length > 0) ids.push("riichi");
  if (game.stage === "claim" && game.claim?.options[self]?.includes("chi")) ids.push("chi");
  return ids;
}
