import { describe, expect, it } from "vitest";
import { ManualClock } from "../runtime/clock.ts";
import {
  NO_WEATHER,
  parseWeather,
  precipitationOf,
  WEATHER_EVERY_MS,
  WEATHER_STALE_MS,
  WeatherService,
  weatherUrl,
} from "./weather.ts";

const T0 = Date.UTC(2026, 10, 24, 11, 15);
const quiet = { info: () => {}, warn: () => {} };

/** Open-Meteo's answer for the current weather. */
const answer = (code: number, mm: number, time = T0) => ({
  current: {
    time: time / 1000,
    interval: 900,
    weather_code: code,
    precipitation: mm,
    temperature_2m: 0.6,
  },
});

describe("precipitationOf", () => {
  it("rain, drizzle, snow and showers all count, by how heavy they are", () => {
    expect(precipitationOf(71, 0.07)).toBe(1); // slight snow
    expect(precipitationOf(77, 0.1)).toBe(1); // snow grains
    expect(precipitationOf(61, 0.1)).toBe(1); // slight rain: snow on the site too
    expect(precipitationOf(53, 0)).toBe(2); // moderate drizzle
    expect(precipitationOf(75, 0)).toBe(3); // heavy snow
    expect(precipitationOf(82, 0)).toBe(3); // violent showers
    expect(precipitationOf(95, 0)).toBe(2); // thunderstorm
  });

  it("nothing falls under clouds or fog; the millimetres count without a code", () => {
    expect(precipitationOf(3, 0)).toBe(0); // overcast
    expect(precipitationOf(45, 0)).toBe(0); // fog
    expect(precipitationOf(null, null)).toBe(0);
    expect(precipitationOf(3, 0.2)).toBe(1);
    expect(precipitationOf(null, 1)).toBe(2);
    expect(precipitationOf(null, 3)).toBe(3);
  });
});

describe("parseWeather", () => {
  it("reads the current step in Unix time", () => {
    expect(parseWeather(answer(71, 0.07))).toEqual({
      precipitation: 1,
      code: 71,
      temperature: 0.6,
      at: T0,
    });
  });

  it("an answer of another shape is no weather", () => {
    expect(parseWeather(null)).toBeNull();
    expect(parseWeather({ error: true, reason: "nope" })).toBeNull();
    expect(parseWeather({ current: { time: "2026-11-24T13:15" } })).toBeNull();
  });

  it("asks for Kyiv, the current step only, in Unix time", () => {
    expect(weatherUrl()).toBe(
      "https://api.open-meteo.com/v1/forecast?latitude=50.45&longitude=30.52" +
        "&current=weather_code,precipitation,temperature_2m&timeformat=unixtime",
    );
  });
});

describe("WeatherService", () => {
  function service(reply: () => Promise<Response>) {
    const clock = new ManualClock(T0);
    const urls: string[] = [];
    const weather = new WeatherService({
      clock,
      log: quiet,
      fetch: async (url) => {
        urls.push(url);
        return reply();
      },
    });
    return { clock, urls, weather };
  }
  const json =
    (body: unknown, status = 200) =>
    async () =>
      Response.json(body, { status });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("asks at once and every 15 minutes", async () => {
    let code = 71;
    const { clock, urls, weather } = service(async () =>
      Response.json(answer(code, code === 3 ? 0 : 0.07, clock.now())),
    );
    weather.start();
    await settle();
    expect(urls).toHaveLength(1);
    expect(weather.now().precipitation).toBe(1);

    code = 3; // the snow stops
    clock.advanceBy(WEATHER_EVERY_MS);
    await settle();
    expect(urls).toHaveLength(2);
    expect(weather.now()).toMatchObject({ precipitation: 0, code: 3 });
    weather.stop();
  });

  it("keeps the last weather through a failure, again in 3 minutes, and none once it is old", async () => {
    let fail = false;
    const { clock, urls, weather } = service(async () =>
      fail ? new Response("down", { status: 503 }) : Response.json(answer(73, 0.6, T0)),
    );
    await weather.poll();
    expect(weather.now().precipitation).toBe(2);

    fail = true;
    clock.advanceBy(WEATHER_EVERY_MS);
    await settle();
    expect(weather.now().precipitation).toBe(2);
    clock.advanceBy(3 * 60_000);
    await settle();
    expect(urls).toHaveLength(3);

    clock.advanceBy(WEATHER_STALE_MS);
    expect(weather.now()).toEqual(NO_WEATHER);
    weather.stop();
  });

  it("an odd answer changes nothing", async () => {
    const { weather } = service(json({ reason: "Parameter is invalid" }, 400));
    await weather.poll();
    expect(weather.now()).toEqual(NO_WEATHER);
    weather.stop();
  });
});
