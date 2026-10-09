import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  canTsumo,
  discardable,
  fewestSuit,
  kindOf,
  kongOptions,
  pickSwapTiles,
  sortTiles,
  suitOfTile,
  SUIT_NAMES,
  SUITS,
  tingInfo,
  type ClaimAction,
  type GameCommand,
  type SichuanEvent as GameEvent,
  type SichuanState as GameState,
  type LobbyRoomSnapshot,
  type Meld,
  type SichuanPlayer,
  type SichuanState,
  type Suit,
  type Tile,
} from "@mahjong/game";
import { art, coverSize, seatColor } from "./art.js";
import { useConfirm } from "./confirm.js";
import GameRules from "./GameRules.js";
import { GameRoomMenu, SpectateBar } from "./RoomExtras.js";
import { socket } from "./socket.js";
import { BAND, MOBILE_OPP_ROW, PLATE_W, useCountdown, useLayout } from "./table.js";
import { kindLabel, ROW_PITCH, TILE_H, TILE_W, tileLabel, TileView } from "./tiles.js";
import type { Theme } from "./theme.js";

interface GameBoardProps {
  readonly room: LobbyRoomSnapshot;
  readonly busy: boolean;
  readonly error: string;
  readonly notice: string;
  readonly brand: ReactNode;
  readonly connection: ReactNode;
  readonly theme: Theme;
  readonly themeToggle: ReactNode;
  readonly chat: ReactNode;
  readonly onCommand: (command: GameCommand) => void;
  readonly onRematch: (accept: boolean) => void;
  readonly onDissolve: () => void;
  readonly watchId: string;
  readonly onWatch: (playerId: string) => void;
  readonly onLeave: () => void;
}

const SUIT_COLOR: Record<Suit, string> = { m: "#e0585e", p: "#4f8fe8", s: "#3fb46a" };
const DIRECTION_TEXT = { next: "给下家", prev: "给上家", across: "给对家" } as const;
const KONG_TEXT = { kong: "明杠", addedKong: "加杠", concealedKong: "暗杠" } as const;
const ACTION_TEXT: Record<ClaimAction | "pass", string> = { hu: "胡", kong: "杠", pung: "碰", pass: "过" };
/** 座位相对自己的位置：0 自己（下）、1 下家（右）、2 对家（上）、3 上家（左）。 */
type Rel = 0 | 1 | 2 | 3;
const REL_CLASS = ["me", "right", "top", "left"] as const;

// ---------------------------------------------------------------------------
// 文案

function describeEvent(event: GameEvent, game: GameState, name: (seat: number) => string): string | null {
  switch (event.type) {
    case "HandStarted":
      return `第 ${event.handNo} 盘开始，${name(event.dealer)}坐庄`;
    case "Swapped":
      return `换三张：${DIRECTION_TEXT[event.direction]}`;
    case "VoidsRevealed":
      return `定缺：${event.voids.map((suit, seat) => `${name(seat)}缺${suit ? SUIT_NAMES[suit] : "?"}`).join("，")}`;
    case "Discarded":
      return `${name(event.seat)} 打出 ${tileLabel(event.tile)}`;
    case "Pung":
      return `${name(event.seat)} 碰 ${tileLabel(event.tile)}`;
    case "Kong":
      return `${name(event.seat)} ${KONG_TEXT[event.kongType]}${event.tile >= 0 ? ` ${tileLabel(event.tile)}` : ""}，收 ${event.gain} 分`;
    case "KongRobbed":
      return `${name(event.seat)} 加杠的 ${tileLabel(event.tile)} 被抢杠`;
    case "Hu": {
      const win = event.win;
      const how = win.how === "zimo" ? "自摸" : win.how === "robKong" ? "抢杠胡" : `胡 ${name(win.from!)} 的`;
      return `${name(event.seat)} ${how} ${tileLabel(win.tile)}：${win.title} ${win.counted} 番，${win.payers.length > 1 ? `每家付 ${win.points}` : `${name(win.payers[0]!)}付 ${win.points}`}`;
    }
    case "Transfer":
      return `呼叫转移：${name(event.from)} 的杠分 ${event.amount} 转给 ${name(event.to)}`;
    case "HandEnded":
      return `第 ${event.handNo} 盘结束（${event.summary.reason === "exhausted" ? "牌摸完了" : "三家胡牌"}）`;
    case "TimedOut":
      return `${name(event.seat)} 超时，自动处理`;
    case "AutoChanged":
      return `${name(event.seat)} ${event.on ? "托管了" : "取消托管"}`;
    case "GameEnded":
      return `对局结束（共 ${game.config.hands} 盘）`;
    case "Drew":
      return null;
  }
}

interface Fx {
  readonly key: string;
  readonly seat: number;
  readonly text: string;
  readonly kind: "pung" | "kong" | "hu" | "zimo";
}

function fxFrom(events: readonly GameEvent[], version: number): Fx[] {
  const list: Fx[] = [];
  events.forEach((event, index) => {
    const key = `${version}-${index}`;
    if (event.type === "Pung") list.push({ key, seat: event.seat, text: "碰", kind: "pung" });
    if (event.type === "Kong") list.push({ key, seat: event.seat, text: event.kongType === "concealedKong" ? "下雨" : "刮风", kind: "kong" });
    if (event.type === "Hu") list.push({ key, seat: event.seat, text: event.win.how === "zimo" ? "自摸" : event.win.how === "robKong" ? "抢杠" : "胡", kind: event.win.how === "zimo" ? "zimo" : "hu" });
  });
  return list;
}

/** 自己看得到的每种牌已经出现了几张（手牌、牌河、亮出的面子、胡的牌、亮出的手牌）。 */
function seenCounts(game: GameState, mySeat: number): number[] {
  const seen = new Array<number>(34).fill(0);
  const add = (tile: Tile) => { if (tile >= 0) seen[kindOf(tile)]! += 1; };
  game.players.forEach((player, seat) => {
    if (seat === mySeat || player.wins.length > 0) player.hand.forEach(add);
    player.discards.forEach((entry) => { if (!entry.taken) add(entry.tile); });
    player.melds.forEach((meld) => meld.tiles.forEach(add));
    player.wins.forEach((win) => add(win.tile));
  });
  return seen;
}

// ---------------------------------------------------------------------------

function GameBoard({ room, busy, error, notice, brand, connection, theme, themeToggle, chat, onCommand, onRematch, onDissolve, watchId, onWatch, onLeave }: GameBoardProps) {
  const game = room.game as SichuanState;
  const member = room.members.find((candidate) => candidate.id === socket.id);
  const spectating = !member;
  const myId = member?.playerId ?? watchId;
  const mySeat = Math.max(0, game.players.findIndex((player) => player.id === myId));
  const me = game.players[mySeat]!;
  const isHost = member?.isHost ?? false;
  const playing = game.phase === "playing";
  const stage = game.stage;
  const secondsLeft = useCountdown(room);
  const [confirm, confirmDialog] = useConfirm();
  const relOf = (seat: number) => ((seat - mySeat + 4) % 4) as Rel;
  const seatAt = (rel: number) => (mySeat + rel) % 4;
  const nameOf = (seat: number) => (seat === mySeat && !spectating ? "你" : game.players[seat]?.name ?? "?");
  const online = (player: SichuanPlayer) => player.bot || (room.members.find((candidate) => candidate.playerId === player.id)?.connected ?? false);
  const send = (command: GameCommand) => { if (!busy) onCommand(command); };
  const firstVersion = useRef(game.version);
  const shownNotice = game.version === firstVersion.current ? notice : "";
  const [tableRef, layout, tableBox] = useLayout();
  const { s, hs } = layout;

  const myMove = !spectating && playing && stage === "turn" && game.turn === mySeat;
  const myClaim = !spectating && playing && stage === "claim" && game.claim?.options[mySeat] && game.claim.responses[mySeat] === undefined ? game.claim.options[mySeat]! : null;
  const tsumoOk = myMove && canTsumo(game, mySeat);
  const kongs = myMove ? kongOptions(game, mySeat) : [];
  const discards = myMove ? discardable(game, mySeat) : [];

  // ---------- 换三张、定缺 ----------
  const [swapPick, setSwapPick] = useState<Tile[]>([]);
  useEffect(() => {
    if (stage === "swap" && !me.swapChosen && !spectating) setSwapPick(pickSwapTiles(me.hand));
    else setSwapPick([]);
  }, [game.handNo, stage, me.swapChosen]);
  const toggleSwap = (tile: Tile) => {
    setSwapPick((current) => {
      if (current.includes(tile)) return current.filter((other) => other !== tile);
      const sameSuit = current.filter((other) => suitOfTile(other) === suitOfTile(tile));
      return [...sameSuit, tile].slice(-3);
    });
  };
  const suggestVoid = useMemo(() => fewestSuit(me.hand), [game.version]);

  // ---------- 听牌提示 ----------
  const seen = useMemo(() => seenCounts(game, mySeat), [game.version, mySeat]);
  const left = (kind: number) => Math.max(0, 4 - seen[kind]!);
  const thirteen = useMemo(() => {
    if (me.hand.length % 3 !== 1) return null;
    return tingInfo(me.hand, me.melds, me.void, game.config);
  }, [game.version, mySeat]);
  /** 打出每种牌以后听什么（轮到自己打牌时，悬停预览）。 */
  const discardTing = useMemo(() => {
    const map = new Map<number, ReturnType<typeof tingInfo>>();
    if (!myMove) return map;
    for (const tile of discards) {
      const kind = kindOf(tile);
      if (map.has(kind)) continue;
      const rest = [...me.hand];
      rest.splice(rest.indexOf(tile), 1);
      map.set(kind, tingInfo(rest, me.melds, me.void, game.config));
    }
    return map;
  }, [game.version, myMove]);
  const [hoverTile, setHoverTile] = useState<Tile | null>(null);
  // 出牌分两步：点一下只是选中（抬起来、显示打这张听什么），再点一次或点「打出」才打出去，免得点错。
  const [selected, setSelected] = useState<Tile | null>(null);
  // 定缺也先选一门，再点「确定」。
  const [voidPick, setVoidPick] = useState<Suit | null>(null);
  useEffect(() => {
    setHoverTile(null);
    setSelected(null);
  }, [game.version]);
  useEffect(() => setVoidPick(null), [game.handNo, stage]);
  const previewTile = selected ?? hoverTile;
  const hoverTing = previewTile !== null ? discardTing.get(kindOf(previewTile)) : undefined;

  // ---------- 动画：只在 version 变的时候 ----------
  const fx = useMemo(() => (game.version === firstVersion.current ? [] : fxFrom(game.events, game.version)), [game.version]);
  const [activeFx, setActiveFx] = useState<Fx[]>([]);
  useEffect(() => {
    if (fx.length === 0) return;
    setActiveFx(fx);
    const timer = window.setTimeout(() => setActiveFx([]), 1500);
    return () => window.clearTimeout(timer);
  }, [fx]);
  const [banner, setBanner] = useState<string | null>(null);
  useEffect(() => {
    if (game.version === firstVersion.current) return;
    const swapped = game.events.find((event) => event.type === "Swapped");
    const voids = game.events.find((event) => event.type === "VoidsRevealed");
    const text = swapped?.type === "Swapped" ? `换三张：${DIRECTION_TEXT[swapped.direction]}` : voids ? "定缺完成，开始打牌" : null;
    if (!text) return;
    setBanner(text);
    const timer = window.setTimeout(() => setBanner(null), 2200);
    return () => window.clearTimeout(timer);
  }, [game.version]);
  const freshIn = useMemo(() => new Set(game.version !== firstVersion.current && game.events.some((event) => event.type === "Swapped") ? me.swapIn : []), [game.version]);

  // ---------- 操作 ----------
  async function respond(action: ClaimAction | "pass") {
    if (action === "pass" && myClaim?.includes("hu")) {
      const ok = await confirm({ title: "确定不胡？", detail: "放过这张以后，到你下次摸牌之前都不能胡别人打的牌。", confirmLabel: "不胡，过" });
      if (!ok) return;
    }
    send({ type: "CLAIM", action });
  }
  const discardTile = (tile: Tile) => { if (discards.includes(tile)) send({ type: "DISCARD", tile }); };
  /** 点手里的牌：没选中就选中，点已经选中的那张才打出去。 */
  const clickDiscard = (tile: Tile) => {
    if (selected === tile) discardTile(tile);
    else setSelected(tile);
  };

  // 键盘：H 胡/自摸，P 碰，G 杠，Esc 过，N 下一盘
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (myClaim) {
        if (key === "h" && myClaim.includes("hu")) void respond("hu");
        else if (key === "p" && myClaim.includes("pung")) void respond("pung");
        else if (key === "g" && myClaim.includes("kong")) void respond("kong");
        else if (key === "escape") void respond("pass");
      } else if (myMove) {
        if (key === "h" && tsumoOk) send({ type: "TSUMO" });
        else if (key === "g" && kongs.length === 1) send({ type: "KONG", tile: kongs[0]!.tile });
        else if ((key === " " || key === "enter") && selected !== null) {
          event.preventDefault();
          discardTile(selected);
        } else if (key === "escape") setSelected(null);
      } else if (stage === "handEnd" && playing && !spectating && key === "n" && !game.ready.includes(myId)) {
        send({ type: "READY" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 在后台时标题提示轮到你
  const needMe = !spectating && playing && (myMove || Boolean(myClaim) || (stage === "swap" && !me.swapChosen) || (stage === "void" && !me.voidChosen));
  useEffect(() => {
    const base = "四川麻将 · 在线对战";
    const update = () => { document.title = needMe && document.hidden ? `【轮到你】${base}` : base; };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      document.title = base;
    };
  }, [needMe, game.version]);

  // ---------- 动作记录 ----------
  const log = useMemo(() => {
    const lines: { key: string; text: string }[] = [];
    game.history.forEach((event, index) => {
      const text = describeEvent(event, game, nameOf);
      if (text) lines.push({ key: `${game.version}-${index}`, text });
    });
    return lines.reverse();
  }, [game.version]);
  const [sideTab, setSideTab] = useState<"log" | "chat">("log");
  const [chatSeen, setChatSeen] = useState(room.chat.length);
  useEffect(() => { if (sideTab === "chat") setChatSeen(room.chat.length); }, [sideTab, room.chat.length]);
  const unread = sideTab === "chat" ? 0 : Math.max(0, room.chat.length - chatSeen);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [hideSummary, setHideSummary] = useState(false);
  useEffect(() => setHideSummary(false), [game.handNo, stage]);

  // ---------- 现在该谁做什么 ----------
  let headline = "";
  let detail = "";
  const waitingFor = (list: number[]) => list.map((seat) => nameOf(seat)).join("、");
  if (game.phase === "finished") headline = "对局结束";
  else if (stage === "swap") {
    const pending = game.players.map((_, seat) => seat).filter((seat) => !game.players[seat]!.swapChosen);
    headline = spectating || me.swapChosen ? "换三张：等其他人" : "换三张：选 3 张同一门的牌";
    detail = spectating || me.swapChosen ? `还在选：${waitingFor(pending)}` : "选好以后大家同时交换，方向随机（给下家、上家或对家）。";
  } else if (stage === "void") {
    const pending = game.players.map((_, seat) => seat).filter((seat) => !game.players[seat]!.voidChosen);
    headline = spectating || me.voidChosen ? "定缺：等其他人" : "定缺：选一门不要";
    detail = spectating || me.voidChosen ? `还在选：${waitingFor(pending)}` : "这一盘不能胡带这门牌的牌，手里有这门要先打掉。";
  } else if (stage === "turn") {
    if (myMove) {
      headline = game.turnMode === "claimed" ? "碰完了：打一张" : "轮到你：打一张";
      detail = me.void && me.hand.some((tile) => suitOfTile(tile) === me.void)
        ? `手里还有${SUIT_NAMES[me.void]}子（缺门），要先打掉。`
        : tsumoOk ? "可以自摸！" : "点一张牌选中，再点一次（或点「打出」）打出去。";
    } else {
      headline = `${nameOf(game.turn)} 出牌中`;
    }
  } else if (stage === "claim") {
    if (myClaim) {
      headline = myClaim.includes("hu") ? "可以胡这张！" : `要${myClaim.filter((action) => action !== "hu").map((action) => ACTION_TEXT[action]).join("还是")}吗？`;
      detail = `${nameOf(game.claim!.from)} ${game.claim!.kind === "robKong" ? "加杠" : "打出"}的 ${tileLabel(game.claim!.tile)}`;
    } else {
      headline = `${nameOf(game.claim!.from)} ${game.claim!.kind === "robKong" ? "加杠" : "打出"} ${tileLabel(game.claim!.tile)}`;
      detail = game.claim!.responses[mySeat] !== undefined ? `你选了「${ACTION_TEXT[game.claim!.responses[mySeat]!]}」，等结果` : "";
    }
  } else if (stage === "handEnd") {
    headline = `第 ${game.handNo} 盘结算`;
    detail = spectating ? `等玩家点「下一盘」（${game.ready.length}/4）` : game.ready.includes(myId) ? `等其他人（${game.ready.length}/4）` : "看完结算点「下一盘」";
  }

  // ---------- 牌河方阵的位置（见 mahjong.css 开头的说明） ----------
  const { c, d, w, field } = layout;
  const riverBoxH = (3 * ROW_PITCH + TILE_H) * s;
  const band = layout.mobile ? 36 : BAND;
  const topBand = band + 8 + (layout.mobile ? MOBILE_OPP_ROW : 0);
  const mineHeight = layout.mobile ? TILE_H * hs * 2 + 48 : TILE_H * hs + 64;
  const fieldLeft = Math.round((tableBox.width - field) / 2);
  const fieldTop = Math.round(topBand + Math.max(0, (tableBox.height - topBand - mineHeight - field) / 2));
  const riverRect = (rel: Rel) => {
    // 视觉上的矩形（旋转以后）：牌河从主人的左手边开始，越过方框的那一截伸进主人左手边的角。
    switch (rel) {
      case 0: return { x: d + c - w, y: d + c, vw: w, vh: riverBoxH, rot: 0 };
      case 1: return { x: d + c, y: d, vw: riverBoxH, vh: w, rot: -90 };
      // 对家的牌河从下往上排，第一排的牌身会伸出盒子底边，整体往上挪一个牌身的厚度
      case 2: return { x: d, y: d - riverBoxH - (TILE_H - ROW_PITCH) * s, vw: w, vh: riverBoxH, rot: 0 };
      case 3: return { x: d - riverBoxH, y: d + c - w, vw: riverBoxH, vh: w, rot: 90 };
    }
  };
  const lastDiscard = stage === "claim" && game.claim?.kind === "discard" ? game.claim : null;

  const riverNode = (seat: number) => {
    const rel = relOf(seat);
    const rect = riverRect(rel);
    const cx = rect.x + rect.vw / 2;
    const cy = rect.y + rect.vh / 2;
    const style: CSSProperties = { left: cx - w / 2, top: cy - riverBoxH / 2, width: w, height: riverBoxH, transform: rect.rot ? `rotate(${rect.rot}deg)` : undefined, "--s": s } as CSSProperties;
    const river = game.players[seat]!.discards;
    return (
      <div key={`river-${seat}`} className={`mj-river r${rel}`} style={style}>
        {river.map((entry, index) => {
          if (entry.taken) return null;
          const latest = lastDiscard?.from === seat && index === river.length - 1;
          return (
            <TileView
              key={index}
              tile={entry.tile}
              scale={s}
              className={[entry.taken ? "taken" : "", latest ? "latest" : ""].join(" ")}
              style={{ marginBottom: -(TILE_H - ROW_PITCH) * s }}
            />
          );
        })}
      </div>
    );
  };

  const meldNode = (meld: Meld, key: string, scale: number, seat: number) => {
    const from = meld.from !== undefined ? relOf(meld.from) : null;
    const relSeat = relOf(seat);
    // 拿来的那张横放：从上家拿放左边，对家中间，下家右边（按主人的视角）。
    const takenIndex = from === null ? -1 : (() => {
      const diff = (meld.from! - seat + 4) % 4;
      return diff === 3 ? 0 : diff === 2 ? 1 : 2;
    })();
    const tiles = meld.type === "addedKong" ? meld.tiles.slice(0, 3) : meld.tiles;
    return (
      <span key={key} className={`mj-meld ${meld.type}`} title={`${KONG_TEXT[meld.type as keyof typeof KONG_TEXT] ?? "碰"}`}>
        {tiles.map((tile, index) => (
          <span key={index} className="mj-meld-slot">
            <TileView tile={meld.type === "concealedKong" && (index === 0 || index === 3) && tile >= 0 && relSeat !== 0 ? -1 : tile} scale={scale} sideways={index === takenIndex} />
            {meld.type === "addedKong" && index === takenIndex && <TileView tile={meld.tiles[3]!} scale={scale} sideways className="stacked" />}
          </span>
        ))}
      </span>
    );
  };

  const plate = (seat: number) => {
    const player = game.players[seat]!;
    const rel = relOf(seat);
    const active = playing && ((stage === "turn" && game.turn === seat) || (stage === "claim" && game.claim?.from === seat));
    const chosen = stage === "swap" ? player.swapChosen : stage === "void" ? player.voidChosen : null;
    return (
      <div className={["mj-plate", `p${rel}`, active ? "active" : "", player.out ? "out" : ""].join(" ")} style={{ "--seat": seatColor(rel) } as CSSProperties}>
        <div className="mj-plate-top">
          <img className="mj-avatar" src={art.avatar(seat)} alt="" />
          <strong title={player.name}>{nameOf(seat)}{seat === mySeat && spectating ? "（观战视角）" : ""}</strong>
          <span className="mj-plate-tags">
            {seat === game.dealer && <em className="mj-dealer" title="庄家">庄</em>}
            {player.void && <em className="mj-void" style={{ "--suit": SUIT_COLOR[player.void] } as CSSProperties} title={`缺${SUIT_NAMES[player.void]}`}>缺{SUIT_NAMES[player.void]}</em>}
          </span>
        </div>
        <div className="mj-plate-bottom">
          <b className={player.handDelta > 0 ? "up" : player.handDelta < 0 ? "down" : ""}>{player.score}</b>
          {player.handDelta !== 0 && <small className={player.handDelta > 0 ? "up" : "down"}>{player.handDelta > 0 ? "+" : ""}{player.handDelta}</small>}
          {chosen !== null && <em className={chosen ? "mj-chip ok" : "mj-chip"}>{chosen ? "已选" : "选择中"}</em>}
          {player.bot && <em className="mj-chip">机器人</em>}
          {!player.bot && player.auto && <em className="mj-chip warn">托管</em>}
          {!online(player) && <em className="mj-chip bad">离线</em>}
          {player.out && <em className="mj-chip win">已胡</em>}
          {!player.out && player.wins.length > 0 && <em className="mj-chip win">胡 ×{player.wins.length}</em>}
        </div>
      </div>
    );
  };

  /** 胡的牌（血战下桌、血流可以好几张）。 */
  const winTiles = (seat: number, scale: number) => {
    const wins = game.players[seat]!.wins;
    if (wins.length === 0) return null;
    return (
      <span className="mj-wins" title={wins.map((win) => `${win.title} ${win.counted} 番`).join("；")}>
        {wins.slice(-2).map((win, index) => <TileView key={index} tile={win.tile} scale={scale} className="won" badge={wins.length > 1 ? undefined : win.how === "zimo" ? "自摸" : "胡"} />)}
        {wins.length > 1 && <em className="mj-wins-count">胡 ×{wins.length}</em>}
      </span>
    );
  };

  /** 别人的手牌：背面（下桌、结算时是正面），刚摸的那张隔开。 */
  /** 别人的一条牌（手牌 + 副露 + 胡的牌）按某个倍数有多长。 */
  const stripLength = (player: SichuanPlayer, backScale: number) =>
    (layout.mobile && player.hand.length === 0 ? TILE_W + 32 : player.handCount * TILE_W * backScale) + player.melds.length * ((2 * TILE_W + TILE_H) * s + 3 * s) + player.wins.length * TILE_W * s + 24;
  const opponentHand = (seat: number, scale: number, squeeze = false) => {
    const player = game.players[seat]!;
    const revealed = player.hand.length > 0;
    // 手机上别人的暗手牌只画一张牌背加张数，免得牌条太长
    if (layout.mobile && !revealed) {
      return (
        <span className="mj-hand-row compact">
          <TileView tile={-1} scale={1} />
          <em className="mj-hand-count">×{player.handCount}</em>
        </span>
      );
    }
    const tiles = revealed ? sortTiles(player.hand) : Array.from({ length: player.handCount }, () => -1);
    const drawn = player.drawn !== null;
    const body = drawn && !revealed ? tiles.slice(0, -1) : tiles;
    return (
      <span className={["mj-hand-row", revealed ? "revealed" : "", squeeze ? "squeeze" : ""].join(" ")}>
        {body.map((tile, index) => <TileView key={index} tile={tile} scale={scale} />)}
        {drawn && !revealed && <TileView tile={-1} scale={scale} className="drawn" />}
      </span>
    );
  };

  /** 别人的座位：一条手牌（左右两家转 90 度贴着牌河方阵）和一块名牌。 */
  const opponentSeat = (seat: number) => {
    const rel = relOf(seat);
    const player = game.players[seat]!;
    const long = field;
    // 放得下就和牌河一样大；放不下先把手牌（背面或亮出的）缩成 1 倍，再不行副露也缩
    const backScale = !layout.mobile && stripLength(player, s) <= field ? s : 1;
    const meldScale = !layout.mobile && stripLength(player, 1) <= field ? s : 1;
    // 1 倍还放不下（亮牌 + 副露 + 胡的牌太长）：手牌叠半张排
    const squeeze = stripLength(player, 1) - (meldScale === s ? 0 : player.melds.length * (2 * TILE_W + TILE_H) * (s - 1)) > field;
    // 手牌条在视觉上的矩形
    const strip = rel === 2
      ? { x: fieldLeft, y: fieldTop - band - 4, vw: long, vh: band, rot: 0 }
      : rel === 1
        ? { x: fieldLeft + field + 8, y: fieldTop, vw: band, vh: long, rot: -90 }
        : { x: fieldLeft - 8 - band, y: fieldTop, vw: band, vh: long, rot: 90 };
    const cx = strip.x + strip.vw / 2;
    const cy = strip.y + strip.vh / 2;
    const stripStyle: CSSProperties = { left: cx - long / 2, top: cy - band / 2, width: long, height: band, transform: strip.rot ? `rotate(${strip.rot}deg)` : undefined, "--s": s } as CSSProperties;
    const plateStyle: CSSProperties = layout.mobile
      ? { left: 4 + (rel === 3 ? 0 : rel === 2 ? 1 : 2) * ((tableBox.width - 8) / 3), top: 4, width: (tableBox.width - 8) / 3 - 4 }
      : rel === 2
        ? { left: fieldLeft - 8 - band - 8 - PLATE_W, top: fieldTop - band - 4 }
        : rel === 1
          ? { left: fieldLeft + field + 8 + band + 8, top: fieldTop + field / 2, transform: "translateY(-50%)" }
          : { left: fieldLeft - 8 - band - 8 - PLATE_W, top: fieldTop + field / 2, transform: "translateY(-50%)" };
    return (
      <div key={`seat-${seat}`} className={`mj-seat s${rel}`}>
        <div className="mj-strip" style={stripStyle}>
          {opponentHand(seat, backScale, squeeze)}
          {player.melds.length > 0 && <span className="mj-melds">{player.melds.map((meld, index) => meldNode(meld, `${seat}-${index}`, meldScale, seat))}</span>}
          {winTiles(seat, meldScale)}
        </div>
        <div className="mj-plate-wrap" style={plateStyle}>
          {plate(seat)}
          {activeFx.filter((item) => item.seat === seat).map((item) => <span key={item.key} className={`mj-fx ${item.kind}`}>{item.text}</span>)}
        </div>
      </div>
    );
  };

  // ---------- 自己的手牌 ----------
  const voidSuit = me.void;
  const handTiles = useMemo(() => {
    const rest = me.drawn !== null ? (() => { const copy = [...me.hand]; copy.splice(copy.indexOf(me.drawn!), 1); return copy; })() : me.hand;
    const sorted = sortTiles(rest);
    // 缺门的牌排到最右边
    return voidSuit ? [...sorted.filter((tile) => suitOfTile(tile) !== voidSuit), ...sorted.filter((tile) => suitOfTile(tile) === voidSuit)] : sorted;
  }, [game.version, mySeat, me.hand.length]);
  const myTile = (tile: Tile, extra = "") => {
    const swapMode = stage === "swap" && !me.swapChosen && !spectating;
    const picked = swapPick.includes(tile);
    const canDiscard = discards.includes(tile);
    const isVoid = voidSuit !== null && suitOfTile(tile) === voidSuit;
    const onClick = swapMode ? () => toggleSwap(tile) : canDiscard ? () => clickDiscard(tile) : undefined;
    const ting = canDiscard ? discardTing.get(kindOf(tile)) : undefined;
    return (
      <TileView
        key={tile}
        tile={tile}
        scale={hs}
        className={[extra, picked || selected === tile ? "picked" : "", canDiscard || swapMode ? "pickable" : myMove ? "locked" : "", isVoid && stage !== "swap" ? "void" : "", freshIn.has(tile) ? "fresh" : "", ting && ting.kinds.length > 0 ? "ting" : ""].join(" ")}
        onClick={onClick}
        disabled={busy}
        onPointerEnter={canDiscard ? () => setHoverTile(tile) : undefined}
        onPointerLeave={canDiscard ? () => setHoverTile(null) : undefined}
        badge={swapMode && picked ? "换" : selected === tile ? "再点打出" : ting && ting.kinds.length > 0 ? "听" : undefined}
      />
    );
  };

  // ---------- 操作按钮（手牌上方） ----------
  const actionBar = (() => {
    if (spectating || !playing) return null;
    if (stage === "swap" && !me.swapChosen) {
      const ok = swapPick.length === 3 && new Set(swapPick.map(suitOfTile)).size === 1;
      return (
        <div className="mj-actions">
          <span className="mj-actions-hint">{swapPick.length}/3 {swapPick.length > 0 ? `· ${SUIT_NAMES[suitOfTile(swapPick[0]!)!]}子` : ""}</span>
          <button className="primary-button" type="button" disabled={busy || !ok} onClick={() => send({ type: "SWAP", tiles: swapPick })}>换出这 3 张{secondsLeft !== null && <small>{secondsLeft}s</small>}</button>
        </div>
      );
    }
    if (stage === "void" && !me.voidChosen) {
      return (
        <div className="mj-actions">
          {SUITS.map((suit) => (
            <button
              key={suit}
              className={["quiet-button mj-void-button", voidPick === suit ? "chosen" : ""].join(" ")}
              type="button"
              aria-pressed={voidPick === suit}
              disabled={busy}
              onClick={() => setVoidPick(suit)}
              style={{ "--suit": SUIT_COLOR[suit] } as CSSProperties}
            >
              缺{SUIT_NAMES[suit]}<small>{me.hand.filter((tile) => suitOfTile(tile) === suit).length} 张{suit === suggestVoid ? " · 推荐" : ""}</small>
            </button>
          ))}
          <button className="primary-button" type="button" disabled={busy || voidPick === null} onClick={() => voidPick && send({ type: "VOID", suit: voidPick })}>
            {voidPick ? `确定缺${SUIT_NAMES[voidPick]}` : "先选一门"}
          </button>
          {secondsLeft !== null && <span className="mj-actions-time">{secondsLeft}s</span>}
        </div>
      );
    }
    if (myClaim) {
      return (
        <div className="mj-actions">
          {myClaim.includes("hu") && <button className="primary-button mj-hu" type="button" disabled={busy} onClick={() => void respond("hu")}>胡<small>H</small></button>}
          {myClaim.includes("kong") && <button className="primary-button" type="button" disabled={busy} onClick={() => void respond("kong")}>杠<small>G</small></button>}
          {myClaim.includes("pung") && <button className="primary-button" type="button" disabled={busy} onClick={() => void respond("pung")}>碰<small>P</small></button>}
          <button className="quiet-button" type="button" disabled={busy} onClick={() => void respond("pass")}>过<small>Esc</small></button>
          {secondsLeft !== null && <span className="mj-actions-time">{secondsLeft}s</span>}
        </div>
      );
    }
    if (myMove && (tsumoOk || kongs.length > 0 || selected !== null)) {
      return (
        <div className="mj-actions">
          {tsumoOk && <button className="primary-button mj-hu" type="button" disabled={busy} onClick={() => send({ type: "TSUMO" })}>自摸<small>H</small></button>}
          {kongs.map((option) => (
            <button key={option.tile} className="primary-button mj-kong-button" type="button" disabled={busy} onClick={() => send({ type: "KONG", tile: option.tile })}>
              <TileView tile={option.tile} scale={1} />{option.type === "concealedKong" ? "暗杠" : "加杠"}
            </button>
          ))}
          {selected !== null ? (
            <>
              <button className={tsumoOk || kongs.length > 0 ? "quiet-button mj-kong-button" : "primary-button mj-kong-button"} type="button" disabled={busy} onClick={() => discardTile(selected)}>
                打出 <TileView tile={selected} scale={1} /><small>空格</small>
              </button>
              <button className="quiet-button" type="button" disabled={busy} onClick={() => setSelected(null)}>取消<small>Esc</small></button>
            </>
          ) : (
            <span className="mj-actions-hint">或者选一张牌打出去</span>
          )}
          {secondsLeft !== null && <span className="mj-actions-time">{secondsLeft}s</span>}
        </div>
      );
    }
    return null;
  })();

  const tingLine = (() => {
    if (spectating && !room.access.spectatorsSeeAll) return null;
    const info = hoverTing ?? thirteen;
    if (!info) return myMove && discardTing.size > 0 && [...discardTing.values()].some((value) => value.kinds.length > 0) ? <span className="mj-ting muted">标「听」的牌打出去就听牌</span> : null;
    if (info.kinds.length === 0) return hoverTing ? <span className="mj-ting muted">打这张不听牌</span> : null;
    return (
      <span className="mj-ting">
        {hoverTing ? "打这张听：" : "听："}
        {info.kinds.map((kind) => (
          <span key={kind} className={left(kind) === 0 ? "mj-ting-kind empty" : "mj-ting-kind"} title={`${kindLabel(kind)}：还剩 ${left(kind)} 张（按你看得到的牌算），点炮 ${info.fanByKind[kind] ?? 0} 番`}>
            <TileView tile={kind * 4 + 1} scale={1} />
            <small>剩{left(kind)}</small>
          </span>
        ))}
      </span>
    );
  })();

  const centerBox = (
    <div className={c < 140 ? "mj-center compact" : "mj-center"} style={{ left: d, top: d, width: c, height: c }}>
      <span className="mj-center-hand">第 <b>{game.handNo}</b>/{game.config.hands} 盘</span>
      <span className="mj-center-wall"><small>余</small><b>{game.wallCount}</b></span>
      <span className="mj-center-mode">{game.config.mode === "xuezhan" ? "血战到底" : "血流成河"}</span>
      {[0, 1, 2, 3].map((rel) => {
        const seat = seatAt(rel);
        const on = playing && ((stage === "turn" && game.turn === seat) || (stage === "claim" && game.claim?.from === seat));
        return <i key={rel} className={`mj-center-edge e${rel} ${on ? "on" : ""}`} />;
      })}
    </div>
  );

  const showSummary = stage === "handEnd" && game.summary && !hideSummary;
  const statusMini = (
    <div className="mj-status-mini">
      <strong>{headline}</strong>
      {secondsLeft !== null && playing && (needMe || stage === "handEnd") && <b className={secondsLeft <= 5 ? "low" : ""}>{secondsLeft}s</b>}
      {(error || shownNotice) && <small className={error ? "error" : ""}>{error || shownNotice}</small>}
    </div>
  );

  return (
    <div className={layout.mobile ? "mj-screen mobile" : "mj-screen"}>
      <header className="mj-topbar">
        {brand}
        {layout.mobile && (
          <button className="quiet-button mj-menu-toggle" type="button" aria-expanded={menu} onClick={() => setMenu(!menu)}>菜单{unread > 0 ? ` · ${unread}` : ""}</button>
        )}
        <div className="mj-round">
          <span>四川麻将 · {game.config.mode === "xuezhan" ? "血战到底" : "血流成河"}</span>
          <span>第 <b>{game.handNo}</b>/{game.config.hands} 盘</span>
          {game.swapDirection && stage !== "swap" && <span className="mj-chip">换牌{DIRECTION_TEXT[game.swapDirection]}</span>}
        </div>
        <div className={menu ? "mj-topbar-right open" : "mj-topbar-right"} onClick={() => layout.mobile && setMenu(false)}>
          {themeToggle}
          <GameRules variant="sichuan" />
          <GameRoomMenu room={room} />
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve}>解散</button>}
          <button className="quiet-button mj-drawer-toggle" type="button" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
            记录 / 聊天{unread > 0 ? ` · ${unread}` : ""}
          </button>
          {connection}
        </div>
      </header>

      <div className={drawer ? "mj-layout drawer-open" : "mj-layout"}>
        <div
          className={`mj-table s${s}`}
          ref={tableRef}
          style={{ "--scene": `url(${theme === "day" ? art.sceneDay : art.sceneNight})`, "--scene-size": coverSize(tableBox.width, tableBox.height) } as CSSProperties}
        >
          <div className="mj-field" style={{ left: fieldLeft, top: fieldTop, width: field, height: field, "--s": s } as CSSProperties}>
            <div className="mj-felt" />
            {centerBox}
            {game.players.map((_, seat) => riverNode(seat))}
          </div>
          {[1, 2, 3].map((rel) => opponentSeat(seatAt(rel)))}

          <section className={["mj-mine", myMove ? "active" : ""].join(" ")} style={{ "--hs": hs, "--s": s } as CSSProperties}>
            <div className="mj-mine-bar">
              {plate(mySeat)}
              {layout.mobile ? statusMini : tingLine}
            </div>
            <div className="mj-mine-row">
              {actionBar}
              <span className="mj-hand">
                {handTiles.map((tile) => myTile(tile))}
                {me.drawn !== null && me.drawn >= 0 && <span className="mj-drawn-gap">{myTile(me.drawn, "drawn")}</span>}
              </span>
              {me.melds.length > 0 && <span className="mj-melds mine">{me.melds.map((meld, index) => meldNode(meld, `me-${index}`, s, mySeat))}</span>}
              {winTiles(mySeat, s)}
            </div>
            {layout.mobile && tingLine}
            {activeFx.filter((item) => item.seat === mySeat).map((item) => <span key={item.key} className={`mj-fx ${item.kind}`}>{item.text}</span>)}
          </section>
          {banner && <div className="mj-banner" role="status">{banner}</div>}
          {!layout.mobile && statusMini}
          {me.auto && !spectating && playing && (
            <div className="mj-auto-banner">
              托管中：机器人替你出牌
              <button className="primary-button" type="button" onClick={() => send({ type: "AUTO", on: false })}>取消托管</button>
            </div>
          )}
        </div>

        <aside className="mj-side">
          {spectating && <SpectateBar room={room} watchId={myId} onWatch={onWatch} onLeave={onLeave} />}
          <section className="mj-panel mj-status">
            <h2>{headline}</h2>
            {detail && <p>{detail}</p>}
            {secondsLeft !== null && playing && (needMe || stage === "handEnd") && <span className={secondsLeft <= 5 ? "mj-timer low" : "mj-timer"}>{secondsLeft}s</span>}
            {!spectating && playing && stage !== "handEnd" && (
              <button className="quiet-button mj-auto-toggle" type="button" onClick={() => send({ type: "AUTO", on: !me.auto })}>{me.auto ? "取消托管" : "托管"}</button>
            )}
            {stage === "handEnd" && playing && hideSummary && <button className="primary-button" type="button" onClick={() => setHideSummary(false)}>看结算</button>}
            {(error || shownNotice) && <p className={error ? "mj-feedback error" : "mj-feedback"} role={error ? "alert" : "status"}>{error || shownNotice}</p>}
          </section>
          <section className="mj-panel mj-scores">
            {game.players.map((player, seat) => (
              <div key={player.id} className={seat === mySeat ? "mine" : ""}>
                <i style={{ background: seatColor(relOf(seat)) }} />
                <span>{nameOf(seat)}</span>
                <b>{player.score}</b>
              </div>
            ))}
          </section>
          <section className="mj-panel mj-tabs">
            <div className="mj-tab-bar" role="tablist">
              <button type="button" role="tab" aria-selected={sideTab === "log"} className={sideTab === "log" ? "active" : ""} onClick={() => setSideTab("log")}>动作记录</button>
              <button type="button" role="tab" aria-selected={sideTab === "chat"} className={sideTab === "chat" ? "active" : ""} onClick={() => setSideTab("chat")}>
                聊天{unread > 0 && <em>{unread}</em>}
              </button>
            </div>
            {sideTab === "log" ? <ul className="mj-log">{log.map((line) => <li key={line.key}>{line.text}</li>)}</ul> : <div className="mj-chat">{chat}</div>}
          </section>
        </aside>
      </div>
      {showSummary && game.phase === "playing" && (
        <HandSummaryDialog game={game} mySeat={mySeat} spectating={spectating} nameOf={nameOf} secondsLeft={secondsLeft} busy={busy} onReady={() => send({ type: "READY" })} onHide={() => setHideSummary(true)} />
      )}
      {game.phase === "finished" && (
        <FinalDialog game={game} room={room} mySeat={mySeat} spectating={spectating} nameOf={nameOf} onRematch={onRematch} onLeave={onLeave} />
      )}
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 一盘结算

function PlayerTiles({ player, scale }: { player: SichuanPlayer; scale: number }) {
  return (
    <span className="mj-sum-tiles">
      {player.melds.map((meld, index) => (
        <span key={index} className="mj-meld">
          {meld.tiles.map((tile, k) => <TileView key={k} tile={tile} scale={scale} />)}
        </span>
      ))}
      <span className="mj-hand-row">{sortTiles(player.hand).map((tile) => <TileView key={tile} tile={tile} scale={scale} />)}</span>
      {player.wins.map((win, index) => <TileView key={`w${index}`} tile={win.tile} scale={scale} className="won" badge={win.how === "zimo" ? "自摸" : "胡"} />)}
    </span>
  );
}

function HandSummaryDialog({ game, mySeat, spectating, nameOf, secondsLeft, busy, onReady, onHide }: {
  game: GameState;
  mySeat: number;
  spectating: boolean;
  nameOf: (seat: number) => string;
  secondsLeft: number | null;
  busy: boolean;
  onReady: () => void;
  onHide: () => void;
}) {
  const summary = game.summary!;
  const ready = game.ready.includes(game.players[mySeat]!.id);
  const status = new Map(summary.status.map((item) => [item.seat, item]));
  return (
    <div className="gm-modal-backdrop" role="presentation">
      <section className="gm-panel mj-summary" role="dialog" aria-modal="true" aria-label={`第 ${game.handNo} 盘结算`}>
        <header>
          <h2>第 {game.handNo} 盘 · {summary.reason === "exhausted" ? "牌摸完了" : "三家胡牌"}</h2>
          <button className="quiet-button" type="button" onClick={onHide}>看牌桌</button>
        </header>
        <ol className="mj-sum-players">
          {game.players.map((player, seat) => {
            const item = status.get(seat);
            const tags = [
              ...player.wins.map((win) => `${win.how === "zimo" ? "自摸" : win.how === "robKong" ? "抢杠胡" : "胡"} ${win.title} ${win.counted} 番`),
              item?.pig ? "花猪" : "",
              item && !item.pig ? (item.ting ? `听牌（最大 ${item.maxFan} 番）` : "没听牌") : "",
            ].filter(Boolean);
            return (
              <li key={player.id} className={seat === mySeat ? "mine" : ""}>
                <div className="mj-sum-who">
                  <strong>{nameOf(seat)}{seat === game.dealer ? " · 庄" : ""}</strong>
                  <small>{player.void ? `缺${SUIT_NAMES[player.void]}` : ""}{tags.length > 0 ? ` · ${tags.join(" · ")}` : ""}</small>
                </div>
                <PlayerTiles player={player} scale={1} />
                <b className={summary.deltas[seat]! > 0 ? "up" : summary.deltas[seat]! < 0 ? "down" : ""}>{summary.deltas[seat]! > 0 ? "+" : ""}{summary.deltas[seat]}</b>
                <span className="mj-sum-total">{player.score}</span>
              </li>
            );
          })}
        </ol>
        <div className="mj-sum-lines">
          <table>
            <thead>
              <tr><th>这一盘的每一笔</th>{game.players.map((_, seat) => <th key={seat}>{nameOf(seat)}</th>)}</tr>
            </thead>
            <tbody>
              {summary.lines.length === 0 && <tr><td colSpan={5}>没有收付</td></tr>}
              {summary.lines.map((line, index) => (
                <tr key={index}>
                  <td>{line.text}</td>
                  {line.deltas.map((delta, seat) => <td key={seat} className={delta > 0 ? "up" : delta < 0 ? "down" : ""}>{delta === 0 ? "" : delta > 0 ? `+${delta}` : delta}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer>
          <span className="mj-muted">下一盘 {nameOf(summary.nextDealer)} 坐庄</span>
          {!spectating ? (
            <button className="primary-button" type="button" disabled={busy || ready} onClick={onReady}>
              {ready ? `等其他人 ${game.ready.length}/4` : "下一盘"}{secondsLeft !== null && <small>{secondsLeft}s</small>}
            </button>
          ) : (
            <span className="mj-muted">等玩家点「下一盘」 {game.ready.length}/4</span>
          )}
        </footer>
      </section>
    </div>
  );
}

function FinalDialog({ game, room, mySeat, spectating, nameOf, onRematch, onLeave }: {
  game: GameState;
  room: LobbyRoomSnapshot;
  mySeat: number;
  spectating: boolean;
  nameOf: (seat: number) => string;
  onRematch: (accept: boolean) => void;
  onLeave: () => void;
}) {
  const result = game.finalResult!;
  const [showLast, setShowLast] = useState(false);
  const accepted = room.rematch?.acceptedIds.includes(socket.id ?? "") ?? false;
  const order = game.players.map((_, seat) => seat).sort((a, b) => result.ranks[a]! - result.ranks[b]!);
  const myId = game.players[mySeat]!.id;
  const won = result.winners.includes(myId) && !spectating;
  const title = won ? (result.winners.length > 1 ? "并列第一！" : "你赢了！") : `${result.winners.map((id) => nameOf(game.players.findIndex((player) => player.id === id))).join("、")} 获胜`;
  if (showLast && game.summary) {
    return <HandSummaryDialog game={game} mySeat={mySeat} spectating nameOf={nameOf} secondsLeft={null} busy={false} onReady={() => undefined} onHide={() => setShowLast(false)} />;
  }
  return (
    <div className="gm-modal-backdrop" role="presentation">
      <section className="gm-panel mj-final" role="dialog" aria-modal="true" aria-labelledby="mj-final-title">
        <h2 id="mj-final-title">{title}</h2>
        <p className="mj-muted">打满 {game.config.hands} 盘，累计积分最高的人获胜（积分一样并列）。</p>
        <ol className="mj-standings">
          {order.map((seat) => (
            <li key={seat} className={result.winners.includes(game.players[seat]!.id) ? "winner" : ""}>
              <span className="mj-rank">{result.ranks[seat]}</span>
              <strong>{nameOf(seat)}</strong>
              <small>最后一盘 {game.players[seat]!.handDelta > 0 ? "+" : ""}{game.players[seat]!.handDelta}</small>
              <b>{game.players[seat]!.score}</b>
            </li>
          ))}
        </ol>
        {game.summary && <button className="quiet-button" type="button" onClick={() => setShowLast(true)}>看最后一盘结算</button>}
        {spectating ? (
          <div className="mj-rematch">
            <span>{room.rematch ? `等玩家决定要不要再来一局（${room.rematch.acceptedIds.length}/${room.members.length}）` : "对局结束"}</span>
            <div className="gm-panel-actions"><button className="quiet-button" type="button" onClick={onLeave}>离开观战</button></div>
          </div>
        ) : room.rematch && (
          <div className="mj-rematch">
            <span>再来一局？还剩 {Math.ceil(room.rematch.remainingMs / 1000)} 秒（{room.rematch.acceptedIds.length}/{room.members.length} 人同意）</span>
            <div className="gm-panel-actions">
              <button className="quiet-button" type="button" onClick={() => onRematch(false)}>离开</button>
              <button className="primary-button" type="button" disabled={accepted} onClick={() => onRematch(true)}>{accepted ? "等待其他人" : "再来一局"}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default GameBoard;
