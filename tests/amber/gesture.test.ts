/** 动作描写：接戏优先、普通闲聊不加；睡着时换成"回或不回"。 */
import { describe, it, expect } from 'vitest';
import {
  activityGesture, countActions, detectSceneAction, gestureLine, hasAction,
} from '../../bots/amber/persona/gesture.ts';

describe('动作描写 · 每轮提示', () => {
  it('醒着且没有对手动作：只列该写的时刻，普通闲聊不加', () => {
    const line = gestureLine({ enabled: true, sleeping: false })!;
    expect(line).toContain('前提');
    expect(line).toContain('耍赖');
    expect(line).toContain('强烈情绪');
    expect(line).toContain('碰到实物');
    expect(line).toContain('普通闲聊不加');
    expect(line).toContain('一条最多一处');
    expect(line).toContain('十二字');
  });

  it('对方这条里有身体动作：要求用动作接戏，而不是"可写可不写"', () => {
    const line = gestureLine({ enabled: true, sleeping: false, sceneAction: '（捏住鼻子）' })!;
    expect(line).toContain('对方这条里有身体动作');
    expect(line).toContain('接戏');
    expect(line).toContain('（拍开手）');
    expect(line).not.toContain('普通闲聊不加');
  });

  it('手头的事决定样例：读书→把书合上，整理→停下笔，没有就不举例', () => {
    expect(activityGesture('读书，坐在窗边')).toBe('（把书合上）');
    expect(activityGesture('整理笔记：把昨晚那一段写进观察')).toBe('（停下笔）');
    expect(activityGesture('喝茶发呆')).toBe('（把杯子放下）');
    expect(activityGesture('')).toBeNull();
    const line = gestureLine({ enabled: true, sleeping: false, activity: '读书，坐在窗边' })!;
    expect(line).toContain('把书合上');
    expect(line).not.toContain('现在手头是「」');
  });

  it('关掉且醒着：什么都不注入（宪法那一条同时失效）', () => {
    expect(gestureLine({ enabled: false, sleeping: false })).toBeNull();
  });

  it('睡着：先回答"要不要回"，开着时允许一处动作', () => {
    const on = gestureLine({ enabled: true, sleeping: true })!;
    expect(on).toContain('你在睡');
    expect(on).toContain('不回');
    expect(on).toContain('一处动作');

    const off = gestureLine({ enabled: false, sleeping: true })!;
    expect(off).toContain('你在睡');
    expect(off).toContain('不写括号');
  });
});

describe('接戏检测', () => {
  it('括号动作、明显动词都算；普通闲聊不算', () => {
    expect(detectSceneAction('（捏住鼻子）你闻到了吗')).toContain('捏住鼻子');
    expect(detectSceneAction('我钻进被窝了')).toBeTruthy();
    expect(detectSceneAction('（死死抱住被子）')).toContain('抱住被子');
    expect(detectSceneAction('把碗推回去')).toBeTruthy();
    expect(detectSceneAction('今天天气不错')).toBeNull();
    expect(detectSceneAction('我把他拉黑了')).toBeNull();
    expect(detectSceneAction('')).toBeNull();
  });

  it('括号里是号或者称谓，不是身体：不当接戏信号', () => {
    // 引用前缀里的 QQ 号和 @ 后面的称谓都长着括号的样子。
    expect(detectSceneAction('#1845700376 [群「g」 00:22] 甲(3926982253): 晚安')).toBeNull();
    expect(detectSceneAction('@Claude🍊昂贵橘子精(你) 晚安')).toBeNull();
  });

  it('前一个括号是号、后一个才是动作：取动作那一个', () => {
    expect(detectSceneAction('甲(3001): 好啊（把书合上）')).toContain('把书合上');
  });
});

describe('动作密度', () => {
  it('数括号里的动作', () => {
    expect(countActions('（翻身）……不要动我')).toBe(1);
    expect(countActions('(把书扣在胸口)嗯？(又睡着了)')).toBe(2);
    expect(countActions('没有动作的一句话')).toBe(0);
    expect(hasAction('（小声）嗯')).toBe(true);
    expect(hasAction('纯文字')).toBe(false);
  });
});

describe('动作描写 · 跟着房间走', () => {
  const base = { enabled: true, sleeping: false, activity: '泡茶' };

  it('群里一条接一条时收短：一处、八个字以内', () => {
    const line = gestureLine({ ...base, room: { heat: 'flood', speakers: 5 } })!;
    expect(line).toContain('八个字以内');
    expect(line).toContain('能不加就不加');
  });

  it('只有两个人安静说话时放宽：普通闲聊也可以带一处', () => {
    const line = gestureLine({ ...base, room: { heat: 'quiet', speakers: 2 } })!;
    expect(line).toContain('这里只有你们俩在说话');
    expect(line).toContain('一条仍然只有一处');
  });

  it('人多但正常节奏时不改判据', () => {
    const line = gestureLine({ ...base, room: { heat: 'normal', speakers: 4 } })!;
    expect(line).not.toContain('这里只有你们俩');
    expect(line).toContain('一条最多一处、十二字以内');
  });

  it('接戏优先于房间：对方动了身体就必须接，只是提醒省着写', () => {
    const line = gestureLine({ ...base, sceneAction: '（捏住鼻子）', room: { heat: 'flood', speakers: 6 } })!;
    expect(line).toContain('接戏就要用一处动作回应');
    expect(line).toContain('动作能省就省');
  });
});
