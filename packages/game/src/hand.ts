/**
 * 和牌拆解、听牌、向听数（整个麻将系列共用）。全部按 34 格的牌种计数（counts）计算。
 */
import { isHonor, isYaochu, type Kind } from "./tiles.js";

export interface Group {
  readonly type: "run" | "triplet";
  /** 顺子是最小的那张，刻子就是那种牌。 */
  readonly kind: Kind;
}

export interface Decomposition {
  readonly pair: Kind;
  readonly groups: Group[];
}

const total = (counts: readonly number[]) => counts.reduce((sum, count) => sum + count, 0);

/** 能不能从 i 开始组成顺子（同一门、点数 1–7 开头）。 */
const runStart = (kind: Kind) => kind < 27 && kind % 9 <= 6;

function findGroups(counts: number[], need: number, acc: Group[], out: Group[][]): void {
  let i = 0;
  while (i < 34 && counts[i] === 0) i += 1;
  if (i === 34) {
    if (acc.length === need) out.push([...acc]);
    return;
  }
  if (acc.length >= need) return;
  if (counts[i]! >= 3) {
    counts[i]! -= 3;
    acc.push({ type: "triplet", kind: i });
    findGroups(counts, need, acc, out);
    acc.pop();
    counts[i]! += 3;
  }
  if (runStart(i) && counts[i + 1]! > 0 && counts[i + 2]! > 0) {
    counts[i]! -= 1;
    counts[i + 1]! -= 1;
    counts[i + 2]! -= 1;
    acc.push({ type: "run", kind: i });
    findGroups(counts, need, acc, out);
    acc.pop();
    counts[i]! += 1;
    counts[i + 1]! += 1;
    counts[i + 2]! += 1;
  }
}

/**
 * 标准型（need 组面子 + 1 对将）的所有拆法。counts 是手里没亮出来的牌（含和的那张），
 * need = 4 − 已经亮出的面子数。
 */
export function decompositions(counts: readonly number[], need: number): Decomposition[] {
  if (total(counts) !== need * 3 + 2) return [];
  const work = [...counts];
  const result: Decomposition[] = [];
  for (let pair = 0; pair < 34; pair += 1) {
    if (work[pair]! < 2) continue;
    work[pair]! -= 2;
    const out: Group[][] = [];
    findGroups(work, need, [], out);
    for (const groups of out) result.push({ pair, groups });
    work[pair]! += 2;
  }
  return result;
}

export const isStandardWin = (counts: readonly number[], need: number) => decompositions(counts, need).length > 0;

/**
 * 七对：14 张、7 个对子。fourAsTwoPairs 为 true（四川）时四张一样算两对；为 false（立直）时 7 对必须各不相同。
 */
export function isSevenPairs(counts: readonly number[], fourAsTwoPairs: boolean): boolean {
  if (total(counts) !== 14) return false;
  if (fourAsTwoPairs) return counts.every((count) => count % 2 === 0);
  return counts.filter((count) => count === 2).length === 7;
}

/** 国士无双：13 种幺九牌各一张，再加其中任意一张。 */
export function isThirteenOrphans(counts: readonly number[]): boolean {
  if (total(counts) !== 14) return false;
  let pair = false;
  for (let kind = 0; kind < 34; kind += 1) {
    const count = counts[kind]!;
    if (!isYaochu(kind)) {
      if (count > 0) return false;
    } else if (count === 0 || count > 2) {
      return false;
    } else if (count === 2) {
      if (pair) return false;
      pair = true;
    }
  }
  return pair;
}

/**
 * 听哪些牌：13 张（counts，碰杠出去的不算在内，need 是还要几组面子）再加哪一种能和。
 * isWin 决定牌型（四川：标准型 + 七对；立直：再加国士）。limit 是每种牌能拿到的最多张数（默认 4），
 * 自己已经拿满 4 张的那种不算听（manyOf 给出自己一共有几张，含亮出去的）。
 */
export function waitingKinds(
  counts: readonly number[],
  isWin: (counts: number[]) => boolean,
  ownTotal: (kind: Kind) => number = (kind) => counts[kind]!,
  kinds: readonly Kind[] = ALL_KINDS,
): Kind[] {
  const work = [...counts];
  const result: Kind[] = [];
  for (const kind of kinds) {
    if (ownTotal(kind) >= 4) continue;
    work[kind]! += 1;
    if (isWin(work)) result.push(kind);
    work[kind]! -= 1;
  }
  return result;
}

export const ALL_KINDS: readonly Kind[] = Array.from({ length: 34 }, (_, kind) => kind);
export const SUITED_KINDS: readonly Kind[] = Array.from({ length: 27 }, (_, kind) => kind);

// ---------------------------------------------------------------------------
// 向听数（机器人用）：离听牌还差几步，0 = 听牌，-1 = 已经和了。
// 标准型按「每门牌分别拆成面子 / 搭子 / 雀头」再合并，结果按门缓存。

interface Block {
  readonly m: number;
  readonly t: number;
  readonly h: number;
}

const suitMemo = new Map<string, Block[]>();
const honorMemo = new Map<number, Block[]>();

function prune(blocks: Block[]): Block[] {
  const keep: Block[] = [];
  for (const block of blocks) {
    if (blocks.some((other) => other !== block && other.h === block.h && other.m >= block.m && other.t >= block.t && (other.m > block.m || other.t > block.t))) continue;
    if (keep.some((other) => other.h === block.h && other.m === block.m && other.t === block.t)) continue;
    keep.push(block);
  }
  return keep;
}

function suitBlocks(counts: number[]): Block[] {
  const key = counts.join("");
  const cached = suitMemo.get(key);
  if (cached) return cached;
  const found: Block[] = [];
  const dfs = (i: number, m: number, t: number, h: number) => {
    while (i < 9 && counts[i] === 0) i += 1;
    if (i === 9) {
      found.push({ m, t, h });
      return;
    }
    if (counts[i]! >= 3) {
      counts[i]! -= 3;
      dfs(i, m + 1, t, h);
      counts[i]! += 3;
    }
    if (i <= 6 && counts[i + 1]! > 0 && counts[i + 2]! > 0) {
      counts[i]! -= 1;
      counts[i + 1]! -= 1;
      counts[i + 2]! -= 1;
      dfs(i, m + 1, t, h);
      counts[i]! += 1;
      counts[i + 1]! += 1;
      counts[i + 2]! += 1;
    }
    if (counts[i]! >= 2) {
      counts[i]! -= 2;
      if (h === 0) dfs(i, m, t, 1);
      dfs(i, m, t + 1, h);
      counts[i]! += 2;
    }
    if (i <= 7 && counts[i + 1]! > 0) {
      counts[i]! -= 1;
      counts[i + 1]! -= 1;
      dfs(i, m, t + 1, h);
      counts[i]! += 1;
      counts[i + 1]! += 1;
    }
    if (i <= 6 && counts[i + 2]! > 0) {
      counts[i]! -= 1;
      counts[i + 2]! -= 1;
      dfs(i, m, t + 1, h);
      counts[i]! += 1;
      counts[i + 2]! += 1;
    }
    counts[i]! -= 1;
    dfs(i, m, t, h);
    counts[i]! += 1;
  };
  dfs(0, 0, 0, 0);
  const result = prune(found);
  suitMemo.set(key, result);
  return result;
}

function honorBlocks(count: number): Block[] {
  const cached = honorMemo.get(count);
  if (cached) return cached;
  const options: Block[] = [{ m: 0, t: 0, h: 0 }];
  if (count >= 3) options.push({ m: 1, t: 0, h: 0 });
  if (count >= 2) options.push({ m: 0, t: 1, h: 0 }, { m: 0, t: 0, h: 1 });
  const result = prune(options);
  honorMemo.set(count, result);
  return result;
}

function combine(left: Block[], right: Block[]): Block[] {
  const out: Block[] = [];
  for (const a of left) {
    for (const b of right) {
      if (a.h + b.h > 1) continue;
      out.push({ m: a.m + b.m, t: a.t + b.t, h: a.h + b.h });
    }
  }
  return prune(out);
}

/** 标准型向听数。melds 是已经亮出的面子数。 */
export function standardShanten(counts: readonly number[], melds: number): number {
  let states: Block[] = [{ m: 0, t: 0, h: 0 }];
  for (let suit = 0; suit < 3; suit += 1) {
    const slice = counts.slice(suit * 9, suit * 9 + 9);
    if (slice.some((count) => count > 0)) states = combine(states, suitBlocks(slice));
  }
  for (let kind = 27; kind < 34; kind += 1) {
    if (counts[kind]! > 0) states = combine(states, honorBlocks(counts[kind]!));
  }
  let best = 8;
  for (const { m, t, h } of states) {
    const sets = Math.min(m + melds, 4);
    const partial = Math.min(t, 4 - sets);
    best = Math.min(best, 8 - 2 * sets - partial - h);
  }
  return best;
}

/** 七对向听数（只在没有亮出面子时有意义）。 */
export function sevenPairsShanten(counts: readonly number[], fourAsTwoPairs: boolean): number {
  if (fourAsTwoPairs) {
    const pairs = counts.reduce((sum, count) => sum + Math.floor(count / 2), 0);
    return 6 - Math.min(pairs, 7);
  }
  const pairs = counts.filter((count) => count >= 2).length;
  const kinds = counts.filter((count) => count >= 1).length;
  return 6 - pairs + Math.max(0, 7 - kinds);
}

export function thirteenOrphansShanten(counts: readonly number[]): number {
  let kinds = 0;
  let pair = false;
  for (let kind = 0; kind < 34; kind += 1) {
    if (!isYaochu(kind)) continue;
    if (counts[kind]! > 0) kinds += 1;
    if (counts[kind]! >= 2) pair = true;
  }
  return 13 - kinds - (pair ? 1 : 0);
}

export interface ShantenOptions {
  readonly sevenPairs?: "four-as-two" | "distinct" | false;
  readonly thirteenOrphans?: boolean;
}

export function shanten(counts: readonly number[], melds: number, options: ShantenOptions = {}): number {
  let best = standardShanten(counts, melds);
  if (melds === 0 && options.sevenPairs) best = Math.min(best, sevenPairsShanten(counts, options.sevenPairs === "four-as-two"));
  if (melds === 0 && options.thirteenOrphans) best = Math.min(best, thirteenOrphansShanten(counts));
  return best;
}

/** 有效牌：摸到哪些牌能让向听数减少，按 remaining(kind) 张数加总。 */
export function effectiveTiles(
  counts: readonly number[],
  melds: number,
  options: ShantenOptions,
  remaining: (kind: Kind) => number,
  kinds: readonly Kind[] = ALL_KINDS,
): { kinds: Kind[]; count: number } {
  const base = shanten(counts, melds, options);
  const work = [...counts];
  const result: Kind[] = [];
  let count = 0;
  for (const kind of kinds) {
    const left = remaining(kind);
    if (left <= 0) continue;
    work[kind]! += 1;
    if (shanten(work, melds, options) < base) {
      result.push(kind);
      count += left;
    }
    work[kind]! -= 1;
  }
  return { kinds: result, count };
}

export { isHonor };
