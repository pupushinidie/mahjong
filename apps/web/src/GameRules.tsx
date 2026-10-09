import { useEffect, useState } from "react";
import { TileView } from "./tiles.js";

/** 示意牌：二三四万（顺子）、五五五筒（刻子）、七七条（将）。 */
const EXAMPLE = [4 * 1 + 1, 4 * 2 + 1, 4 * 3 + 1, 4 * 13 + 1, 4 * 13 + 2, 4 * 13 + 3, 4 * 24 + 1, 4 * 24 + 2];

/** 规则说明：一个按钮，点开是像素弹窗。用自己的话写，不照搬别人的规则书。首页 / 等候房间不传玩法时两种都写。 */
function GameRules({ variant }: { variant?: "sichuan" | "riichi" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button className="quiet-button mj-rules-button" type="button" aria-expanded={open} onClick={() => setOpen(true)}>规则</button>
      {open && (
        <div className="gm-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section className="gm-panel mj-rules" role="dialog" aria-modal="true" aria-labelledby="mj-rules-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="mj-rules-title">{variant === "riichi" ? "立直麻将怎么打" : variant === "sichuan" ? "四川麻将怎么打" : "麻将规则"}</h2>
            {variant !== "riichi" && <SichuanRules />}
            {variant !== "sichuan" && <RiichiRules />}
            <div className="gm-panel-actions">
              <button className="primary-button" type="button" onClick={() => setOpen(false)}>知道了</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function SichuanRules() {
  return (
    <>
      <h3 className="mj-rules-variant">四川麻将</h3>
            <div className="game-rules-block">
              <h3>牌和目标</h3>
              <ul>
                <li>只有万、筒、条三门，每种 4 张，一共 108 张；没有字牌和花，不能吃，只能碰、杠。</li>
                <li>4 个座位，空座由机器人坐。打满设定的盘数（默认 8 盘），累计积分最高的人获胜。积分只是游戏分。</li>
                <li>胡牌：14 张凑成「4 组 + 1 对」（一组是三张连号的顺子，或者三张一样的刻子），或者 7 个对子。没有起胡番数，平胡也能胡。</li>
              </ul>
              <div className="mj-rules-tiles" aria-hidden="true">{EXAMPLE.map((tile) => <TileView key={tile} tile={tile} scale={2} />)}</div>
            </div>
            <div className="game-rules-block">
              <h3>开局：换三张、定缺</h3>
              <ul>
                <li>庄家 14 张，其他人 13 张。换三张（可以在开房时关掉）：每人挑 3 张同一门的牌，大家选好后同时交换，方向随机（给下家、上家或对家）。</li>
                <li>定缺：每人选一门不要，大家选好后同时公开。手里有这门牌时只能先打它；胡牌时 14 张里不能有这门；这门的牌不能碰也不能杠。</li>
              </ul>
            </div>
            <div className="game-rules-block">
              <h3>打牌</h3>
              <ul>
                <li>从庄家开始轮流摸一张、打一张。别人打出的牌，你手里有一对可以碰，有三张可以杠，能胡就胡。胡比碰杠优先，几个人都能胡就一起胡（一炮多响）。</li>
                <li>杠完从牌墙尾部补一张。杠马上收分（刮风下雨）：明杠放杠的人付 2，暗杠其他人各付 2，加杠其他人各付 1。加杠的那张别人能胡就会被抢杠。</li>
                <li>放过了能胡的牌，到你下次摸牌之前都不能胡别人打的牌（过胡），自摸不受影响。</li>
                <li>血战到底：胡了就下桌，剩下的人接着打，三家胡了或者牌摸完这一盘结束。血流成河：胡了不下桌，手牌锁定，摸到能胡的还能再胡，打到牌摸完。</li>
              </ul>
            </div>
            <div className="game-rules-block">
              <h3>算番和分数</h3>
              <ul>
                <li>一次胡牌得 2 的番数次方分（0 番 1 分、1 番 2 分、2 番 4 分……）。点炮只有放炮的人付，自摸其他还在局中的人都付。</li>
                <li>牌型：平胡 0、对对胡 1、七对 2、金钩钓（四组都碰杠出去，单钓一张）2。再加：清一色 +2、带幺九 +2、将对（对对胡/七对/金钩钓且全是二五八）+2、断幺九 +1、每个根（四张一样）+1、自摸 +1、杠上花 +1、杠上炮 +1、抢杠胡 +1、海底捞月 +1、天胡/地胡 +5。</li>
                <li>牌摸完还没结束：没听牌的人退还收到的杠分（退税）；手里还有缺门牌的是花猪，赔每个不是花猪的人 16 分；没听牌的人按每个听牌的人能胡的最大番赔分（查大叫）。</li>
                <li>杠完补牌打出的牌被别人胡了，这次杠收的分转给胡牌的人（呼叫转移）。</li>
              </ul>
            </div>
            <div className="game-rules-block">
              <h3>其他</h3>
              <ul>
                <li>限时：换三张 20 秒、定缺 10 秒、出牌 15 秒、碰杠胡 8 秒、结算 30 秒，超时自动处理（能胡自动胡，碰杠一律过，出牌先打缺门否则摸切）。连续超时 2 次转托管，点「取消托管」接回。掉线由机器人代打，用原昵称和房间码回来能接上。</li>
                <li>每张牌打出后都固定停一下再继续，别人看不出谁能碰、能胡。</li>
                <li>出牌：点一张牌选中，再点一次同一张（或点「打出」、按空格）才打出去；定缺也是先选一门再点「确定」，免得点错。</li>
                <li>快捷键：H 胡/自摸，P 碰，G 杠，空格 / 回车 打出选中的牌，Esc 取消选中或「过」，N 下一盘。</li>
              </ul>
            </div>
    </>
  );
}

/** 示意：一组门清听牌（234 万、567 万、78 筒、345 索、66 索，听 6 筒 / 9 筒）。 */
const RIICHI_EXAMPLE = [4 * 1 + 1, 4 * 2 + 1, 4 * 3 + 1, 4 * 15 + 1, 4 * 16 + 1, 4 * 20 + 1, 4 * 21 + 1, 4 * 22 + 1];

function RiichiRules() {
  return (
    <>
      <h3 className="mj-rules-variant">立直麻将（日本麻将）</h3>
      <div className="game-rules-block">
        <h3>牌和目标</h3>
        <ul>
          <li>万、筒、索各 1–9，加东南西北白发中，每种 4 张共 136 张；五万、五筒、五索里各有 1 张红五（开房可以关）。</li>
          <li>每人 25000 点起，打一个半庄（东风场 + 南风场，庄家连庄时局数更多）或东风战。结束时点数最多的第一。</li>
          <li>胡牌（和了）要凑成「4 组 + 1 对」、7 个不同的对子、或国士无双，<b>而且至少要有 1 个役</b>。宝牌只加番，不算役。</li>
        </ul>
        <div className="mj-rules-tiles" aria-hidden="true">{RIICHI_EXAMPLE.map((tile) => <TileView key={tile} tile={tile} scale={2} />)}</div>
      </div>
      <div className="game-rules-block">
        <h3>打牌</h3>
        <ul>
          <li>庄家先摸，轮流摸一张打一张。上家打的牌可以吃（凑顺子），谁打的都可以碰、明杠，能和就荣和。荣和优先，其次碰杠，最后才是吃；几家同时能荣和就一起和。</li>
          <li>吃碰完这一手不能打出同一种牌、也不能打顺子另一头接得上的那张（食替）。</li>
          <li>王牌 14 张摸不到：开局翻 1 张宝牌指示牌，它的下一张是宝牌。开杠从岭上补一张，再翻一张杠宝（暗杠马上翻，明杠、加杠在开杠的人打牌后翻）。</li>
          <li>立直：门清听牌、点数 ≥ 1000、牌墙还剩 4 张以上时可以宣告，交 1000 点。立直后只能摸切，能和就和；和了能翻里宝牌，立直后一巡内和了还有一发。</li>
          <li>振听：自己打过能和的牌、或者放过了能荣和的牌，就不能荣和，只能自摸（放过以后到自己再打一张为止；立直后放过整局都不行）。</li>
        </ul>
      </div>
      <div className="game-rules-block">
        <h3>常见的役</h3>
        <ul>
          <li>1 番：立直、一发、门前清自摸和、平和（全顺子、两面听、雀头不是役牌）、断幺九（副露也算）、一杯口、役牌（白发中、自风、场风的刻子）、岭上开花、抢杠、海底摸月、河底捞鱼。</li>
          <li>2 番：双立直、七对子、三色同顺、一气通贯、混全带幺九、三色同刻、三暗刻、三杠子、对对和、小三元、混老头。3 番：二杯口、混一色、纯全带幺九。6 番：清一色。副露时一部分役少算 1 番。</li>
          <li>役满：国士无双、四暗刻、大三元、小四喜、大四喜、字一色、绿一色、清老头、九莲宝灯、四杠子、天和、地和；普通役加宝牌 13 番以上算累计役满。</li>
        </ul>
      </div>
      <div className="game-rules-block">
        <h3>点数</h3>
        <ul>
          <li>基本点 = 符 × 2^(番 + 2)，5 番满贯 8000（庄家 12000），6–7 跳满、8–10 倍满、11–12 三倍满、役满 32000（庄家 48000）。荣和放铳的人付，自摸三家分着付。不切上满贯（4 番 30 符是 7700）。</li>
          <li>本场：每本场荣和多付 300、自摸每家多付 100。桌上的立直棒归和牌的人；几家同时荣和时本场和立直棒给离放铳的人最近的那家。</li>
          <li>牌摸完没人和：没听牌的人一共付 3000 给听牌的人；牌河全是幺九牌、没被拿走的人收流局满贯。庄家听牌或和牌就连庄。</li>
          <li>途中流局：九种九牌（第一巡手里 9 种以上幺九，可以选择流局）、四风连打、四家立直、四杠散了。</li>
          <li>大三元、大四喜最后一组是碰别人的牌凑成的，打出那张的人要负责（包牌）。</li>
          <li>有人点数低于 0 马上结束（击飞）。南 4 局打完有人到 30000 就结束，没人到就进西风场，有人到 30000 马上结束，最多打到西 4 局。南 4 局庄家和牌或听牌后是第一名（≥ 30000）也直接结束。最终得分 =（点数 − 30000）÷ 1000 + 马（+15 / +5 / −5 / −15），第一名再加 20。</li>
        </ul>
      </div>
      <div className="game-rules-block">
        <h3>其他</h3>
        <ul>
          <li>限时：每手 5 秒，用完了扣这一局的 20 秒备用时间，再超时自动处理（能和自动和，吃碰杠一律过，出牌摸切）。连续超时 2 次转托管。</li>
          <li>右边可以打开「自动和牌」「不吃碰杠」「自动摸切」。出牌和立直都是先选中、再点一次确认。</li>
          <li>快捷键：H 荣和 / 自摸，P 碰，C 吃，G 杠，R 立直，空格 / 回车 打出，Esc 取消或过，N 下一局。</li>
        </ul>
      </div>
    </>
  );
}

export default GameRules;
