# YieldLens

A local investment calculator for classic compounding, crypto earn products (flexible, simple earn with bonus APR, fixed term, staking), and stocks/ETFs — including how rates actually work on platforms that quote **APR** instead of explaining compounding.

Built with **HTML, CSS, and vanilla JavaScript**, plus Bootstrap, Font Awesome, Chart.js, and jsPDF. No build step required.

## Run locally

Open `index.html` in a browser (CDN assets need network on first load).

Or serve the folder:

```bash
npx --yes serve .
```

Then open the URL shown in the terminal.

## Features

- **Three calculators**
  - Investment — principal, contributions, rate, compounding frequency (yearly / quarterly / monthly / daily)
  - Crypto — default flexible earn, Simple Earn (regular + capped bonus APR), fixed term, staking
  - Stocks / ETFs — simple return or advanced (dividend yield, expense ratio, DRIP, withdrawal fee)
- **Growing contributions** — optional step-ups by fixed amount, fixed %, or a variable min/max swing every year or quarter
- **Guide ↔ Results toggle** — learn about the active calculator, then keep results without recalculating
- **Results** — key metrics (up to 8), expected / best / worst scenarios (±20% rate), growth charts, paginated period table
- **Learn modal** — simple vs compound, APR vs APY, crypto earn mechanics, ETF dividends & fees
- **PDF export** — structured export of full results (including the complete period table), not a page screenshot

## Project layout

```
index.html          App shell, forms, learn modal
css/styles.css      Layout and theme
js/calculations.js  Compounding / earn / ETF math
js/charts.js        Chart.js helpers
js/pdf-export.js    PDF generation
js/app.js           UI wiring
```

## Notes

Projections are hypothetical. Crypto promo APRs, bonus tiers, and ETF yields change over time — always verify numbers on the exchange or fund page.

## Author

Branko Pereira

## License

Personal / educational use.
