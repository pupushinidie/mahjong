/**
 * 四川麻将的机器人（空座位、托管、断线代打共用）。规则书 9.4：够用就行，不追求强。
 * 只看公开信息和自己的手牌。
 */
import { effectiveTiles, shanten, SUITED_KINDS } from "./hand.js";
import { canTsumo, discardable, fewestSuit, kongOptions, pickSwapTiles } from "./sichuan.js";
import { countTiles, kindOf, rankOf, suitOfKind, suitOfTile, type Tile } from "./tiles.js";
import type { GameCommand, SichuanState } from "./types.js";

const OPTIONS = { sevenPairs: "four-as-two" as const };

/** 自己看得到的牌里每种已经出现了几张（手牌、所有牌河、所有亮出的面子）。 */
function visibleCounts(state: SichuanState, seat: number): number[] {
  const seen = countTiles(state.players[seat]!.hand);
  for (const player of state.players) {
    for (const entry of player.discards) if (!entry.taken) seen[kindOf(entry.tile)]! += 1;
    for (const meld of player.melds) for (const tile of meld.tiles) if (tile >= 0) seen[kindOf(tile)]! += 1;
    for (const win of player.wins) seen[kindOf(win.tile)]! += 1;
  }
  return seen;
}

function handShanten(state: SichuanState, seat: number, tiles: readonly Tile[], melds: number): number {
  const player = state.players[seat]!;
  // 缺门的牌算废牌：从计数里拿掉。
  const counts = countTiles(tiles.filter((tile) => suitOfTile(tile) !== player.void));
  const missing = tiles.filter((tile) => suitOfTile(tile) === player.void).length;
  return shanten(counts, melds, OPTIONS) + (missing > 0 ? 0 : 0);
}

function bestDiscard(state: SichuanState, seat: number, options: readonly Tile[]): { tile: Tile; shanten: number } {
  const player = state.players[seat]!;
  const melds = player.melds.length;
  if (player.void && options.some((tile) => suitOfTile(tile) === player.void)) {
    // 有缺门：先打缺门里最孤立、离 5 最远的。
    const voids = options.filter((tile) => suitOfTile(tile) === player.void);
    const counts = countTiles(voids);
    const score = (tile: Tile) => {
      const kind = kindOf(tile);
      const near = [-2, -1, 1, 2].reduce((sum, d) => sum + (suitOfKind(kind + d) === suitOfKind(kind) ? counts[kind + d] ?? 0 : 0), 0);
      return near * 10 + counts[kind]! * 8 - Math.abs(rankOf(kind) - 5);
    };
    const tile = [...voids].sort((a, b) => score(a) - score(b) || b - a)[0]!;
    return { tile, shanten: 99 };
  }
  const seen = visibleCounts(state, seat);
  const kinds = SUITED_KINDS.filter((kind) => suitOfKind(kind) !== player.void);
  let best: { tile: Tile; shanten: number; effective: number; edge: number } | null = null;
  const tried = new Set<number>();
  for (const tile of options) {
    const kind = kindOf(tile);
    if (tried.has(kind)) continue;
    tried.add(kind);
    const rest = [...player.hand];
    rest.splice(rest.indexOf(tile), 1);
    const counts = countTiles(rest.filter((own) => suitOfTile(own) !== player.void));
    const value = shanten(counts, melds, OPTIONS);
    const effective = effectiveTiles(counts, melds, OPTIONS, (k) => 4 - seen[k]!, kinds).count;
    const edge = Math.abs(rankOf(kind) - 5);
    if (!best || value < best.shanten || (value === best.shanten && (effective > best.effective || (effective === best.effective && edge > best.edge)))) {
      best = { tile, shanten: value, effective, edge };
    }
  }
  return best!;
}

export function sichuanBotCommand(state: SichuanState, seat: number): GameCommand {
  const player = state.players[seat]!;
  switch (state.stage) {
    case "swap":
      return { type: "SWAP", tiles: pickSwapTiles(player.hand) };
    case "void":
      return { type: "VOID", suit: fewestSuit(player.hand) };
    case "handEnd":
      return { type: "READY" };
    case "claim": {
      const options = state.claim?.options[seat] ?? [];
      if (options.includes("hu")) return { type: "CLAIM", action: "hu" };
      const tile = state.claim!.tile;
      const kind = kindOf(tile);
      const before = handShanten(state, seat, player.hand, player.melds.length);
      if (options.includes("kong")) {
        const rest = player.hand.filter((own) => kindOf(own) !== kind);
        if (handShanten(state, seat, rest, player.melds.length + 1) <= before) return { type: "CLAIM", action: "kong" };
      }
      if (options.includes("pung")) {
        const rest = [...player.hand];
        for (let k = 0; k < 2; k += 1) rest.splice(rest.findIndex((own) => kindOf(own) === kind), 1);
        let after = 99;
        for (const discard of new Set(rest)) {
          const left = [...rest];
          left.splice(left.indexOf(discard), 1);
          after = Math.min(after, handShanten(state, seat, left, player.melds.length + 1));
        }
        if (after <= before) return { type: "CLAIM", action: "pung" };
      }
      return { type: "CLAIM", action: "pass" };
    }
    case "turn": {
      if (canTsumo(state, seat)) return { type: "TSUMO" };
      const before = handShanten(state, seat, player.hand, player.melds.length);
      for (const option of kongOptions(state, seat)) {
        const kind = kindOf(option.tile);
        const rest = player.hand.filter((own) => kindOf(own) !== kind);
        const melds = option.type === "concealedKong" ? player.melds.length + 1 : player.melds.length;
        if (handShanten(state, seat, rest, melds) <= before) return { type: "KONG", tile: option.tile };
      }
      const options = discardable(state, seat);
      return { type: "DISCARD", tile: bestDiscard(state, seat, options).tile };
    }
  }
}
