/**
 * Chart.js helpers for YieldLens
 */

const Charts = (() => {
  let growthChart = null;
  let compositionChart = null;
  let scenarioChart = null;
  let lastGrowthResult = null;
  let growthTypeOverride = null; // null = use result.chartPreference

  const COLORS = {
    balance: "#0f6b4c",
    invested: "#4a5750",
    earnings: "#b8842a",
    expected: "#b8842a",
    best: "#0f6b4c",
    worst: "#9b3b2e",
    grid: "rgba(28, 36, 32, 0.08)",
    text: "#4a5750",
  };

  function formatMoney(value, currency, asset) {
    const n = Number(value) || 0;
    if (currency === "$") {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(n);
    }
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${asset || ""}`.trim();
  }

  function destroyAll() {
    [growthChart, compositionChart, scenarioChart].forEach((chart) => {
      if (chart) chart.destroy();
    });
    growthChart = null;
    compositionChart = null;
    scenarioChart = null;
  }

  function getAxisMeta(result) {
    if (result.chartMeta?.axisUnit && result.chartMeta?.axisCount) {
      return {
        axisUnit: result.chartMeta.axisUnit,
        axisCount: Math.max(1, result.chartMeta.axisCount),
      };
    }
    return { axisUnit: "years", axisCount: Math.max(1, Math.round(result.years || 1)) };
  }

  function getDetailGrain(result) {
    const unit = result.displayUnit;
    if (unit === "day" || unit === "days") return "day";
    if (unit === "month" || unit === "months") return "month";
    if (unit === "quarter" || unit === "quarters") return "quarter";
    if (unit === "year" || unit === "years" || unit === "term") return "year";
    if (result.compoundsPerYear >= 300) return "day";
    if (result.compoundsPerYear === 12) return "month";
    if (result.compoundsPerYear === 4) return "quarter";
    if (result.compoundsPerYear === 1) return "year";
    return "month";
  }

  function periodNoun(axisUnit, n) {
    switch (axisUnit) {
      case "months": return `Month ${n}`;
      case "quarters": return `Quarter ${n}`;
      case "days": return `Day ${n}`;
      case "years":
      default: return `Year ${n}`;
    }
  }

  /**
   * BAR charts = completed buckets (end-of-period).
   * Tick 0 = Start, tick N = end of period N.
   */
  function barAxisLabel(value, axisUnit) {
    if (value === 0) return "Start";
    return periodNoun(axisUnit, Math.round(value));
  }

  function barHoverLabel(bucketIndex, axisUnit) {
    if (bucketIndex === 0) return "Start";
    return periodNoun(axisUnit, bucketIndex);
  }

  /**
   * LINE charts: labels centered in each period band (0.5, 1.5, …).
   * Midpoint between start and end of the period — not glued to a grid line.
   */
  function lineAxisLabel(value, axisUnit) {
    const n = Math.round(value + 0.5); // 0.5 → 1, 1.5 → 2, …
    return periodNoun(axisUnit, n);
  }

  /** Hover keeps fine detail (M/Y etc.) inside the period. */
  function lineHoverLabel(period, detailGrain, axisUnit) {
    if (!period) return "Start";

    if (detailGrain === "month" && axisUnit === "years") {
      const year = Math.ceil(period / 12);
      const month = ((period - 1) % 12) + 1;
      return `M${month} · Year ${year}`;
    }

    if (detailGrain === "month") {
      return periodNoun(axisUnit === "months" ? "months" : axisUnit, period);
    }

    if (detailGrain === "day" && axisUnit === "years") {
      const year = Math.ceil(period / 365);
      const dayInYear = ((period - 1) % 365) + 1;
      const month = Math.min(12, Math.max(1, Math.ceil(dayInYear / 30.4167)));
      const day = Math.max(1, Math.round(dayInYear - (month - 1) * 30.4167));
      return `Day ${day} · M${month} · Year ${year}`;
    }

    if (detailGrain === "day") {
      return periodNoun("days", period);
    }

    if (detailGrain === "quarter" && axisUnit === "years") {
      const year = Math.ceil(period / 4);
      const q = ((period - 1) % 4) + 1;
      return `Q${q} · Year ${year}`;
    }

    if (detailGrain === "quarter") {
      return periodNoun("quarters", period);
    }

    if (detailGrain === "year") {
      return periodNoun("years", period);
    }

    return `Period ${period}`;
  }

  /**
   * Line-axis tick positions: integer boundaries (grid) + band midpoints (labels).
   * Midpoints only for real periods — no phantom Year N+1 after the horizon.
   * e.g. 10 years → labels at 0.5…9.5 (Year 1…Year 10), grid at 0…10.
   */
  function buildLineAxisTicks(axisCount) {
    const max = Math.max(1, axisCount);
    const mids = [];
    if (max <= 20) {
      for (let i = 0; i < max; i++) mids.push(i + 0.5);
    } else {
      const step = Math.ceil(max / 12);
      for (let i = 0; i < max; i += step) mids.push(i + 0.5);
      const last = max - 0.5;
      if (Math.abs(mids[mids.length - 1] - last) > 1e-9) mids.push(last);
    }
    const boundaries = Array.from({ length: max + 1 }, (_, i) => i);
    return [...new Set([...boundaries, ...mids])].sort((a, b) => a - b);
  }

  function isLineMidTick(value) {
    return Math.abs(value - Math.floor(value) - 0.5) < 1e-9;
  }

  function buildGrowthPoints(result) {
    const source = (result.fullRows?.length ? result.fullRows : result.rows) || [];
    const { axisUnit, axisCount } = getAxisMeta(result);
    const detailGrain = getDetailGrain(result);
    if (!source.length) {
      return { points: [], axisUnit, axisCount, detailGrain };
    }
    const maxPeriod = Number(source[source.length - 1].period) || 0;
    const points = source.map((r) => {
      const period = Number(r.period) || 0;
      const x = maxPeriod <= 0 ? 0 : (period / maxPeriod) * axisCount;
      return {
        x,
        period,
        balance: r.balance,
        invested: r.invested,
        earnings: r.earnings,
      };
    });
    return { points, axisUnit, axisCount, detailGrain };
  }

  function aggregateBars(points, axisCount, axisUnit) {
    const bars = [];
    for (let k = 0; k <= axisCount; k++) {
      let best = points[0];
      for (let i = 0; i < points.length; i++) {
        if (points[i].x <= k + 1e-9) best = points[i];
        else break;
      }
      bars.push({
        ...best,
        x: k,
        axisLabel: barAxisLabel(k, axisUnit),
        hoverLabel: barHoverLabel(k, axisUnit),
      });
    }
    return bars;
  }

  function resolveGrowthType(result) {
    if (!result.chartAllowsToggle) return "line";
    if (growthTypeOverride === "bar" || growthTypeOverride === "line") {
      return growthTypeOverride;
    }
    return result.chartPreference === "bar" ? "bar" : "line";
  }

  function updateGrowthToggleUi(result, activeType) {
    const toggle = document.getElementById("chartTypeToggle");
    const badge = document.getElementById("chartModeBadge");
    const btnBar = document.getElementById("btn-chart-bar");
    const btnLine = document.getElementById("btn-chart-line");
    const allows = !!result.chartAllowsToggle;
    const axisCount = result.chartMeta?.axisCount || getAxisMeta(result).axisCount;
    const unit = result.chartMeta?.axisUnit || getAxisMeta(result).axisUnit;
    const unitWord = unit === "years" ? "years"
      : unit === "months" ? "months"
      : unit === "quarters" ? "quarters"
      : unit === "days" ? "days"
      : "periods";

    if (toggle) toggle.classList.toggle("d-none", !allows);
    btnBar?.classList.toggle("active", activeType === "bar");
    btnLine?.classList.toggle("active", activeType === "line");

    if (badge) {
      badge.textContent = activeType === "bar"
        ? `Bars · ${axisCount} ${unitWord}`
        : `Line · ${axisCount} ${unitWord}`;
    }
  }

  function setGrowthType(type) {
    if (!lastGrowthResult?.chartAllowsToggle) return;
    if (type !== "bar" && type !== "line") return;
    growthTypeOverride = type;
    const canvas = document.getElementById("growthChart");
    if (canvas && lastGrowthResult) renderGrowth(canvas, lastGrowthResult);
  }

  function renderGrowth(canvas, result) {
    if (!canvas || !result) return;

    if (lastGrowthResult !== result) {
      growthTypeOverride = null;
      lastGrowthResult = result;
    }

    const type = resolveGrowthType(result);
    updateGrowthToggleUi(result, type);

    const currency = result.currency;
    const asset = result.asset;
    const built = buildGrowthPoints(result);
    let { points, axisUnit, axisCount } = built;
    const detailGrain = built.detailGrain;
    if (!points.length) return;

    const isBar = type === "bar";
    if (isBar) {
      points = aggregateBars(points, axisCount, axisUnit);
    } else {
      points = points.map((p) => ({
        ...p,
        hoverLabel: lineHoverLabel(p.period, detailGrain, axisUnit),
      }));
    }

    if (growthChart) growthChart.destroy();
    hideGrowthTooltip();

    const tickVals = isBar ? null : buildLineAxisTicks(axisCount);
    const categoryLabels = isBar ? points.map((p) => p.axisLabel) : null;

    const lineDataset = (label, key, color) => ({
      label,
      data: points.map((p) => ({ x: p.x, y: p[key] })),
      borderColor: color,
      backgroundColor: color + "22",
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHitRadius: 10,
      tension: 0.25,
      fill: true,
    });

    const barDataset = (label, key, color) => ({
      label,
      data: points.map((p) => p[key]),
      backgroundColor: color + "cc",
      borderColor: color,
      borderWidth: 0,
      borderRadius: 0,
      maxBarThickness: axisCount <= 6 ? 36 : 22,
    });

    const datasets = isBar
      ? [
          barDataset("Final balance", "balance", COLORS.balance),
          barDataset("Total invested", "invested", COLORS.invested),
          barDataset("Earnings", "earnings", COLORS.earnings),
        ]
      : [
          lineDataset("Final balance", "balance", COLORS.balance),
          lineDataset("Total invested", "invested", COLORS.invested),
          lineDataset("Earnings", "earnings", COLORS.earnings),
        ];

    growthChart = new Chart(canvas, {
      type,
      data: {
        labels: isBar ? categoryLabels : undefined,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false, axis: "x" },
        layout: {
          padding: { left: 4 },
        },
        plugins: {
          legend: {
            position: "top",
            labels: { color: COLORS.text, usePointStyle: true, boxWidth: 8 },
          },
          tooltip: {
            enabled: false,
            external(context) {
              const { tooltip } = context;
              if (!tooltip || tooltip.opacity === 0) {
                hideGrowthTooltip();
                return;
              }
              const idx = tooltip.dataPoints?.[0]?.dataIndex;
              if (idx == null || !points[idx]) {
                hideGrowthTooltip();
                return;
              }
              const p = points[idx];
              const title = p.hoverLabel
                || (isBar
                  ? barHoverLabel(Math.round(p.x), axisUnit)
                  : lineAxisLabel(p.x, axisUnit));
              const rowsHtml = (tooltip.dataPoints || []).map((dp) => {
                const v = dp.parsed.y ?? dp.parsed;
                const color = dp.dataset.borderColor || dp.dataset.backgroundColor || COLORS.text;
                return `<div class="tft-row">
                  <span class="tft-label">
                    <span class="tft-swatch" style="background:${escapeHtml(String(color).slice(0, 7))}"></span>
                    ${escapeHtml(dp.dataset.label)}
                  </span>
                  <strong>${escapeHtml(formatMoney(v, currency, asset))}</strong>
                </div>`;
              }).join("");
              showGrowthTooltip(`<div class="tft-title">${escapeHtml(title)}</div>${rowsHtml}`);
            },
          },
        },
        scales: {
          x: isBar
            ? {
                ticks: {
                  color: COLORS.text,
                  maxRotation: axisCount > 12 ? 40 : 0,
                  autoSkip: false,
                },
                grid: { color: COLORS.grid },
              }
            : {
                type: "linear",
                min: 0,
                max: axisCount,
                afterBuildTicks(axis) {
                  axis.ticks = tickVals.map((v) => ({ value: v }));
                },
                ticks: {
                  color: COLORS.text,
                  maxRotation: 0,
                  autoSkip: false,
                  callback(value) {
                    // Labels only at band centers; integers keep the grid clean.
                    if (!isLineMidTick(value)) return "";
                    return lineAxisLabel(value, axisUnit);
                  },
                },
                grid: {
                  color(ctx) {
                    const v = ctx.tick?.value;
                    if (v == null || isLineMidTick(v)) return "transparent";
                    return COLORS.grid;
                  },
                },
              },
          y: {
            position: "right",
            ticks: {
              color: COLORS.text,
              callback: (v) => {
                if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
                if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "k";
                return v;
              },
            },
            grid: { color: COLORS.grid },
          },
        },
      },
    });
  }

  function hideGrowthTooltip() {
    document.getElementById("growthTooltip")?.classList.add("d-none");
  }

  function showGrowthTooltip(html) {
    const el = document.getElementById("growthTooltip");
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove("d-none");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderComposition(canvas, result) {
    if (!canvas || !result) return;
    const s = result.summary;
    const invested = Math.max(0, s.totalInvested);
    const earnings = Math.max(0, s.earnings);
    const currency = result.currency;
    const asset = result.asset;

    if (compositionChart) compositionChart.destroy();

    compositionChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["Total invested", "Earnings"],
        datasets: [{
          data: [invested, earnings],
          backgroundColor: [COLORS.invested, COLORS.earnings],
          borderWidth: 0,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: COLORS.text, usePointStyle: true, boxWidth: 8 },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed;
                const total = invested + earnings || 1;
                const pct = ((v / total) * 100).toFixed(1);
                return `${ctx.label}: ${formatMoney(v, currency, asset)} (${pct}%)`;
              },
            },
          },
        },
        cutout: "62%",
      },
    });
  }

  function renderScenarios(canvas, result) {
    if (!canvas || !result?.scenarios) return;
    const currency = result.currency;
    const asset = result.asset;
    const { expected, best, worst } = result.scenarios;

    if (scenarioChart) scenarioChart.destroy();

    scenarioChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: ["Expected", "Best (+20%)", "Worst (−20%)"],
        datasets: [
          {
            label: "Final balance",
            data: [
              expected.finalBalance,
              best.finalBalance,
              worst.finalBalance,
            ],
            backgroundColor: [COLORS.expected, COLORS.best, COLORS.worst],
            borderRadius: 8,
            borderSkipped: false,
            maxBarThickness: 48,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const key = ["expected", "best", "worst"][ctx.dataIndex];
                const sc = result.scenarios[key];
                return [
                  `Balance: ${formatMoney(sc.finalBalance, currency, asset)}`,
                  `Earnings: ${formatMoney(sc.earnings, currency, asset)}`,
                  `ROI: ${Number(sc.roi).toFixed(2)}%`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: COLORS.text },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: COLORS.text,
              callback: (v) => {
                if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
                if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "k";
                return v;
              },
            },
            grid: { color: COLORS.grid },
          },
        },
      },
    });
  }

  function renderAll(result) {
    renderGrowth(document.getElementById("growthChart"), result);
    renderComposition(document.getElementById("compositionChart"), result);
    renderScenarios(document.getElementById("scenarioChart"), result);
  }

  function getChartImages() {
    const out = {};
    if (growthChart) out.growth = growthChart.toBase64Image("image/png", 1);
    if (compositionChart) out.composition = compositionChart.toBase64Image("image/png", 1);
    if (scenarioChart) out.scenario = scenarioChart.toBase64Image("image/png", 1);
    return out;
  }

  return { renderAll, destroyAll, formatMoney, getChartImages, setGrowthType };
})();
