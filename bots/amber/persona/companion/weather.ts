/**
 * 天气：她今天所在城市的实况。
 *
 * 用 Open-Meteo（免 key）：城市名先地理编码（同样免 key），再拉当前天气与当日高低温。
 * 没开开关、没填城市、编码或请求失败时一律返回 null——面板显示「暂无天气信息」，
 * 和她此刻没联网时的样子一致。不做静默重试：一次失败就等下一轮，原因写进日志。
 */

export interface WeatherSettings {
  enabled: boolean;
  /** 城市名，交给 Open-Meteo 地理编码；空 = 没配。 */
  city: string;
  refreshMinutes: number;
}

export interface WeatherReading {
  text: string;
  tempC: number | null;
  fetchedAt: number;
  source: string;
}

interface Coords {
  latitude: number;
  longitude: number;
  label: string;
}

/** WMO 天气码 → 中文。只收常见几档。 */
const WMO: Record<number, string> = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '细雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};

export function weatherText(code: number | null, current: number | null, low: number | null, high: number | null): string {
  const name = code !== null && WMO[code] ? WMO[code] : '';
  let range = '';
  if (low !== null && high !== null && Number.isFinite(low) && Number.isFinite(high)) {
    const lo = Math.round(low);
    const hi = Math.round(high);
    range = lo === hi ? `${lo}℃` : `${lo}–${hi}℃`;
  } else if (current !== null && Number.isFinite(current)) {
    range = `${Math.round(current)}℃`;
  }
  return [name, range].filter(Boolean).join(' ') || '天气数据不完整';
}

interface OpenMeteoResponse {
  current?: { temperature_2m?: number; weather_code?: number };
  daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
}

interface GeocodeResponse {
  results?: Array<{ latitude?: number; longitude?: number; name?: string; admin1?: string; country?: string }>;
}

export class WeatherService {
  private lastAttempt = 0;
  private coords: Coords | null = null;
  private coordsFor = '';

  constructor(
    private readonly settings: () => WeatherSettings,
    private readonly log: { warn(msg: string, data?: unknown): void } | null = null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** 到点没有：没有读数、或者过了刷新间隔。 */
  due(now: number, hasReading: boolean): boolean {
    const cfg = this.settings();
    if (!cfg.enabled || !cfg.city.trim()) return false;
    if (!hasReading) return true;
    return now - this.lastAttempt >= Math.max(15, cfg.refreshMinutes) * 60_000;
  }

  /** 城市 → 坐标；同一次进程里只编码一次，换城市才重来。 */
  private async resolve(city: string): Promise<Coords | null> {
    if (this.coords && this.coordsFor === city) return this.coords;
    const url = 'https://geocoding-api.open-meteo.com/v1/search'
      + `?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
    try {
      const res = await this.fetcher(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        this.log?.warn('天气地点解析失败', { status: res.status, city });
        return null;
      }
      const body = await res.json() as GeocodeResponse;
      const first = body.results?.[0];
      if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') {
        this.log?.warn('天气地点没找到', { city });
        return null;
      }
      this.coords = {
        latitude: first.latitude,
        longitude: first.longitude,
        label: [first.name, first.admin1].filter(Boolean).join(' '),
      };
      this.coordsFor = city;
      return this.coords;
    } catch (err) {
      this.log?.warn('天气地点解析异常', { error: String(err), city });
      return null;
    }
  }

  /** 拉一次；失败返回 null，调用方保留旧读数。 */
  async fetch(now = Date.now()): Promise<WeatherReading | null> {
    const cfg = this.settings();
    const city = cfg.city.trim();
    if (!cfg.enabled || !city) return null;
    this.lastAttempt = now;
    const coords = await this.resolve(city);
    if (!coords) return null;
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${coords.latitude}&longitude=${coords.longitude}`
      + '&current=temperature_2m,weather_code'
      + '&daily=temperature_2m_max,temperature_2m_min'
      + '&timezone=auto&forecast_days=1';
    try {
      const res = await this.fetcher(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        this.log?.warn('天气请求失败', { status: res.status });
        return null;
      }
      const body = await res.json() as OpenMeteoResponse;
      const current = typeof body.current?.temperature_2m === 'number' ? body.current.temperature_2m : null;
      const code = typeof body.current?.weather_code === 'number' ? body.current.weather_code : null;
      const low = Array.isArray(body.daily?.temperature_2m_min) ? body.daily.temperature_2m_min[0] ?? null : null;
      const high = Array.isArray(body.daily?.temperature_2m_max) ? body.daily.temperature_2m_max[0] ?? null : null;
      return {
        text: weatherText(code, current, low, high),
        tempC: current,
        fetchedAt: now,
        source: 'open-meteo',
      };
    } catch (err) {
      this.log?.warn('天气请求异常', { error: String(err) });
      return null;
    }
  }
}
