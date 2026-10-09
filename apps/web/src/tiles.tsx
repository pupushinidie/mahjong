import type { CSSProperties, ReactNode } from "react";
import { isRedFive, kindName, kindOf, RED_FIVES, type Kind, type Tile } from "@mahjong/game";
import { art } from "./art.js";

/** 图集里每张牌的像素尺寸（art/tiles.py）。牌面 26 像素高，下面 4 像素是牌身厚度。 */
export const TILE_W = 20;
export const TILE_H = 32;
/** 平放成排时，后一排压住前一排的牌身：行距 = 28 像素 × 倍数。 */
export const ROW_PITCH = 28;
const ATLAS_COUNT = 38;
const BACK_INDEX = 37;

/** 图集里的第几张：牌种 0–33，红五 34–36（只在用红五的玩法里），牌背 37。 */
export function spriteIndex(tile: Tile | null, redFives = false): number {
  if (tile === null || tile < 0) return BACK_INDEX;
  if (redFives && isRedFive(tile)) return 34 + RED_FIVES.indexOf(tile);
  return kindOf(tile);
}

export function tileLabel(tile: Tile | null, suitWord?: { s?: string }): string {
  if (tile === null || tile < 0) return "牌背";
  return kindName(kindOf(tile), suitWord);
}

export function kindLabel(kind: Kind): string {
  return kindName(kind);
}

export function spriteStyle(index: number, scale: number): CSSProperties {
  return {
    width: TILE_W * scale,
    height: TILE_H * scale,
    backgroundImage: `url(${art.tiles})`,
    backgroundSize: `${TILE_W * ATLAS_COUNT * scale}px ${TILE_H * scale}px`,
    backgroundPosition: `${-index * TILE_W * scale}px 0`,
  };
}

interface TileProps {
  readonly tile: Tile | null;
  /** 整数倍（像素图只按整数倍放大）。 */
  readonly scale: number;
  readonly redFives?: boolean | undefined;
  /** 横放（碰、杠拿来的那张）。 */
  readonly sideways?: boolean | undefined;
  readonly className?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly onPointerEnter?: (() => void) | undefined;
  readonly onPointerLeave?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  readonly badge?: ReactNode | undefined;
  readonly style?: CSSProperties | undefined;
}

/** 一张牌。能点的是 button，其他是 span。 */
export function TileView({ tile, scale, redFives, sideways, className, onClick, onPointerEnter, onPointerLeave, disabled, title, badge, style }: TileProps) {
  const sprite = <span className="mj-sprite" style={spriteStyle(spriteIndex(tile, redFives), scale)} />;
  const classes = ["mj-tile", sideways ? "sideways" : "", tile === null || tile < 0 ? "back" : "", className ?? ""].join(" ");
  const box: CSSProperties = sideways
    ? { width: TILE_H * scale, height: TILE_W * scale, ...style }
    : { width: TILE_W * scale, height: TILE_H * scale, ...style };
  const label = title ?? tileLabel(tile);
  const inner = (
    <>
      {sprite}
      {badge !== undefined && badge !== null && <span className="mj-tile-badge">{badge}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={classes} style={box} onClick={onClick} disabled={disabled} title={label} aria-label={label} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
        {inner}
      </button>
    );
  }
  return (
    <span className={classes} style={box} title={label} aria-label={label} role="img" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      {inner}
    </span>
  );
}
