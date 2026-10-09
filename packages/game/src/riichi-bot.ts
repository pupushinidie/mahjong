/**
 * 立直麻将的机器人（空座位、托管、断线代打共用）。规则书 9.4：够用就行。只看公开信息和自己的手牌。
 */
import { effectiveTiles, shanten, type ShantenOptions } from "./hand.js";
import { doraOf, isMenzen } from "./riichi-score.js";
import { canKyuushu, canTsumo, riichiDiscardable, riichiKanOptions, riichiOptions, seatWindOf } from "./riichi.js";
import { countKinds, isHonor, isRedFive, isYaochu, kindOf, type Kind, type Tile } from "./tiles.js";
import type { RiichiCommand, RiichiMeld, RiichiState } from "./riichi-types.js";

const OPTIONS: ShantenOptions = { sevenPairs: "distinct", thirteenOrphans: true };

function visibleCounts(state: RiichiState, seat: number): number[] {
  const seen = countKinds(state.players[seat]!.hand.map(kindOf));
  for (const player of state.players) {
    for (const entry of player.river) if (!entry.taken) seen[kindOf(entry.tile)]! += 1;
    for (const meld of player.melds) for (const tile of meld.tiles) seen[kindOf(tile)]! += 1;
  }
  for (const indicator of state.doraIndicators) seen[kindOf(indicator)]! += 1;
  return seen.map((count) => Math.min(4, count));
}

const yakuhaiKinds = (state: RiichiState, seat: number): Kind[] => [31, 32, 33, 27 + seatWindOf(state, seat), 27 + state.roundWind];

function handShanten(tiles: readonly Tile[], melds: number): number {
  return shanten(countKinds(tiles.map(kindOf)), melds, OPTIONS);
}

/** 副露以后还有没有役的希望：已经有役牌刻子、或者全是中张（食断）。 */
function hasOpenYaku(state: RiichiState, seat: number, tiles: readonly Tile[], melds: readonly RiichiMeld[]): boolean {
  const yakuhai = yakuhaiKinds(state, seat);
  if (melds.some((meld) => meld.type !== "chi" && yakuhai.includes(kindOf(meld.tiles[0]!)))) return true;
  const counts = countKinds(tiles.map(kindOf));
  if (yakuhai.some((kind) => counts[kind]! >= 3)) return true;
  const all = [...tiles, ...melds.flatMap((meld) => meld.tiles)];
  return state.config.kuitan && all.every((tile) => !isYaochu(kindOf(tile)));
}

function bestDiscard(state: RiichiState, seat: number, options: readonly Tile[]): Tile {
  const player = state.players[seat]!;
  const melds = player.melds.length;
  const seen = visibleCounts(state, seat);
  const doraKinds = state.doraIndicators.map((indicator) => doraOf(kindOf(indicator)));
  const yakuhai = yakuhaiKinds(state, seat);
  // 防守：别人立直、自己向听数 ≥ 2 时，先打现物，再打别人打过 2 张以上的字牌
  const riichiSeats = state.players.map((other, index) => (index !== seat && other.riichi ? index : -1)).filter((index) => index >= 0);
  if (riichiSeats.length > 0 && handShanten(player.hand, melds) >= 2) {
    const safe = options.filter((tile) => riichiSeats.every((index) => state.players[index]!.river.some((entry) => kindOf(entry.tile) === kindOf(tile))));
    if (safe.length > 0) return safe[0]!;
    const honors = options.filter((tile) => isHonor(kindOf(tile)) && seen[kindOf(tile)]! >= 3);
    if (honors.length > 0) return honors[0]!;
  }
  let best: { tile: Tile; value: number } | null = null;
  const tried = new Set<string>();
  for (const tile of options) {
    const key = `${kindOf(tile)}:${isRedFive(tile)}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const rest = [...player.hand];
    rest.splice(rest.indexOf(tile), 1);
    const counts = countKinds(rest.map(kindOf));
    const sh = shanten(counts, melds, OPTIONS);
    const effective = effectiveTiles(counts, melds, OPTIONS, (kind) => 4 - seen[kind]!).count;
    const kind = kindOf(tile);
    let keep = 0;
    if (doraKinds.includes(kind)) keep += 3;
    if (isRedFive(tile)) keep += 3;
    if (isHonor(kind)) keep += yakuhai.includes(kind) ? 1 : -2;
    else if (isYaochu(kind)) keep -= 1;
    const value = -sh * 1000 + effective * 4 - keep;
    if (!best || value > best.value) best = { tile, value };
  }
  return best!.tile;
}

export function riichiBotCommand(state: RiichiState, seat: number): RiichiCommand {
  const player = state.players[seat]!;
  switch (state.stage) {
    case "handEnd":
      return { type: "READY" };
    case "claim": {
      const claim = state.claim!;
      const options = claim.options[seat] ?? [];
      if (options.includes("ron")) return { type: "CLAIM", action: "ron" };
      const kind = kindOf(claim.tile);
      const before = handShanten(player.hand, player.melds.length);
      if (options.includes("pon")) {
        const combo = claim.ponOptions[seat]![0]!;
        const rest = player.hand.filter((tile) => tile !== combo[0] && tile !== combo[1]);
        const melds: RiichiMeld[] = [...player.melds, { type: "pon", tiles: [...combo, claim.tile] }];
        let after = 99;
        for (const tile of new Set(rest)) after = Math.min(after, handShanten(rest.filter((own) => own !== tile), melds.length));
        const yakuhai = yakuhaiKinds(state, seat).includes(kind);
        if (yakuhai || (after < before && hasOpenYaku(state, seat, rest, melds))) return { type: "CLAIM", action: "pon", tiles: combo };
      }
      if (options.includes("chi")) {
        let bestCombo: [Tile, Tile] | null = null;
        let bestAfter = before;
        for (const combo of claim.chiOptions[seat]!) {
          const rest = player.hand.filter((tile) => tile !== combo[0] && tile !== combo[1]);
          const melds: RiichiMeld[] = [...player.melds, { type: "chi", tiles: [...combo, claim.tile] }];
          if (!hasOpenYaku(state, seat, rest, melds)) continue;
          let after = 99;
          for (const tile of new Set(rest)) after = Math.min(after, handShanten(rest.filter((own) => own !== tile), melds.length));
          if (after < bestAfter) {
            bestAfter = after;
            bestCombo = combo;
          }
        }
        if (bestCombo) return { type: "CLAIM", action: "chi", tiles: bestCombo };
      }
      return { type: "CLAIM", action: "pass" };
    }
    case "turn": {
      if (canTsumo(state, seat)) return { type: "TSUMO" };
      if (canKyuushu(state, seat)) return { type: "KYUUSHU" };
      const before = handShanten(player.hand, player.melds.length);
      for (const option of riichiKanOptions(state, seat)) {
        const kind = kindOf(option.tile);
        const rest = player.hand.filter((tile) => kindOf(tile) !== kind);
        const melds = option.type === "ankan" ? player.melds.length + 1 : player.melds.length;
        if (handShanten(rest, melds) <= before) return { type: "KONG", tile: option.tile };
      }
      const riichiTiles = riichiOptions(state, seat);
      if (riichiTiles.length > 0 && isMenzen(player.melds)) {
        const tile = bestDiscard(state, seat, riichiTiles);
        return { type: "DISCARD", tile, riichi: true };
      }
      return { type: "DISCARD", tile: bestDiscard(state, seat, riichiDiscardable(state, seat)) };
    }
  }
}
