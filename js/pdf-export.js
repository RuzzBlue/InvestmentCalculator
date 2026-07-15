/**
 * Structured PDF export from calculation data (not page screenshots).
 * Uses jsPDF + autotable for clean pagination and the full period table.
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

  async function exportResults(result) {
    if (!result || !window.jspdf) {
      alert("Nothing to export yet, or PDF libraries failed to load.");
      return;
    }

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
        result.title || "Investment",
        result.asset && result.currency !== "$" ? result.asset : null,
        result.days ? `${result.days} days` : null,
        result.ratePct != null ? `Assumed rate ${pct(result.ratePct)}` : null,
        `Exported ${new Date().toLocaleString()}`,
      ].filter(Boolean).join("  ·  ");
      const metaLines = doc.splitTextToSize(meta, contentWidth);
      doc.text(metaLines, margin, y);
      y += metaLines.length * 4.2 + 4;

      // Key metrics
      ensureSpace(28);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(28, 36, 32);
      doc.text("Key metrics", margin, y);
      y += 5;

      const s = result.summary;
      const metricRows = [
        ["Total invested", money(s.totalInvested, result.currency, result.asset)],
        ["Earnings", money(s.earnings, result.currency, result.asset)],
        ["Final balance", money(s.finalBalance, result.currency, result.asset)],
        ["Return on investment", pct(s.roi)],
        ["Effective APY", pct(s.apy)],
      ];

      if (result.extras?.afterWithdraw != null) {
        metricRows.push([
          `After withdraw (fee ${pct(result.extras.withdrawFee)})`,
          money(result.extras.afterWithdraw, result.currency, result.asset),
        ]);
      }
      if (result.extras?.bonusEarnings != null) {
        metricRows.push([
          "Bonus rewards (non-compounded)",
          money(result.extras.bonusEarnings, result.currency, result.asset),
        ]);
      }
      if (s.selfFund) {
        metricRows.push([
          "Self-funding from",
          `${s.selfFund.label} (earnings cover deposits)`,
        ]);
      }
      if (s.contribGrowthEnabled && s.endingContribution != null) {
        metricRows.push([
          "Ending contribution",
          money(s.endingContribution, result.currency, result.asset),
        ]);
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

      // Scenarios
      ensureSpace(36);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(28, 36, 32);
      doc.text("Scenario comparison", margin, y);
      y += 5;

      const sc = result.scenarios;
      const expectedBal = sc.expected.finalBalance;
      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Scenario", "Final balance", "Earnings", "ROI", "vs Expected"]],
        body: [
          [
            "Expected",
            money(sc.expected.finalBalance, result.currency, result.asset),
            money(sc.expected.earnings, result.currency, result.asset),
            pct(sc.expected.roi),
            "Baseline",
          ],
          [
            "Best (+20% rate)",
            money(sc.best.finalBalance, result.currency, result.asset),
            money(sc.best.earnings, result.currency, result.asset),
            pct(sc.best.roi),
            money(sc.best.finalBalance - expectedBal, result.currency, result.asset),
          ],
          [
            "Worst (−20% rate)",
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

      // Charts as images (vector-ish PNG from Chart.js, not HTML screenshot)
      const images = typeof Charts.getChartImages === "function" ? Charts.getChartImages() : {};
      if (images.growth) {
        ensureSpace(78);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("Growth over time", margin, y);
        y += 3;
        const imgH = 62;
        doc.addImage(images.growth, "PNG", margin, y, contentWidth, imgH);
        y += imgH + 8;
      }

      if (images.composition || images.scenario) {
        ensureSpace(72);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("Composition & scenarios", margin, y);
        y += 3;
        const half = (contentWidth - 4) / 2;
        const imgH = 55;
        if (images.composition) {
          doc.addImage(images.composition, "PNG", margin, y, half, imgH);
        }
        if (images.scenario) {
          doc.addImage(images.scenario, "PNG", margin + half + 4, y, half, imgH);
        }
        y += imgH + 8;
      }

      // Notes / insights
      if (result.notes?.length) {
        ensureSpace(20);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(28, 36, 32);
        doc.text("Model notes", margin, y);
        y += 5;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(74, 87, 80);
        result.notes.forEach((note) => {
          const lines = doc.splitTextToSize(`• ${note}`, contentWidth);
          ensureSpace(lines.length * 4.2 + 2);
          doc.text(lines, margin, y);
          y += lines.length * 4.2 + 1.5;
        });
        y += 4;
      }

      // Full period table
      ensureSpace(30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(28, 36, 32);
      doc.text("Period breakdown (all entries)", margin, y);
      y += 4;

      const rows = result.fullRows?.length ? result.fullRows : (result.rows || []);
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
        didDrawPage: (data) => {
          doc.setFontSize(8);
          doc.setTextColor(110, 124, 116);
          doc.text(
            `YieldLens · Branko Pereira · page ${data.pageNumber}`,
            pageWidth / 2,
            pageHeight - 6,
            { align: "center" }
          );
        },
      });

      // Fill in total page counts now that the document is complete.
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
