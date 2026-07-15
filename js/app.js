/**
 * YieldLens UI controller
 */

(() => {
  const state = {
    lastResult: null,
    tablePage: 1,
    pageSize: 10,
    activeView: "guide", // "guide" | "results"
  };

  const CONTEXT = {
    investment: {
      title: "Investment calculator",
      lead: "Project a classic savings or brokerage plan with a starting balance, recurring contributions, and a chosen compounding frequency. Use this when a platform clearly states how often interest compounds — or when you want a clean “what if” baseline.",
      cards: [
        {
          icon: "fa-layer-group",
          title: "Compounding frequency",
          body: "Annually, quarterly, monthly, or daily changes the curve for the same APR. The Learn modal shows APR vs APY so you can compare bank-style APY quotes fairly.",
        },
        {
          icon: "fa-calendar-plus",
          title: "Contributions matter",
          body: "Monthly deposits often outweigh small APY differences. The results chart separates total invested from earnings so you can see which driver is larger.",
        },
        {
          icon: "fa-scale-balanced",
          title: "Stress-test the rate",
          body: "After you calculate, Expected / Best / Worst scenarios apply ±20% to your assumed rate — a simple way to avoid single-number optimism.",
        },
        {
          icon: "fa-lightbulb",
          title: "Tip",
          body: "If a product only quotes APR and says “paid daily into Spot” without auto-reinvest, your true path is closer to simple interest unless you manually restake.",
        },
      ],
      note: "Hit Calculate to open Results. You can toggle back to this Guide anytime without losing your last run.",
    },
    crypto: {
      title: "Crypto Earn & staking",
      lead: "Modeled after how Binance Simple Earn and Bybit Easy Earn typically work — not marketing headlines. Switch Type to unlock fields for flexible earn, bonus APR caps, fixed terms, and staking.",
      cards: [
        {
          icon: "fa-bolt",
          title: "Flexible / default",
          body: "APR usually accrues daily (sometimes every minute on Flexible). We compound the quoted APR into the balance — the common auto-earn case.",
        },
        {
          icon: "fa-gift",
          title: "Simple Earn bonus",
          body: "Bonus APR applies only up to your cap (e.g. first $2,000). That slice is treated as non-compounding Spot-style rewards; the rest earns regular APR that does compound.",
        },
        {
          icon: "fa-lock",
          title: "Fixed term",
          body: "Yield = Principal × APR ÷ 365 × lock days. Paid at maturity. No mid-term compounding — matching typical locked earn products.",
        },
        {
          icon: "fa-link",
          title: "Staking",
          body: "Modeled as daily compounding of staking APR when rewards auto-restake. If your chain pays to a wallet you never restake, outcomes will look closer to simple interest.",
        },
      ],
      note: "Promo “up to 200% APR” almost always means a tiny tier or short campaign. Always enter the bonus cap.",
    },
    etf: {
      title: "Stocks & ETFs",
      lead: "Simple mode uses one assumed annual return. Advanced mode splits price appreciation, dividend yield, expense ratio, DRIP, and optional withdrawal fees — closer to how a fund like VOO actually behaves.",
      cards: [
        {
          icon: "fa-chart-line",
          title: "Price vs total return",
          body: "In Advanced, Annual return is price appreciation. Dividends are separate. Expense ratio quietly reduces assets every year.",
        },
        {
          icon: "fa-rotate",
          title: "DRIP",
          body: "Reinvesting dividends buys more shares so distributions compound. Turning DRIP off keeps dividends as cash earnings that stop compounding inside the ETF.",
        },
        {
          icon: "fa-percent",
          title: "Expense ratio",
          body: "VOO’s ~0.03% looks tiny; active funds at 0.5–1% drag hard over decades. The calculator subtracts it continuously.",
        },
        {
          icon: "fa-door-open",
          title: "Withdrawal fee",
          body: "Does not change growth. If set, results show Final balance and After withdraw so you see friction when cashing out of an app.",
        },
      ],
      note: "Past ETF yields and returns are not guarantees — use scenario cards to explore weaker and stronger markets.",
    },
  };

  document.addEventListener("DOMContentLoaded", () => {
    renderContext("investment");
    bindTabs();
    bindForms();
    bindCryptoType();
    bindEtfType();
    bindAssetSymbol();
    bindFixedTermCustom();
    bindTableControls();
    bindViewToggle();
    bindContributionGrowth();
    bindContribTiming();
    bindChartTypeToggle();
    updateViewChrome();
    document.getElementById("btn-export-pdf")?.addEventListener("click", () => {
      if (state.lastResult) PdfExport.exportResults(state.lastResult);
    });
  });

  function bindChartTypeToggle() {
    document.getElementById("btn-chart-bar")?.addEventListener("click", () => {
      Charts.setGrowthType("bar");
    });
    document.getElementById("btn-chart-line")?.addEventListener("click", () => {
      Charts.setGrowthType("line");
    });
    document.getElementById("chartGrainSelect")?.addEventListener("change", (e) => {
      Charts.setChartGrain(e.target.value);
    });
  }

  function bindViewToggle() {
    document.getElementById("btn-show-guide")?.addEventListener("click", () => setView("guide"));
    document.getElementById("btn-show-results")?.addEventListener("click", () => {
      if (state.lastResult) setView("results");
    });
  }

  function bindTabs() {
    document.querySelectorAll('#calcTypeTabs button[data-bs-toggle="pill"]').forEach((btn) => {
      btn.addEventListener("shown.bs.tab", (e) => {
        const id = e.target.id;
        if (id === "tab-investment") renderContext("investment");
        if (id === "tab-crypto") renderContext("crypto");
        if (id === "tab-etf") renderContext("etf");
        // Keep prior results available via the Results toggle; land on Guide for the new tab.
        setView("guide");
      });
    });
  }

  function renderContext(key) {
    const data = CONTEXT[key];
    const panel = document.getElementById("contextPanel");
    if (!panel || !data) return;
    panel.innerHTML = `
      <h2>${data.title}</h2>
      <p class="lead-text">${data.lead}</p>
      <div class="context-cards">
        ${data.cards.map((c) => `
          <article class="context-card">
            <h3><i class="fa-solid ${c.icon}"></i>${c.title}</h3>
            <p>${c.body}</p>
          </article>
        `).join("")}
      </div>
      <div class="context-note"><i class="fa-solid fa-circle-info me-2"></i>${data.note}</div>
    `;
  }

  function setView(view) {
    if (view === "results" && !state.lastResult) return;
    state.activeView = view;
    updateViewChrome();

    // Re-draw charts after the panel is visible again (avoids zero-size canvases).
    if (state.activeView === "results" && state.lastResult) {
      requestAnimationFrame(() => Charts.renderAll(state.lastResult));
    }
  }

  function updateViewChrome() {
    const hasResults = !!state.lastResult;
    const showingResults = state.activeView === "results" && hasResults;

    document.getElementById("preCalcView")?.classList.toggle("d-none", showingResults);
    const resultsView = document.getElementById("resultsView");
    resultsView?.classList.toggle("d-none", !showingResults);
    if (showingResults) resultsView?.classList.add("show-animate");

    const title = document.getElementById("resultsPanelTitle");
    if (title) title.textContent = showingResults ? "Calculation Results" : "Guide";

    const btnGuide = document.getElementById("btn-show-guide");
    const btnResults = document.getElementById("btn-show-results");
    const btnExport = document.getElementById("btn-export-pdf");

    btnGuide?.classList.toggle("active", !showingResults);
    btnResults?.classList.toggle("active", showingResults);
    btnGuide?.setAttribute("aria-pressed", String(!showingResults));
    btnResults?.setAttribute("aria-pressed", String(showingResults));

    if (btnResults) {
      btnResults.disabled = !hasResults;
      btnResults.title = hasResults ? "Show calculation results" : "Calculate first to unlock results";
    }
    if (btnExport) {
      btnExport.disabled = !hasResults;
      btnExport.title = hasResults ? "Export full results to PDF" : "Calculate first to export";
    }
  }

  function bindContribTiming() {
    document.querySelectorAll(".contrib-after-start").forEach((el) => {
      el.addEventListener("change", () => syncContribTimingLabel(el.dataset.timingPrefix));
      syncContribTimingLabel(el.dataset.timingPrefix);
    });
  }

  function syncContribTimingLabel(prefix) {
    if (!prefix) return;
    const checked = document.getElementById(`${prefix}-contrib-after-start`)?.checked;
    const label = document.querySelector(`label.contrib-timing-label[for="${prefix}-contrib-after-start"]`);
    if (label) {
      label.textContent = checked ? "after starting amount" : "with starting amount";
    }
  }

  function readContribAfterStart(prefix) {
    const el = document.getElementById(`${prefix}-contrib-after-start`);
    return el ? el.checked : true;
  }

  function bindContributionGrowth() {
    document.querySelectorAll(".grow-toggle").forEach((el) => {
      el.addEventListener("change", () => syncGrowFields(el.dataset.growPrefix));
      syncGrowFields(el.dataset.growPrefix);
    });
    document.querySelectorAll(".grow-mode").forEach((el) => {
      el.addEventListener("change", () => syncGrowMode(el.dataset.growPrefix));
      syncGrowMode(el.dataset.growPrefix);
    });
  }

  function syncGrowFields(prefix) {
    if (!prefix) return;
    const on = document.getElementById(`${prefix}-grow-contrib`)?.checked;
    document.getElementById(`${prefix}-grow-fields`)?.classList.toggle("d-none", !on);
    if (on) syncGrowMode(prefix);
  }

  function syncGrowMode(prefix) {
    if (!prefix) return;
    const mode = sel(`${prefix}-grow-mode`) || "percent";
    document.getElementById(`${prefix}-grow-fixed-wrap`)?.classList.toggle("d-none", mode !== "fixed");
    document.getElementById(`${prefix}-grow-percent-wrap`)?.classList.toggle("d-none", mode !== "percent");
    document.getElementById(`${prefix}-grow-variable-wrap`)?.classList.toggle("d-none", mode !== "variable");
  }

  function readContribGrowth(prefix) {
    const enabled = !!document.getElementById(`${prefix}-grow-contrib`)?.checked;
    if (!enabled) return { enabled: false };
    return {
      enabled: true,
      mode: sel(`${prefix}-grow-mode`) || "percent",
      every: sel(`${prefix}-grow-every`) || "year",
      amount: val(`${prefix}-grow-amount`),
      percent: val(`${prefix}-grow-percent`),
      minPercent: Number(document.getElementById(`${prefix}-grow-min`)?.value),
      maxPercent: Number(document.getElementById(`${prefix}-grow-max`)?.value),
    };
  }

  function bindForms() {
    document.getElementById("form-investment")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = {
        principal: val("inv-principal"),
        years: val("inv-years"),
        contribution: val("inv-contribution"),
        contribFreq: sel("inv-contrib-freq"),
        contribAfterStart: readContribAfterStart("inv"),
        contribGrowth: readContribGrowth("inv"),
        rate: val("inv-rate"),
        compound: sel("inv-compound"),
      };
      run("investment", input);
    });

    document.getElementById("form-crypto")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const cryType = sel("cry-type");
      const input = {
        cryType,
        principal: val("cry-principal"),
        asset: sel("cry-asset"),
        contribution: val("cry-contribution"),
        contribFreq: sel("cry-contrib-freq"),
        contribAfterStart: readContribAfterStart("cry"),
        contribGrowth: readContribGrowth("cry"),
        period: val("cry-period"),
        periodUnit: sel("cry-period-unit"),
        apr: val("cry-apr"),
        rateQuote: cryType === "default" ? (sel("cry-rate-quote") || "apr") : "apr",
        regularApr: val("cry-regular-apr"),
        bonusApr: val("cry-bonus-apr"),
        bonusCap: val("cry-bonus-cap"),
        fixedTerm: sel("cry-fixed-term"),
        customDays: val("cry-custom-days"),
        fixedApr: val("cry-fixed-apr"),
      };
      run("crypto", input);
    });

    document.getElementById("form-etf")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = {
        etfType: sel("etf-type"),
        principal: val("etf-principal"),
        contribution: val("etf-contribution"),
        contribFreq: sel("etf-contrib-freq"),
        contribAfterStart: readContribAfterStart("etf"),
        contribGrowth: readContribGrowth("etf"),
        period: val("etf-period"),
        periodUnit: sel("etf-period-unit"),
        annualReturn: val("etf-return"),
        dividendYield: val("etf-dividend"),
        expenseRatio: val("etf-expense"),
        reinvestDividends: document.getElementById("etf-reinvest")?.checked,
        withdrawFee: val("etf-withdraw-fee"),
      };
      run("etf", input);
    });
  }

  function run(source, input) {
    try {
      const result = Calculations.calculate(source, input);
      result.input = input;
      state.lastResult = result;
      state.tablePage = 1;
      renderResults(result);
      setView("results");
      const panel = document.getElementById("resultsPanel");
      if (panel) panel.scrollTop = 0;
    } catch (err) {
      console.error(err);
      alert("Calculation failed. Check your inputs and try again.");
    }
  }

  function bindCryptoType() {
    const typeSel = document.getElementById("cry-type");
    typeSel?.addEventListener("change", updateCryptoFields);
    updateCryptoFields();
  }

  function updateCryptoFields() {
    const type = sel("cry-type");
    const flexPeriod = document.getElementById("cry-period-flex");
    const fixedPeriod = document.getElementById("cry-period-fixed");
    const rateDefault = document.getElementById("cry-rate-default");
    const simpleEarn = document.getElementById("cry-simple-earn-fields");
    const fixedRate = document.getElementById("cry-fixed-rate-wrap");
    const contrib = document.getElementById("cry-contrib-wrap");
    const aprLabel = document.getElementById("cry-apr-label");
    const aprHint = document.getElementById("cry-apr-hint");
    const rateQuote = document.getElementById("cry-rate-quote");

    // reset
    flexPeriod?.classList.remove("d-none");
    fixedPeriod?.classList.add("d-none");
    rateDefault?.classList.remove("d-none");
    simpleEarn?.classList.add("d-none");
    fixedRate?.classList.add("d-none");
    contrib?.classList.remove("d-none");
    rateQuote?.classList.remove("d-none");

    if (type === "simple_earn") {
      rateDefault?.classList.add("d-none");
      simpleEarn?.classList.remove("d-none");
    } else if (type === "fixed_term") {
      flexPeriod?.classList.add("d-none");
      fixedPeriod?.classList.remove("d-none");
      rateDefault?.classList.add("d-none");
      fixedRate?.classList.remove("d-none");
      contrib?.classList.add("d-none");
    } else if (type === "staking") {
      if (aprLabel) aprLabel.textContent = "Staking APR";
      if (aprHint) aprHint.textContent = "Modeled as daily compounding when rewards auto-restake.";
      // Staking path always takes APR; hide quote-unit picker to avoid mix-ups.
      rateQuote?.classList.add("d-none");
      if (rateQuote) rateQuote.value = "apr";
    } else {
      if (aprLabel) aprLabel.textContent = "Annual interest rate";
      if (aprHint) {
        aprHint.textContent = "Default APR (Binance-style). Switch to APY for quotes like Meru — converted to APR before daily compounding.";
      }
    }
  }

  function bindEtfType() {
    document.getElementById("etf-type")?.addEventListener("change", updateEtfFields);
    updateEtfFields();
  }

  function updateEtfFields() {
    const advanced = sel("etf-type") === "advanced";
    document.getElementById("etf-advanced-fields")?.classList.toggle("d-none", !advanced);
    const label = document.getElementById("etf-return-label");
    const hint = document.getElementById("etf-return-hint");
    if (label) label.textContent = advanced ? "Annual price return" : "Annual return";
    if (hint) {
      hint.textContent = advanced
        ? "Expected capital appreciation only — dividends and fees are separate fields below."
        : "Single assumed total annual return, compounded monthly with contributions.";
    }
  }

  function bindAssetSymbol() {
    document.getElementById("cry-asset")?.addEventListener("change", () => {
      const sym = sel("cry-asset");
      document.querySelectorAll(".cry-symbol").forEach((el) => {
        el.textContent = sym;
      });
    });
  }

  function bindFixedTermCustom() {
    document.getElementById("cry-fixed-term")?.addEventListener("change", () => {
      const custom = sel("cry-fixed-term") === "custom";
      document.getElementById("cry-custom-days-wrap")?.classList.toggle("d-none", !custom);
    });
  }

  function bindTableControls() {
    document.getElementById("tablePageSize")?.addEventListener("change", (e) => {
      const v = e.target.value;
      state.pageSize = v === "all" ? "all" : Number(v);
      state.tablePage = 1;
      if (state.lastResult) renderTable(state.lastResult);
    });
  }

  function renderResults(result) {
    const money = (n) => Charts.formatMoney(n, result.currency, result.asset);
    const s = result.summary;

    document.getElementById("resultsMeta").textContent = buildMeta(result);

    const metrics = buildMetricCards(result, money);
    const grid = document.getElementById("metricGrid");
    grid.innerHTML = metrics.map((m) => `
      <div class="metric-card${m.highlight ? " metric-highlight" : ""}${m.warn ? " metric-warn" : ""}">
        <div class="metric-label">${m.label}</div>
        <div class="metric-value">${m.value}</div>
        ${m.sub ? `<div class="metric-sub">${m.sub}</div>` : ""}
      </div>
    `).join("");

    // Scenarios
    const sc = result.scenarios;
    const expectedBal = sc.expected.finalBalance;
    const bestDelta = sc.best.finalBalance - expectedBal;
    const worstDelta = sc.worst.finalBalance - expectedBal;

    document.getElementById("scenarioGrid").innerHTML = [
      {
        cls: "expected",
        label: "Expected case",
        s: sc.expected,
        delta: `<span class="scenario-delta neutral">Baseline @ ${fmtPct(result.ratePct)}</span>`,
      },
      {
        cls: "best",
        label: "Best case (+20% rate)",
        s: sc.best,
        delta: `<span class="scenario-delta up"><i class="fa-solid fa-arrow-up me-1"></i>vs Expected ${money(bestDelta)}</span>`,
      },
      {
        cls: "worst",
        label: "Worst case (−20% rate)",
        s: sc.worst,
        delta: `<span class="scenario-delta down"><i class="fa-solid fa-arrow-down me-1"></i>vs Expected ${money(worstDelta)}</span>`,
      },
    ].map((c) => `
      <article class="scenario-card ${c.cls}">
        <div class="scenario-label">${c.label}</div>
        <div class="scenario-balance">${money(c.s.finalBalance)}</div>
        <div class="scenario-stats">
          <div>Earnings: <strong>${money(c.s.earnings)}</strong></div>
          <div>ROI: <strong>${fmtPct(c.s.roi)}</strong></div>
        </div>
        ${c.delta}
      </article>
    `).join("");

    Charts.renderAll(result);
    renderTable(result);
    renderInsights(result);
  }

  function buildMeta(result) {
    const parts = [result.title];
    if (result.asset && result.currency !== "$") parts.push(result.asset);
    if (result.days) parts.push(`${result.days} day${result.days === 1 ? "" : "s"}`);
    else if (result.years) parts.push(`${formatYears(result.years)}`);
    parts.push(`Assumed rate ${fmtPct(result.ratePct)}`);
    if (result.summary?.contribGrowthEnabled) parts.push("Growing contributions");
    return parts.join(" · ");
  }

  /**
   * Prefer up to 8 useful cards. Priority: core → situational → analytic → scenario fallbacks.
   */
  function buildMetricCards(result, money) {
    const s = result.summary || {};
    const sc = result.scenarios || {};
    const cards = [];
    const push = (card) => {
      if (!card || cards.length >= 8) return;
      if (cards.some((c) => c.label === card.label)) return;
      cards.push(card);
    };

    push({ label: "Total invested", value: money(s.totalInvested) });
    push({
      label: "Earnings",
      value: money(s.earnings),
      sub: s.roi != null ? `ROI ${fmtPct(s.roi)}` : null,
    });
    push({ label: "Final balance", value: money(s.finalBalance), highlight: true });
    push({
      label: "Return on investment",
      value: fmtPct(s.roi),
      sub: s.apy != null ? `Effective APY ${fmtPct(s.apy)}` : null,
    });

    if (result.extras?.afterWithdraw != null) {
      push({
        label: "After withdraw",
        value: money(result.extras.afterWithdraw),
        sub: `Fee ${fmtPct(result.extras.withdrawFee)}`,
        warn: true,
      });
    }

    if (result.extras?.bonusEarnings != null && result.extras.bonusEarnings > 0) {
      push({
        label: "Bonus rewards",
        value: money(result.extras.bonusEarnings),
        sub: "Non-compounding bonus APR",
      });
    }

    if (result.extras?.reinvest === false && (result.extras.cashDividends || 0) > 0) {
      push({
        label: "Cash dividends",
        value: money(result.extras.cashDividends),
        sub: "Taken as cash (not DRIP’d)",
      });
    } else if (
      result.subtype === "advanced" &&
      result.extras?.reinvest &&
      (s.dividendYield || 0) > 0 &&
      s.finalBalance > 0
    ) {
      const estDiv = s.finalBalance * (s.dividendYield / 100);
      push({
        label: "Est. annual dividends",
        value: money(estDiv),
        sub: `At final balance × ${fmtPct(s.dividendYield)} yield`,
      });
    }

    if (s.selfFund) {
      push({
        label: "Self-funding from",
        value: String(s.selfFund.label || "—"),
        sub: "Earnings alone cover ongoing deposits",
      });
    }

    if (s.contribGrowthEnabled && s.endingContribution != null) {
      push({
        label: "Ending contribution",
        value: money(s.endingContribution),
        sub: "Contribution level at the final period",
      });
    }

    if (s.apy != null && result.compoundsPerYear > 1) {
      push({
        label: "Effective APY",
        value: fmtPct(s.apy),
        sub: `From ${fmtPct(result.ratePct)} compounded`,
      });
    }

    if (s.cagr != null && result.years >= 1) {
      push({
        label: "CAGR (on invested)",
        value: fmtPct(s.cagr),
        sub: "Annualized: contributions → final",
      });
    }

    if (result.ratePct > 0) {
      const doubleYears = 72 / result.ratePct;
      push({
        label: "Years to double",
        value: `${doubleYears.toFixed(1)} yrs`,
        sub: "Rule of 72 (rate only, no deposits)",
      });
    }

    // Fill remaining slots with scenario totals (avoid if situational cards already crowded)
    if (sc.best) {
      push({
        label: "Best-case balance",
        value: money(sc.best.finalBalance),
        sub: "+20% rate scenario",
      });
    }
    if (sc.worst) {
      push({
        label: "Worst-case balance",
        value: money(sc.worst.finalBalance),
        sub: "−20% rate scenario",
      });
    }

    return cards.slice(0, 8);
  }

  function formatYears(y) {
    if (y < 1 / 12) return `${Math.round(y * 365)} days`;
    if (y < 1) return `${(y * 12).toFixed(1)} months`;
    return `${Number(y.toFixed(2))} years`;
  }

  function renderTable(result) {
    const rows = result.rows || [];
    const tbody = document.getElementById("resultsTableBody");
    const pager = document.getElementById("tablePager");
    const money = (n) => Charts.formatMoney(n, result.currency, result.asset);

    const pageSize = state.pageSize === "all" ? rows.length || 1 : state.pageSize;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    state.tablePage = Math.min(state.tablePage, totalPages);
    const start = (state.tablePage - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);

    tbody.innerHTML = slice.map((r) => `
      <tr>
        <td>${escapeHtml(r.label)}</td>
        <td class="text-end">${money(r.invested)}</td>
        <td class="text-end">${money(r.earnings)}</td>
        <td class="text-end"><strong>${money(r.balance)}</strong></td>
      </tr>
    `).join("") || `<tr><td colspan="4" class="text-muted">No periods to show.</td></tr>`;

    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + pageSize, rows.length);
    pager.innerHTML = `
      <div class="pager-info">Showing ${from}–${to} of ${rows.length}</div>
      <div class="pager-buttons">
        <button type="button" class="btn btn-outline-secondary btn-sm" id="pagerPrev" ${state.tablePage <= 1 ? "disabled" : ""}>Previous</button>
        <button type="button" class="btn btn-outline-secondary btn-sm" id="pagerNext" ${state.tablePage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    document.getElementById("pagerPrev")?.addEventListener("click", () => {
      state.tablePage -= 1;
      renderTable(result);
    });
    document.getElementById("pagerNext")?.addEventListener("click", () => {
      state.tablePage += 1;
      renderTable(result);
    });
  }

  function renderInsights(result) {
    const block = document.getElementById("insightsBlock");
    if (!block) return;
    const s = result.summary;
    const money = (n) => Charts.formatMoney(n, result.currency, result.asset);
    const items = [];

    const earningsShare = s.finalBalance > 0 ? (s.earnings / s.finalBalance) * 100 : 0;
    items.push(`Earnings make up <strong>${earningsShare.toFixed(1)}%</strong> of the final balance; the rest is capital you put in.`);

    if (s.apy != null && result.compoundsPerYear > 1) {
      items.push(`Quoted rate ${fmtPct(result.ratePct)} compounds ~${result.compoundsPerYear}×/year → effective APY about <strong>${fmtPct(s.apy)}</strong>.`);
    }

    if (result.subtype === "simple_earn" && result.extras) {
      items.push(`Of your earnings, <strong>${money(result.extras.bonusEarnings || 0)}</strong> came from the non-compounding bonus tier.`);
    }

    if (result.subtype === "fixed_term") {
      items.push("Fixed term does not compound during the lock. Rolling into a new term after maturity is how you recreate compounding.");
    }

    if (result.extras?.reinvest === false) {
      items.push(`Cash dividends set aside: <strong>${money(result.extras.cashDividends || 0)}</strong> (not compounding inside the ETF).`);
    }

    if (result.notes?.length) {
      result.notes.slice(0, 2).forEach((n) => items.push(n));
    }

    // Rule of 72 approx on rate
    if (result.ratePct > 0 && result.years >= 1) {
      const doubleYears = 72 / result.ratePct;
      items.push(`Rule of 72: money roughly doubles every <strong>${doubleYears.toFixed(1)} years</strong> at ${fmtPct(result.ratePct)} (ignoring contributions).`);
    }

    block.innerHTML = `
      <h3><i class="fa-solid fa-compass me-2"></i>Insights for this run</h3>
      <ul class="insight-list">
        ${items.map((t) => `<li><i class="fa-solid fa-caret-right"></i><span>${t}</span></li>`).join("")}
      </ul>
    `;
  }

  function val(id) {
    const el = document.getElementById(id);
    return el ? Number(el.value) : 0;
  }

  function sel(id) {
    const el = document.getElementById(id);
    return el ? el.value : "";
  }

  function fmtPct(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return `${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
