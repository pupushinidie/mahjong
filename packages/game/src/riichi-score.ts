/**
 * 立直麻将的和牌判定、役、符、点数（规则书第 6 节）。
 * 标准型按每种拆法 × 和的那张落在哪一组（两面 / 嵌张 / 边张 / 单骑 / 双碰）分别算，取点数最高的解释。
 */
import { decompositions, isSevenPairs, isThirteenOrphans, waitingKinds, ALL_KINDS } from "./hand.js";
import { countKinds, isHonor, isRedFive, isYaochu, kindOf, rankOf, suitIndexOf, type Kind, type Tile } from "./tiles.js";
import type { RiichiMeld, YakuItem } from "./riichi-types.js";

export interface RiichiHandInput {
  /** 手里的牌（含和的那张）。 */
  readonly concealed: readonly Tile[];
  readonly melds: readonly RiichiMeld[];
  readonly winTile: Tile;
  readonly tsumo: boolean;
  /** 自风、场风：0 东 1 南 2 西 3 北。 */
  readonly seatWind: number;
  readonly roundWind: number;
  readonly dealer: boolean;
  readonly riichi?: "riichi" | "double" | null;
  readonly ippatsu?: boolean;
  readonly rinshan?: boolean;
  readonly chankan?: boolean;
  readonly haitei?: boolean;
  readonly houtei?: boolean;
  readonly tenhou?: boolean;
  readonly chiihou?: boolean;
  readonly doraIndicators?: readonly Tile[];
  readonly uraIndicators?: readonly Tile[];
  readonly aka?: boolean;
  readonly kuitan?: boolean;
}

export interface RiichiScore {
  readonly yaku: YakuItem[];
  /** 普通役 + 宝牌（役满时 0）。 */
  readonly han: number;
  readonly fu: number;
  /** 役满倍数（累计役满算 1）。 */
  readonly yakuman: number;
  readonly limit: string;
  /** 基本点。 */
  readonly base: number;
  /** 大三元 / 大四喜（包牌用）里，包牌役满的倍数。 */
  readonly paoYakuman: { readonly daisangen: number; readonly daisuushii: number };
}

const DRAGONS = [31, 32, 33];
const WINDS = [27, 28, 29, 30];
const WIND_NAMES = ["东", "南", "西", "北"];
const DRAGON_NAMES = ["白", "发", "中"];
const GREEN = new Set([19, 20, 21, 23, 25, 32]);

/** 宝牌指示牌的下一张。 */
export function doraOf(indicator: Kind): Kind {
  if (indicator < 27) return indicator % 9 === 8 ? indicator - 8 : indicator + 1;
  if (indicator < 31) return indicator === 30 ? 27 : indicator + 1;
  return indicator === 33 ? 31 : indicator + 1;
}

const meldKind = (meld: RiichiMeld) => Math.min(...meld.tiles.map(kindOf));
const isKan = (meld: RiichiMeld) => meld.type === "minkan" || meld.type === "kakan" || meld.type === "ankan";

/** 门清：没有吃碰明杠加杠（暗杠可以有）。 */
export const isMenzen = (melds: readonly RiichiMeld[]) => melds.every((meld) => meld.type === "ankan");

/** 牌型能不能和（只看牌型，不看役）：标准型、七对子（门清、7 对不同）、国士（门清）。 */
export function isWinShape(counts: readonly number[], meldCount: number): boolean {
  const need = 4 - meldCount;
  if (decompositions(counts, need).length > 0) return true;
  if (meldCount === 0 && (isSevenPairs(counts, false) || isThirteenOrphans(counts))) return true;
  return false;
}

/** 听哪些牌（只看牌型）：自己已经拿满 4 张的那种不算。 */
export function riichiWaits(hand: readonly Tile[], melds: readonly RiichiMeld[]): Kind[] {
  const counts = countKinds(hand.map(kindOf));
  const own = [...counts];
  for (const meld of melds) for (const tile of meld.tiles) own[kindOf(tile)]! += 1;
  return waitingKinds(counts, (work) => isWinShape(work, melds.length), (kind) => own[kind]!, ALL_KINDS);
}

interface Group {
  readonly kind: Kind;
  readonly type: "run" | "triplet" | "kan";
  /** 明的（副露，或者荣和凑成的刻子）。 */
  readonly open: boolean;
  /** 副露出去的（吃碰杠，不含暗杠）。 */
  readonly called: boolean;
}

type Wait = "ryanmen" | "kanchan" | "penchan" | "tanki" | "shanpon";

const groupTiles = (group: Group): Kind[] => (group.type === "run" ? [group.kind, group.kind + 1, group.kind + 2] : [group.kind, group.kind, group.kind]);
const groupHasYaochu = (group: Group) => groupTiles(group).some(isYaochu);
const groupHasHonor = (group: Group) => isHonor(group.kind);

interface Candidate {
  yaku: YakuItem[];
  han: number;
  fu: number;
  yakuman: number;
  paoYakuman: { daisangen: number; daisuushii: number };
}

function countDora(input: RiichiHandInput, allTiles: readonly Tile[]): YakuItem[] {
  const items: YakuItem[] = [];
  const kinds = allTiles.map(kindOf);
  const count = (indicators: readonly Tile[] | undefined) =>
    (indicators ?? []).reduce((sum, indicator) => sum + kinds.filter((kind) => kind === doraOf(kindOf(indicator))).length, 0);
  const dora = count(input.doraIndicators);
  if (dora > 0) items.push({ name: "宝牌", han: dora });
  if (input.aka) {
    const aka = allTiles.filter(isRedFive).length;
    if (aka > 0) items.push({ name: "赤宝牌", han: aka });
  }
  if (input.riichi) {
    const ura = count(input.uraIndicators);
    if (ura > 0) items.push({ name: "里宝牌", han: ura });
  }
  return items;
}

/** 基本点：符 × 2^(番+2)，满贯以上查表。 */
export function basePoints(han: number, fu: number, yakuman: number): { base: number; limit: string } {
  if (yakuman > 0) return { base: 8000 * yakuman, limit: yakuman > 1 ? `${yakuman} 倍役满` : "役满" };
  if (han >= 13) return { base: 8000, limit: "累计役满" };
  if (han >= 11) return { base: 6000, limit: "三倍满" };
  if (han >= 8) return { base: 4000, limit: "倍满" };
  if (han >= 6) return { base: 3000, limit: "跳满" };
  const raw = fu * 2 ** (han + 2);
  if (han >= 5 || raw >= 2000) return { base: 2000, limit: "满贯" };
  return { base: raw, limit: "" };
}

export const roundUp100 = (value: number) => Math.ceil(value / 100) * 100;

/** 每家付多少（不含本场）。荣和：放铳的人付 ron；自摸：庄家付 dealerPays、闲家付 nonDealerPays（庄家自摸时三家都付 nonDealerPays）。 */
export function payments(base: number, dealer: boolean): { ron: number; dealerPays: number; nonDealerPays: number } {
  return dealer
    ? { ron: roundUp100(base * 6), dealerPays: 0, nonDealerPays: roundUp100(base * 2) }
    : { ron: roundUp100(base * 4), dealerPays: roundUp100(base * 2), nonDealerPays: roundUp100(base) };
}

function yakumanFor(input: RiichiHandInput, groups: Group[], pair: Kind, wait: Wait, allKinds: Kind[]): { items: YakuItem[]; pao: { daisangen: number; daisuushii: number } } {
  const items: YakuItem[] = [];
  const pao = { daisangen: 0, daisuushii: 0 };
  const triplets = groups.filter((group) => group.type !== "run");
  const tripletKinds = triplets.map((group) => group.kind);
  if (DRAGONS.every((kind) => tripletKinds.includes(kind))) {
    items.push({ name: "大三元", han: 1, yakuman: true });
    pao.daisangen = 1;
  }
  const windTriplets = WINDS.filter((kind) => tripletKinds.includes(kind)).length;
  if (windTriplets === 4) {
    items.push({ name: "大四喜", han: 2, yakuman: true });
    pao.daisuushii = 2;
  } else if (windTriplets === 3 && WINDS.includes(pair)) {
    items.push({ name: "小四喜", han: 1, yakuman: true });
  }
  if (allKinds.every(isHonor)) items.push({ name: "字一色", han: 1, yakuman: true });
  if (allKinds.every((kind) => GREEN.has(kind))) items.push({ name: "绿一色", han: 1, yakuman: true });
  if (allKinds.every((kind) => !isHonor(kind) && isYaochu(kind))) items.push({ name: "清老头", han: 1, yakuman: true });
  const concealedTriplets = triplets.filter((group) => !group.open).length;
  if (concealedTriplets === 4) items.push(wait === "tanki" ? { name: "四暗刻单骑", han: 2, yakuman: true } : { name: "四暗刻", han: 1, yakuman: true });
  if (groups.filter((group) => group.type === "kan").length === 4) items.push({ name: "四杠子", han: 1, yakuman: true });
  return { items, pao };
}

function chuuren(input: RiichiHandInput): YakuItem | null {
  if (input.melds.length > 0) return null;
  const kinds = input.concealed.map(kindOf);
  const suit = suitIndexOf(kinds[0]!);
  if (suit === 3 || kinds.some((kind) => suitIndexOf(kind) !== suit)) return null;
  const counts = new Array<number>(9).fill(0);
  for (const kind of kinds) counts[kind % 9]! += 1;
  const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
  if (!need.every((value, index) => counts[index]! >= value)) return null;
  const before = [...counts];
  before[kindOf(input.winTile) % 9]! -= 1;
  const junsei = need.every((value, index) => before[index] === value);
  return junsei ? { name: "纯正九莲宝灯", han: 2, yakuman: true } : { name: "九莲宝灯", han: 1, yakuman: true };
}

function situationalYaku(input: RiichiHandInput, menzen: boolean): YakuItem[] {
  const items: YakuItem[] = [];
  if (input.riichi === "double") items.push({ name: "双立直", han: 2 });
  else if (input.riichi === "riichi") items.push({ name: "立直", han: 1 });
  if (input.riichi && input.ippatsu) items.push({ name: "一发", han: 1 });
  if (menzen && input.tsumo) items.push({ name: "门前清自摸和", han: 1 });
  if (input.rinshan) items.push({ name: "岭上开花", han: 1 });
  if (input.chankan) items.push({ name: "抢杠", han: 1 });
  if (input.haitei && input.tsumo && !input.rinshan) items.push({ name: "海底摸月", han: 1 });
  if (input.houtei && !input.tsumo) items.push({ name: "河底捞鱼", han: 1 });
  return items;
}

function standardCandidate(input: RiichiHandInput, groups: Group[], pair: Kind, wait: Wait): Candidate {
  const menzen = isMenzen(input.melds);
  const allKinds: Kind[] = [...groups.flatMap(groupTiles), pair, pair];
  const ym = yakumanFor(input, groups, pair, wait, allKinds);
  const extra: YakuItem[] = [];
  if (input.tenhou) extra.push({ name: "天和", han: 1, yakuman: true });
  if (input.chiihou) extra.push({ name: "地和", han: 1, yakuman: true });
  const chuu = menzen ? chuuren(input) : null;
  const yakumanItems = [...ym.items, ...(chuu ? [chuu] : []), ...extra];
  if (yakumanItems.length > 0) {
    return { yaku: yakumanItems, han: 0, fu: 0, yakuman: yakumanItems.reduce((sum, item) => sum + item.han, 0), paoYakuman: ym.pao };
  }

  const seatKind = 27 + input.seatWind;
  const roundKind = 27 + input.roundWind;
  const yakuhaiPair = DRAGONS.includes(pair) || pair === seatKind || pair === roundKind;
  const runs = groups.filter((group) => group.type === "run");
  const triplets = groups.filter((group) => group.type !== "run");
  const items: YakuItem[] = situationalYaku(input, menzen);
  const pinfu = menzen && runs.length === 4 && !yakuhaiPair && wait === "ryanmen";
  if (pinfu) items.push({ name: "平和", han: 1 });
  if (allKinds.every((kind) => !isYaochu(kind)) && (menzen || input.kuitan !== false)) items.push({ name: "断幺九", han: 1 });
  if (menzen) {
    const runCounts = new Map<number, number>();
    for (const run of runs) runCounts.set(run.kind, (runCounts.get(run.kind) ?? 0) + 1);
    const peiko = [...runCounts.values()].reduce((sum, count) => sum + Math.floor(count / 2), 0);
    if (peiko >= 2) items.push({ name: "二杯口", han: 3 });
    else if (peiko === 1) items.push({ name: "一杯口", han: 1 });
  }
  for (const group of triplets) {
    const dragon = DRAGONS.indexOf(group.kind);
    if (dragon >= 0) items.push({ name: `役牌：${DRAGON_NAMES[dragon]}`, han: 1 });
    if (group.kind === seatKind) items.push({ name: `自风：${WIND_NAMES[input.seatWind]}`, han: 1 });
    if (group.kind === roundKind) items.push({ name: `场风：${WIND_NAMES[input.roundWind]}`, han: 1 });
  }
  const open = !menzen;
  // 三色同顺、一气通贯
  const runKinds = runs.map((run) => run.kind);
  for (let rank = 0; rank < 7; rank += 1) {
    if ([0, 1, 2].every((suit) => runKinds.includes(suit * 9 + rank))) {
      items.push({ name: "三色同顺", han: open ? 1 : 2 });
      break;
    }
  }
  for (let suit = 0; suit < 3; suit += 1) {
    if ([0, 3, 6].every((rank) => runKinds.includes(suit * 9 + rank))) {
      items.push({ name: "一气通贯", han: open ? 1 : 2 });
      break;
    }
  }
  // 混全带幺九 / 纯全带幺九
  if (runs.length > 0 && groups.every(groupHasYaochu) && isYaochu(pair)) {
    const honors = groups.some(groupHasHonor) || isHonor(pair);
    if (honors) items.push({ name: "混全带幺九", han: open ? 1 : 2 });
    else items.push({ name: "纯全带幺九", han: open ? 2 : 3 });
  }
  const tripletKinds = triplets.map((group) => group.kind);
  for (let rank = 0; rank < 9; rank += 1) {
    if ([0, 1, 2].every((suit) => tripletKinds.includes(suit * 9 + rank))) {
      items.push({ name: "三色同刻", han: 2 });
      break;
    }
  }
  const concealedTriplets = triplets.filter((group) => !group.open).length;
  if (concealedTriplets === 3) items.push({ name: "三暗刻", han: 2 });
  if (groups.filter((group) => group.type === "kan").length === 3) items.push({ name: "三杠子", han: 2 });
  if (triplets.length === 4) items.push({ name: "对对和", han: 2 });
  if (DRAGONS.filter((kind) => tripletKinds.includes(kind)).length === 2 && DRAGONS.includes(pair)) items.push({ name: "小三元", han: 2 });
  if (allKinds.every(isYaochu)) items.push({ name: "混老头", han: 2 });
  const suits = new Set(allKinds.filter((kind) => !isHonor(kind)).map(suitIndexOf));
  if (suits.size === 1) {
    if (allKinds.some(isHonor)) items.push({ name: "混一色", han: open ? 2 : 3 });
    else items.push({ name: "清一色", han: open ? 5 : 6 });
  }

  // 符
  let fu: number;
  if (pinfu) fu = input.tsumo ? 20 : 30;
  else {
    let raw = 20;
    if (menzen && !input.tsumo) raw += 10;
    if (input.tsumo) raw += 2;
    for (const group of triplets) {
      let value = group.type === "kan" ? 8 : 2;
      if (isYaochu(group.kind)) value *= 2;
      if (!group.open) value *= 2;
      raw += value;
    }
    if (DRAGONS.includes(pair)) raw += 2;
    if (pair === seatKind) raw += 2;
    if (pair === roundKind) raw += 2;
    if (wait === "kanchan" || wait === "penchan" || wait === "tanki") raw += 2;
    fu = Math.ceil(raw / 10) * 10;
    if (!menzen && fu === 20) fu = 30;
  }
  return { yaku: items, han: items.reduce((sum, item) => sum + item.han, 0), fu, yakuman: 0, paoYakuman: { daisangen: 0, daisuushii: 0 } };
}

function sevenPairsCandidate(input: RiichiHandInput, kinds: Kind[]): Candidate {
  const extra: YakuItem[] = [];
  if (input.tenhou) extra.push({ name: "天和", han: 1, yakuman: true });
  if (input.chiihou) extra.push({ name: "地和", han: 1, yakuman: true });
  if (kinds.every(isHonor)) extra.push({ name: "字一色", han: 1, yakuman: true });
  if (extra.length > 0) return { yaku: extra, han: 0, fu: 0, yakuman: extra.reduce((sum, item) => sum + item.han, 0), paoYakuman: { daisangen: 0, daisuushii: 0 } };
  const items: YakuItem[] = situationalYaku(input, true);
  items.push({ name: "七对子", han: 2 });
  if (kinds.every((kind) => !isYaochu(kind))) items.push({ name: "断幺九", han: 1 });
  if (kinds.every(isYaochu)) items.push({ name: "混老头", han: 2 });
  const suits = new Set(kinds.filter((kind) => !isHonor(kind)).map(suitIndexOf));
  if (suits.size === 1) {
    if (kinds.some(isHonor)) items.push({ name: "混一色", han: 3 });
    else items.push({ name: "清一色", han: 6 });
  }
  return { yaku: items, han: items.reduce((sum, item) => sum + item.han, 0), fu: 25, yakuman: 0, paoYakuman: { daisangen: 0, daisuushii: 0 } };
}

/** 按役和宝牌算一手牌。不能和（牌型不对或没有役）返回 null。 */
export function scoreRiichiHand(input: RiichiHandInput): RiichiScore | null {
  const kinds = input.concealed.map(kindOf);
  const counts = countKinds(kinds);
  const winKind = kindOf(input.winTile);
  const menzen = isMenzen(input.melds);
  const allTiles = [...input.concealed, ...input.melds.flatMap((meld) => meld.tiles)];
  const candidates: Candidate[] = [];

  if (input.melds.length === 0 && isThirteenOrphans(counts)) {
    const before = [...counts];
    before[winKind]! -= 1;
    const thirteenSided = before.every((count, kind) => (isYaochu(kind) ? count === 1 : count === 0));
    const items: YakuItem[] = [thirteenSided ? { name: "国士无双十三面", han: 2, yakuman: true } : { name: "国士无双", han: 1, yakuman: true }];
    if (input.tenhou) items.push({ name: "天和", han: 1, yakuman: true });
    if (input.chiihou) items.push({ name: "地和", han: 1, yakuman: true });
    candidates.push({ yaku: items, han: 0, fu: 0, yakuman: items.reduce((sum, item) => sum + item.han, 0), paoYakuman: { daisangen: 0, daisuushii: 0 } });
  }
  if (input.melds.length === 0 && isSevenPairs(counts, false)) candidates.push(sevenPairsCandidate(input, kinds));

  const meldGroups: Group[] = input.melds.map((meld) => ({
    kind: meldKind(meld),
    type: meld.type === "chi" ? "run" : isKan(meld) ? "kan" : "triplet",
    open: meld.type !== "ankan",
    called: meld.type !== "ankan",
  }));
  for (const decomposition of decompositions(counts, 4 - input.melds.length)) {
    const slots: { index: number | "pair"; wait: Wait }[] = [];
    if (decomposition.pair === winKind) slots.push({ index: "pair", wait: "tanki" });
    decomposition.groups.forEach((group, index) => {
      if (group.type === "triplet" && group.kind === winKind) slots.push({ index, wait: "shanpon" });
      if (group.type === "run" && winKind >= group.kind && winKind <= group.kind + 2) {
        const position = winKind - group.kind;
        const rank = rankOf(group.kind);
        const wait: Wait = position === 1 ? "kanchan" : position === 0 ? (rank === 7 ? "penchan" : "ryanmen") : rank === 1 ? "penchan" : "ryanmen";
        slots.push({ index, wait });
      }
    });
    const seen = new Set<string>();
    for (const slot of slots) {
      const key = `${slot.index}:${slot.wait}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const groups: Group[] = [
        ...decomposition.groups.map((group, index) => ({
          kind: group.kind,
          type: group.type,
          // 荣和凑成的那组刻子算明刻
          open: group.type === "triplet" && !input.tsumo && slot.index === index,
          called: false,
        })),
        ...meldGroups,
      ];
      candidates.push(standardCandidate(input, groups, decomposition.pair, slot.wait));
    }
  }

  let best: RiichiScore | null = null;
  for (const candidate of candidates) {
    if (candidate.yakuman === 0 && candidate.han === 0) continue;
    let yaku = candidate.yaku;
    let han = candidate.han;
    let yakuman = candidate.yakuman;
    if (yakuman === 0) {
      const dora = countDora(input, allTiles);
      yaku = [...yaku, ...dora];
      han += dora.reduce((sum, item) => sum + item.han, 0);
      if (han >= 13) yakuman = 0;
    }
    const { base, limit } = basePoints(han, candidate.fu, yakuman);
    const score: RiichiScore = { yaku, han, fu: candidate.fu, yakuman, limit, base, paoYakuman: candidate.paoYakuman };
    if (!best || score.base > best.base || (score.base === best.base && (score.han > best.han || (score.han === best.han && score.fu > best.fu)))) best = score;
  }
  void menzen;
  return best;
}
