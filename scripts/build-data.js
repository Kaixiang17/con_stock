import axios from "axios";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import fs from "fs";
import path from "path";

const PEICHENG_URL =
  "https://www.peicheng.com.tw/asp/main/report/report_r4all.html";

const OUT_DIR = path.join(process.cwd(), "data");
const OUT_FILE = path.join(OUT_DIR, "chip_screener.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (!s || s === "-" || s === "--") return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function lastMA(values, n) {
  if (values.length < n) return null;
  return avg(values.slice(-n));
}

function prevMA(values, n) {
  if (values.length < n + 1) return null;
  return avg(values.slice(-n - 1, -1));
}

function round(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Number(v.toFixed(d));
}

function classifyStock(code, name) {
  const c = Number(code);
  const n = String(name || "");

  // 粗分：科技類股優先。這裡用股票代碼區間 + 名稱關鍵字判斷。
  const techCode =
    (c >= 2300 && c < 2500) ||
    (c >= 3000 && c < 3700) ||
    (c >= 4900 && c < 5500) ||
    (c >= 6100 && c < 6800) ||
    (c >= 8000 && c < 8500);

  const techName =
    /(電|科|半導|矽|晶|光|通|訊|網|智|微|精密|材料|軟|資|系統|封測|光學|電子|積電|聯發|台積|鴻海|廣達|緯創|仁寶|華通|欣興|台光電|PCB|IC|AI|伺服器|散熱|機殼|記憶體|DRAM|NAND)/i.test(
      n
    );

  const stableCode =
    (c >= 1100 && c < 1500) ||
    (c >= 2800 && c < 2900) ||
    (c >= 9900 && c < 9999);

  const stableName =
    /(金|銀|保|證|控|電信|中華電|台灣大|遠傳|統一|食品|水泥|瓦斯|天然氣|電力|電纜|中鋼|台泥|亞泥|正新|和泰|貨櫃|航|運|倉儲|超商|藥|醫材|保健)/i.test(
      n
    );

  if (techCode || techName) {
    return { category: "科技", categoryRank: 3 };
  }

  if (stableCode || stableName) {
    return { category: "穩定", categoryRank: 2 };
  }

  return { category: "其他", categoryRank: 1 };
}

async function fetchPeichengRows() {
  console.log("Fetching Peicheng chip data...");

  const res = await axios.get(PEICHENG_URL, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"
    }
  });

  // 北城常見為 Big5 頁面，GitHub Actions 用 iconv 解碼比較穩。
  const html = iconv.decode(Buffer.from(res.data), "big5");
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td, th")
      .map((_, td) =>
        $(td)
          .text()
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
      .get();

    const codeIndex = cells.findIndex((x) => /^\d{4,6}$/.test(x));
    if (codeIndex < 0) return;

    const code = cells[codeIndex];
    const name = cells[codeIndex + 1];
    if (!name) return;

    // 依照北城表格常見欄位：代號、名稱、1日、5日、10日、20日、60日、120日、10日均量
    const conc1 = toNumber(cells[codeIndex + 2]);
    const conc5 = toNumber(cells[codeIndex + 3]);
    const conc10 = toNumber(cells[codeIndex + 4]);
    const conc20 = toNumber(cells[codeIndex + 5]);
    const conc60 = toNumber(cells[codeIndex + 6]);
    const conc120 = toNumber(cells[codeIndex + 7]);
    const avgVol10 = toNumber(cells[codeIndex + 8]);

    if (conc1 === null && conc5 === null && conc10 === null && conc20 === null) return;

    rows.push({
      code,
      name,
      conc1,
      conc5,
      conc10,
      conc20,
      conc60,
      conc120,
      avgVol10
    });
  });

  const unique = rows.filter(
    (x, i, arr) => arr.findIndex((y) => y.code === x.code) === i
  );

  console.log(`Peicheng rows: ${unique.length}`);
  return unique;
}

async function fetchYahooChart(code) {
  const symbols = [`${code}.TW`, `${code}.TWO`];

  for (const symbol of symbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        symbol
      )}?range=9mo&interval=1d`;

      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
        }
      });

      const result = res.data?.chart?.result?.[0];
      if (!result) continue;

      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const closes = quote.close || [];
      const volumes = quote.volume || [];

      const data = timestamps
        .map((t, i) => ({
          date: new Date(t * 1000).toISOString().slice(0, 10),
          close: closes[i],
          volume: volumes[i]
        }))
        .filter(
          (x) =>
            typeof x.close === "number" &&
            Number.isFinite(x.close) &&
            typeof x.volume === "number" &&
            Number.isFinite(x.volume)
        );

      if (data.length >= 120) {
        return { symbol, data };
      }
    } catch {
      // 換 TW / TWO
    }
  }

  throw new Error("Yahoo chart not found");
}

async function mapLimit(list, limit, mapper) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < list.length) {
      const current = idx++;
      try {
        results[current] = await mapper(list[current], current);
      } catch (err) {
        console.warn(`Skip ${list[current]?.code}: ${err.message}`);
        results[current] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function analyzeStock(base, chartPayload) {
  const data = chartPayload.data;
  const closes = data.map((x) => x.close);
  const volumes = data.map((x) => x.volume);

  const close = closes.at(-1);
  const prevClose = closes.at(-2);
  const volume = volumes.at(-1);
  const date = data.at(-1)?.date;

  const ma5 = lastMA(closes, 5);
  const ma10 = lastMA(closes, 10);
  const ma20 = lastMA(closes, 20);
  const ma60 = lastMA(closes, 60);
  const ma120 = lastMA(closes, 120);

  const pma5 = prevMA(closes, 5);
  const pma10 = prevMA(closes, 10);
  const pma20 = prevMA(closes, 20);
  const pma60 = prevMA(closes, 60);
  const pma120 = prevMA(closes, 120);

  const maList = [ma5, ma10, ma20, ma60, ma120].filter((x) => x !== null);
  const pmaList = [pma5, pma10, pma20, pma60, pma120].filter((x) => x !== null);

  const maxMA = maList.length === 5 ? Math.max(...maList) : null;
  const prevMaxMA = pmaList.length === 5 ? Math.max(...pmaList) : null;

  const aboveAll = maxMA !== null && close > maxMA;
  const prevAboveAll = prevMaxMA !== null && prevClose > prevMaxMA;
  const stretch = aboveAll && maxMA ? close / maxMA - 1 : null;

  const justAboveAll =
    aboveAll &&
    (!prevAboveAll || (stretch !== null && stretch <= 0.06));

  const volMA20 = lastMA(volumes, 20);
  const volMA60 = lastMA(volumes, 60);
  const volRatio = volMA20 ? volume / volMA20 : null;

  const volumeBreakout = volRatio !== null && volRatio >= 1.5;
  const volumeControlled = volRatio !== null && volRatio >= 0.7 && volRatio <= 2.8;
  const volumeTooCrazy = volRatio !== null && volRatio >= 3.5;

  const ma20Up = ma20 !== null && pma20 !== null && ma20 > pma20;
  const ma60FlatOrUp = ma60 !== null && pma60 !== null && ma60 >= pma60 * 0.995;

  const maNice =
    ma5 !== null &&
    ma10 !== null &&
    ma20 !== null &&
    ma60 !== null &&
    ma5 > ma10 &&
    ma10 > ma20 &&
    ma20 >= ma60 * 0.98 &&
    ma20Up &&
    ma60FlatOrUp;

  const notTooFarA = stretch !== null && stretch <= 0.06;
  const distanceFromMA20 = ma20 ? close / ma20 - 1 : null;
  const notTooFarB = distanceFromMA20 !== null && distanceFromMA20 <= 0.1;

  // 北城說明的經驗值
  const chip1Ok = base.conc1 !== null && base.conc1 >= 20;
  const chip5Ok = base.conc5 !== null && base.conc5 >= 15;
  const chip10Ok = base.conc10 !== null && base.conc10 >= 10;
  const chip20Ok = base.conc20 !== null && base.conc20 >= 5;

  // 成交量過小集中度容易失真，預設 500 張。
  const liquidityOk = base.avgVol10 !== null && base.avgVol10 >= 500;

  // A：10日集中度高 + 剛站上所有均線 + 沒有噴太遠
  const strategyA =
    chip10Ok &&
    aboveAll &&
    justAboveAll &&
    notTooFarA &&
    !volumeTooCrazy &&
    liquidityOk;

  // B：20日集中度高 + MA20上彎 + 量沒有失控爆太大
  const strategyB =
    chip20Ok &&
    ma20Up &&
    close > ma20 &&
    notTooFarB &&
    volumeControlled &&
    liquidityOk;

  const { category, categoryRank } = classifyStock(base.code, base.name);

  let score = 0;
  score += Math.max(base.conc10 ?? 0, 0) * 1.8;
  score += Math.max(base.conc20 ?? 0, 0) * 2.2;

  if (strategyA) score += 45;
  if (strategyB) score += 38;
  if (aboveAll) score += 15;
  if (justAboveAll) score += 18;
  if (maNice) score += 16;
  if (ma20Up) score += 8;
  if (volumeControlled) score += 8;
  if (volumeBreakout && !volumeTooCrazy) score += 6;
  if (category === "科技") score += 12;
  if (category === "穩定") score += 7;
  if (!liquidityOk) score -= 25;
  if (volumeTooCrazy) score -= 14;
  if (stretch !== null && stretch > 0.12) score -= 20;

  let signal = "觀察";
  if (strategyA && strategyB) signal = "剛轉強 + 慢慢墊高";
  else if (strategyA) signal = "剛轉強";
  else if (strategyB) signal = "慢慢墊高";

  return {
    ...base,
    symbol: chartPayload.symbol,
    date,
    close: round(close, 2),
    volume,
    category,
    categoryRank,

    ma5: round(ma5, 2),
    ma10: round(ma10, 2),
    ma20: round(ma20, 2),
    ma60: round(ma60, 2),
    ma120: round(ma120, 2),

    volMA20: round(volMA20, 0),
    volMA60: round(volMA60, 0),
    volRatio: round(volRatio, 2),
    stretch: round(stretch === null ? distanceFromMA20 * 100 : stretch * 100, 2),

    chip1Ok,
    chip5Ok,
    chip10Ok,
    chip20Ok,
    liquidityOk,

    aboveAll,
    justAboveAll,
    ma20Up,
    ma60FlatOrUp,
    maNice,
    volumeBreakout,
    volumeControlled,
    volumeTooCrazy,

    strategyA,
    strategyB,
    signal,
    score: round(score, 1)
  };  const baseList = chipRows
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const chipRows = await fetchPeichengRows();

  const baseList = chipRows
    .filter((x) => (x.conc10 ?? 0) >= 5 || (x.conc20 ?? 0) >= 3)
    .sort((a, b) => {
      const aScore = Math.max(a.conc10 ?? 0, 0) + Math.max(a.conc20 ?? 0, 0);
      const bScore = Math.max(b.conc10 ?? 0, 0) + Math.max(b.conc20 ?? 0, 0);
      return bScore - aScore;
    })
    .slice(0, 240);

  console.log(`Analyze list: ${baseList.length}`);

  const analyzed = await mapLimit(baseList, 5, async (stock, index) => {
    console.log(`${index + 1}/${baseList.length} ${stock.code} ${stock.name}`);
    await sleep(120);
    const chart = await fetchYahooChart(stock.code);
    return analyzeStock(stock, chart);
  });

  const rows = analyzed.filter(Boolean).sort((a, b) => b.score - a.score);

  const payload = {
    ok: true,
    source: "Peicheng 籌碼集中度 + Yahoo Finance 日K",
    note: {
      chipRule:
        "1日>20%、5日>15%、10日>10%、20日>5% 視為籌碼明確集中參考。",
      strategyA:
        "10日集中度高 + 剛站上所有均線 + 沒有噴太遠，偏剛轉強。",
      strategyB:
        "20日集中度高 + MA20上彎 + 量沒有失控爆太大，偏慢慢墊高。",
      liquidity:
        "成交量過小容易讓籌碼集中度失真，預設用10日均量500張作為基本門檻。"
    },
    generatedAt: new Date().toISOString(),
    count: rows.length,
    rows
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Saved: ${OUT_FILE}`);
  console.log(`Rows: ${rows.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
