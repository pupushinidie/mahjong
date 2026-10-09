/**
 * 两种麻将牌桌共用的东西：倒计时、按牌桌大小选整数倍和中间方框大小（像素牌只按整数倍放大）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LobbyRoomSnapshot } from "@mahjong/game";
import { ROW_PITCH, TILE_H, TILE_W } from "./tiles.js";

export function useCountdown(room: LobbyRoomSnapshot): number | null {
  const [now, setNow] = useState(Date.now());
  const [anchor, setAnchor] = useState({ at: Date.now(), ms: room.turnRemainingMs });
  useEffect(() => setAnchor({ at: Date.now(), ms: room.turnRemainingMs }), [room]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  if (anchor.ms === undefined) return null;
  return Math.max(0, Math.ceil((anchor.ms - Math.max(0, now - anchor.at)) / 1000));
}

// ---------------------------------------------------------------------------
// 尺寸：按牌桌区域的大小选整数倍和中间方框大小（像素牌只按整数倍放大）

export interface Layout {
  /** 牌河、副露、别人手牌的倍数。 */
  readonly s: number;
  /** 自己手牌的倍数。 */
  readonly hs: number;
  /** 中间方框边长。 */
  readonly c: number;
  /** 牌河 3 排的深度（方框到牌桌边）。 */
  readonly d: number;
  /** 牌河宽（6 张）。 */
  readonly w: number;
  /** 整个牌河方阵的边长。 */
  readonly field: number;
  readonly mobile: boolean;
}

/** 别人手牌条的厚度、名牌宽度（桌面版）。 */
export const BAND = 76;
export const PLATE_W = 120;

/** 手机版：最上面一行三家的名牌。 */
export const MOBILE_OPP_ROW = 56;

export function pickLayout(width: number, height: number): Layout {
  const mobile = width < 640;
  const s = mobile ? 1 : 2;
  const d = (2 * ROW_PITCH + TILE_H) * s;
  const w = 6 * TILE_W * s;
  if (mobile) {
    // 手牌 2 倍分两排；牌河、别人的牌 1 倍
    const hs = 2;
    const sideBand = 8 + 36;
    const room = Math.min(width - 2 * sideBand, height - MOBILE_OPP_ROW - 40 - (TILE_H * hs * 2 + 48));
    const c = Math.max(64, Math.min(140, room - 2 * d));
    return { s, hs, c, d, w, field: c + 2 * d, mobile };
  }
  const sideBand = 8 + BAND + 8 + PLATE_W;
  const topBand = BAND + 8;
  const mine = (h: number) => TILE_H * h + 64;
  // 自己的手牌尽量大：4 倍放不下（中间方框小于 120）就 3 倍，再不行 2 倍
  let hs = 4;
  let room = 0;
  for (; hs >= 2; hs -= 1) {
    room = Math.min(height - topBand - mine(hs), width - 2 * sideBand);
    if (room - 2 * d >= 120 || hs === 2) break;
  }
  // 手牌一排要放得下 14 张
  while (hs > 2 && 15 * TILE_W * hs + 24 > width) hs -= 1;
  room = Math.min(height - topBand - mine(hs), width - 2 * sideBand);
  const c = Math.max(96, Math.min(220, room - 2 * d));
  return { s, hs, c, d, w, field: c + 2 * d, mobile };
}

export function useLayout(): [React.RefObject<HTMLDivElement | null>, Layout, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 1100, height: 700 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, pickLayout(box.width, box.height), box];
}

