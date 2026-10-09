import { describe, expect, it } from "vitest";
import { payments, riichiWaits, scoreRiichiHand, type RiichiHandInput } from "./riichi-score.js";
import { kindOf, parseKinds, parseTiles, type Tile } from "./tiles.js";
import type { RiichiMeld } from "./riichi-types.js";

/** 手牌（含和的那张）+ 副露 → 算分输入。 */
function hand(text: string, win: string, extra: Partial<Omit<RiichiHandInput, "melds">> & { melds?: { type: RiichiMeld["type"]; tiles: string }[] } = {}): RiichiHandInput {
  const used = new Set<Tile>();
  const melds: RiichiMeld[] = (extra.melds ?? []).map((meld) => ({ type: meld.type, tiles: parseTiles(meld.tiles, used) }));
  const concealed = parseTiles(`${text} ${win}`, used);
  const winKind = parseKinds(win)[0]!;
  const winTile = concealed.filter((tile) => kindOf(tile) === winKind).at(-1)!;
  const { melds: _melds, ...rest } = extra;
  return { concealed, melds, winTile, tsumo: false, seatWind: 1, roundWind: 0, dealer: false, aka: true, kuitan: true, ...rest };
}

const yakuNames = (input: RiichiHandInput) => scoreRiichiHand(input)!.yaku.map((item) => item.name);

describe("立直麻将算分（规则书第 10 节）", () => {
  it("T2 立直平和荣和，换成 6p 再加断幺九", () => {
    const score = scoreRiichiHand(hand("234m 567m 78p 345s 66s", "9p", { riichi: "riichi" }))!;
    expect([score.han, score.fu]).toEqual([2, 30]);
    expect(payments(score.base, false).ron).toBe(2000);
    const tanyao = scoreRiichiHand(hand("234m 567m 78p 345s 66s", "6p", { riichi: "riichi" }))!;
    expect([tanyao.han, tanyao.fu]).toEqual([3, 30]);
    expect(payments(tanyao.base, false).ron).toBe(3900);
  });

  it("T3 庄家门清自摸满贯（含红五、宝牌）", () => {
    const input = hand("234m 3p 0p 4p 66p 456s 78s", "6s", { tsumo: true, dealer: true, seatWind: 0, doraIndicators: parseTiles("3p", new Set([4 * 11 + 1])) });
    const score = scoreRiichiHand(input)!;
    expect(score.han).toBe(5);
    expect(score.limit).toBe("满贯");
    expect(payments(score.base, true).nonDealerPays).toBe(4000);
    expect(yakuNames(input)).toEqual(expect.arrayContaining(["门前清自摸和", "平和", "断幺九", "宝牌", "赤宝牌"]));
  });

  it("T4 副露役牌单骑 1 番 40 符", () => {
    const score = scoreRiichiHand(hand("234m 567p 999s 1p", "1p", { seatWind: 2, melds: [{ type: "pon", tiles: "777z" }] }))!;
    expect([score.han, score.fu]).toEqual([1, 40]);
    expect(payments(score.base, false).ron).toBe(1300);
  });

  it("T5 七对子混一色满贯", () => {
    const score = scoreRiichiHand(hand("11m 22m 55m 99m 11z 55z 7z", "7z", { seatWind: 3 }))!;
    expect(score.han).toBe(5);
    expect(score.fu).toBe(25);
    expect(payments(score.base, false).ron).toBe(8000);
  });

  it("T6 食断、不切上满贯；关掉食断不能和", () => {
    const input = hand("234p 678s 345s 7p", "7p", { melds: [{ type: "pon", tiles: "666m" }], doraIndicators: parseTiles("5m", new Set([4 * 4, 4 * 4 + 1, 4 * 4 + 2])) });
    const score = scoreRiichiHand(input)!;
    expect([score.han, score.fu]).toEqual([4, 30]);
    expect(payments(score.base, false).ron).toBe(7700);
    expect(scoreRiichiHand({ ...input, kuitan: false })).toBeNull();
  });

  it("T7 庄家双东 2 番 30 符", () => {
    const score = scoreRiichiHand(hand("234m 567p 789s 2p", "2p", { dealer: true, seatWind: 0, roundWind: 0, melds: [{ type: "pon", tiles: "111z" }] }))!;
    expect([score.han, score.fu]).toEqual([2, 30]);
    expect(payments(score.base, true).ron).toBe(2900);
  });

  it("T8 累计役满", () => {
    const used = new Set<Tile>();
    const dora = parseTiles("1p", used);
    const ura = parseTiles("8p", used);
    const input: RiichiHandInput = { ...hand("123p 456p 789p 23p 11p", "4p", { tsumo: true, riichi: "riichi" }), doraIndicators: dora, uraIndicators: ura };
    // hand() 用了自己的 used，指示牌换成不冲突的那几张
    const score = scoreRiichiHand(input)!;
    expect(score.han).toBeGreaterThanOrEqual(13);
    expect(score.limit).toBe("累计役满");
    const pay = payments(score.base, false);
    expect([pay.dealerPays, pay.nonDealerPays]).toEqual([16000, 8000]);
  });

  it("T9 四暗刻单骑双倍役满", () => {
    const score = scoreRiichiHand(hand("111m 333p 555s 777s 9m", "9m", { tsumo: true, seatWind: 2 }))!;
    expect(score.yakuman).toBe(2);
    const pay = payments(score.base, false);
    expect([pay.dealerPays, pay.nonDealerPays]).toEqual([32000, 16000]);
  });

  it("没有役不能和；四暗刻双碰荣和只是三暗刻对对和", () => {
    expect(scoreRiichiHand(hand("234m 567m 79p 345s 11s", "8p", {}))).toBeNull();
    expect(yakuNames(hand("234m 567m 78p 345s 66s", "9p", {}))).toEqual(["平和"]);
    const shanpon = scoreRiichiHand(hand("111m 333p 555s 77s 99m", "7s", {}))!;
    expect(shanpon.yakuman).toBe(0);
    expect(shanpon.yaku.map((item) => item.name)).toEqual(expect.arrayContaining(["三暗刻", "对对和"]));
  });

  it("国士十三面、九莲、大三元、一杯口、混全", () => {
    expect(scoreRiichiHand(hand("19m 19p 19s 1234567z", "1m", {}))!.yakuman).toBe(2);
    expect(scoreRiichiHand(hand("1112345678999m", "5m", {}))!.yaku[0]!.name).toBe("纯正九莲宝灯");
    expect(scoreRiichiHand(hand("555z 666z 777z 23m 99p", "1m", {}))!.yaku.map((item) => item.name)).toContain("大三元");
    expect(yakuNames(hand("112233m 456p 789s 5p", "5p", { riichi: "riichi" }))).toEqual(expect.arrayContaining(["一杯口"]));
    expect(yakuNames(hand("123m 789p 111z 999s 7z", "7z", {}))).toContain("混全带幺九");
  });

  it("听牌（只看牌型），自己有 4 张的不算", () => {
    expect(riichiWaits(parseTiles("234m 567m 78p 345s 66s"), []).map((kind) => kind)).toEqual(parseKinds("6p 9p"));
    expect(riichiWaits(parseTiles("1111m 234p 567p 789s"), [])).toEqual([]);
  });
});
