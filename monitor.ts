/**
 * rugs.fun standard game monitor — Puppeteer WebSocket interception
 */

import puppeteer, {
  type Browser,
  type Page,
  type CDPSession,
} from "puppeteer";
import { logger } from "./logger";

const RUGS_URL = "https://rugs.fun";
const PAGE_TIMEOUT_MS = 25_000;
const HEARTBEAT_MS = 30_000;
const PAGE_REFRESH_MS = 4 * 60 * 1000; // refresh every 4 min before memory crash

async function sendWebhook(key: string, content: string): Promise<void> {
  const url = process.env[key];
  if (!url) { logger.warn({ key }, "Webhook env var not set — skipping"); return; }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) logger.error({ key, status: res.status }, "Webhook delivery failed");
    else logger.debug({ key }, "Webhook sent");
  } catch (err) {
    logger.error({ err, key }, "Webhook fetch error");
  }
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtTs(): string {
  return new Date().toUTCString().replace(" GMT", " UTC");
}

let roundsSinceLong = 0;
let roundsSince100x = 0;
let roundsSinceInsta = 0;
let totalRounds = 0;

async function onRoundEnd(mult: number, durS: number): Promise<void> {
  totalRounds++;
  const dur = fmtDuration(durS);
  const ts = fmtTs();
  const isLong = durS >= 130;
  const is100x = mult >= 100;
  const isInsta = durS <= 5;

  logger.info({ multiplier: mult.toFixed(2), duration: dur, isLong, is100x, isInsta, totalRounds }, "Round ended");

  await sendWebhook("ALL_WEBHOOK", [
    `**Round ended** · #${totalRounds}`,
    `⏱ Duration: **${dur}**  |  💥 Multiplier: **${mult.toFixed(2)}x**`,
    `\`${ts}\``,
  ].join("\n"));

  if (isLong) {
    await sendWebhook("LONG_WEBHOOK", [
      `🐋 **LONG ROUND!**`,
      `Duration: **${dur}** (≥130 s)  |  Multiplier: **${mult.toFixed(2)}x**`,
      `Long round came after **${roundsSinceLong}** normal rounds since the last one`,
      `\`${ts}\``,
    ].join("\n"));
    roundsSinceLong = 0;
  } else if (!isInsta && !is100x) {
    roundsSinceLong++;
  }

  if (is100x) {
    await sendWebhook("HUNDREDX_WEBHOOK", [
      `🚀 **100x+ ROUND!**`,
      `Multiplier: **${mult.toFixed(2)}x**  |  Duration: **${dur}**`,
      `100x+ came after **${roundsSince100x}** normal rounds since the last one`,
      `\`${ts}\``,
    ].join("\n"));
    roundsSince100x = 0;
  } else if (!isInsta && !isLong) {
    roundsSince100x++;
  }

  if (isInsta) {
    await sendWebhook("INSTA_WEBHOOK", [
      `💥 **INSTA-RUG!**`,
      `Duration: **${dur}** (≤5 s)  |  Multiplier: **${mult.toFixed(2)}x**`,
      `Insta-rug came after **${roundsSinceInsta}** normal rounds since the last one`,
      `\`${ts}\``,
    ].join("\n"));
    roundsSinceInsta = 0;
  } else if (!isLong && !is100x) {
    roundsSinceInsta++;
  }
}

interface RoundTracker {
  phase: "prep" | "round";
  roundStartMs: number | null;
  peakMultiplier: number;
  lastGameId: string | null;
  processedIds: Set<string>;
}

function makeTracker(): RoundTracker {
  return { phase: "prep", roundStartMs: null, peakMultiplier: 1, lastGameId: null, processedIds: new Set() };
}

let tracker = makeTracker();

function handleGameEvent(eventName: string, data: Record<string, unknown>): void {
  logger.debug({ eventName }, "Game event");

  switch (eventName) {
    case "game:standard:phase": {
      const phase = data.phase as string | undefined;
      const gameId = data.gameId as string | undefined;
      if (!phase) break;

      if (phase === "round") {
        tracker.phase = "round";
        tracker.roundStartMs = Date.now();
        tracker.peakMultiplier = 1;
        if (gameId) tracker.lastGameId = gameId;
        logger.info({ gameId }, "Round started");
      } else if (phase === "crash") {
        if (gameId && tracker.processedIds.has(gameId)) break;

        const prices = data.prices as number[] | undefined;
        const peakMult = prices && prices.length > 0 ? Math.max(...prices) : tracker.peakMultiplier;
        const durS = tracker.roundStartMs ? (Date.now() - tracker.roundStartMs) / 1000 : 0;

        if (gameId) {
          tracker.processedIds.add(gameId);
          if (tracker.processedIds.size > 100) {
            const first = tracker.processedIds.values().next().value;
            if (first !== undefined) tracker.processedIds.delete(first);
          }
          tracker.lastGameId = gameId;
        }

        tracker.phase = "prep";
        tracker.roundStartMs = null;
        tracker.peakMultiplier = 1;

        logger.info({ gameId, peakMult: peakMult.toFixed(2), durS: durS.toFixed(1) }, "Round crashed");
        onRoundEnd(peakMult, durS).catch((err) => logger.error({ err }, "onRoundEnd threw"));
      } else {
        tracker.phase = "prep";
      }
      break;
    }

    case "game:standard:tick": {
      const prices = data.p as number[] | undefined;
      if (prices && prices.length > 0) {
        const current = prices[prices.length - 1];
        if (current !== undefined && current > tracker.peakMultiplier) tracker.peakMultiplier = current;
      }
      break;
    }
  }
}

function parseSocketIOFrame(raw: string): [string, Record<string, unknown>] | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^42(?:\/[^,]*,)?\d*(\[.*)$/s);
  if (!m) return null;
  let arr: unknown[];
  try { arr = JSON.parse(m[1]!) as unknown[]; } catch { return null; }
  if (!Array.isArray(arr) || arr.length < 1) return null;
  const eventName = arr[0];
  if (typeof eventName !== "string") return null;
  const dataArg = arr.length > 1 ? arr[arr.length - 1] : {};
  if (typeof dataArg !== "object" || dataArg === null) return null;
  return [eventName, dataArg as Record<string, unknown>];
}

async function launchPage(browser: Browser, onCrash: () => void): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Trigger immediate restart on page crash or close
  page.on("error", (err) => {
    logger.error({ err }, "Page error — restarting");
    onCrash();
  });
  page.on("close", () => {
    logger.info("Page closed — restarting");
    onCrash();
  });

  const client: CDPSession = await page.createCDPSession();
  await client.send("Network.enable");

  client.on("Network.webSocketFrameReceived", ({ response }: { response: { payloadData: string } }) => {
    const parsed = parseSocketIOFrame(response.payloadData);
    if (!parsed) return;
    const [eventName, data] = parsed;
    if (!eventName.startsWith("game:standard:")) return;
    handleGameEvent(eventName, data);
  });

  client.on("Target.targetCrashed", (event) => {
    logger.error({ event }, "CDP target crashed — restarting");
    onCrash();
  });

  logger.info({ url: RUGS_URL }, "Navigating to rugs.fun");
  try {
    await page.goto(RUGS_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    logger.error({ err }, "Navigation to rugs.fun failed");
    throw err;
  }
  await new Promise((r) => setTimeout(r, 5_000));
  logger.info("Page ready — intercepting game events via CDP");
  return page;
}

export async function startMonitor(): Promise<void> {
  logger.info("Starting rugs.fun monitor (WS intercept mode)");

  let browser: Browser | null = null;
  let page: Page | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let restarting = false;

  async function ensureBrowser(): Promise<void> {
    // Clean up old browser
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    try {
      if (page && !page.isClosed()) await page.close().catch(() => {});
    } catch {}
    try { if (browser) await browser.close().catch(() => {}); } catch {}
    browser = null;
    page = null;
    tracker.processedIds.clear();
    // Give the OS time to reclaim file descriptors and process slots
    await new Promise((r) => setTimeout(r, 2_000));

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--no-first-run",
        "--no-zygote",
        "--mute-audio",
      ],
    });

    tracker = makeTracker();
    restarting = false;

    browser.on("disconnected", () => {
      logger.warn("Browser disconnected — will relaunch");
      browser = null;
      page = null;
      scheduleRestart(3_000);
    });

    const onCrash = () => scheduleRestart(3_000);

    page = await launchPage(browser, onCrash);

    // Proactively refresh every 4 min to prevent memory-induced crash
    refreshTimer = setTimeout(() => {
      logger.info("Proactive page refresh (4 min) — restarting browser");
      scheduleRestart(0);
    }, PAGE_REFRESH_MS);
  }

  let restartFailures = 0;

  function scheduleRestart(delayMs: number): void {
    if (restarting) return;
    restarting = true;
    setTimeout(async () => {
      try {
        await ensureBrowser();
        logger.info("Browser restarted successfully");
        restartFailures = 0;
      } catch (err) {
        restartFailures++;
        // Exponential backoff: 30s on first failure, 60s on second+
        const retryDelay = restartFailures === 1 ? 30_000 : 60_000;
        logger.error({ err, restartFailures, retryDelay }, `Browser restart failed — retrying in ${retryDelay / 1000}s`);
        restarting = false;
        scheduleRestart(retryDelay);
      }
    }, delayMs);
  }

  await ensureBrowser().catch((err) => {
    logger.error({ err }, "Initial browser launch failed — will retry");
    scheduleRestart(10_000);
  });

  // Heartbeat
  setInterval(() => {
    logger.info({
      phase: tracker.phase,
      totalRounds,
      roundsSinceLong,
      roundsSince100x,
      roundsSinceInsta,
      lastGameId: tracker.lastGameId,
      browserAlive: !!browser,
      pageAlive: !!page && !page.isClosed(),
    }, "Monitor alive");

    // Fallback: if browser/page silently died and no restart scheduled
    if (!browser || !page || page.isClosed()) {
      scheduleRestart(1_000);
    }
  }, HEARTBEAT_MS);
}
