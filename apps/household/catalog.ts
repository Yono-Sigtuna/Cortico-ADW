import { coreConfigGroup } from '../../src/core/config.ts';
import { PERSONA_CONFIG_GROUP } from '../../bots/amber/persona/config.ts';
import { qqConfigGroup } from '../../src/worlds/qq/config.ts';
import { webSearchConfigGroup } from '../../src/worlds/websearch/config.ts';
import type { Language } from '../../src/core/language.ts';
import type { ConfigGroup } from '../../src/core/config-schema.ts';

/** Declarations only: assembling groups must not construct a Persona or mount a World. */
export function loadCatalog(language: Language = 'zh'): ConfigGroup[] {
  const core = coreConfigGroup(language);
  core.schema.properties.activeProvider = { type: 'string', title: '当前模型端点', 'x-options': 'provider' };
  return [core, PERSONA_CONFIG_GROUP, qqConfigGroup(language), webSearchConfigGroup(language)];
}
