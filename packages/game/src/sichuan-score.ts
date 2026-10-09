/**
 * 四川麻将的和牌判定和算番（规则书第 4.5、6.1、6.4 节）。
 */
import { decompositions, isSevenPairs, SUITED_KINDS, waitingKinds } from "./hand.js";
import { countKinds, kindOf, rankOf, suitOfKind, type Kind, type Suit, type Tile } from "./tiles.js";
import type { FanItem, Meld, SichuanConfig } from "./types.js";

export interface HuSituation {
  readonly how: "zimo" | "ron" | "robKong";
  /** 开杠补牌后自摸。 */
  readonly afterKongDraw?: boolean;
  /** 别人开杠补牌后打出的牌（杠上炮）。 */
  readonly afterKongDiscard?: boolean;
  /** 摸牌墙最后一张自摸。 */
  readonly haidi?: boolean;
  readonly tianhu?: boolean;
  readonly dihu?: boolean;
}

export interface HuResult {
  readonly fan: number;
  readonly counted: number;
  readonly items: FanItem[];
  readonly title: string;
  readonly points: number;
}

const meldKind = (meld: Pick<Meld, "tiles">) => kindOf(meld.tiles[0]!);
const meldSize = (meld: Pick<Meld, "type">) => (meld.type === "pung" ? 3 : 4);
const isTerminalKind = (kind: Kind) => rankOf(kind) === 1 || rankOf(kind) === 9;

/** 封顶后的番数。 */
export const cappedFan = (fan: number, cap: SichuanConfig["cap"]) => (cap === null ? fan : Math.min(fan, cap));

/**
 * concealed：手里的牌种（含和的那张），melds：亮出的面子。返回最高的番；不能和（牌型不对或有缺门牌）返回 null。
 */
export function evaluateHu(
  concealed: readonly Kind[],
  melds: readonly Pick<Meld, "type" | "tiles">[],
  voidSuit: Suit | null,
  situation: HuSituation,
  config: Pick<SichuanConfig, "zimo" | "cap">,
): HuResult | null {
  const all: Kind[] = [...concealed];
  for (const meld of melds) for (let k = 0; k < meldSize(meld); k += 1) all.push(meldKind(meld));
  if (all.some((kind) => kind >= 27)) return null;
  if (voidSuit && all.some((kind) => suitOfKind(kind) === voidSuit)) return null;

  const counts = countKinds(concealed);
  const need = 4 - melds.length;
  type Base = { name: "平胡" | "对对胡" | "七对" | "金钩钓"; fan: number; yaojiu: boolean };
  const bases: Base[] = [];
  if (melds.length === 0 && isSevenPairs(counts, true)) bases.push({ name: "七对", fan: 2, yaojiu: false });
  const meldTerminal = melds.every((meld) => isTerminalKind(meldKind(meld)));
  for (const decomposition of decompositions(counts, need)) {
    const allTriplets = decomposition.groups.every((group) => group.type === "triplet");
    const yaojiu = meldTerminal
      && isTerminalKind(decomposition.pair)
      && decomposition.groups.every((group) => (group.type === "triplet" ? isTerminalKind(group.kind) : rankOf(group.kind) === 1 || rankOf(group.kind) === 7));
    if (melds.length === 4) bases.push({ name: "金钩钓", fan: 2, yaojiu });
    else if (allTriplets) bases.push({ name: "对对胡", fan: 1, yaojiu });
    else bases.push({ name: "平胡", fan: 0, yaojiu });
  }
  if (bases.length === 0) return null;

  const allCounts = countKinds(all);
  const flush = new Set(all.map(suitOfKind)).size === 1;
  const noTerminals = all.every((kind) => !isTerminalKind(kind));
  const all258 = all.every((kind) => [2, 5, 8].includes(rankOf(kind)));
  const roots = allCounts.filter((count) => count === 4).length;

  let best: HuResult | null = null;
  for (const base of bases) {
    const items: FanItem[] = [{ name: base.name, fan: base.fan }];
    if (flush) items.push({ name: "清一色", fan: 2 });
    if (base.yaojiu) items.push({ name: "带幺九", fan: 2 });
    const jiangdui = base.name !== "平胡" && all258;
    if (jiangdui) items.push({ name: "将对", fan: 2 });
    else if (noTerminals) items.push({ name: "断幺九", fan: 1 });
    if (roots > 0) items.push({ name: roots > 1 ? `根 ×${roots}` : "根", fan: roots });
    const heavenly = situation.tianhu || situation.dihu;
    if (situation.how === "zimo") {
      if (config.zimo === "fan" && !heavenly) items.push({ name: "自摸", fan: 1 });
      if (situation.afterKongDraw) items.push({ name: "杠上花", fan: 1 });
      else if (situation.haidi) items.push({ name: "海底捞月", fan: 1 });
      if (situation.tianhu) items.push({ name: "天胡", fan: 5 });
      else if (situation.dihu) items.push({ name: "地胡", fan: 5 });
    }
    if (situation.how === "ron" && situation.afterKongDiscard) items.push({ name: "杠上炮", fan: 1 });
    if (situation.how === "robKong") items.push({ name: "抢杠胡", fan: 1 });
    const fan = items.reduce((sum, item) => sum + item.fan, 0);
    if (best && best.fan >= fan) continue;
    const counted = cappedFan(fan, config.cap);
    best = { fan, counted, items, title: titleFor(base.name, flush, jiangdui, roots, base.yaojiu, noTerminals), points: 2 ** counted };
  }
  return best;
}

function titleFor(base: string, flush: boolean, jiangdui: boolean, roots: number, yaojiu: boolean, noTerminals: boolean): string {
  const qing = flush ? "清" : "";
  if (base === "七对") return `${qing}${jiangdui ? "将" : ""}${roots > 0 ? "龙" : ""}七对`;
  if (base === "对对胡") return flush ? "清对" : jiangdui ? "将对" : "对对胡";
  if (base === "金钩钓") return `${qing}${jiangdui ? "将" : ""}金钩钓`;
  if (flush) return yaojiu ? "清带幺九" : "清一色";
  if (yaojiu) return "带幺九";
  if (noTerminals) return "断幺九";
  return "平胡";
}

export interface TingInfo {
  readonly kinds: Kind[];
  /** 听的牌里按点炮算的最大番（不含自摸等情形番），封顶后。 */
  readonly maxFan: number;
  /** 每种听的牌按点炮算的番（封顶后）。 */
  readonly fanByKind: Record<number, number>;
}

/**
 * 听牌（规则书 6.4）：13 张再加哪一种能和。自己已经有 4 张的那种不算。
 */
export function tingInfo(
  hand: readonly Tile[],
  melds: readonly Pick<Meld, "type" | "tiles">[],
  voidSuit: Suit | null,
  config: Pick<SichuanConfig, "zimo" | "cap">,
): TingInfo {
  const kinds = hand.map(kindOf);
  if (voidSuit && kinds.some((kind) => suitOfKind(kind) === voidSuit)) return { kinds: [], maxFan: 0, fanByKind: {} };
  const own = countKinds(kinds);
  for (const meld of melds) own[meldKind(meld)]! += meldSize(meld);
  const counts = countKinds(kinds);
  const need = 4 - melds.length;
  const candidates = SUITED_KINDS.filter((kind) => suitOfKind(kind) !== voidSuit);
  const waits = waitingKinds(
    counts,
    (work) => decompositions(work, need).length > 0 || (melds.length === 0 && isSevenPairs(work, true)),
    (kind) => own[kind]!,
    candidates,
  );
  const fanByKind: Record<number, number> = {};
  let maxFan = 0;
  for (const kind of waits) {
    const result = evaluateHu([...kinds, kind], melds, voidSuit, { how: "ron" }, config);
    const fan = result?.counted ?? 0;
    fanByKind[kind] = fan;
    maxFan = Math.max(maxFan, fan);
  }
  return { kinds: waits, maxFan, fanByKind };
}
