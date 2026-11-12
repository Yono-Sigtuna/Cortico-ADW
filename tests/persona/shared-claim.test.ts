/**
 * 认领的优先级：点名优先于先到。
 * 之前的规则只按谁先抢，导致「claude，你去做…」被白龙先认领、琥珀直接收工。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { homeClaimTool, publishIdentity, type SharedHomeDeps } from '../../bots/amber/persona/shared.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(beat: string) {
  const root = mkdtempSync(join(tmpdir(), 'claim-'));
  roots.push(root);
  const deps = (id: string, qq: number, names: string[]): SharedHomeDeps => ({
    memoryDir: join(root, 'deployments', id, 'memory'),
    selfId: id,
    selfLabel: id,
    selfQq: qq,
    selfNames: names,
    recentMessages: () => [{ at: 1_700_000_000_000, from: '3124076548', text: beat }],
  });
  const dA = deps('amber', 3929446263, ['claude', '克劳德', '大小姐']);
  const dB = deps('bailong', 3199133998, ['gpt', '白龙', '龙娘']);
  publishIdentity(dA);
  publishIdentity(dB);
  return { amber: homeClaimTool(dA), bailong: homeClaimTool(dB) };
}

const claim = async (tool: ReturnType<typeof homeClaimTool>, conversation = 'group:1') =>
  String(await tool.handler({ conversation }, {} as never));

it('点名的人被抢先认领后，仍然能把这拍拿回来', async () => {
  const { amber, bailong } = setup('claude，你根据这些名单去查这些游戏的设计点');
  expect(await claim(bailong)).toContain('[claim taken]');
  expect(await claim(amber)).toContain('[claim ok]');
});

it('叫别人的名字时，没被点到的人不抢', async () => {
  const { amber, bailong } = setup('白龙，你去看一下那份名单');
  expect(await claim(amber)).toContain('[claim taken]');
  expect(await claim(bailong)).toContain('[claim ok]');
});

it('拿回来之后，原来那个人再来认领会被挡', async () => {
  const { amber, bailong } = setup('群里这几天好安静');
  expect(await claim(bailong)).toContain('[claim ok]');
  expect(await claim(amber)).toContain('[claim taken]');
});

it('没人点名时谁先到谁答', async () => {
  const { amber, bailong } = setup('今天群里好安静');
  expect(await claim(amber)).toContain('[claim ok]');
  expect(await claim(bailong)).toContain('[claim taken]');
});
