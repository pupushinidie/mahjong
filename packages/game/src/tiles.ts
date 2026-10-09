/**
 * 麻将牌的编码（整个系列共用）。
 *
 * - 牌种 Kind：0–33。万 0–8，筒 9–17，条/索 18–26，东南西北 27–30，白发中 31–33。
 * - 每张牌 Tile：0–135，tile >> 2 就是牌种，同一种的 4 张是 4k..4k+3。
 *   四川麻将只用 0–107（万筒条）。立直麻将的红五是各门五的第一张：16（五万）、52（五筒）、88（五索）。
 * - 隐藏的牌（别人的暗杠等）用 -1 表示。
 */
export type Tile = number;
export type Kind = number;
/** 花色：0 万、1 筒、2 条，3 字牌。 */
export type SuitIndex = 0 | 1 | 2 | 3;
export type Suit = "m" | "p" | "s";

export const SUITS: readonly Suit[] = ["m", "p", "s"];
export const SUIT_NAMES: Record<Suit, string> = { m: "万", p: "筒", s: "条" };
export const HIDDEN: Tile = -1;
export const RED_FIVES: readonly Tile[] = [16, 52, 88];

export const kindOf = (tile: Tile): Kind => tile >> 2;
export const suitIndexOf = (kind: Kind): SuitIndex => (kind < 27 ? (Math.floor(kind / 9) as SuitIndex) : 3);
export const suitOfKind = (kind: Kind): Suit | null => (kind < 27 ? SUITS[Math.floor(kind / 9)]! : null);
export const suitOfTile = (tile: Tile): Suit | null => suitOfKind(kindOf(tile));
/** 数牌的点数 1–9；字牌返回 0。 */
export const rankOf = (kind: Kind): number => (kind < 27 ? (kind % 9) + 1 : 0);
export const isHonor = (kind: Kind): boolean => kind >= 27;
export const isTerminal = (kind: Kind): boolean => kind < 27 && (kind % 9 === 0 || kind % 9 === 8);
/** 幺九牌：一、九和字牌。 */
export const isYaochu = (kind: Kind): boolean => isHonor(kind) || isTerminal(kind);
export const isRedFive = (tile: Tile): boolean => RED_FIVES.includes(tile);
export const kindIndex = (suit: Suit, rank: number): Kind => SUITS.indexOf(suit) * 9 + rank - 1;

const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const HONOR_NAMES = ["东", "南", "西", "北", "白", "发", "中"];

/** 牌的中文名：「三万」「九筒」「一条」「东」；立直里条子叫索（suitWord 传「索」）。 */
export function kindName(kind: Kind, suitWord: { s?: string } = {}): string {
  if (kind >= 27) return HONOR_NAMES[kind - 27] ?? "?";
  const suit = suitOfKind(kind)!;
  const word = suit === "s" && suitWord.s ? suitWord.s : SUIT_NAMES[suit];
  return `${NUMERALS[kind % 9]}${word}`;
}

/** 简写：1m、5p、9s、1z（东）…7z（中）。 */
export function kindCode(kind: Kind): string {
  if (kind >= 27) return `${kind - 26}z`;
  return `${(kind % 9) + 1}${suitOfKind(kind)}`;
}

/** 34 格计数。 */
export function countKinds(kinds: Iterable<Kind>): number[] {
  const counts = new Array<number>(34).fill(0);
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

export const countTiles = (tiles: Iterable<Tile>): number[] => countKinds([...tiles].map(kindOf));

/** 按牌种、再按编号排序（理牌）。 */
export function sortTiles(tiles: readonly Tile[]): Tile[] {
  return [...tiles].sort((a, b) => a - b);
}

/**
 * 解析「123m 55p 1z」这样的写法成牌种列表（测试用）。0m / 0p / 0s 是红五，按 5 算，红五信息见 parseTiles。
 */
export function parseKinds(text: string): Kind[] {
  const kinds: Kind[] = [];
  for (const group of text.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(\d+)([mpsz])$/.exec(group);
    if (!match) throw new Error(`看不懂的牌：${group}`);
    for (const digit of match[1]!) {
      const rank = Number(digit) || 5;
      kinds.push(match[2] === "z" ? 26 + rank : kindIndex(match[2] as Suit, rank));
    }
  }
  return kinds;
}

/**
 * 把写法转成具体的牌（测试用）：每种牌按 4k、4k+1… 依次取，红五（0m 等）取 4k（即红五那张），
 * 普通的五从 4k+1 开始取，避免误用红五。used 记录已经用掉的牌，跨多次调用不重复。
 */
export function parseTiles(text: string, used: Set<Tile> = new Set()): Tile[] {
  const tiles: Tile[] = [];
  for (const group of text.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(\d+)([mpsz])$/.exec(group);
    if (!match) throw new Error(`看不懂的牌：${group}`);
    for (const digit of match[1]!) {
      const red = digit === "0";
      const rank = Number(digit) || 5;
      const kind = match[2] === "z" ? 26 + rank : kindIndex(match[2] as Suit, rank);
      const candidates = red ? [kind * 4] : RED_FIVES.includes(kind * 4) ? [kind * 4 + 1, kind * 4 + 2, kind * 4 + 3, kind * 4] : [0, 1, 2, 3].map((k) => kind * 4 + k);
      const tile = candidates.find((candidate) => !used.has(candidate));
      if (tile === undefined) throw new Error(`${group} 超过 4 张`);
      used.add(tile);
      tiles.push(tile);
    }
  }
  return tiles;
}
