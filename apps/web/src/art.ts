/** 美术资源（art/ 下的脚本导出到 public/art/）和座位色。 */
const BASE = `${import.meta.env.BASE_URL}art/`;

export const art = {
  /** 牌面图集：每张 20×32，见 art/tiles.py。 */
  tiles: `${BASE}tiles.png`,
  /** 四川麻将的茶馆场景（512×288）：夜间灯笼、白天竹帘阳光。牌桌背景和首页主图。 */
  sceneNight: `${BASE}scene-night.png`,
  sceneDay: `${BASE}scene-day.png`,
  /** 座位头像 0–3（32px）。 */
  avatar: (index: number) => `${BASE}avatar-${index % 4}.png`,
};

/** 座位色：自己、下家、对家、上家。 */
export const SEAT_COLORS = ["#f0b53a", "#3f8fe8", "#ef6b57", "#47b968"] as const;

export function seatColor(index: number): string {
  return SEAT_COLORS[index % SEAT_COLORS.length]!;
}

/** 背景图 512×288，按整数倍放大到盖满一块区域。 */
export function coverSize(width: number, height: number): string {
  const scale = Math.max(1, Math.ceil(Math.max(width / 512, height / 288)));
  return `${512 * scale}px ${288 * scale}px`;
}
