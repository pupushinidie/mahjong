import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  canKyuushu,
  kindOf,
  riichiCanTsumo,
  riichiDiscardable,
  riichiKanOptions,
  riichiOptions,
  riichiWaits,
  roundLabel,
  scoreRiichiHand,
  seatWindOf,
  sortTiles,
  type GameCommand,
  type Kind,
  type LobbyRoomSnapshot,
  type RiichiClaimAction,
  type RiichiEvent,
  type RiichiMeld,
  type RiichiPlayer,
  type RiichiState,
  type Tile,
} from "@mahjong/game";
import { art, coverSize, seatColor } from "./art.js";
import { useConfirm } from "./confirm.js";
import GameRules from "./GameRules.js";
import { GameRoomMenu, SpectateBar } from "./RoomExtras.js";
import { socket } from "./socket.js";
import { BAND, MOBILE_OPP_ROW, PLATE_W, useCountdown, useLayout } from "./table.js";
import type { Theme } from "./theme.js";
import { ROW_PITCH, TILE_H, TILE_W, tileLabel, TileView } from "./tiles.js";

interface RiichiBoardProps {
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

type Rel = 0 | 1 | 2 | 3;
const WINDS = ["东", "南", "西", "北"];
const SUIT_WORD = { s: "索" };
const tileName = (tile: Tile) => tileLabel(tile, SUIT_WORD);
const kindName = (kind: Kind) => tileLabel(kind * 4 + 1, SUIT_WORD);
const ACTION_TEXT: Record<RiichiClaimAction | "pass", string> = { ron: "荣", pon: "碰", minkan: "杠", chi: "吃", pass: "过" };
const DRAW_TEXT = { exhaustive: "荒牌流局", kyuushu: "九种九牌", suufon: "四风连打", suucha: "四家立直", suukan: "四杠散了" } as const;
const MELD_TEXT: Record<RiichiMeld["type"], string> = { chi: "吃", pon: "碰", minkan: "明杠", kakan: "加杠", ankan: "暗杠" };

/** 玩家开关（雀魂那几个）：存在 localStorage，只影响自己这边自动发什么。 */
type Switch = "autoWin" | "noCall" | "autoDiscard";
const SWITCHES: { key: Switch; label: string; hint: string }[] = [
  { key: "autoWin", label: "自动和牌", hint: "能荣和、能自摸时自动和" },
  { key: "noCall", label: "不吃碰杠", hint: "别人打的牌不能荣和时自动「过」" },
  { key: "autoDiscard", label: "自动摸切", hint: "摸到牌没有别的选项时自动打出刚摸的那张" },
];
function readSwitch(key: Switch): boolean {
  try {
    return localStorage.getItem(`mj-riichi-${key}`) === "1";
  } catch {
    return false;
  }
}
function writeSwitch(key: Switch, on: boolean): void {
  try {
    localStorage.setItem(`mj-riichi-${key}`, on ? "1" : "0");
  } catch {
    // 无痕模式等：只在这一页有效
  }
}

function describeEvent(event: RiichiEvent, name: (seat: number) => string): string | null {
  switch (event.type) {
    case "HandStarted":
      return `${event.label}开始，${name(event.dealer)}坐庄`;
    case "Discarded":
      return `${name(event.seat)} ${event.riichi ? "立直，" : ""}打出 ${tileName(event.tile)}${event.tsumogiri ? "（摸切）" : ""}`;
    case "RiichiDeclared":
      // 打牌那一条已经写了「立直，打出 X」
      return event.double ? `${name(event.seat)} 双立直` : null;
    case "Called":
      return `${name(event.seat)} ${MELD_TEXT[event.meld.type]} ${tileName(event.meld.taken ?? event.meld.tiles[0]!)}`;
    case "DoraRevealed":
      return `翻开杠宝指示牌 ${tileName(event.indicator)}`;
    case "Won": {
      const win = event.win;
      const how = win.how === "tsumo" ? "自摸" : `荣和 ${name(win.from!)} 的`;
      return `${name(win.seat)} ${how} ${tileName(win.tile)}：${winTitle(win)}，${win.points} 点`;
    }
    case "Draw":
      return DRAW_TEXT[event.kind];
    case "HandEnded":
      return `${event.result.roundLabel}结束${event.result.gameOver ? `：${event.result.gameOver}` : ""}`;
    case "TimedOut":
      return `${name(event.seat)} 超时，自动处理`;
    case "AutoChanged":
      return `${name(event.seat)} ${event.on ? "托管了" : "取消托管"}`;
    case "GameEnded":
      return "对局结束";
    case "Drew":
      return null;
  }
}

function winTitle(win: { yakuman: number; han: number; fu: number; limit: string }): string {
  if (win.yakuman > 0) return win.limit;
  return `${win.han} 番${win.han < 5 ? ` ${win.fu} 符` : ""}${win.limit ? ` ${win.limit}` : ""}`;
}

interface Fx {
  readonly key: string;
  readonly seat: number;
  readonly text: string;
  readonly kind: "pung" | "kong" | "hu" | "zimo" | "riichi";
}

function fxFrom(events: readonly RiichiEvent[], version: number): Fx[] {
  const list: Fx[] = [];
  events.forEach((event, index) => {
    const key = `${version}-${index}`;
    if (event.type === "Called") list.push({ key, seat: event.seat, text: event.meld.type === "chi" ? "吃" : event.meld.type === "pon" ? "碰" : "杠", kind: event.meld.type === "chi" || event.meld.type === "pon" ? "pung" : "kong" });
    if (event.type === "RiichiDeclared") list.push({ key, seat: event.seat, text: event.double ? "双立直" : "立直", kind: "riichi" });
    if (event.type === "Won") list.push({ key, seat: event.win.seat, text: event.win.how === "tsumo" ? "自摸" : "荣", kind: event.win.how === "tsumo" ? "zimo" : "hu" });
  });
  return list;
}

function seenCounts(game: RiichiState, mySeat: number): number[] {
  const seen = new Array<number>(34).fill(0);
  const add = (tile: Tile) => { if (tile >= 0) seen[kindOf(tile)]! += 1; };
  game.players.forEach((player, seat) => {
    if (seat === mySeat) player.hand.forEach(add);
    player.river.forEach((entry) => { if (!entry.taken) add(entry.tile); });
    player.melds.forEach((meld) => meld.tiles.forEach(add));
  });
  game.doraIndicators.forEach(add);
  return seen;
}

// ---------------------------------------------------------------------------

function RiichiBoard({ room, busy, error, notice, brand, connection, theme, themeToggle, chat, onCommand, onRematch, onDissolve, watchId, onWatch, onLeave }: RiichiBoardProps) {
  const game = room.game as RiichiState;
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
  const online = (player: RiichiPlayer) => player.bot || (room.members.find((candidate) => candidate.playerId === player.id)?.connected ?? false);
  const send = (command: GameCommand) => { if (!busy) onCommand(command); };
  const firstVersion = useRef(game.version);
  const shownNotice = game.version === firstVersion.current ? notice : "";
  const [tableRef, layout, tableBox] = useLayout();
  const { s, hs } = layout;
  const aka = game.config.aka;

  const myMove = !spectating && playing && stage === "turn" && game.turn === mySeat;
  const claim = game.claim;
  const myClaim = !spectating && playing && stage === "claim" && claim?.options[mySeat] && claim.responses[mySeat] === undefined ? claim.options[mySeat]! : null;
  const tsumoOk = myMove && riichiCanTsumo(game, mySeat);
  const kans = myMove ? riichiKanOptions(game, mySeat) : [];
  const riichiTiles = myMove ? riichiOptions(game, mySeat) : [];
  const kyuushu = myMove && canKyuushu(game, mySeat);
  const discards = myMove ? riichiDiscardable(game, mySeat) : [];

  // ---------- 选牌：先选中，再点一次或点「打出」；立直模式下只能选能立直的牌 ----------
  const [riichiMode, setRiichiMode] = useState(false);
  const [selected, setSelected] = useState<Tile | null>(null);
  const [hoverTile, setHoverTile] = useState<Tile | null>(null);
  useEffect(() => {
    setSelected(null);
    setHoverTile(null);
    setRiichiMode(false);
  }, [game.version]);
  const pickable = riichiMode ? riichiTiles : discards;
  const doDiscard = (tile: Tile) => { if (pickable.includes(tile)) send({ type: "DISCARD", tile, ...(riichiMode ? { riichi: true } : {}) }); };
  const clickTile = (tile: Tile) => (selected === tile ? doDiscard(tile) : setSelected(tile));

  // ---------- 听牌提示 ----------
  const seen = useMemo(() => seenCounts(game, mySeat), [game.version, mySeat]);
  const left = (kind: number) => Math.max(0, 4 - seen[kind]!);
  /** 听的牌，带「这张荣和有没有役」。 */
  const waitInfo = (hand: readonly Tile[]) => riichiWaits(hand, me.melds).map((kind) => {
    const tile = kind * 4 + 1;
    const score = scoreRiichiHand({
      concealed: [...hand, tile],
      melds: me.melds,
      winTile: tile,
      tsumo: false,
      seatWind: seatWindOf(game, mySeat),
      roundWind: game.roundWind,
      dealer: mySeat === game.dealer,
      riichi: me.riichi || riichiMode ? "riichi" : null,
      aka,
      kuitan: game.config.kuitan,
      doraIndicators: game.doraIndicators,
    });
    return { kind, yaku: score !== null };
  });
  const thirteen = useMemo(() => (me.hand.length % 3 === 1 ? waitInfo(me.hand) : null), [game.version, mySeat]);
  const discardWaits = useMemo(() => {
    const map = new Map<number, ReturnType<typeof waitInfo>>();
    if (!myMove) return map;
    for (const tile of discards) {
      const kind = kindOf(tile);
      if (map.has(kind)) continue;
      const rest = [...me.hand];
      rest.splice(rest.indexOf(tile), 1);
      map.set(kind, waitInfo(rest));
    }
    return map;
  }, [game.version, myMove, riichiMode]);
  const previewTile = selected ?? hoverTile;
  const previewWaits = previewTile !== null ? discardWaits.get(kindOf(previewTile)) : undefined;
  const furiten = me.furiten.discard || me.furiten.temp || me.furiten.riichi;

  // ---------- 玩家开关 ----------
  const [switches, setSwitches] = useState<Record<Switch, boolean>>(() => ({ autoWin: readSwitch("autoWin"), noCall: readSwitch("noCall"), autoDiscard: readSwitch("autoDiscard") }));
  const toggleSwitch = (key: Switch) => setSwitches((current) => {
    writeSwitch(key, !current[key]);
    return { ...current, [key]: !current[key] };
  });
  const autoSent = useRef(-1);
  useEffect(() => {
    if (spectating || !playing || busy || autoSent.current === game.version) return;
    let command: GameCommand | null = null;
    if (switches.autoWin && myClaim?.includes("ron")) command = { type: "CLAIM", action: "ron" };
    else if (switches.autoWin && tsumoOk) command = { type: "TSUMO" };
    else if (switches.noCall && myClaim && !myClaim.includes("ron")) command = { type: "CLAIM", action: "pass" };
    else if (switches.autoDiscard && myMove && game.turnMode === "draw" && me.drawn !== null && !tsumoOk && riichiTiles.length === 0 && kans.length === 0 && !kyuushu && discards.includes(me.drawn)) command = { type: "DISCARD", tile: me.drawn };
    if (!command) return;
    autoSent.current = game.version;
    send(command);
  }, [game.version, switches, busy]);

  // ---------- 动画 ----------
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
    const started = game.events.find((event) => event.type === "HandStarted");
    const draw = game.events.find((event) => event.type === "Draw");
    const text = started?.type === "HandStarted" ? started.label : draw?.type === "Draw" ? DRAW_TEXT[draw.kind] : null;
    if (!text) return;
    setBanner(text);
    const timer = window.setTimeout(() => setBanner(null), 2000);
    return () => window.clearTimeout(timer);
  }, [game.version]);

  // ---------- 操作 ----------
  async function respond(action: RiichiClaimAction | "pass", tiles?: [Tile, Tile]) {
    if (action === "pass" && myClaim?.includes("ron")) {
      const ok = await confirm({ title: "确定不荣和？", detail: me.riichi ? "立直以后放过能和的牌，这一局都不能再荣和（立直振听），只能自摸。" : "放过以后到你下次打牌之前都不能荣和（同巡振听）。", confirmLabel: "不和，过" });
      if (!ok) return;
    }
    send({ type: "CLAIM", action, ...(tiles ? { tiles } : {}) });
  }
  async function declareKyuushu() {
    const ok = await confirm({ title: "九种九牌流局？", detail: "这一局马上流局，不收付点数，庄家连庄。", confirmLabel: "流局" });
    if (ok) send({ type: "KYUUSHU" });
  }

  // 键盘：H 荣/自摸，P 碰，C 吃，G 杠，R 立直，空格 / 回车 打出选中的牌，Esc 取消或过，N 下一局
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (myClaim) {
        if (key === "h" && myClaim.includes("ron")) void respond("ron");
        else if (key === "p" && myClaim.includes("pon") && (claim!.ponOptions[mySeat]?.length ?? 0) === 1) void respond("pon", claim!.ponOptions[mySeat]![0]);
        else if (key === "c" && myClaim.includes("chi") && (claim!.chiOptions[mySeat]?.length ?? 0) === 1) void respond("chi", claim!.chiOptions[mySeat]![0]);
        else if (key === "g" && myClaim.includes("minkan")) void respond("minkan");
        else if (key === "escape") void respond("pass");
      } else if (myMove) {
        if (key === "h" && tsumoOk) send({ type: "TSUMO" });
        else if (key === "r" && riichiTiles.length > 0) setRiichiMode(!riichiMode);
        else if (key === "g" && kans.length === 1) send({ type: "KONG", tile: kans[0]!.tile });
        else if ((key === " " || key === "enter") && selected !== null) {
          event.preventDefault();
          doDiscard(selected);
        } else if (key === "escape") {
          setSelected(null);
          setRiichiMode(false);
        }
      } else if (stage === "handEnd" && playing && !spectating && key === "n" && !game.ready.includes(myId)) {
        send({ type: "READY" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const needMe = !spectating && playing && (myMove || Boolean(myClaim));
  useEffect(() => {
    const base = "立直麻将 · 在线对战";
    const update = () => { document.title = needMe && document.hidden ? `【轮到你】${base}` : base; };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      document.title = base;
    };
  }, [needMe, game.version]);

  const log = useMemo(() => {
    const lines: { key: string; text: string }[] = [];
    game.history.forEach((event, index) => {
      const text = describeEvent(event, nameOf);
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
  if (game.phase === "finished") headline = "对局结束";
  else if (stage === "turn") {
    if (myMove) {
      headline = riichiMode ? "立直：选一张打出" : game.turnMode === "called" ? "鸣牌了：打一张" : "轮到你：打一张";
      detail = riichiMode ? "只有打出以后还听牌的牌能选。打出那张没人荣和，立直才成立（交 1000 点）。"
        : me.riichi ? "立直中：能和就和，不能和自动摸切。"
          : tsumoOk ? "可以自摸！" : "点一张牌选中，再点一次（或点「打出」）打出去。";
    } else {
      headline = `${nameOf(game.turn)} 出牌中`;
    }
  } else if (stage === "claim" && claim) {
    const verb = claim.kind === "discard" ? "打出" : claim.kind === "kakan" ? "加杠" : "暗杠";
    if (myClaim) {
      headline = myClaim.includes("ron") ? "可以荣和！" : `要${myClaim.map((action) => ACTION_TEXT[action]).join("、")}吗？`;
      detail = `${nameOf(claim.from)} ${verb}的 ${tileName(claim.tile)}`;
    } else {
      headline = `${nameOf(claim.from)} ${verb} ${tileName(claim.tile)}`;
    }
  } else if (stage === "handEnd") {
    headline = `${game.result?.roundLabel ?? ""} 结算`;
    detail = spectating ? `等玩家点「下一局」（${game.ready.length}/4）` : game.ready.includes(myId) ? `等其他人（${game.ready.length}/4）` : "看完结算点「下一局」";
  }

  // ---------- 牌河方阵的位置（和四川一样，见 mahjong.css 开头） ----------
  const { c, d, w, field } = layout;
  const riverBoxH = (3 * ROW_PITCH + TILE_H) * s;
  const band = layout.mobile ? 36 : BAND;
  const topBand = band + 8 + (layout.mobile ? MOBILE_OPP_ROW : 0);
  const mineHeight = layout.mobile ? TILE_H * hs * 2 + 48 : TILE_H * hs + 64;
  const fieldLeft = Math.round((tableBox.width - field) / 2);
  const fieldTop = Math.round(topBand + Math.max(0, (tableBox.height - topBand - mineHeight - field) / 2));
  const riverRect = (rel: Rel) => {
    switch (rel) {
      case 0: return { x: d + c - w, y: d + c, vw: w, vh: riverBoxH, rot: 0 };
      case 1: return { x: d + c, y: d, vw: riverBoxH, vh: w, rot: -90 };
      case 2: return { x: d, y: d - riverBoxH - (TILE_H - ROW_PITCH) * s, vw: w, vh: riverBoxH, rot: 0 };
      case 3: return { x: d - riverBoxH, y: d + c - w, vw: riverBoxH, vh: w, rot: 90 };
    }
  };
  const latestDiscard = stage === "claim" && claim?.kind === "discard" ? claim : null;

  const riverNode = (seat: number) => {
    const rel = relOf(seat);
    const rect = riverRect(rel);
    const cx = rect.x + rect.vw / 2;
    const cy = rect.y + rect.vh / 2;
    const style: CSSProperties = { left: cx - w / 2, top: cy - riverBoxH / 2, width: w, height: riverBoxH, transform: rect.rot ? `rotate(${rect.rot}deg)` : undefined, "--s": s } as CSSProperties;
    const river = game.players[seat]!.river;
    return (
      <div key={`river-${seat}`} className={`mj-river riichi r${rel}`} style={style}>
        {river.map((entry, index) => (
          <TileView
            key={index}
            tile={entry.tile}
            scale={s}
            redFives={aka}
            sideways={entry.riichi === true}
            className={[entry.taken ? "taken" : "", latestDiscard?.from === seat && index === river.length - 1 ? "latest" : "", entry.tsumogiri ? "tsumogiri" : ""].join(" ")}
            style={{ marginBottom: -(TILE_H - ROW_PITCH) * s }}
          />
        ))}
      </div>
    );
  };

  /** 副露：拿来的那张横放（上家拿的放最左、对家中间、下家最右）；加杠在横放的那张上面再叠一张；暗杠两头扣着。 */
  const meldNode = (meld: RiichiMeld, key: string, scale: number, seat: number) => {
    const tiles = sortTiles(meld.type === "kakan" ? meld.tiles.filter((tile) => tile !== meld.taken) : meld.tiles);
    let sidewaysIndex = -1;
    let display = tiles;
    if (meld.from !== undefined && meld.taken !== undefined) {
      const diff = (meld.from - seat + 4) % 4;
      const others = tiles.filter((tile) => tile !== meld.taken);
      const taken = meld.type === "kakan" ? tiles.find((tile) => kindOf(tile) === kindOf(meld.taken!) && tile !== meld.taken) ?? tiles[0]! : meld.taken;
      const rest = meld.type === "kakan" ? tiles.filter((tile) => tile !== taken) : others;
      if (diff === 3) { display = [taken, ...rest]; sidewaysIndex = 0; }
      else if (diff === 2) { display = [rest[0]!, taken, ...rest.slice(1)]; sidewaysIndex = 1; }
      else { display = [...rest, taken]; sidewaysIndex = display.length - 1; }
    }
    return (
      <span key={key} className={`mj-meld ${meld.type}`} title={MELD_TEXT[meld.type]}>
        {display.map((tile, index) => (
          <span key={index} className="mj-meld-slot">
            <TileView tile={meld.type === "ankan" && (index === 0 || index === 3) ? -1 : tile} scale={scale} redFives={aka} sideways={index === sidewaysIndex} />
            {meld.type === "kakan" && index === sidewaysIndex && <TileView tile={meld.taken!} scale={scale} redFives={aka} sideways className="stacked" />}
          </span>
        ))}
      </span>
    );
  };

  const plate = (seat: number) => {
    const player = game.players[seat]!;
    const rel = relOf(seat);
    const active = playing && ((stage === "turn" && game.turn === seat) || (stage === "claim" && claim?.from === seat));
    return (
      <div className={["mj-plate", `p${rel}`, active ? "active" : ""].join(" ")} style={{ "--seat": seatColor(rel) } as CSSProperties}>
        <div className="mj-plate-top">
          <img className="mj-avatar" src={art.riichiAvatar(seat)} alt="" />
          <strong title={player.name}>{nameOf(seat)}{seat === mySeat && spectating ? "（观战视角）" : ""}</strong>
          <span className="mj-plate-tags">
            <em className={seat === game.dealer ? "mj-dealer" : "mj-wind"} title={seat === game.dealer ? "庄家（东）" : "自风"}>{WINDS[seatWindOf(game, seat)]}</em>
            {(player.riichi || player.riichiPending) && <em className="mj-riichi-stick" title="立直">{player.riichi?.double ? "双立直" : "立直"}</em>}
          </span>
        </div>
        <div className="mj-plate-bottom">
          <b>{player.points}</b>
          {player.handDelta !== 0 && <small className={player.handDelta > 0 ? "up" : "down"}>{player.handDelta > 0 ? "+" : ""}{player.handDelta}</small>}
          {player.bot && <em className="mj-chip">机器人</em>}
          {!player.bot && player.auto && <em className="mj-chip warn">托管</em>}
          {!online(player) && <em className="mj-chip bad">离线</em>}
        </div>
      </div>
    );
  };

  const stripLength = (player: RiichiPlayer, backScale: number) =>
    (layout.mobile && player.hand.length === 0 ? TILE_W + 32 : player.handCount * TILE_W * backScale) + player.melds.length * ((2 * TILE_W + TILE_H) * s + 3 * s) + 24;
  const opponentHand = (seat: number, scale: number, squeeze: boolean) => {
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
    const drawn = player.drawn !== null && !revealed;
    const body = drawn ? tiles.slice(0, -1) : tiles;
    return (
      <span className={["mj-hand-row", revealed ? "revealed" : "", squeeze ? "squeeze" : ""].join(" ")}>
        {body.map((tile, index) => <TileView key={index} tile={tile} scale={scale} redFives={aka} />)}
        {drawn && <TileView tile={-1} scale={scale} className="drawn" />}
      </span>
    );
  };
  const opponentSeat = (seat: number) => {
    const rel = relOf(seat);
    const player = game.players[seat]!;
    const backScale = !layout.mobile && stripLength(player, s) <= field ? s : 1;
    const meldScale = !layout.mobile && stripLength(player, 1) <= field ? s : 1;
    const squeeze = stripLength(player, 1) - (meldScale === s ? 0 : player.melds.length * (2 * TILE_W + TILE_H) * (s - 1)) > field;
    const strip = rel === 2
      ? { x: fieldLeft, y: fieldTop - band - 4, vw: field, vh: band, rot: 0 }
      : rel === 1
        ? { x: fieldLeft + field + 8, y: fieldTop, vw: band, vh: field, rot: -90 }
        : { x: fieldLeft - 8 - band, y: fieldTop, vw: band, vh: field, rot: 90 };
    const cx = strip.x + strip.vw / 2;
    const cy = strip.y + strip.vh / 2;
    const stripStyle: CSSProperties = { left: cx - field / 2, top: cy - band / 2, width: field, height: band, transform: strip.rot ? `rotate(${strip.rot}deg)` : undefined, "--s": s } as CSSProperties;
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
        </div>
        <div className="mj-plate-wrap" style={plateStyle}>
          {plate(seat)}
          {activeFx.filter((item) => item.seat === seat).map((item) => <span key={item.key} className={`mj-fx ${item.kind}`}>{item.text}</span>)}
        </div>
      </div>
    );
  };

  // ---------- 自己的手牌 ----------
  const handTiles = useMemo(() => {
    const rest = me.drawn !== null && me.drawn >= 0 ? (() => { const copy = [...me.hand]; copy.splice(copy.indexOf(me.drawn!), 1); return copy; })() : me.hand;
    return sortTiles(rest);
  }, [game.version, mySeat, me.hand.length]);
  const myTile = (tile: Tile, extra = "") => {
    const canPick = pickable.includes(tile);
    const waits = canPick ? discardWaits.get(kindOf(tile)) : undefined;
    const ting = waits !== undefined && waits.length > 0;
    return (
      <TileView
        key={tile}
        tile={tile}
        scale={hs}
        redFives={aka}
        className={[extra, selected === tile ? "picked" : "", canPick ? "pickable" : myMove ? "locked" : "", ting ? "ting" : ""].join(" ")}
        onClick={canPick ? () => clickTile(tile) : undefined}
        disabled={busy}
        onPointerEnter={canPick ? () => setHoverTile(tile) : undefined}
        onPointerLeave={canPick ? () => setHoverTile(null) : undefined}
        badge={selected === tile ? (riichiMode ? "再点立直" : "再点打出") : ting ? "听" : undefined}
      />
    );
  };

  const comboButton = (action: "chi" | "pon", tiles: [Tile, Tile], key: string, primary: boolean) => (
    <button key={key} className={primary ? "primary-button mj-kong-button" : "quiet-button mj-kong-button"} type="button" disabled={busy} onClick={() => void respond(action, tiles)}>
      {ACTION_TEXT[action]}
      <span className="mj-combo">{tiles.map((tile) => <TileView key={tile} tile={tile} scale={1} redFives={aka} />)}</span>
    </button>
  );

  const actionBar = (() => {
    if (spectating || !playing) return null;
    if (myClaim && claim) {
      const chis = myClaim.includes("chi") ? claim.chiOptions[mySeat] ?? [] : [];
      const pons = myClaim.includes("pon") ? claim.ponOptions[mySeat] ?? [] : [];
      return (
        <div className="mj-actions">
          {myClaim.includes("ron") && <button className="primary-button mj-hu" type="button" disabled={busy} onClick={() => void respond("ron")}>荣和<small>H</small></button>}
          {myClaim.includes("minkan") && <button className="primary-button" type="button" disabled={busy} onClick={() => void respond("minkan")}>杠<small>G</small></button>}
          {pons.map((tiles, index) => comboButton("pon", tiles, `pon-${index}`, true))}
          {chis.map((tiles, index) => comboButton("chi", tiles, `chi-${index}`, true))}
          <button className="quiet-button" type="button" disabled={busy} onClick={() => void respond("pass")}>过<small>Esc</small></button>
          {secondsLeft !== null && <span className="mj-actions-time">{secondsLeft}s</span>}
        </div>
      );
    }
    if (myMove && (tsumoOk || kans.length > 0 || riichiTiles.length > 0 || kyuushu || selected !== null)) {
      return (
        <div className="mj-actions">
          {tsumoOk && <button className="primary-button mj-hu" type="button" disabled={busy} onClick={() => send({ type: "TSUMO" })}>自摸<small>H</small></button>}
          {riichiTiles.length > 0 && (
            <button className={riichiMode ? "primary-button mj-riichi-button on" : "primary-button mj-riichi-button"} type="button" disabled={busy} onClick={() => { setRiichiMode(!riichiMode); setSelected(null); }}>
              {riichiMode ? "不立直了" : "立直"}<small>R</small>
            </button>
          )}
          {kans.map((option) => (
            <button key={option.tile} className="primary-button mj-kong-button" type="button" disabled={busy} onClick={() => send({ type: "KONG", tile: option.tile })}>
              <TileView tile={option.tile} scale={1} redFives={aka} />{option.type === "ankan" ? "暗杠" : "加杠"}
            </button>
          ))}
          {kyuushu && <button className="quiet-button" type="button" disabled={busy} onClick={() => void declareKyuushu()}>九种九牌</button>}
          {selected !== null ? (
            <>
              <button className="primary-button mj-kong-button" type="button" disabled={busy} onClick={() => doDiscard(selected)}>
                {riichiMode ? "立直，打出" : "打出"} <TileView tile={selected} scale={1} redFives={aka} /><small>空格</small>
              </button>
              <button className="quiet-button" type="button" disabled={busy} onClick={() => setSelected(null)}>取消<small>Esc</small></button>
            </>
          ) : (
            <span className="mj-actions-hint">{riichiMode ? "选一张能立直的牌" : "或者选一张牌打出去"}</span>
          )}
          {secondsLeft !== null && <span className="mj-actions-time">{secondsLeft}s</span>}
        </div>
      );
    }
    return null;
  })();

  const tingLine = (() => {
    if (spectating && !room.access.spectatorsSeeAll) return null;
    const info = previewWaits ?? thirteen;
    if (!info) return myMove && [...discardWaits.values()].some((value) => value.length > 0) ? <span className="mj-ting muted">标「听」的牌打出去就听牌</span> : null;
    if (info.length === 0) return previewWaits ? <span className="mj-ting muted">打这张不听牌</span> : null;
    return (
      <span className={furiten && !previewWaits ? "mj-ting furiten" : "mj-ting"}>
        {previewWaits ? "打这张听：" : furiten ? "振听！听：" : "听："}
        {info.map((item) => (
          <span key={item.kind} className={left(item.kind) === 0 ? "mj-ting-kind empty" : "mj-ting-kind"} title={`${kindName(item.kind)}：还剩 ${left(item.kind)} 张（按你看得到的牌算）${item.yaku ? "" : "，荣和没有役（只能自摸或立直）"}`}>
            <TileView tile={item.kind * 4 + 1} scale={1} />
            <small>剩{left(item.kind)}{item.yaku ? "" : " 无役"}</small>
          </span>
        ))}
      </span>
    );
  })();

  const doraStrip = (scale: number) => (
    <span className="mj-dora" title="宝牌指示牌（下一张是宝牌）">
      {Array.from({ length: 5 }, (_, index) => {
        const tile = game.doraIndicators[index];
        return <TileView key={index} tile={tile ?? -1} scale={scale} redFives={aka} className={tile === undefined ? "hidden" : ""} />;
      })}
    </span>
  );

  const centerBox = (
    <div className={c < 140 ? "mj-center compact riichi" : "mj-center riichi"} style={{ left: d, top: d, width: c, height: c }}>
      <span className="mj-center-hand"><b>{WINDS[game.roundWind]}{game.roundIndex}</b> 局</span>
      <span className="mj-center-sticks">{game.honba} 本场 · 供托 {game.kyoutaku / 1000}</span>
      <span className="mj-center-wall"><small>余</small><b>{game.wallCount}</b></span>
      {[0, 1, 2, 3].map((rel) => {
        const seat = seatAt(rel);
        const on = playing && ((stage === "turn" && game.turn === seat) || (stage === "claim" && claim?.from === seat));
        return (
          <span key={rel} className={`mj-center-seatwind w${rel} ${seat === game.dealer ? "dealer" : ""} ${on ? "on" : ""}`}>{WINDS[seatWindOf(game, seat)]}</span>
        );
      })}
    </div>
  );

  const statusMini = (
    <div className="mj-status-mini">
      <strong>{headline}</strong>
      {secondsLeft !== null && playing && (needMe || stage === "handEnd") && <b className={secondsLeft <= 5 ? "low" : ""}>{secondsLeft}s</b>}
      {!layout.mobile && <span className="mj-dora-row"><small>宝牌指示</small>{doraStrip(2)}</span>}
      {(error || shownNotice) && <small className={error ? "error" : ""}>{error || shownNotice}</small>}
    </div>
  );
  const showSummary = stage === "handEnd" && game.result && !hideSummary;

  return (
    <div className={layout.mobile ? "mj-screen mobile" : "mj-screen"}>
      <header className="mj-topbar">
        {brand}
        {layout.mobile && <button className="quiet-button mj-menu-toggle" type="button" aria-expanded={menu} onClick={() => setMenu(!menu)}>菜单{unread > 0 ? ` · ${unread}` : ""}</button>}
        <div className="mj-round">
          <span>立直麻将 · {game.config.length === "hanchan" ? "半庄战" : "东风战"}</span>
          <span><b>{roundLabel({ ...game, honba: 0 })}</b>{game.honba > 0 ? ` ${game.honba} 本场` : ""}</span>
          {layout.mobile && <span className="mj-dora-top" title="宝牌指示牌">{doraStrip(1)}</span>}
        </div>
        <div className={menu ? "mj-topbar-right open" : "mj-topbar-right"} onClick={() => layout.mobile && setMenu(false)}>
          {themeToggle}
          <GameRules variant="riichi" />
          <GameRoomMenu room={room} />
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve}>解散</button>}
          <button className="quiet-button mj-drawer-toggle" type="button" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>记录 / 聊天{unread > 0 ? ` · ${unread}` : ""}</button>
          {connection}
        </div>
      </header>

      <div className={drawer ? "mj-layout drawer-open" : "mj-layout"}>
        <div
          className={`mj-table riichi s${s}`}
          ref={tableRef}
          style={{ "--scene": `url(${theme === "day" ? art.riichiDay : art.riichiNight})`, "--scene-size": coverSize(tableBox.width, tableBox.height) } as CSSProperties}
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
            <span className="mj-dora-row"><small>宝牌指示牌</small>{doraStrip(2)}</span>
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
                <span>{WINDS[seatWindOf(game, seat)]} · {nameOf(seat)}</span>
                <b>{player.points}</b>
              </div>
            ))}
          </section>
          {!spectating && (
            <section className="mj-panel mj-switches">
              {SWITCHES.map((item) => (
                <button key={item.key} type="button" className={switches[item.key] ? "room-setting on" : "room-setting"} aria-pressed={switches[item.key]} title={item.hint} onClick={() => toggleSwitch(item.key)}>
                  <i aria-hidden="true" />{item.label}
                </button>
              ))}
            </section>
          )}
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
        <RiichiSummary game={game} mySeat={mySeat} spectating={spectating} nameOf={nameOf} secondsLeft={secondsLeft} busy={busy} onReady={() => send({ type: "READY" })} onHide={() => setHideSummary(true)} />
      )}
      {game.phase === "finished" && <RiichiFinalDialog game={game} room={room} mySeat={mySeat} spectating={spectating} nameOf={nameOf} onRematch={onRematch} onLeave={onLeave} />}
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 一局结算

function RiichiSummary({ game, mySeat, spectating, nameOf, secondsLeft, busy, onReady, onHide, final = false }: {
  game: RiichiState;
  mySeat: number;
  spectating: boolean;
  nameOf: (seat: number) => string;
  secondsLeft: number | null;
  busy: boolean;
  onReady: () => void;
  onHide: () => void;
  final?: boolean;
}) {
  const result = game.result!;
  const ready = game.ready.includes(game.players[mySeat]!.id);
  const aka = game.config.aka;
  const title = result.wins.length > 0
    ? result.wins.length > 1 ? `${result.wins.length} 家和` : result.wins[0]!.how === "tsumo" ? "自摸" : "荣和"
    : DRAW_TEXT[result.draw!.kind];
  return (
    <div className="gm-modal-backdrop" role="presentation">
      <section className="gm-panel mj-summary riichi" role="dialog" aria-modal="true" aria-label={`${result.roundLabel}结算`}>
        <header>
          <h2>{result.roundLabel} · {title}</h2>
          <button className="quiet-button" type="button" onClick={onHide}>看牌桌</button>
        </header>
        {result.wins.map((win, index) => (
          <article key={index} className="mj-win">
            <div className="mj-win-head">
              <strong>{nameOf(win.seat)}{win.how === "tsumo" ? " 自摸" : ` 荣和（${nameOf(win.from!)} 放铳）`}</strong>
              <b>{winTitle(win)} · {win.points} 点</b>
            </div>
            <div className="mj-win-tiles">
              {win.melds.map((meld, k) => (
                <span key={k} className="mj-meld">{meld.tiles.map((tile, t) => <TileView key={t} tile={meld.type === "ankan" && (t === 0 || t === 3) ? -1 : tile} scale={2} redFives={aka} />)}</span>
              ))}
              <span className="mj-hand-row">
                {win.hand.filter((tile) => tile !== win.tile).map((tile) => <TileView key={tile} tile={tile} scale={2} redFives={aka} />)}
              </span>
              <TileView tile={win.tile} scale={2} redFives={aka} className="won" badge={win.how === "tsumo" ? "自摸" : "荣"} />
            </div>
            <ul className="mj-yaku">
              {win.yaku.map((item, k) => (
                <li key={k}><span>{item.name}</span><b>{item.yakuman ? (item.han > 1 ? `${item.han} 倍役满` : "役满") : `${item.han} 番`}</b></li>
              ))}
            </ul>
            <div className="mj-win-dora">
              <span>宝牌指示牌</span>
              {win.doraIndicators.map((tile, k) => <TileView key={k} tile={tile} scale={1} redFives={aka} />)}
              {win.uraIndicators.length > 0 && <><span>里宝牌指示牌</span>{win.uraIndicators.map((tile, k) => <TileView key={`u${k}`} tile={tile} scale={1} redFives={aka} />)}</>}
              {win.liable !== undefined && <span className="mj-pao">包牌：{nameOf(win.liable)}</span>}
            </div>
          </article>
        ))}
        {result.draw && (
          <div className="mj-draw">
            {result.draw.kind === "exhaustive" ? (
              <>
                {result.draw.nagashi.length > 0 && <p>流局满贯：{result.draw.nagashi.map(nameOf).join("、")}</p>}
                <ul>
                  {game.players.map((player, seat) => (
                    <li key={player.id}>
                      <strong>{nameOf(seat)}</strong>
                      <em className={result.draw!.tenpai[seat] ? "mj-chip ok" : "mj-chip"}>{result.draw!.tenpai[seat] ? "听牌" : "没听"}</em>
                      {result.draw!.tenpai[seat] && player.hand.length > 0 && <span className="mj-hand-row">{sortTiles(player.hand).map((tile) => <TileView key={tile} tile={tile} scale={1} redFives={aka} />)}</span>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>途中流局，不收付点数，庄家连庄，本场 +1。</p>
            )}
          </div>
        )}
        <ol className="mj-sum-points">
          {game.players.map((player, seat) => (
            <li key={player.id} className={seat === mySeat ? "mine" : ""}>
              <span>{nameOf(seat)}</span>
              <b className={result.deltas[seat]! > 0 ? "up" : result.deltas[seat]! < 0 ? "down" : ""}>{result.deltas[seat]! > 0 ? "+" : ""}{result.deltas[seat]}</b>
              <span className="mj-sum-total">{result.points[seat]}</span>
            </li>
          ))}
        </ol>
        <footer>
          <span className="mj-muted">{result.gameOver ? `半庄结束：${result.gameOver}` : `下一局：${roundLabel(game)}${result.renchan ? "（连庄）" : ""}`}</span>
          {final ? null : !spectating ? (
            <button className="primary-button" type="button" disabled={busy || ready} onClick={onReady}>
              {ready ? `等其他人 ${game.ready.length}/4` : "下一局"}{secondsLeft !== null && <small>{secondsLeft}s</small>}
            </button>
          ) : (
            <span className="mj-muted">等玩家点「下一局」 {game.ready.length}/4</span>
          )}
        </footer>
      </section>
    </div>
  );
}

function RiichiFinalDialog({ game, room, mySeat, spectating, nameOf, onRematch, onLeave }: {
  game: RiichiState;
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
  const myRank = result.ranks[mySeat]!;
  const title = spectating ? `${nameOf(order[0]!)} 第一` : myRank === 1 ? "你是第一名！" : `你是第 ${myRank} 名`;
  if (showLast && game.result) {
    return <RiichiSummary game={game} mySeat={mySeat} spectating nameOf={nameOf} secondsLeft={null} busy={false} onReady={() => undefined} onHide={() => setShowLast(false)} final />;
  }
  return (
    <div className="gm-modal-backdrop" role="presentation">
      <section className="gm-panel mj-final" role="dialog" aria-modal="true" aria-labelledby="mj-final-title">
        <h2 id="mj-final-title">{title}</h2>
        <p className="mj-muted">{game.result?.gameOver ?? "对局结束"}。最终得分 =（点数 − 30000）÷ 1000 + 顺位马（+15 / +5 / −5 / −15），第一名再加 20。</p>
        <ol className="mj-standings">
          {order.map((seat) => (
            <li key={seat} className={result.ranks[seat] === 1 ? "winner" : ""}>
              <span className="mj-rank">{result.ranks[seat]}</span>
              <strong>{nameOf(seat)}</strong>
              <small>{game.players[seat]!.points} 点</small>
              <b>{result.scores[seat]! > 0 ? "+" : ""}{result.scores[seat]!.toFixed(1)}</b>
            </li>
          ))}
        </ol>
        {game.result && <button className="quiet-button" type="button" onClick={() => setShowLast(true)}>看最后一局结算</button>}
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

export default RiichiBoard;
