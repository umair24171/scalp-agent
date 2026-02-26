import { ScalpEngine }     from './ScalpEngine.js';
import { MT5ScalpBridge }  from './MT5ScalpBridge.js';

// ═══════════════════════════════════════════════════════════════
// SCALP AGENT — Main Entry Point
// Run: node src/scalp_index.js
// ═══════════════════════════════════════════════════════════════

const SYMBOLS    = (process.env.SCALP_WATCHLIST || 'XAU/USD').split(',').map(s => s.trim());
const API_KEY    = process.env.TWELVEDATA_API_KEY;
const DISCORD    = process.env.DISCORD_WEBHOOK_URL;

const engine = new ScalpEngine();
const mt5    = new MT5ScalpBridge({ enabled: process.env.MT5_AUTO_TRADE === 'true' });

// ── Candle buffers for resampling 1m → 5m ──
const buffer5m = {}; // { symbol: { ts, o, h, l, c } | null }

// ── Discord notification ──
async function notify(msg) {
  if (!DISCORD) return;
  try {
    await fetch(DISCORD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    });
  } catch {}
}

// ── Fetch latest 1min candle from TwelveData ──
async function fetchLatest1m(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=35&apikey=${API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.values) return null;
  return data.values.reverse().map(v => ({
    ts:    new Date(v.datetime + 'Z').getTime(),
    open:  parseFloat(v.open),  high: parseFloat(v.high),
    low:   parseFloat(v.low),   close: parseFloat(v.close),
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low),  c: parseFloat(v.close),
  }));
}

// ── Fetch 5min candles ──
async function fetch5m(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=70&apikey=${API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.values) return null;
  return data.values.reverse().map(v => ({
    ts: new Date(v.datetime + 'Z').getTime(),
    open: parseFloat(v.open), high: parseFloat(v.high),
    low:  parseFloat(v.low),  close: parseFloat(v.close),
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low),  c: parseFloat(v.close),
  }));
}

// ── Fetch 1h candles for macro filter ──
async function fetch1h(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1h&outputsize=100&apikey=${API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.values) return null;
  return data.values.reverse().map(v => ({
    ts: new Date(v.datetime + 'Z').getTime(),
    open: parseFloat(v.open), high: parseFloat(v.high),
    low:  parseFloat(v.low),  close: parseFloat(v.close),
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low),  c: parseFloat(v.close),
  }));
}

// ── Format signal Discord message ──
function formatSignalMsg(symbol, result, price) {
  const s = result.signal;
  const t = result.trade;
  return [
    `🔴 **SCALP SELL — ${symbol}**`,
    `💰 Entry: \`${price.toFixed(2)}\` | SL: \`${t.sl.toFixed(2)}\` | TP: \`${t.tp.toFixed(2)}\``,
    `📊 RR: 1.8 | Risk: ${t.risk.toFixed(2)} pts | Confidence: ${s.confidence}%`,
    `📈 ATR: ${s.atr.toFixed(2)} | RSI: ${s.rsi?.toFixed(0)} | Stoch: ${s.stochK?.toFixed(0)}`,
    `✅ ${s.reasons?.join(' | ')}`,
    `⏰ ${new Date().toUTCString()}`,
  ].join('\n');
}

// ── MAIN LOOP ──
async function run() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         SCALP AGENT v1 — SELL-ONLY PULLBACK                  ║');
  console.log(`║  Symbols: ${SYMBOLS.join(', ').padEnd(50)}║`);
  console.log('║  Session: 12:00-13:00 UTC | RR: 1.8 | WR: 51.2% (backtest)  ║');
  console.log(`║  MT5 Auto-Trade: ${(process.env.MT5_AUTO_TRADE === 'true' ? 'ON ✅' : 'OFF ❌').padEnd(44)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── Warm up with historical data ──
  console.log('📥 Loading historical data...');
  for (const symbol of SYMBOLS) {
    const c1m = await fetchLatest1m(symbol);
    const c5m = await fetch5m(symbol);
    const c1h = await fetch1h(symbol);
    if (c1m) engine.load1mCandles(symbol, c1m);
    if (c5m) engine.load5mCandles(symbol, c5m);
    if (c1h) engine.load1hCandles(symbol, c1h);
    buffer5m[symbol] = null;
    await new Promise(r => setTimeout(r, 1200)); // API rate limit
  }
  console.log('✅ Warmed up\n');

  // ── MT5 result handler ──
  mt5.on('trade_result', async (result) => {
    const status = result.status === 'OPENED' ? '✅ MT5 Executed' : '❌ MT5 Failed';
    const msg = `${status}: ${result.symbol} | Ticket: ${result.ticket} | Entry: ${result.entryPrice}`;
    console.log(msg);
    await notify(msg);
  });

  // ── Auto-exit at 13:10 UTC (session ends 13:00) ──
  const now = new Date();
  const exitAt = new Date();
  exitAt.setUTCHours(13, 10, 0, 0);
  if (exitAt <= now) exitAt.setUTCDate(exitAt.getUTCDate() + 1);
  const msUntilExit = exitAt - now;
  setTimeout(async () => {
    const s = engine.getStats();
    const msg = `📊 NY Scalp Session Done | ${s.wins}W ${s.losses}L | WR: ${s.winRate}% | PF: ${s.profitFactor} | ${s.totalR.toFixed(1)}R total`;
    console.log('\n' + msg);
    await notify(msg);
    console.log('👋 Session ended, exiting cleanly.');
    process.exit(0);
  }, msUntilExit);
  console.log(`⏱ Auto-exit scheduled at 13:10 UTC (in ${Math.round(msUntilExit/60000)} min)\n`);

  // ── Poll every 60 seconds (1min candle cadence) ──
  console.log('⏱ Polling every 60 seconds...\n');
  setInterval(async () => {
    const hour = new Date().getUTCHours();
    const isActive = hour >= 12 && hour < 14;

    if (!isActive) return;

    for (const symbol of SYMBOLS) {
      try {
        const c1m = await fetchLatest1m(symbol);
        if (!c1m || !c1m.length) continue;

        const latest   = c1m[c1m.length - 1];
        const price    = latest.close;

        // Update 1m buffer
        engine.load1mCandles(symbol, c1m);

        // Refresh 5m every 5 candles (save API credits)
        const now = Date.now();
        if (!buffer5m[symbol] || now - buffer5m[symbol] > 4 * 60000) {
          const c5m = await fetch5m(symbol);
          if (c5m) engine.load5mCandles(symbol, c5m);
          buffer5m[symbol] = now;
        }

        // Check if open trade resolved
        const resolved = engine.resolveOpenTrade(symbol, latest);
        if (resolved) {
          const emoji   = resolved.result === 'WIN' ? '✅' : resolved.result === 'EXPIRED' ? '⏰' : '❌';
          const msg = `${emoji} Trade closed: ${symbol} | ${resolved.result} | ${resolved.rPnL > 0 ? '+' : ''}${resolved.rPnL}R`;
          console.log(msg);
          await notify(msg);
        }

        // Generate signal
        const result = engine.generateSignal(symbol, price);

        console.log(`[${new Date().toUTCString()}] ${symbol} @ ${price.toFixed(2)} → ${result.action}`);
        if (result.action !== 'HOLD') {
          console.log(`   🔴 SELL SIGNAL! Conf: ${result.signal.confidence}% | SL: ${result.trade.sl.toFixed(2)} | TP: ${result.trade.tp.toFixed(2)}`);
          console.log(`   Reasons: ${result.signal.reasons?.join(', ')}`);

          // Send Discord notification
          await notify(formatSignalMsg(symbol, result, price));

          // Send to MT5 if enabled
          if (mt5.enabled) {
            mt5.sendSignal(result.trade);
          }
        } else {
          if (process.env.DEBUG_MODE) console.log(`   ⏸ ${result.reason}`);
        }

        await new Promise(r => setTimeout(r, 1200));
      } catch (err) {
        console.error(`Error processing ${symbol}:`, err.message);
      }
    }

    // Print stats every hour
    if (new Date().getUTCMinutes() === 0) {
      const s = engine.getStats();
      console.log(`\n📊 Live Stats: ${s.wins}W ${s.losses}L | WR: ${s.winRate}% | PF: ${s.profitFactor} | ${s.totalR.toFixed(1)}R\n`);
    }
  }, 60000);
}

run().catch(console.error);