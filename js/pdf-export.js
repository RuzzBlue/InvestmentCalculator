/**
 * Export the results column to a multi-page PDF
 */

const PdfExport = (() => {
  async function exportResults() {
    const root = document.getElementById("exportRoot");
    if (!root || typeof html2canvas === "undefined" || !window.jspdf) {
      alert("PDF libraries failed to load. Check your connection and try again.");
      return;
    }

    const btn = document.getElementById("btn-export-pdf");
    const prev = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Preparing…';
    }

    try {
      const canvas = await html2canvas(root, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#fffdf8",
        logging: false,
        windowWidth: root.scrollWidth,
      });

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 10;
      const usableWidth = pageWidth - margin * 2;
      const imgHeight = (canvas.height * usableWidth) / canvas.width;

      let heightLeft = imgHeight;
      let position = margin;
      const imgData = canvas.toDataURL("image/png");

      pdf.addImage(imgData, "PNG", margin, position, usableWidth, imgHeight);
      heightLeft -= pageHeight - margin * 2;

      while (heightLeft > 0) {
        position = margin - (imgHeight - heightLeft);
        pdf.addPage();
        pdf.addImage(imgData, "PNG", margin, position, usableWidth, imgHeight);
        heightLeft -= pageHeight - margin * 2;
      }

      const stamp = new Date().toISOString().slice(0, 10);
      pdf.save(`YieldLens-results-${stamp}.pdf`);
    } catch (err) {
      console.error(err);
      alert("Could not create PDF. Try again or use your browser print dialog.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = prev;
      }
    }
  }

  return { exportResults };
})();
