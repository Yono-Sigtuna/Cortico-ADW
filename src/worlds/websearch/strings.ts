import { pick, type Language } from '../../core/language.ts';

/** 给操作员看的文案。 */
const zh = {
  // ── 配置组 ─────────────────────────────────────────────────────────
  configTitle: 'WebSearch · 检索偏好',
  configDescription: 'Tavily 的检索深度与国家偏好;改完重启生效(客户端构造时固定)。',
  countryTitle: '结果偏向国家',
  countryDescription: '小写英文名,如 china / united states;留空不偏。新闻检索不用这一项。',
  searchDepthTitle: '检索深度',
  searchDepthDescription: 'basic 快而省;advanced 多抓一页、更准也更贵。',
  timeoutTitle: '请求超时',
  timeoutDescription: '单次搜索请求的超时。',
  // ── WebUI 露出 ─────────────────────────────────────────────────────
  moduleLabel: 'WebSearch',
  key: '密钥',
  keySet: '已配置',
  keyUnset: '未配置',
  keyUnsetBadge: '未配置(工具仍在,调用会提示)',
  promptDocTitle: 'WebSearch · 环境提示词',
  promptDocDescription: '搜索工具 World 的可选常驻环境;留空时不进入系统前缀。',
};

export const en: typeof zh = {
  configTitle: 'WebSearch · Search preferences',
  configDescription: 'Tavily search depth and country bias. Changes take effect after a restart (fixed when the client is created).',
  countryTitle: 'Result country',
  countryDescription: 'Lowercase English name, e.g. china / united states. Empty means unbiased. Unused by news searches.',
  searchDepthTitle: 'Search depth',
  searchDepthDescription: 'basic is fast and cheap; advanced fetches more and is more accurate and expensive.',
  timeoutTitle: 'Request timeout',
  timeoutDescription: 'Timeout for one search request.',
  moduleLabel: 'WebSearch',
  key: 'API key',
  keySet: 'Set',
  keyUnset: 'Not set',
  keyUnsetBadge: 'Not set (the tool stays available and reports this when called)',
  promptDocTitle: 'WebSearch · Environment prompt',
  promptDocDescription: 'Optional standing environment for the search World. Left empty, it stays out of the system prefix.',
};

export const text = (language: Language) => pick(language, { zh, en });
