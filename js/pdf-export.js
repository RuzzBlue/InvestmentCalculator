/**
 * Structured PDF export from calculation data (not page screenshots).
 * Mirrors the on-screen Results view: metrics, scenarios, live charts,
 * period breakdown (selected Scale), and insights.
 */

const PdfExport = (() => {
  function money(value, currency, asset) {
    return Charts.formatMoney(value, currency, asset);
  }

  function pct(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return `${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }

  async function exportResults(result, options = {}) {
    if (!result || !window.jspdf) {
      alert("Nothing to export yet, or PDF libraries failed to load.");
      return;
    }
    const tableGrain = options.tableGrain || "auto";
    const metaLine = options.meta || "";
    const metricCards = Array.isArray(options.metrics) ? options.metrics : null;
    const insightItems = Array.isArray(options.insights) ? options.insights : [];
    const growthBadge = options.growthBadge || "";
    const chartScaleLabel = options.chartScaleLabel || "";

    const btn = document.getElementById("btn-export-pdf");
    const prev = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Building PDF…';
    }

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 14;
      const contentWidth = pageWidth - margin * 2;
      let y = margin;

      const ensureSpace = (needed) => {
        if (y + needed > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
      };

      const sectionTitle = (title) => {
        ensureSpace(14);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(28, 36, 32);
        doc.text(title, margin, y);
        y += 5;
      };

      // Title block
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.setTextColor(15, 107, 76);
      doc.text("YieldLens", margin, y);
      y += 7;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(28, 36, 32);
      doc.text("Calculation Results", margin, y);
      y += 6;

      doc.setFontSize(9);
      doc.setTextColor(110, 124, 116);
      const meta = [
        metaLine || result.title || "Investment",
        `Exported ${new Date().toLocaleString()}`,
      ].filter(Boolean).join("  ·  ");
      const metaLines = doc.splitTextToSize(meta, contentWidth);
      doc.text(metaLines, margin, y);
      y += metaLines.length * 4.2 + 4;

      // Key metrics — same cards as on screen
      sectionTitle("Key metrics");
      const s = result.summary;
      let metricRows;
      if (metricCards?.length) {
        metricRows = metricCards.map((m) => [
          m.sub ? `${m.label} (${m.sub})` : m.label,
          m.value,
        ]);
      } else {
        metricRows = [
          ["Total invested", money(s.totalInvested, result.currency, result.asset)],
          ["Earnings", money(s.earnings, result.currency, result.asset)],
          ["Final balance", money(s.finalBalance, result.currency, result.asset)],
          ["Return on investment", pct(s.roi)],
          ["Effective APY", pct(s.apy)],
        ];
      }

      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Metric", "Value"]],
        body: metricRows,
        theme: "grid",
        styles: { fontSize: 9, cellPadding: 2.2, textColor: [28, 36, 32] },
        headStyles: { fillColor: [15, 107, 76], textColor: 255, fontStyle: "bold" },
        columnStyles: { 1: { halign: "right" } },
      });
      y = doc.lastAutoTable.finalY + 8;

      // Scenario comparison (cards → table)
      sectionTitle("Scenario comparison");
      const sc = result.scenarios;
      const expectedBal = sc.expected.finalBalance;
      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Scenario", "Final balance", "Earnings", "ROI", "vs Expected"]],
        body: [
          [
            "Expected case",
            money(sc.expected.finalBalance, result.currency, result.asset),
            money(sc.expected.earnings, result.currency, result.asset),
            pct(sc.expected.roi),
            `Baseline @ ${pct(result.ratePct)}`,
          ],
          [
            "Best case (+20% rate)",
            money(sc.best.finalBalance, result.currency, result.asset),
            money(sc.best.earnings, result.currency, result.asset),
            pct(sc.best.roi),
            money(sc.best.finalBalance - expectedBal, result.currency, result.asset),
          ],
          [
            "Worst case (−20% rate)",
            money(sc.worst.finalBalance, result.currency, result.asset),
            money(sc.worst.earnings, result.currency, result.asset),
            pct(sc.worst.roi),
            money(sc.worst.finalBalance - expectedBal, result.currency, result.asset),
          ],
        ],
        theme: "grid",
        styles: { fontSize: 8.5, cellPadding: 2 },
        headStyles: { fillColor: [74, 87, 80], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          1: { halign: "right" },
          2: { halign: "right" },
          3: { halign: "right" },
          4: { halign: "right" },
        },
      });
      y = doc.lastAutoTable.finalY + 8;

      // Live Chart.js images (growth uses current type + Scale)
      const images = typeof Charts.getChartImages === "function" ? Charts.getChartImages() : {};

      if (images.growth) {
        const growthTitle = chartScaleLabel
          ? `Growth over time (${chartScaleLabel}${growthBadge ? ` · ${growthBadge}` : ""})`
          : (growthBadge ? `Growth over time (${growthBadge})` : "Growth over time");
        sectionTitle(growthTitle);
        y -= 2;
        ensureSpace(66);
        const imgH = 62;
        doc.addImage(images.growth, "PNG", margin, y, contentWidth, imgH);
        y += imgH + 8;
      }

      if (images.composition) {
        sectionTitle("Where the final balance comes from");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(110, 124, 116);
        doc.text("Share of capital you put in vs. growth earned.", margin, y);
        y += 3;
        ensureSpace(60);
        const imgH = 55;
        doc.addImage(images.composition, "PNG", margin, y, contentWidth * 0.72, imgH);
        y += imgH + 8;
      }

      if (images.scenario) {
        sectionTitle("Scenario outcomes");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(110, 124, 116);
        doc.text("Final balances under Expected, Best, and Worst rates.", margin, y);
        y += 3;
        ensureSpace(60);
        const imgH = 55;
        doc.addImage(images.scenario, "PNG", margin, y, contentWidth * 0.72, imgH);
        y += imgH + 8;
      }

      // Period table at the same Scale as the on-screen breakdown
      const grainOpt = (result.tableMeta?.grains || []).find((g) => g.id === tableGrain);
      const grainLabel = grainOpt?.label || "Auto";
      sectionTitle(`Period breakdown (${grainLabel})`);
      y -= 1;

      const rows = typeof Calculations?.rowsForTableGrain === "function"
        ? Calculations.rowsForTableGrain(result, tableGrain)
        : (result.rows || []);
      const body = rows.map((r) => [
        r.label,
        money(r.invested, result.currency, result.asset),
        money(r.earnings, result.currency, result.asset),
        money(r.balance, result.currency, result.asset),
      ]);

      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Period", "Invested", "Earnings", "Balance"]],
        body,
        theme: "striped",
        styles: { fontSize: 8, cellPadding: 1.6, textColor: [28, 36, 32] },
        headStyles: { fillColor: [15, 107, 76], textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [243, 240, 232] },
        columnStyles: {
          1: { halign: "right" },
          2: { halign: "right" },
          3: { halign: "right" },
        },
      });
      y = doc.lastAutoTable.finalY + 8;

      // Insights for this run (same recommendations as Results)
      if (insightItems.length) {
        sectionTitle("Insights for this run");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(74, 87, 80);
        insightItems.forEach((note) => {
          const lines = doc.splitTextToSize(`• ${note}`, contentWidth);
          ensureSpace(lines.length * 4.2 + 2);
          doc.text(lines, margin, y);
          y += lines.length * 4.2 + 1.5;
        });
      }

      // Footer on every page
      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(110, 124, 116);
        doc.setFillColor(255, 253, 248);
        doc.rect(margin, pageHeight - 10, contentWidth, 6, "F");
        doc.text(
          `YieldLens · Branko Pereira · page ${i} of ${pageCount}`,
          pageWidth / 2,
          pageHeight - 6,
          { align: "center" }
        );
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const safeTitle = String(result.title || "results").replace(/[^\w\-]+/g, "_");
      doc.save(`YieldLens-${safeTitle}-${stamp}.pdf`);
    } catch (err) {
      console.error(err);
      alert("Could not create PDF. Check the console for details.");
    } finally {
      if (btn) {
        btn.disabled = !result;
        btn.innerHTML = prev || '<i class="fa-solid fa-file-pdf me-1"></i>Export PDF';
      }
    }
  }

  return { exportResults };
})();
