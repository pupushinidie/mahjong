/**
 * 麻将的新手教程：四川、立直各一份剧本（packages/game/src/tutorial.ts），在浏览器里按剧本走，
 * 牌桌就是真正对局的 GameBoard / RiichiBoard，咕噜嘎的对话框叠在上面；剧本走完开一局练习局，另外三个座位交给人机。
 * 不连服务器，不占房间；首页、等候房间都能进来（从等候房间进来时，房主开局会自动回到牌桌，见 App.tsx）。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createPracticeGame,
  createTutorialGame,
  DEFAULT_ROOM_ACCESS,
  redactGameForViewer,
  sameCommand,
  TUTORIAL_SELF,
  tutorialActor,
  tutorialApply,
  tutorialBot,
  tutorialCanAct,
  tutorialSteps,
  type GameCommand,
  type GameOptions,
  type GameState,
  type LobbyMember,
  type LobbyRoomSnapshot,
  type TutorialCommand,
  type TutorialStep,
  type TutorialVariant,
} from "@mahjong/game";
import GameBoard from "./GameBoard.js";
import RiichiBoard from "./RiichiBoard.js";
import { Coach, isTouchDevice, StepPips, type CoachView } from "./tutorial/Coach.js";
import { writeTutorial } from "./tutorial/storage.js";
import type { Theme } from "./theme.js";
import { useTutorial } from "./tutorial/useTutorial.js";
import { gameIdOf } from "./tutorialGame.js";

const SELF_MEMBER = "tutorial-self";
const TUTORIAL_CODE = "GULU01";
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

function optionsOf(game: GameState): GameOptions {
  if (game.variant === "riichi") return { variant: "riichi", length: game.config.length, aka: game.config.aka, kuitan: game.config.kuitan };
  return { variant: "sichuan", mode: game.config.mode, swap: game.config.swap, cap: game.config.cap, zimo: game.config.zimo, hands: game.config.hands };
}

export default function TutorialMode({ variant, name, brand, themeToggle, theme, waitingRoom, onExit }: {
  variant: TutorialVariant;
  /** 首页填过的昵称；没填叫「新玩家」。 */
  name: string;
  brand: ReactNode;
  themeToggle: ReactNode;
  theme: Theme;
  /** 从等候房间点进来的：那个房间的房间码。 */
  waitingRoom?: string | undefined;
  onExit: () => void;
}) {
  const selfName = name.trim().length >= 2 ? name.trim() : "新玩家";
  const steps = tutorialSteps(variant);
  const gameId = gameIdOf(variant);
  const [selection, setSelection] = useState("");

  const tutorial = useTutorial<GameState, TutorialCommand, TutorialStep>({
    steps,
    self: TUTORIAL_SELF,
    start: () => createTutorialGame(variant, selfName),
    restart: () => createPracticeGame(variant, selfName, randomSeed()),
    apply: tutorialApply,
    same: sameCommand,
    actor: tutorialActor,
    canAct: tutorialCanAct,
    // "__resolve"：抢牌窗口所有人都回应完了，交给 tutorialApply 结算（命令本身不看）
    bot: (state, playerId) => (playerId === "__resolve" ? { type: "READY" } : tutorialBot(state, playerId)),
    botDelay: (state) => (state.stage === "turn" ? 850 : state.stage === "claim" ? 650 : 500),
    watchDelay: (command) => (command.type === "FAST_FORWARD" ? 1800 : command.type === "TSUMO" ? 1600 : 1250),
  });
  const { game, step, index, practice, flash } = tutorial;
  // 每开一局练习局，牌桌重新挂载（动作记录、特效从头来）
  const [table, setTable] = useState(0);
  const newPractice = () => {
    setTable((value) => value + 1);
    tutorial.newPractice();
  };

  // 走到最后一步就算学完（之后首页不再邀请）
  useEffect(() => {
    if (practice || (step?.kind === "info" && step.finale)) writeTutorial(gameId, "done");
  }, [practice, step?.id]);

  function leave() {
    writeTutorial(gameId, "skipped");
    onExit();
  }

  const members = useMemo<LobbyMember[]>(() => [{ id: SELF_MEMBER, playerId: TUTORIAL_SELF, name: selfName, isHost: false, connected: true }], [selfName]);
  const room = useMemo<LobbyRoomSnapshot>(() => ({
    code: TUTORIAL_CODE,
    variant: game.variant,
    options: optionsOf(game),
    spectators: [],
    access: DEFAULT_ROOM_ACCESS,
    status: "playing",
    members,
    chat: [],
    voice: [],
    game: redactGameForViewer(game, TUTORIAL_SELF),
  }), [game, members]);

  let view: CoachView | null = null;
  if (step) {
    const note = isTouchDevice() && step.noteTouch ? step.noteTouch : step.note;
    const finale = step.kind === "info" && step.finale === true;
    // 先选再确认：选对了，高亮就挪到下一个要点的地方
    let anchor = step.anchor ?? null;
    if (step.kind === "do" && step.then) {
      for (const follow of step.then) if (selection === follow.sel) anchor = follow.anchor;
    }
    view = {
      key: `${step.id}:${anchor ?? ""}`,
      say: step.say,
      ...(note ? { note } : {}),
      ...(flash ? { flash } : {}),
      anchor,
      focus: step.kind !== "watch",
      face: flash ? "surprised" : step.face ?? "base",
      footer: (
        <>
          <StepPips index={index} total={steps.length} />
          {!finale && <button className="tut-link" type="button" onClick={leave}>跳过教程</button>}
        </>
      ),
      actions: step.kind !== "info" ? null : finale ? (
        <>
          <button className="quiet-button" type="button" onClick={onExit}>结束教程</button>
          <button className="primary-button tut-main" type="button" onClick={newPractice}>开一局练习</button>
        </>
      ) : (
        <button className="primary-button tut-main" type="button" onClick={tutorial.next}>下一步 ▶</button>
      ),
    };
  }

  const Board = variant === "riichi" ? RiichiBoard : GameBoard;
  return (
    <div className={practice ? "tut-practice" : "tut-script"} style={{ display: "contents" }}>
      <Board
        key={table}
        room={room}
        busy={false}
        error=""
        notice=""
        brand={brand}
        connection={
          <>
            <span className="connection-status online"><span className="connection-dot" />{practice ? "练习局" : "新手教程"}</span>
            <button className="quiet-button" type="button" onClick={practice ? onExit : leave}>退出教程</button>
          </>
        }
        theme={theme}
        themeToggle={themeToggle}
        chat={null}
        onCommand={(command: GameCommand) => tutorial.onCommand(command)}
        onRematch={() => undefined}
        onDissolve={() => undefined}
        watchId={TUTORIAL_SELF}
        onWatch={() => undefined}
        onLeave={onExit}
        selfMemberId={SELF_MEMBER}
        mode={practice ? "practice" : "tutorial"}
        onSelection={setSelection}
        sidePanel={<Checklist steps={steps} index={index} practice={practice} waitingRoom={waitingRoom} variant={variant} />}
        {...(practice
          ? {
              finalActions: (
                <>
                  <button className="quiet-button" type="button" onClick={onExit}>结束教程</button>
                  <button className="primary-button" type="button" onClick={newPractice}>再练一局</button>
                </>
              ),
            }
          : {})}
      />
      {view && <Coach view={view} />}
    </div>
  );
}

/** 侧栏：剧本进行中列出这次学哪几样；练习局只留一句话。 */
function Checklist({ steps, index, practice, waitingRoom, variant }: { steps: readonly TutorialStep[]; index: number; practice: boolean; waitingRoom: string | undefined; variant: TutorialVariant }) {
  const lessons = steps.map((step, at) => ({ step, at })).filter(({ step }) => step.lesson);
  const done = lessons.filter(({ at }) => at < index).length;
  return (
    <section className="mj-panel tut-checklist" aria-label="新手教程进度">
      {practice ? (
        <>
          <h3>练习局 <small>{variant === "riichi" ? "东风战" : "一盘"}</small></h3>
          <p>拿不准就点「问咕噜嘎」（键盘 T），我告诉你我会怎么打、为什么。</p>
        </>
      ) : (
        <>
          <h3>{variant === "riichi" ? "立直麻将" : "四川麻将"}教程 <small>{done}/{lessons.length}</small></h3>
          <ul>
            {lessons.map(({ step, at }) => {
              const nextLesson = lessons.find((item) => item.at > at)?.at ?? steps.length;
              const state = index >= nextLesson ? "done" : index >= at ? "now" : "";
              return (
                <li key={step.id} className={state}>
                  <i aria-hidden="true">{state === "done" ? "✓" : state === "now" ? "▶" : "·"}</i>
                  {step.lesson}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {waitingRoom && <p>你还在房间 {waitingRoom} 里，房主一开局就自动回到牌桌。</p>}
    </section>
  );
}
