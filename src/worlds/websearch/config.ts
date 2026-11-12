import type { ConfigGroup } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import type { SearchDepth } from './tavily-client.ts';
import { text } from './strings.ts';

/** World 自有配置的默认值;启用状态由部署装配配置决定。 */
export const WEBSEARCH_DEFAULTS = {
  enabled: false,
  /** 结果偏向的国家(小写英文名);空串不偏 */
  country: '',
  searchDepth: 'basic' as SearchDepth,
  timeoutMs: 20000,
} as const;

/** 本 World 需要的密钥的环境变量名(core 不认识这个名字) */
export const WEBSEARCH_SECRET = 'TAVILY_API_KEY';

/** 本 World 声明的可调项:结果偏向哪个国家、检索深度、多久超时。文案按界面语言给。 */
export function webSearchConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:websearch',
    owner: 'world:websearch',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.websearch.country': {
          type: 'string',
          title: t.countryTitle,
          'x-hot': false,
          description: t.countryDescription,
        },
        'worlds.websearch.searchDepth': {
          type: 'string',
          title: t.searchDepthTitle,
          enum: ['basic', 'advanced'],
          'x-hot': false,
          description: t.searchDepthDescription,
        },
        'worlds.websearch.timeoutMs': {
          type: 'integer',
          title: t.timeoutTitle,
          minimum: 1000,
          maximum: 120_000,
          multipleOf: 1000,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': false,
          description: t.timeoutDescription,
        },
      },
    },
  };
}

/** config.json 的 `worlds.websearch` 节。全部在构造时读走,改完重启 World 生效。 */
export interface WebSearchConfigSection {
  enabled: boolean;
  country: string;
  searchDepth: SearchDepth;
  timeoutMs: number;
}
