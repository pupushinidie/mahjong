import { describe, expect, it } from "vitest";
import { legalCommands } from "./engine.js";
import { createRng } from "./rng.js";
import { kindOf, SUIT_NAMES } from "./tiles.js";
import {
  anchorVisible,
  createPracticeGame,
  createTutorialGame,
  RIICHI_STEPS,
  sameCommand,
  SICHUAN_STEPS,
  TUTORIAL_SELF,
  tutorialActor,
  tutorialApply,
  tutorialBot,
  tutorialSteps,
  type TutorialStep,
  type TutorialVariant,
} from "./tutorial.js";
import type { GameState, RiichiState, SichuanState } from "./types.js";

/** 按剧本从头走：每走完一步回调一次（给关键几幕检查用）。 */
function walk(variant: TutorialVariant, onStep?: (step: TutorialStep, state: GameState) => void): GameState {
  let state = createTutorialGame(variant, "小明");
  for (const step of tutorialSteps(variant)) {
    if (step.anchor && step.kind !== "watch") expect(anchorVisible(state, step.anchor), `${step.id} 的锚点 ${step.anchor}`).toBe(true);
    if (step.kind === "do") {
      const legal = legalCommands(state, TUTORIAL_SELF);
      // 换三张的合法列表只给默认选择，剧本就是按默认选择写的
      expect(legal.some((command) => sameCommand(command, step.expect)), `${step.id} 的操作应该合法`).toBe(true);
      for (const follow of step.then ?? []) expect(anchorVisible(state, follow.anchor), `${step.id} 之后的锚点 ${follow.anchor}`).toBe(true);
      state = tutorialApply(state, TUTORIAL_SELF, step.expect);
    } else if (step.kind === "watch") {
      for (const move of step.moves) {
        const actor = tutorialActor(state);
        expect(actor, `${step.id} 时应该轮到咕噜`).not.toBe(TUTORIAL_SELF);
        expect(actor).not.toBeNull();
        state = tutorialApply(state, actor!, move);
      }
      if (step.anchor) expect(anchorVisible(state, step.anchor), `${step.id} 的锚点 ${step.anchor}`).toBe(true);
    }
    // 剧本里除了 do 步骤，不应该停在要你做决定的地方以外的人机决定上
    onStep?.(step, state);
  }
  return state;
}

const tilesOf = (state: GameState) => {
  if (state.variant === "sichuan") {
    return [
      ...state.wall!,
      ...state.players.flatMap((player) => [...player.hand, ...player.melds.flatMap((meld) => meld.tiles), ...player.discards.filter((entry) => !entry.taken).map((entry) => entry.tile), ...player.wins.map((win) => win.tile)]),
    ];
  }
  const placed = [
    ...state.wall!,
    ...state.dead!,
    ...state.players.flatMap((player) => [...player.hand, ...player.melds.flatMap((meld) => meld.tiles), ...player.river.filter((entry) => !entry.taken).map((entry) => entry.tile)]),
  ];
  // 荣和的那张：牌河里标成被拿走，也不在手牌里
  const won = (state.result?.wins ?? []).map((win) => win.tile).filter((tile) => !placed.includes(tile));
  return [...placed, ...won];
};

describe("新手教程剧本", () => {
  for (const variant of ["sichuan", "riichi"] as const) {
    it(`${variant}：id 不重复，只有最后一步是 finale，每句话都不空、不太长`, () => {
      const steps = tutorialSteps(variant);
      expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
      const finales = steps.filter((step) => step.kind === "info" && step.finale);
      expect(finales).toHaveLength(1);
      expect(steps.at(-1)).toBe(finales[0]);
      for (const step of steps) {
        expect(step.say.trim().length, step.id).toBeGreaterThan(0);
        expect(step.say.length, `${step.id} 的主句太长`).toBeLessThanOrEqual(44);
        expect((step.note ?? "").length, `${step.id} 的补充太长`).toBeLessThanOrEqual(64);
      }
      // 主线控制在 10 分钟内：30 步左右，课程不超过 10 个（侧栏放得下）
      expect(steps.length).toBeLessThanOrEqual(31);
      expect(steps.filter((step) => step.lesson).length).toBeLessThanOrEqual(10);
    });
  }

  it("四川：从头走到尾，每一步都合法、牌一张不少", () => {
    const end = walk("sichuan", (step, state) => {
      const all = tilesOf(state);
      expect(all.length, step.id).toBe(108);
      expect(new Set(all).size, step.id).toBe(108);
    }) as SichuanState;
    expect(end.stage).toBe("handEnd");
  });

  it("四川关键几幕：换给对家、碰 8 筒、暗杠收 6、咕噜二号自摸下桌、你点炮胡 3 番、花猪和查大叫", () => {
    walk("sichuan", (step, raw) => {
      const state = raw as SichuanState;
      const me = state.players[0]!;
      if (step.id === "sc-swap-do") {
        expect(state.swapDirection).toBe("across");
        expect(me.hand.filter((tile) => kindOf(tile) === 10)).toHaveLength(3);
        expect(state.stage).toBe("void");
      }
      if (step.id === "sc-void-do") {
        expect(state.players.map((player) => player.void)).toEqual(["m", "m", "s", "p"]);
        expect(state.stage).toBe("turn");
        expect(state.turn).toBe(0);
      }
      if (step.id === "sc-watch-1") {
        expect(state.stage).toBe("claim");
        expect(state.claim!.options).toEqual({ 0: ["pung"] });
      }
      if (step.id === "sc-kong") expect(me.handDelta).toBe(6);
      if (step.id === "sc-watch-3") {
        expect(state.players[2]!.out).toBe(true);
        expect(state.players[2]!.wins[0]!.how).toBe("zimo");
        expect(me.handDelta).toBe(4);
      }
      if (step.id === "sc-watch-4") {
        expect(Object.keys(state.claim!.options)).toEqual(["0"]);
        expect(state.claim!.options[0]).toContain("hu");
      }
      if (step.id === "sc-hu") {
        const win = me.wins[0]!;
        expect(win.items.map((item) => item.name)).toEqual(["对对胡", "断幺九", "根"]);
        expect(win.counted).toBe(3);
        expect(win.points).toBe(8);
        expect(win.payers).toEqual([3]);
        expect(me.out).toBe(true);
      }
      if (step.id === "sc-ff") {
        const summary = state.summary!;
        expect(summary.reason).toBe("exhausted");
        const status = new Map(summary.status.map((item) => [item.seat, item]));
        expect(status.get(3)!.pig).toBe(true);
        expect(status.get(1)!.ting).toBe(true);
        expect(status.get(1)!.maxFan).toBe(2);
        expect(summary.lines.map((line) => line.kind)).toEqual(expect.arrayContaining(["pig", "noTing"]));
        expect(summary.deltas[0]).toBe(12);
        expect(summary.deltas.reduce((a, b) => a + b, 0)).toBe(0);
      }
    });
  });

  it("立直：从头走到尾，每一步都合法、牌一张不少", () => {
    const end = walk("riichi", (step, state) => {
      const all = tilesOf(state);
      expect(all.length, step.id).toBe(136);
      expect(new Set(all).size, step.id).toBe(136);
    }) as RiichiState;
    expect(end.stage).toBe("handEnd");
  });

  it("立直关键几幕：吃红 5 万、碰中、荣和 3900；第二局立直振听、3 索不能荣和、一发自摸满贯", () => {
    walk("riichi", (step, raw) => {
      const state = raw as RiichiState;
      const me = state.players[0]!;
      if (step.id === "rc-watch-1") expect(state.claim!.options).toEqual({ 0: ["chi"] });
      if (step.id === "rc-watch-2") expect(state.claim!.options).toEqual({ 0: ["pon"] });
      if (step.id === "rc-watch-3") expect(state.claim!.options).toEqual({ 0: ["ron"] });
      if (step.id === "rc-ron") {
        const win = state.result!.wins[0]!;
        expect(win.yaku.map((item) => item.name)).toEqual(expect.arrayContaining(["宝牌", "赤宝牌"]));
        expect(win.han).toBe(3);
        expect(win.fu).toBe(30);
        expect(win.points).toBe(3900);
        expect(win.from).toBe(1);
      }
      if (step.id === "rc-next") {
        expect(state.handNo).toBe(2);
        expect(state.dealer).toBe(0);
        expect(state.turn).toBe(0);
        expect(me.hand).toHaveLength(14);
      }
      if (step.id === "rc-riichi") {
        expect(me.riichi).not.toBeNull();
        expect(me.furiten.discard).toBe(true);
        expect(state.kyoutaku).toBe(1000);
      }
      if (step.id === "rc-watch-4") {
        // 咕噜二号打的 3 索：你振听，没有荣和的选项（窗口已经结算，轮到咕噜三号）
        expect(state.players[2]!.river.at(-1)!.tile >> 2).toBe(20);
        expect(state.stage).toBe("turn");
        expect(state.turn).toBe(3);
      }
      if (step.id === "rc-tsumo") {
        const win = state.result!.wins[0]!;
        expect(win.how).toBe("tsumo");
        expect(win.han).toBe(5);
        expect(win.limit).toBe("满贯");
        expect(win.points).toBe(12000);
        expect(win.uraIndicators).toHaveLength(1);
        expect(win.yaku.map((item) => item.name)).toEqual(expect.arrayContaining(["立直", "一发", "平和"]));
      }
    });
  });

  it("剧本随机：四川换三张一定是给对家（剧本写死），练习局按种子随机", () => {
    const script = createTutorialGame("sichuan") as SichuanState;
    expect(script.players.map((player) => player.id)).toEqual([TUTORIAL_SELF, "g1", "g2", "g3"]);
    const directions = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) {
      let state = createPracticeGame("sichuan", "小明", seed) as SichuanState;
      for (const player of state.players) state = tutorialApply(state, player.id, legalCommands(state, player.id)[0]!) as SichuanState;
      directions.add(state.swapDirection!);
    }
    expect(directions.size).toBe(3);
    expect(Object.keys(SUIT_NAMES)).toHaveLength(3);
  });

  for (const [variant, games] of [["sichuan", 100], ["riichi", 16]] as const) {
    it(`${variant}：剧本走完接练习局，全部交给人机，${games} 局都能打完`, () => {
      // 剧本本身走完能接（finale 停在结算画面）
      expect(walk(variant).stage).toBe("handEnd");
      const stuck: number[] = [];
      const rng = createRng(99);
      for (let game = 0; game < games; game += 1) {
        let state = createPracticeGame(variant, "小明", rng.int(2 ** 30));
        let guard = 0;
        while (state.phase !== "finished" && guard < 6000) {
          guard += 1;
          const actor = tutorialActor(state);
          if (!actor) break;
          const command = actor === "__resolve" ? { type: "READY" as const } : tutorialBot(state, actor);
          if (!command) break;
          state = tutorialApply(state, actor, command);
        }
        if (state.phase !== "finished") stuck.push(game);
      }
      expect(stuck).toEqual([]);
    }, 120000);
  }
});

// 两份剧本别串：四川的步骤 id 都是 sc-，立直的都是 rc-
describe("两份剧本互不相干", () => {
  it("步骤 id 前缀分开", () => {
    expect(SICHUAN_STEPS.every((step) => step.id.startsWith("sc-"))).toBe(true);
    expect(RIICHI_STEPS.every((step) => step.id.startsWith("rc-"))).toBe(true);
  });
});
