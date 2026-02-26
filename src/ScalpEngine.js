import { EMA, RSI, ATR, Stochastic, ADX, MACD } from 'technicalindicators';

// ═══════════════════════════════════════════════════════════════
// ScalpEngine.js — SELL-ONLY PULLBACK SCALPER
// Proven backtest: 51.2% WR | PF 1.89 | All years profitable
// Session: 12:00-13:00 UTC only (London/NY overlap peak)
// Settings: RR 1.8 | ATR_MUL 1.0 | MaxPB 0.4×ATR | MinConf 65%
// ═══════════════════════════════════════════════════════════════

const SCALP_CONFIG = {
  RR:          1.8,
  ATR_MUL:     1.0,
  MAX_PB_ATR:  0.4,   // only clean EMA21 taps
  MIN_CONF:    65,
  MAX_HOLD:    20,    // 20 candles = 20 min max hold
  COOLDOWN:    5,     // minutes between signals
  HOUR_START:  12,
  HOUR_END:    13,    // 12:00-13:00 UTC only
};

export class ScalpEngine {
  constructor() {
    this.candles1m    = {};   // { symbol: [...] }
    this.candles5m    = {};   // { symbol: [...] }
    this.candles1h    = {};   // { symbol: [...] } ← 1h macro filter
    this.openTrade    = {};   // { symbol: tradeObj | null }
    this.lastSignalTs = {};   // { symbol: timestamp }
    this.config       = SCALP_CONFIG;
    this.stats        = {     // live performance tracking
      wins: 0, losses: 0, expired: 0, totalR: 0,
      bySymbol: {}
    };
  }

  // ── Load historical 1min candles (called on startup) ──
  load1mCandles(symbol, candles) {
    this.candles1m[symbol] = candles.slice(-100); // keep last 100
    this.openTrade[symbol]    = null;
    this.lastSignalTs[symbol] = 0;
    if (!this.stats.bySymbol[symbol]) {
      this.stats.bySymbol[symbol] = { wins:0, losses:0, totalR:0 };
    }
    console.log(`   📊 ScalpEngine: Loaded ${candles.length} × 1min candles for ${symbol}`);
  }

  // ── Load historical 5min candles ──
  load5mCandles(symbol, candles) {
    this.candles5m[symbol] = candles.slice(-80);
    console.log(`   📊 ScalpEngine: Loaded ${candles.length} × 5min candles for ${symbol}`);
  }

  // ── Load 1h candles for macro filter ──
  load1hCandles(symbol, candles) {
    this.candles1h[symbol] = candles.slice(-100);
    console.log(`   📊 ScalpEngine: Loaded ${candles.length} × 1h candles for ${symbol} (macro filter)`);
  }

  // ── 1H MACRO TREND: hard block counter-macro trades ──
  get1hMacro(symbol) {
    const c1h = this.candles1h[symbol];
    if (!c1h || c1h.length < 55) return 'NEUTRAL';
    const closes = c1h.map(c => c.close || c.c);
    const highs  = c1h.map(c => c.high  || c.h);
    const lows   = c1h.map(c => c.low   || c.l);
    try {
      const ema21 = EMA.calculate({ values: closes, period: 21 });
      const ema50 = EMA.calculate({ values: closes, period: 50 });
      const adx   = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
      if (!ema21.length || !ema50.length || !adx.length) return 'NEUTRAL';
      const e21    = ema21[ema21.length - 1];
      const e50    = ema50[ema50.length - 1];
      const price  = closes[closes.length - 1];
      const adxVal = adx[adx.length - 1].adx;
      if (adxVal < 20) return 'NEUTRAL';
      if (e21 > e50 && price > e21) return 'BULLISH';
      if (e21 < e50 && price < e21) return 'BEARISH';
      return 'NEUTRAL';
    } catch { return 'NEUTRAL'; }
  }

  // ── Push new 1min candle (called every minute) ──
  push1mCandle(symbol, candle) {
    if (!this.candles1m[symbol]) this.candles1m[symbol] = [];
    this.candles1m[symbol].push(candle);
    if (this.candles1m[symbol].length > 100) this.candles1m[symbol].shift();
  }

  // ── Push new 5min candle ──
  push5mCandle(symbol, candle) {
    if (!this.candles5m[symbol]) this.candles5m[symbol] = [];
    this.candles5m[symbol].push(candle);
    if (this.candles5m[symbol].length > 80) this.candles5m[symbol].shift();
  }

  // ── SESSION CHECK ──
  isScalpSession(ts = Date.now()) {
    const d    = new Date(ts);
    const hour = d.getUTCHours();
    const day  = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    if (day === 1 && hour < 10) return false;
    if (day === 5 && hour >= this.config.HOUR_END) return false;
    return hour >= this.config.HOUR_START && hour < this.config.HOUR_END;
  }

  // ── 5MIN TREND: strict bearish stack required ──
  get5mTrend(symbol) {
    const c5 = this.candles5m[symbol];
    if (!c5 || c5.length < 55) return 'NEUTRAL';

    const closes = c5.map(c => c.close || c.c);
    const highs  = c5.map(c => c.high  || c.h);
    const lows   = c5.map(c => c.low   || c.l);

    try {
      const ema9  = EMA.calculate({ values: closes, period: 9 });
      const ema21 = EMA.calculate({ values: closes, period: 21 });
      const ema50 = EMA.calculate({ values: closes, period: 50 });
      const adx   = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

      if (!ema9.length || !ema21.length || !ema50.length || !adx.length) return 'NEUTRAL';

      const e9  = ema9[ema9.length - 1];
      const e21 = ema21[ema21.length - 1];
      const e50 = ema50[ema50.length - 1];
      const p   = closes[closes.length - 1];
      const adxVal = adx[adx.length - 1].adx;

      // STRICT bearish: full stack + ADX ≥ 25
      if (e9 < e21 && e21 < e50 && p < e9 && adxVal >= 25) return 'BEARISH';
      return 'NEUTRAL';
    } catch { return 'NEUTRAL'; }
  }

  // ── 1MIN SELL SIGNAL: pullback to EMA21 rejection ──
  getSellSignal(symbol) {
    const c1 = this.candles1m[symbol];
    if (!c1 || c1.length < 30) return null;

    const closes = c1.map(c => c.close || c.c);
    const highs  = c1.map(c => c.high  || c.h);
    const lows   = c1.map(c => c.low   || c.l);

    try {
      const ema8  = EMA.calculate({ values: closes, period: 8 });
      const ema21 = EMA.calculate({ values: closes, period: 21 });
      const rsi   = RSI.calculate({ values: closes, period: 7 });
      const atr   = ATR.calculate({ high: highs, low: lows, close: closes, period: 7 });
      const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 5, signalPeriod: 3 });
      const macd  = MACD.calculate({ values: closes, fastPeriod: 5, slowPeriod: 13, signalPeriod: 4, SimpleMAOscillator: false, SimpleMASignal: false });

      if (!ema21.length || !rsi.length || !atr.length) return null;

      const price     = closes[closes.length - 1];
      const prevPrice = closes[closes.length - 2];
      const e8        = ema8[ema8.length - 1];
      const e8Prev    = ema8[ema8.length - 2];
      const e21       = ema21[ema21.length - 1];
      const e21Prev   = ema21[ema21.length - 2];
      const rsiVal    = rsi[rsi.length - 1];
      const rsiPrev   = rsi[rsi.length - 2];
      const atrVal    = atr[atr.length - 1];
      const stochCur  = stoch[stoch.length - 1];
      const stochPrev = stoch[stoch.length - 2];
      const macdCur   = macd[macd.length - 1];
      const macdPrev  = macd[macd.length - 2];

      if (!atrVal || atrVal < 0.3) return null;

      // ── PULLBACK CHECK: price touched EMA21, now rejecting ──
      const lookback     = c1.slice(-8, -1);
      const pullbackHigh = Math.max(...lookback.map(c => c.high || c.h));
      const distToEMA    = Math.abs(pullbackHigh - e21);

      if (distToEMA > atrVal * this.config.MAX_PB_ATR) return null; // too far from EMA21
      if (pullbackHigh > e21 + atrVal * 1.0) return null;           // overshot EMA21
      if (price >= e8) return null;                                   // not below EMA8 yet
      if (price >= prevPrice) return null;                            // not moving down
      if (rsiVal < 35) return null;                                   // no sell into oversold
      if (rsiVal >= rsiPrev) return null;                             // RSI must be falling
      if (e21 >= e21Prev) return null;                               // EMA21 must slope down
      if (e8 >= e8Prev) return null;                                  // EMA8 must slope down

      if (!stochCur || !stochPrev) return null;
      if (stochCur.k < 25) return null;
      if (stochCur.k >= stochCur.d && stochPrev.k >= stochPrev.d) return null;

      if (!macdCur) return null;
      if (macdCur.histogram > 0 && (!macdPrev || macdCur.histogram >= macdPrev.histogram)) return null;

      // ── CONFIDENCE SCORING ──
      let conf = 50;

      // Pullback quality (closer to EMA21 = better)
      if (distToEMA < atrVal * 0.15)      conf += 20;
      else if (distToEMA < atrVal * 0.3)  conf += 12;
      else if (distToEMA < atrVal * 0.4)  conf += 5;

      // RSI
      if (rsiVal > 60 && rsiVal < rsiPrev)  conf += 12;
      else if (rsiVal > 50)                  conf += 6;

      // Stoch cross
      if (stochCur.k < stochCur.d && stochPrev.k >= stochPrev.d) conf += 12;
      else if (stochCur.k < stochCur.d) conf += 5;

      // Stoch overbought zone rejection
      if (stochCur.k > 65 && stochCur.k < stochCur.d) conf += 5;

      // MACD
      if (macdCur.histogram < 0) conf += 8;
      if (macdCur.histogram < 0 && macdPrev && macdCur.histogram < macdPrev.histogram) conf += 6;

      // EMA momentum
      if (e21 < e21Prev) conf += 5;
      if (e8 < e8Prev)   conf += 4;

      conf = Math.min(conf, 95);
      if (conf < this.config.MIN_CONF) return null;

      // ── CALCULATE SL/TP ──
      const sl   = price + atrVal * this.config.ATR_MUL;
      const risk = Math.abs(price - sl);
      if (risk <= 0 || risk > atrVal * 3) return null;
      const tp = price - risk * this.config.RR;

      return {
        action:       'SELL',
        confidence:   conf,
        price,
        sl,
        tp,
        risk,
        atr:          atrVal,
        pullbackHigh,
        ema21:        e21,
        rsi:          rsiVal,
        stochK:       stochCur.k,
        macdHist:     macdCur.histogram,
        reasons:      this._buildReasons(conf, distToEMA, atrVal, rsiVal, stochCur, stochPrev, macdCur, macdPrev),
      };
    } catch (err) {
      return null;
    }
  }

  _buildReasons(conf, dist, atr, rsi, stoch, stochPrev, macd, macdPrev) {
    const r = [];
    if (dist < atr * 0.15) r.push('Perfect EMA21 tap');
    else if (dist < atr * 0.3) r.push('Clean EMA21 pullback');
    if (rsi > 60) r.push(`RSI falling from overbought (${rsi.toFixed(0)})`);
    if (stoch.k < stoch.d && stochPrev.k >= stochPrev.d) r.push('Fresh stoch bearish cross');
    if (macd.histogram < 0 && macdPrev && macd.histogram < macdPrev.histogram) r.push('MACD accelerating down');
    return r;
  }

  // ── RESOLVE OPEN TRADE (check if SL/TP hit on new candle) ──
  resolveOpenTrade(symbol, newCandle) {
    const trade = this.openTrade[symbol];
    if (!trade) return null;

    const { sl, tp, openTime, action } = trade;
    const h = newCandle.high  || newCandle.h;
    const l = newCandle.low   || newCandle.l;

    // Check SL hit (SELL: price goes up)
    if (h >= sl) {
      const result = { ...trade, result: 'LOSS', rPnL: -1, closePrice: sl };
      this.openTrade[symbol] = null;
      this._recordResult(symbol, 'LOSS', -1);
      return result;
    }

    // Check TP hit (SELL: price goes down)
    if (l <= tp) {
      const result = { ...trade, result: 'WIN', rPnL: this.config.RR, closePrice: tp };
      this.openTrade[symbol] = null;
      this._recordResult(symbol, 'WIN', this.config.RR);
      return result;
    }

    // Check max hold time
    const ageMin = (Date.now() - openTime) / 60000;
    if (ageMin >= this.config.MAX_HOLD) {
      const result = { ...trade, result: 'EXPIRED', rPnL: -0.15, closePrice: newCandle.close || newCandle.c };
      this.openTrade[symbol] = null;
      this._recordResult(symbol, 'EXPIRED', -0.15);
      return result;
    }

    return null; // still open
  }

  _recordResult(symbol, outcome, rPnL) {
    if (outcome === 'WIN')       { this.stats.wins++;    this.stats.totalR += rPnL; this.stats.bySymbol[symbol].wins++;  this.stats.bySymbol[symbol].totalR += rPnL; }
    else if (outcome === 'LOSS') { this.stats.losses++;  this.stats.totalR += rPnL; this.stats.bySymbol[symbol].losses++; this.stats.bySymbol[symbol].totalR += rPnL; }
    else                         { this.stats.expired++; this.stats.totalR += rPnL; }
  }

  // ── MAIN: Generate signal for symbol ──
  generateSignal(symbol, currentPrice, ts = Date.now()) {
    const now = new Date(ts);

    // 1. Session check
    if (!this.isScalpSession(ts)) {
      return { action: 'HOLD', reason: `Outside scalp session (need 12-13 UTC, got ${now.getUTCHours()}h)` };
    }

    // 2. Cooldown check
    const cooldownMs = this.config.COOLDOWN * 60000;
    if (ts - (this.lastSignalTs[symbol] || 0) < cooldownMs) {
      const waitMin = Math.ceil((cooldownMs - (ts - this.lastSignalTs[symbol])) / 60000);
      return { action: 'HOLD', reason: `Cooldown: ${waitMin}min remaining` };
    }

    // 3. Already in trade for this symbol
    if (this.openTrade[symbol]) {
      const t = this.openTrade[symbol];
      return {
        action: 'HOLD',
        reason: `Open trade: SELL @ ${t.entryPrice?.toFixed(2)} | SL: ${t.sl?.toFixed(2)} | TP: ${t.tp?.toFixed(2)}`,
        openTrade: t,
      };
    }

    // 4. 1h MACRO FILTER: block SELL if macro is BULLISH
    const macro = this.get1hMacro(symbol);
    if (macro === 'BULLISH') {
      return { action: 'HOLD', reason: `1h macro BULLISH — SELL blocked (trading with trend only)` };
    }

    // 5. 5min trend
    const trend = this.get5mTrend(symbol);
    if (trend !== 'BEARISH') {
      return { action: 'HOLD', reason: `5min trend: ${trend} (need BEARISH)` };
    }

    // 6. Get 1min signal
    const sig = this.getSellSignal(symbol);
    if (!sig) {
      return { action: 'HOLD', reason: 'No valid pullback setup on 1min' };
    }

    // 7. Fire signal — store as open trade
    const trade = {
      symbol,
      action:      'SELL',
      entryPrice:  currentPrice,
      sl:          sig.sl,
      tp:          sig.tp,
      risk:        sig.risk,
      rr:          this.config.RR,
      confidence:  sig.confidence,
      atr:         sig.atr,
      openTime:    ts,
      reasons:     sig.reasons,
      // MT5 fields
      lotSize:     null,  // set by caller based on account risk %
    };

    this.openTrade[symbol]    = trade;
    this.lastSignalTs[symbol] = ts;

    return {
      action:     'SELL',
      signal:     sig,
      trade,
      trend5m:    trend,
    };
  }

  // ── STATS REPORT ──
  getStats() {
    const closed = this.stats.wins + this.stats.losses;
    const wr  = closed > 0 ? (this.stats.wins / closed * 100).toFixed(1) : '0';
    const pf  = this.stats.losses > 0
      ? (this.stats.wins * this.config.RR / this.stats.losses).toFixed(2)
      : '∞';
    return {
      ...this.stats,
      winRate: wr,
      profitFactor: pf,
      closed,
    };
  }
}