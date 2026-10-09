import { useEffect, useState } from "react";
import { TileView } from "./tiles.js";

/** 示意牌：二三四万（顺子）、五五五筒（刻子）、七七条（将）。 */
const EXAMPLE = [4 * 1 + 1, 4 * 2 + 1, 4 * 3 + 1, 4 * 13 + 1, 4 * 13 + 2, 4 * 13 + 3, 4 * 24 + 1, 4 * 24 + 2];

/** 规则说明：一个按钮，点开是像素弹窗。用自己的话写，不照搬别人的规则书。 */
function GameRules() {
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
            <h2 id="mj-rules-title">四川麻将怎么打</h2>
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
            <div className="gm-panel-actions">
              <button className="primary-button" type="button" onClick={() => setOpen(false)}>知道了</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default GameRules;
