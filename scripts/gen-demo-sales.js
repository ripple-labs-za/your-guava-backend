/**
 * A realistic, deterministic Yoco-format sales export for local seeding.
 *   node scripts/gen-demo-sales.js --out demo-sales.csv                    # 10 weeks ending yesterday
 *   node scripts/gen-demo-sales.js --end 2026-09-21 --weeks 10 --out demo-sales.csv
 * The same arguments always give the same file. Status is "Approved", as a real Yoco export writes.
 * Ported from the-road-to-90/tools/gen-yoco.mjs (the UAT baseline generator).
 */
const fs = require('fs');

const HEADER = 'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,'
  + 'Note,Currency,Tip,Discount,VAT,Total (incl. tax),Fee Amount,Net Amount';
// name, price, share of volume
const MENU = [
  ['Flat White', 38, 0.22], ['Cappuccino', 36, 0.16], ['Americano', 30, 0.12],
  ['Latte', 40, 0.10], ['Iced Coffee', 45, 0.06], ['Rooibos Tea', 25, 0.05],
  ['Croissant', 32, 0.08], ['Blueberry Muffin', 28, 0.06],
  ['Toasted Cheese & Tomato', 55, 0.05], ['Avo Toast', 68, 0.04],
  ['Chocolate Brownie', 30, 0.03], ['Bottled Water', 18, 0.02], ['Coke 330ml', 22, 0.01],
];
const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n, width = 2) => String(n).padStart(width, '0');

const generateDemoSales = ({ end, weeks = 10 } = {}) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(end))) throw new Error(`end must be YYYY-MM-DD, got "${end}"`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const days = Math.max(1, Math.round(Number(weeks) * 7));
  let seed = 20260922;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const totalShare = MENU.reduce((sum, item) => sum + item[2], 0);
  const pickItem = () => {
    let remaining = rnd() * totalShare;
    for (const item of MENU) {
      remaining -= item[2];
      if (remaining <= 0) return item;
    }
    return MENU[0];
  };

  const rows = [HEADER];
  let receipt = 1;
  for (let back = days; back >= 0; back -= 1) {
    const day = new Date(endMs - back * DAY_MS);
    const dow = day.getUTCDay();
    const date = `${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}`;
    // Saturdays busy, Sundays quiet, Fridays above average.
    const base = dow === 6 ? 115 : dow === 0 ? 55 : dow === 5 ? 95 : 80;
    const sales = Math.round(base * (0.85 + rnd() * 0.3));
    for (let i = 0; i < sales; i += 1) {
      const hour = 7 + Math.floor(Math.abs(rnd() + rnd() - 1) * 9);
      const time = `${pad(hour)}:${pad(Math.floor(rnd() * 60))}:${pad(Math.floor(rnd() * 60))}`;
      const lines = [];
      const seen = new Set();
      let total = 0;
      const count = 1 + (rnd() < 0.45 ? 1 : 0) + (rnd() < 0.15 ? 1 : 0);
      for (let j = 0; j < count; j += 1) {
        const [name, price] = pickItem();
        if (seen.has(name)) continue;
        seen.add(name);
        const qty = rnd() < 0.15 ? 2 : 1;
        lines.push(`${qty} x ${name}`);
        total += qty * price;
      }
      const tip = rnd() < 0.2 ? 5 : 0;
      const gross = total + tip;
      const fee = Number((gross * 0.0275).toFixed(2));
      rows.push(`${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(receipt, 6)},${date},${time},Approved,Card,`
        + `${receipt},Reader-01,"${lines.join(', ')}",,ZAR,${tip.toFixed(2)},0.00,${(total * 0.15 / 1.15).toFixed(2)},`
        + `${gross.toFixed(2)},${fee.toFixed(2)},${(gross - fee).toFixed(2)}`);
      receipt += 1;
    }
  }
  return `${rows.join('\r\n')}\r\n`;
};

const yesterday = () => {
  const d = new Date(Date.now() - DAY_MS);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const csv = generateDemoSales({ end: value('--end', yesterday()), weeks: Number(value('--weeks', 10)) });
  const out = value('--out', null);
  if (out) {
    fs.writeFileSync(out, csv);
    console.log(`[gen-demo-sales] ${csv.trim().split('\n').length - 1} sales written to ${out}`);
  } else {
    process.stdout.write(csv);
  }
}

module.exports = { generateDemoSales };
