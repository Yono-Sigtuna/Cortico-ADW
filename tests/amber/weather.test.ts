/** 天气：天气码翻译、地理编码、成功/失败路径与刷新节流。 */
import { describe, it, expect } from 'vitest';
import { WeatherService, weatherText, type WeatherSettings } from '../../bots/amber/persona/companion/weather.ts';

const settings = (patch: Partial<WeatherSettings> = {}): WeatherSettings => ({
  enabled: true,
  city: '上海',
  refreshMinutes: 90,
  ...patch,
});

/** 依次回答地理编码与天气的假 fetch。 */
function fakeFetch(weather: unknown, geocode: unknown = { results: [{ latitude: 31.2, longitude: 121.5, name: '上海' }] }): typeof fetch {
  let call = 0;
  return (async (url: string) => {
    call += 1;
    if (String(url).includes('geocoding')) {
      return { ok: true, json: async () => geocode } as unknown as Response;
    }
    return { ok: true, json: async () => weather } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('天气 · 文案', () => {
  it('天气码与高低温', () => {
    expect(weatherText(2, 21.4, 18.2, 24.6)).toBe('多云 18–25℃');
    expect(weatherText(61, 12, 12, 12)).toBe('小雨 12℃');
    expect(weatherText(null, 21, null, null)).toBe('21℃');
    expect(weatherText(999, null, null, null)).toBe('天气数据不完整');
  });
});

describe('天气 · 服务', () => {
  it('关掉或没城市就不拉', async () => {
    expect(await new WeatherService(() => settings({ enabled: false }), null, fakeFetch({})).fetch()).toBeNull();
    expect(await new WeatherService(() => settings({ city: '' }), null, fakeFetch({})).fetch()).toBeNull();
    expect(new WeatherService(() => settings({ enabled: false }), null).due(Date.now(), false)).toBe(false);
  });

  it('地理编码 + 当前天气合成一句读数', async () => {
    const service = new WeatherService(() => settings(), null, fakeFetch({
      current: { temperature_2m: 21.4, weather_code: 2 },
      daily: { temperature_2m_max: [24.6], temperature_2m_min: [18.2] },
    }));
    const reading = await service.fetch(Date.parse('2026-10-25T06:00:00Z'));
    expect(reading).toMatchObject({ text: '多云 18–25℃', tempC: 21.4, source: 'open-meteo' });
  });

  it('没找到城市或请求失败时返回 null，不抛错', async () => {
    const noCity = new WeatherService(() => settings(), null, fakeFetch({}, { results: [] }));
    expect(await noCity.fetch()).toBeNull();
    const broken = new WeatherService(() => settings(), null, (async () => { throw new Error('断网'); }) as unknown as typeof fetch);
    expect(await broken.fetch()).toBeNull();
  });

  it('到点才刷新：没有读数立刻拉，有读数按间隔', () => {
    let now = Date.parse('2026-10-25T06:00:00Z');
    const service = new WeatherService(() => settings(), null);
    expect(service.due(now, false)).toBe(true);
    void service.fetch(now);
    expect(service.due(now + 60_000, true)).toBe(false);
    expect(service.due(now + 91 * 60_000, true)).toBe(true);
    void now;
  });
});
