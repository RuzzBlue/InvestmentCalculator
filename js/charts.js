/**
 * Chart.js helpers for YieldLens
 */

const Charts = (() => {
  let growthChart = null;
  let compositionChart = null;

  const COLORS = {
    balance: "#0f6b4c",
    invested: "#4a5750",
    earnings: "#b8842a",
    grid: "rgba(28, 36, 32, 0.08)",
    text: "#4a5750",
  };

  function moneyTooltip(currency, asset) {
    return (ctx) => {
      const v = ctx.parsed.y ?? ctx.parsed;
      return `${ctx.dataset.label}: ${formatMoney(v, currency, asset)}`;
    };
  }

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
    if (growthChart) {
      growthChart.destroy();
      growthChart = null;
    }
    if (compositionChart) {
      compositionChart.destroy();
      compositionChart = null;
    }
  }

  function renderGrowth(canvas, result) {
    if (!canvas || !result) return;
    const rows = result.rows || [];
    const labels = rows.map((r) => r.label);
    const balances = rows.map((r) => r.balance);
    const invested = rows.map((r) => r.invested);
    const earnings = rows.map((r) => r.earnings);
    const type = result.chartPreference === "bar" ? "bar" : "line";
    const currency = result.currency;
    const asset = result.asset;

    if (growthChart) growthChart.destroy();

    const commonDataset = (label, data, color) => ({
      label,
      data,
      borderColor: color,
      backgroundColor: type === "bar" ? color + "cc" : color + "22",
      borderWidth: type === "line" ? 2.5 : 0,
      pointRadius: type === "line" ? (labels.length > 60 ? 0 : 2.5) : 0,
      pointHoverRadius: 5,
      tension: 0.25,
      fill: type === "line",
    });

    growthChart = new Chart(canvas, {
      type,
      data: {
        labels,
        datasets: [
          commonDataset("Final balance", balances, COLORS.balance),
          commonDataset("Total invested", invested, COLORS.invested),
          commonDataset("Earnings", earnings, COLORS.earnings),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "top",
            labels: { color: COLORS.text, usePointStyle: true, boxWidth: 8 },
          },
          tooltip: {
            callbacks: {
              label: moneyTooltip(currency, asset),
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: COLORS.text,
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 10,
            },
            grid: { color: COLORS.grid },
          },
          y: {
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

  function renderAll(result) {
    renderGrowth(document.getElementById("growthChart"), result);
    renderComposition(document.getElementById("compositionChart"), result);
  }

  return { renderAll, destroyAll, formatMoney };
})();
