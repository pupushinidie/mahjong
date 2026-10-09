#!/usr/bin/env node
/**
 * 麻将陪玩机器人（本地联调、线上在服务器上连 localhost 测试用）。先 npm run build:game（规则包的 dist）。
 * 服务器自己会给空座位补机器人；这个脚本是用来模拟「真人」连进房间的（测重连、抢座位、多人房间）。
 *
 * 用法：
 *   node scripts/test-bot.mjs host <昵称> [--start-at=N] [--mode=xueliu] [--hands=4]   建房（四川麻将），打印房间码；凑够 N 个真人自动开局
 *   node scripts/test-bot.mjs host <昵称> --variant=riichi [--length=hanchan]         建立直麻将的房（默认东风战）
 *   node scripts/test-bot.mjs join <房间码> <昵称>                                       加入房间
 *   node scripts/test-bot.mjs fill <房间码> <人数> [昵称前缀=陪玩]                        一次加入好几个
 *
 * 环境变量：BOT_URL（默认 http://localhost:3012）、BOT_DELAY（每步之前等多少毫秒，默认 600）、
 *          BOT_PATH（socket.io 路径，默认 /socket.io）、BOT_REMATCH=0（终局后不同意再来一局）。
 * 策略和服务器上的机器人一样（botCommand：向听数贪心）。每次 ack 之后都按最新状态重新判断。
 */
import { io } from "socket.io-client";
import { botCommand, legalCommands } from "@mahjong/game";

const URL = process.env.BOT_URL ?? "http://localhost:3012";
const DELAY = Number(process.env.BOT_DELAY ?? 600);
const PATH = process.env.BOT_PATH ?? "/socket.io";

const [mode, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
const flag = (name, fallback) => [...flags].find((item) => item.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const startAt = Number(flag("start-at", 0));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decide(game, me) {
  const seat = game.players.findIndex((player) => player.id === me);
  if (seat < 0 || legalCommands(game, me).length === 0) return null;
  return botCommand(game, seat);
}

function runBot(name, setup) {
  const socket = io(URL, { path: PATH, transports: ["websocket"], reconnection: true });
  let room = null;
  let acting = false;
  let lastKey = "";
  const log = (...items) => console.log(`[${name}]`, ...items);
  const myPlayerId = () => room?.members.find((member) => member.id === socket.id)?.playerId;

  async function act() {
    if (acting || !room) return;
    const game = room.game;
    if (room.rematch && game?.phase === "finished") {
      if (!room.rematch.acceptedIds.includes(socket.id) && process.env.BOT_REMATCH !== "0") {
        acting = true;
        await sleep(DELAY);
        socket.emit("room:rematch", true, () => { acting = false; });
      }
      return;
    }
    if (!game || game.phase !== "playing") return;
    const me = myPlayerId();
    const key = `${game.version}:${game.stage}`;
    const command = decide(game, me);
    if (!command || key === lastKey) return;
    acting = true;
    lastKey = key;
    await sleep(DELAY);
    socket.emit("game:command", command, (response) => {
      acting = false;
      if (!response.ok) {
        log("被拒绝：", command.type, response.error);
        lastKey = "";
      } else {
        room = response.data;
      }
      void act(); // ack 之后按最新状态再判断一次
    });
  }

  socket.on("connect", () => {
    if (room) return;
    setup(socket, (snapshot) => {
      room = snapshot;
      void act();
    }, log);
  });
  socket.on("room:updated", (snapshot) => {
    room = snapshot;
    if (startAt && room.status === "waiting" && room.members.length >= startAt && room.members.find((m) => m.id === socket.id)?.isHost) {
      socket.emit("room:start", (response) => log(response.ok ? "开局" : `开局失败：${response.error}`));
    }
    if (room.game?.phase === "finished" && room.game.finalResult && !room.rematch?.acceptedIds.length) {
      const scores = room.game.players.map((player) => `${player.name} ${player.score ?? player.points}`).join(" / ");
      log("终局：", scores, "胜者", room.game.finalResult.winners.join(","));
    }
    void act();
  });
  socket.on("room:closed", ({ reason }) => {
    log("房间关闭：", reason);
    process.exit(0);
  });
  socket.on("connect_error", (error) => log("连不上：", error.message));
  return socket;
}

if (mode === "host") {
  const [name = "房主陪玩"] = positional;
  const options = flag("variant", "sichuan") === "riichi"
    ? { variant: "riichi", length: flag("length", "tonpuu") }
    : { variant: "sichuan", mode: flag("mode", "xuezhan"), hands: Number(flag("hands", 8)) };
  runBot(name, (socket, done, log) => {
    socket.emit("room:create", { name, options }, (response) => {
      if (!response.ok) {
        log("建房失败：", response.error);
        process.exit(1);
      }
      log("房间码", response.data.code);
      console.log(`ROOM ${response.data.code}`);
      done(response.data);
    });
  });
} else if (mode === "join" || mode === "fill") {
  const code = positional[0];
  const count = mode === "fill" ? Number(positional[1] ?? 1) : 1;
  const prefix = mode === "fill" ? positional[2] ?? "陪玩" : positional[1] ?? "陪玩";
  for (let k = 0; k < count; k += 1) {
    const name = mode === "fill" ? `${prefix}${k + 1}` : prefix;
    runBot(name, (socket, done, log) => {
      socket.emit("room:join", { name, code }, (response) => {
        if (!response.ok) {
          log("加入失败：", response.error);
          return;
        }
        log("已加入", code);
        done(response.data);
      });
    });
    await sleep(150);
  }
} else {
  console.log("用法见文件开头的注释。");
  process.exit(1);
}
