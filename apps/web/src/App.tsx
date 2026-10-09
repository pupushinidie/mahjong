import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { DEFAULT_RIICHI_OPTIONS, DEFAULT_SICHUAN_OPTIONS, SEAT_COUNT, VARIANTS, type GameCommand, type GameOptions, type LobbyRoomSnapshot, type PublicRoomSummary, type Tile, type Variant } from "@mahjong/game";
import { art, seatColor } from "./art.js";
import { useConfirm } from "./confirm.js";
import GameBoard from "./GameBoard.js";
import GameRules from "./GameRules.js";
import RiichiBoard from "./RiichiBoard.js";
import OnlineRooms from "./OnlineRooms.js";
import RoomChat from "./RoomChat.js";
import { roomRole, RoomSettingsPanel, SeatSwitch } from "./RoomExtras.js";
import { socket } from "./socket.js";
import { ThemeToggle, useTheme } from "./theme.js";
import { TileView } from "./tiles.js";
import { useVoice } from "./voice.js";

type EntryMode = "create" | "join";

const validRoomCode = /^[A-HJ-NP-Z2-9]{6}$/;

/** 首页摆的几张牌（一万、五筒、一条、九万、发、中）。 */
const SHOWCASE: Tile[] = [0, 4 * 13 + 1, 4 * 18 + 1, 4 * 8 + 1, 4 * 32 + 1, 4 * 33 + 1];

// 线上游戏中心在站点根路径；本地开发时跑在 5175 端口。
const CENTER_URL = import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:5175/` : "/";

function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 6);
}

/** 各玩法的一句话介绍（首页的玩法卡片）。 */
const VARIANT_BLURB: Record<string, string> = {
  sichuan: "只用万筒条 108 张，不能吃。开局换三张、定缺一门，一家胡了不散场：血战到底打到三家胡，血流成河胡了还能接着胡。",
  riichi: "日本麻将：136 张带字牌和红五，能吃碰杠。要有役才能和，门清听牌可以立直；宝牌、振听、符和番，打一个半庄或东风战，按点数排名次。",
};

function App() {
  const [mode, setMode] = useState<EntryMode>("create");
  const [name, setName] = useState("");
  const [variant, setVariant] = useState<Variant>("sichuan");
  const [sichuanMode, setSichuanMode] = useState(DEFAULT_SICHUAN_OPTIONS.mode);
  const [riichiLength, setRiichiLength] = useState(DEFAULT_RIICHI_OPTIONS.length);
  const options: GameOptions = variant === "riichi"
    ? { variant: "riichi", ...DEFAULT_RIICHI_OPTIONS, length: riichiLength }
    : { variant: "sichuan", ...DEFAULT_SICHUAN_OPTIONS, mode: sichuanMode };
  const [confirmAction, confirmDialog] = useConfirm();
  // 白天 / 夜间画面：首页、等候房间、牌桌共用，顶栏按钮随时切换；和游戏中心、其他游戏共用同一个选择。
  const [theme, toggleTheme] = useTheme();
  const themeToggle = <ThemeToggle theme={theme} onToggle={toggleTheme} />;
  const [roomCode, setRoomCode] = useState("");
  const [room, setRoom] = useState<LobbyRoomSnapshot | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lobbyRooms, setLobbyRooms] = useState<PublicRoomSummary[]>([]);
  // 观战时从谁的座位看（默认第一位玩家）。
  const [watchId, setWatchId] = useState("");
  const voice = useVoice(room);

  // 「房间已创建」「房间码已复制」这类临时提示 4 秒后自动消失，不一直挂在页面上。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 在房间里时服务端不推送在线牌桌列表；回到首页时主动拉一次最新的。
  useEffect(() => {
    if (room || !socket.connected) return;
    socket.emit("lobby:get", (response) => {
      if (response.ok) setLobbyRooms(response.data);
    });
  }, [room === null]);

  useEffect(() => {
    const handleConnect = () => {
      setConnected(true);
      socket.emit("lobby:get", (response) => {
        if (response.ok) setLobbyRooms(response.data);
      });
    };
    const handleDisconnect = () => setConnected(false);
    const handleRoomUpdate = (snapshot: LobbyRoomSnapshot) => setRoom(snapshot);
    const handleRoomError = (message: string) => setError(message);
    const handleLobbyUpdate = (rooms: PublicRoomSummary[]) => setLobbyRooms(rooms);
    const handleRoomClosed = ({ reason }: { reason: string }) => {
      setRoom(null);
      setBusy(false);
      setError("");
      setNotice(reason);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("room:updated", handleRoomUpdate);
    socket.on("room:error", handleRoomError);
    socket.on("lobby:updated", handleLobbyUpdate);
    socket.on("room:closed", handleRoomClosed);
    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("room:updated", handleRoomUpdate);
      socket.off("room:error", handleRoomError);
      socket.off("lobby:updated", handleLobbyUpdate);
      socket.off("room:closed", handleRoomClosed);
      socket.disconnect();
    };
  }, []);

  const canSubmit = useMemo(() => {
    if (!connected || busy || name.trim().length < 2 || name.trim().length > 18) return false;
    return mode === "create" || validRoomCode.test(roomCode);
  }, [busy, connected, mode, name, roomCode]);

  /** 从首页列表加入空座位或进去观战（用上面填的昵称）。 */
  function joinListed(roomId: string, spectate: boolean) {
    const nickname = name.trim();
    if (nickname.length < 2 || nickname.length > 18) {
      setNotice("");
      setError("先在上面填好你的昵称（2–18 个字符）。");
      document.getElementById("player-name")?.focus();
      return;
    }
    setError("");
    setNotice("");
    setBusy(true);
    socket.emit("room:join", { name: nickname, roomId, spectate }, (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice(spectate ? "正在观战。" : "已加入房间。");
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    const nickname = name.trim();

    const complete = (response: { ok: true; data: LobbyRoomSnapshot } | { ok: false; error: string }) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice(mode === "create"
        ? "房间已创建，可以邀请朋友加入。"
        : response.data.status === "playing" ? "已回到对局，继续游戏吧。" : "已加入房间。");
    };

    if (mode === "create") {
      socket.emit("room:create", { name: nickname, options }, complete);
    } else {
      socket.emit("room:join", { name: nickname, code: roomCode }, complete);
    }
  }

  function startGame() {
    setError("");
    setBusy(true);
    socket.emit("room:start", (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice("对局已开始，祝你好运。" );
    });
  }

  function leaveRoom() {
    setBusy(true);
    socket.emit("room:leave", (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(null);
      setError("");
      setNotice("已离开房间。" );
    });
  }

  function submitGameCommand(command: GameCommand) {
    setBusy(true);
    setError("");
    setNotice("");
    socket.emit("game:command", command, (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
    });
  }

  /** 房间管理类操作：只关心成败，界面更新由服务端广播。 */
  function roomCommand(send: (ack: (response: { ok: true; data: void } | { ok: false; error: string }) => void) => void) {
    setError("");
    send((response) => {
      if (!response.ok) setError(response.error);
    });
  }

  const kickMember = (memberId: string) => roomCommand((ack) => socket.emit("room:kick", memberId, ack));
  const voteRematch = (accept: boolean) => roomCommand((ack) => socket.emit("room:rematch", accept, ack));
  async function dissolveRoom() {
    const ok = await confirmAction({
      title: "解散房间？",
      detail: "所有玩家都会被移出，当前对局也会结束。",
      confirmLabel: "解散",
    });
    if (ok) roomCommand((ack) => socket.emit("room:dissolve", ack));
  }

  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setNotice("房间码已复制。" );
    } catch {
      setNotice("请手动复制房间码。" );
    }
  }

  if (room?.status === "playing" && room.game) {
    const players = room.game.players;
    const watched = players.some((player) => player.id === watchId) ? watchId : players[0]!.id;
    const Board = room.game.variant === "riichi" ? RiichiBoard : GameBoard;
    return (
      <main className="app-shell mj-game">
        <Board
          room={room}
          busy={busy}
          error={error}
          notice={notice}
          brand={<Brand />}
          connection={<ConnectionStatus connected={connected} />}
          theme={theme}
          themeToggle={themeToggle}
          chat={<RoomChat room={room} voice={voice} />}
          onCommand={submitGameCommand}
          onRematch={voteRematch}
          onDissolve={dissolveRoom}
          watchId={watched}
          onWatch={setWatchId}
          onLeave={leaveRoom}
        />
        {confirmDialog}
      </main>
    );
  }

  if (room) {
    return (
      <main className="app-shell mj-room">
        <header className="topbar">
          <Brand />
          <div className="topbar-right">
            {themeToggle}
            <GameRules variant={room.options.variant} />
            <ConnectionStatus connected={connected} />
          </div>
        </header>
        <RoomView
          room={room}
          busy={busy}
          error={error}
          notice={notice}
          onCopyCode={copyRoomCode}
          onLeave={leaveRoom}
          onStart={startGame}
          onKick={kickMember}
          onDissolve={dissolveRoom}
          chat={<RoomChat room={room} voice={voice} />}
        />
        {confirmDialog}
      </main>
    );
  }

  return (
    <main className="app-shell mj-home">
      <header className="topbar">
        <Brand />
        <div className="topbar-right">
          <a className="center-link" href={CENTER_URL}>← 游戏中心</a>
          {themeToggle}
          <GameRules />
          <ConnectionStatus connected={connected} />
        </div>
      </header>

      <section className="welcome-grid">
        <div className="welcome-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> 在线对战 · 1–4 人 · 空座机器人补位</div>
          <h1>麻将</h1>
          <p className="welcome-description">
            四个座位，和朋友一起打；人不够时机器人坐空座，一个人也能练手。算番、结算都由程序完成。先选一种玩法：
          </p>
          <div className="mj-variants" role="radiogroup" aria-label="选择玩法">
            {VARIANTS.map((variant) => (
              <button
                key={variant.id}
                type="button"
                role="radio"
                aria-checked={options.variant === variant.id}
                disabled={!variant.ready}
                className={["mj-variant", options.variant === variant.id ? "selected" : "", variant.ready ? "" : "soon"].join(" ")}
                onClick={() => variant.ready && setVariant(variant.id)}
              >
                <strong>{variant.name}{!variant.ready && <em>制作中</em>}</strong>
                <span>{VARIANT_BLURB[variant.id]}</span>
              </button>
            ))}
          </div>
          <div className="mj-hero" style={{ backgroundImage: `url(${theme === "day" ? art.sceneDay : art.sceneNight})` }}>
            <div className="mj-showcase" aria-hidden="true">
              {SHOWCASE.map((tile) => <TileView key={tile} tile={tile} scale={2} />)}
            </div>
          </div>
        </div>

        <div className="mj-home-side">
          <section className="entry-card" aria-labelledby="entry-title">
            <div className="entry-card-heading">
              <div>
                <span className="section-kicker">准备开始</span>
                <h2 id="entry-title">进入牌桌</h2>
              </div>
              <span className="step-indicator">01 <i /> 02</span>
            </div>

            <div className="mode-switch" role="tablist" aria-label="选择房间操作">
              <button
                className={mode === "create" ? "mode-tab active" : "mode-tab"}
                type="button"
                role="tab"
                aria-selected={mode === "create"}
                onClick={() => { setMode("create"); setError(""); }}
              >
                创建房间
              </button>
              <button
                className={mode === "join" ? "mode-tab active" : "mode-tab"}
                type="button"
                role="tab"
                aria-selected={mode === "join"}
                onClick={() => { setMode("join"); setError(""); }}
              >
                加入房间
              </button>
            </div>

            <form className="entry-form" onSubmit={handleSubmit}>
              <label className="field-label" htmlFor="player-name">你的昵称</label>
              <input
                id="player-name"
                className="text-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="输入 2–18 个字符"
                minLength={2}
                maxLength={18}
                autoComplete="nickname"
                required
              />

              {mode === "create" ? (
                <>
                  {variant === "riichi" ? (
                    <>
                      <label className="field-label field-label-spaced" htmlFor="room-mode">立直麻将 · 场数</label>
                      <div className="capacity-options mj-mode-pick" id="room-mode" role="group" aria-label="选择场数">
                        {(["hanchan", "tonpuu"] as const).map((length) => (
                          <button
                            key={length}
                            type="button"
                            className={riichiLength === length ? "capacity-option selected" : "capacity-option"}
                            aria-pressed={riichiLength === length}
                            onClick={() => setRiichiLength(length)}
                          >
                            <strong>{length === "hanchan" ? "半庄战" : "东风战"}</strong>
                            <span>{length === "hanchan" ? "东南两圈，约 40 分钟" : "只打东风圈，约 20 分钟"}</span>
                          </button>
                        ))}
                      </div>
                      <p className="field-hint">红宝牌、食断进房间后房主可以改。空座位开局时由机器人补上。</p>
                    </>
                  ) : (
                    <>
                      <label className="field-label field-label-spaced" htmlFor="room-mode">四川麻将 · 模式</label>
                      <div className="capacity-options mj-mode-pick" id="room-mode" role="group" aria-label="选择模式">
                        {(["xuezhan", "xueliu"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={sichuanMode === mode ? "capacity-option selected" : "capacity-option"}
                            aria-pressed={sichuanMode === mode}
                            onClick={() => setSichuanMode(mode)}
                          >
                            <strong>{mode === "xuezhan" ? "血战到底" : "血流成河"}</strong>
                            <span>{mode === "xuezhan" ? "胡了下桌" : "胡了接着打"}</span>
                          </button>
                        ))}
                      </div>
                      <p className="field-hint">换三张、封顶、盘数这些进房间后房主可以改。空座位开局时由机器人补上。</p>
                    </>
                  )}
                </>
              ) : (
                <>
                  <label className="field-label field-label-spaced" htmlFor="room-code">房间码</label>
                  <input
                    id="room-code"
                    className="text-input room-code-input"
                    value={roomCode}
                    onChange={(event) => setRoomCode(normalizeRoomCode(event.target.value))}
                    placeholder="例如：7KQ2TX"
                    autoComplete="off"
                    maxLength={6}
                    required
                  />
                  <p className="field-hint">房间码为 6 位字母或数字，不含易混淆字符。掉线后用原昵称和房间码可回到进行中的对局。</p>
                </>
              )}

              {error && <p className="feedback feedback-error" role="alert">{error}</p>}
              {notice && <p className="feedback feedback-success" role="status">{notice}</p>}

              <button className="primary-button" type="submit" disabled={!canSubmit}>
                {busy ? <><span className="spinner" /> 正在连接</> : mode === "create" ? "创建私人房间" : "加入牌桌"}
                {!busy && <span aria-hidden="true">↗</span>}
              </button>
            </form>
            <div className="entry-footnote"><span className="lock-icon">◇</span> 默认邀请制 · 房主可以设为公开</div>
          </section>
          <OnlineRooms rooms={lobbyRooms} connected={connected} busy={busy} onJoin={joinListed} />
        </div>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <a className="brand" href={import.meta.env.BASE_URL} aria-label="麻将首页">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
      <span className="brand-name">麻将<span> MAHJONG</span></span>
    </a>
  );
}

function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <div className={connected ? "connection-status online" : "connection-status"}>
      <span className="connection-dot" />
      {connected ? "服务已连接" : "连接中…"}
    </div>
  );
}

type Ack = { ok: true; data: void } | { ok: false; error: string };

/** 开房选项：房主在等候房间里改，其他人只看。 */
function OptionsPanel({ room }: { room: LobbyRoomSnapshot }) {
  const { isHost } = roomRole(room);
  const [error, setError] = useState("");
  const options = room.options as Record<string, unknown> & GameOptions;
  const change = (patch: Record<string, unknown>) => socket.emit("room:options", { ...options, ...patch } as GameOptions, (response: Ack) => setError(response.ok ? "" : response.error));
  const row = <T extends string | number | boolean | null>(label: string, key: string, values: readonly { value: T; text: string }[]) => (
    <div className="mj-option-row">
      <span>{label}</span>
      <div className="mj-option-values">
        {values.map((item) => (
          <button
            key={String(item.value)}
            type="button"
            className={options[key] === item.value ? "room-setting on" : "room-setting"}
            aria-pressed={options[key] === item.value}
            disabled={!isHost}
            onClick={() => change({ [key]: item.value })}
          >
            <i aria-hidden="true" />{item.text}
          </button>
        ))}
      </div>
    </div>
  );
  if (options.variant === "riichi") {
    return (
      <div className="mj-options">
        <div className="panel-label">立直麻将 · 开房选项 <span>{isHost ? "房主可以改" : "只有房主能改"}</span></div>
        {row("场数", "length", [{ value: "hanchan", text: "半庄战" }, { value: "tonpuu", text: "东风战" }])}
        {row("红宝牌", "aka", [{ value: true, text: "3 张" }, { value: false, text: "无" }])}
        {row("食断", "kuitan", [{ value: true, text: "有" }, { value: false, text: "无" }])}
        {error && <p className="feedback feedback-error" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div className="mj-options">
      <div className="panel-label">四川麻将 · 开房选项 <span>{isHost ? "房主可以改" : "只有房主能改"}</span></div>
      {row("模式", "mode", [{ value: "xuezhan", text: "血战到底" }, { value: "xueliu", text: "血流成河" }])}
      {row("换三张", "swap", [{ value: true, text: "换" }, { value: false, text: "不换" }])}
      {row("封顶", "cap", [{ value: null, text: "不封顶" }, { value: 3, text: "3 番" }, { value: 4, text: "4 番" }, { value: 6, text: "6 番" }])}
      {row("自摸", "zimo", [{ value: "fan", text: "加 1 番" }, { value: "base", text: "每家多付 1 分" }])}
      {row("盘数", "hands", [{ value: 4, text: "4 盘" }, { value: 8, text: "8 盘" }, { value: 16, text: "16 盘" }])}
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
    </div>
  );
}

function RoomView({
  room,
  busy,
  error,
  notice,
  onCopyCode,
  onLeave,
  onStart,
  onKick,
  onDissolve,
  chat,
}: {
  room: LobbyRoomSnapshot;
  busy: boolean;
  error: string;
  notice: string;
  onCopyCode: () => void;
  onLeave: () => void;
  onStart: () => void;
  onKick: (memberId: string) => void;
  onDissolve: () => void;
  chat: ReactNode;
}) {
  const { isHost, spectating } = roomRole(room);
  const openSeats = Math.max(0, SEAT_COUNT - room.members.length);

  return (
    <section className="room-layout">
      <div className="room-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> {room.status === "waiting" ? "等待大厅" : "对局已创建"} · {room.options.variant === "riichi" ? "立直麻将" : "四川麻将"}</div>
          <h1>{spectating ? "你在观战。" : room.status === "waiting" ? "牌桌准备中。" : "好戏即将开始。"}</h1>
          <p>{spectating ? "等房主开始对局；有空座位时可以坐下一起玩。" : "把房间码分享给朋友；人没到齐也能开始，空座位由机器人补上。"}</p>
        </div>
        <div className="room-heading-actions">
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve} disabled={busy}>解散房间</button>}
          <button className="quiet-button" type="button" onClick={onLeave} disabled={busy || (room.status === "playing" && !spectating)}>
            {spectating ? "离开观战" : "离开房间"}
          </button>
        </div>
      </div>

      {room.status === "waiting" ? (
        <div className="room-grid">
          <section className="room-panel room-code-panel">
            <div className="panel-label">房间码 <span>仅分享给朋友</span></div>
            {room.code ? (
              <>
                <button className="room-code-display" type="button" onClick={onCopyCode} title="复制房间码">
                  {room.code}<span aria-hidden="true">⧉</span>
                </button>
                <div className="room-code-caption">点击复制 · 6 位邀请代码</div>
              </>
            ) : (
              <div className="room-code-caption">从首页列表进来观战，看不到房间码</div>
            )}
            <OptionsPanel room={room} />
          </section>

          <section className="room-panel player-panel">
            <div className="panel-topline">
              <div className="panel-label">座位 <span>{room.members.length} 人 · {openSeats} 个空座</span></div>
              <span className="waiting-pill"><i /> 等待中</span>
            </div>
            <div className="player-list">
              {room.members.map((member, index) => (
                <div className="player-row" key={member.id}>
                  <div className="player-avatar mj-member-avatar" style={{ background: seatColor(index) } as CSSProperties}>
                    <img src={art.avatar(index)} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />
                    <span>{member.name.slice(0, 1).toUpperCase()}</span>
                  </div>
                  <div className="player-details">
                    <strong>{member.name}{member.id === socket.id ? <small>你</small> : null}</strong>
                    <span>{member.isHost ? "房主" : "已加入"}</span>
                  </div>
                  {member.isHost && <span className="host-badge">房主</span>}
                  {isHost && !member.isHost && (
                    <button className="kick-button" type="button" onClick={() => onKick(member.id)} title={`把 ${member.name} 移出房间`}>移出</button>
                  )}
                </div>
              ))}
              {Array.from({ length: openSeats }, (_, index) => (
                <div className="player-row open-seat" key={`open-${index}`}>
                  <div className="empty-avatar"><span>＋</span></div>
                  <div className="player-details"><strong>空座：机器人补位</strong><span>{room.access.open ? "公开房间，路过的人也能坐下" : "朋友用房间码加入就会坐这里"}</span></div>
                </div>
              ))}
            </div>
            <p className="field-hint">
              {room.options.variant === "riichi"
                ? `${room.options.length === "tonpuu" ? "东风战" : "半庄战"}，每人 25000 点起，按点数排名次。每手 5 秒，用完扣这一局的 20 秒备用时间，超时自动处理；连续超时 2 次转托管，掉线由机器人代打，回来能接上。`
                : `打 ${room.options.hands ?? 8} 盘，累计积分最高的人获胜。换三张 20 秒、定缺 10 秒、出牌 15 秒、碰杠胡 8 秒，超时自动处理；连续超时 2 次转托管，掉线由机器人代打，回来能接上。`}
            </p>
            <RoomSettingsPanel room={room} />
            <SeatSwitch room={room} />
            <div className="room-actions">
              {isHost ? (
                <button className="primary-button" type="button" onClick={onStart} disabled={busy}>
                  {busy ? <><span className="spinner" /> 正在开始</> : openSeats > 0 ? `开始（${openSeats} 个机器人补位）` : "开始对局"}<span aria-hidden="true">↗</span>
                </button>
              ) : (
                <div className="host-wait-note"><span className="pulse-dot" /> {spectating ? "等房主开始，开始后在这里观战" : "等待房主开始对局"}</div>
              )}
            </div>
          </section>
          <div className="mj-room-chat">{chat}</div>
        </div>
      ) : null}

      {error && <p className="feedback feedback-error room-feedback" role="alert">{error}</p>}
      {notice && <p className="feedback feedback-success room-feedback" role="status">{notice}</p>}
      <div className="room-secure-note"><span>◇</span> {room.access.open ? "公开房间：首页列表里的人可以直接加入空座位。" : "邀请制：要有房间码才能加入；首页列表不显示房间码。"}</div>
    </section>
  );
}

export default App;
