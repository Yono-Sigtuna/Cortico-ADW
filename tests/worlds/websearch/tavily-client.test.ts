import { afterEach, describe, expect, it, vi } from 'vitest';
import { TavilyApiError, TavilyClient } from '../../../src/worlds/websearch/tavily-client.ts';

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function makeClient(overrides: Partial<ConstructorParameters<typeof TavilyClient>[0]> = {}): TavilyClient {
  return new TavilyClient({
    apiKey: 'test-key',
    country: '',
    searchDepth: 'basic',
    timeoutMs: 5000,
    ...overrides,
  });
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('TavilyClient.search', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('mode=auto → general,鉴权头与正文正确,content 压成 snippet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        results: [
          { title: 'A', url: 'https://a.example', content: '多行\n\n片段   一' },
          { title: 'B', url: 'https://b.example', content: '纯文本' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().search('OpenAI', { mode: 'auto', fresh: 'any', n: 4 });
    expect(out.endpoint).toBe('general');
    expect(out.results).toEqual([
      { title: 'A', url: 'https://a.example', snippet: '多行 片段 一' },
      { title: 'B', url: 'https://b.example', snippet: '纯文本' },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = bodyOf(fetchMock);
    expect(body).toMatchObject({
      query: 'OpenAI',
      search_depth: 'basic',
      max_results: 4,
      include_answer: false,
      include_images: false,
    });
    expect(body.topic).toBeUndefined();
    expect(body.country).toBeUndefined();
  });

  it('fresh 映射到 time_range,any 不发', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().search('q1', { mode: 'links', fresh: 'week', n: 4 });
    expect(bodyOf(fetchMock, 0).time_range).toBe('week');

    await makeClient().search('q2', { mode: 'links', fresh: 'any', n: 4 });
    expect(bodyOf(fetchMock, 1).time_range).toBeUndefined();
  });

  it('mode=news → topic=news,即使配了 country 也不发', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ results: [{ title: 'N', url: 'https://n.example', content: 'd' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient({ country: 'china' }).search('q', { mode: 'news', fresh: 'day', n: 2 });
    expect(out.endpoint).toBe('news');
    expect(out.results).toEqual([{ title: 'N', url: 'https://n.example', snippet: 'd' }]);
    const body = bodyOf(fetchMock);
    expect(body.topic).toBe('news');
    expect(body.country).toBeUndefined();
    expect(body.time_range).toBe('day');
  });

  it('mode=answer → include_answer=advanced,答案取回并截断', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        answer: '这是答案',
        results: [{ title: 'S', url: 'https://s.example', content: '依据' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().search('q', { mode: 'answer', fresh: 'any', n: 3 });
    expect(out.answer).toBe('这是答案');
    expect(out.results).toHaveLength(1);
    expect(bodyOf(fetchMock).include_answer).toBe('advanced');
  });

  it('mode=images → include_images,images 各自成条且不超过 n', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        images: [
          { url: 'https://img.example/1.png', description: '第一张' },
          { url: 'https://img.example/2.png', description: '第二张' },
          { url: 'https://img.example/3.png', description: '第三张' },
        ],
        results: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().search('q', { mode: 'images', fresh: 'any', n: 2 });
    expect(out.endpoint).toBe('general + images');
    expect(out.images).toEqual([
      { url: 'https://img.example/1.png', title: '第一张' },
      { url: 'https://img.example/2.png', title: '第二张' },
    ]);
    const body = bodyOf(fetchMock);
    expect(body.include_images).toBe(true);
    expect(body.include_image_descriptions).toBe(true);
  });

  it('配了 country 且非新闻 → 正文带 country', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await makeClient({ country: 'china' }).search('q', { mode: 'links', fresh: 'any', n: 4 });
    expect(bodyOf(fetchMock).country).toBe('china');
  });

  it('searchDepth=advanced 透传', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await makeClient({ searchDepth: 'advanced' }).search('q', { mode: 'links', fresh: 'any', n: 4 });
    expect(bodyOf(fetchMock).search_depth).toBe('advanced');
  });

  it('429 退避重试后成功', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const p = makeClient().search('q', { mode: 'links', fresh: 'any', n: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    const out = await p;
    expect(out.results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('401 直抛 TavilyApiError,带出 detail.error,不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: { error: 'Unauthorized: missing or invalid API key.' } }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeClient().search('q', { mode: 'links', fresh: 'any', n: 4 })).rejects.toMatchObject({
      name: 'TavilyApiError',
      status: 401,
      message: 'Tavily API 401 (Unauthorized: missing or invalid API key.)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重试次数耗尽后仍失败 → 抛最后一次的 TavilyApiError', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const p = makeClient().search('q', { mode: 'links', fresh: 'any', n: 4 });
    const assertion = expect(p).rejects.toBeInstanceOf(TavilyApiError);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 首次 + 2次重试
  });
});
