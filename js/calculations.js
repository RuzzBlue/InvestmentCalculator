/**
 * YieldLens calculation engines
 * Models based on common exchange / broker behavior:
 * - Flexible earn: daily compounding of APR on balance
 * - Simple Earn bonus: non-compounding daily bonus on capped amount
 * - Fixed term: simple interest for lock days (principal × APR/365 × days)
 * - ETF advanced: price return + optional DRIP dividend − expense ratio
 */

const Calculations = (() => {
  const DAYS_YEAR = 365;

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function contribPerYear(amount, freq) {
    if (!amount) return 0;
    switch (freq) {
      case "monthly": return amount * 12;
      case "quarterly": return amount * 4;
      case "yearly": return amount;
      default: return amount * 12;
    }
  }

  function contribPerPeriod(amount, freq, periodsPerYear) {
    const annual = contribPerYear(amount, freq);
    return annual / periodsPerYear;
  }

  function toYears(value, unit) {
    switch (unit) {
      case "days": return value / DAYS_YEAR;
      case "months": return value / 12;
      case "quarters": return value / 4;
      case "years":
      default: return value;
    }
  }

  function toDays(value, unit) {
    switch (unit) {
      case "days": return value;
      case "months": return Math.round(value * 30.4167);
      case "quarters": return Math.round(value * 91.25);
      case "years":
      default: return Math.round(value * DAYS_YEAR);
    }
  }

  /** Effective APY from nominal APR and compounds/year */
  function aprToApy(aprPct, n) {
    const r = aprPct / 100;
    if (n <= 0) return r;
    return Math.pow(1 + r / n, n) - 1;
  }

  /**
   * Generic periodic compound with contributions at start of each period.
   * Returns schedule rows + summary.
   */
  function compoundSchedule({
    principal,
    annualRatePct,
    years,
    compoundsPerYear,
    contribution = 0,
    contribFreq = "monthly",
    labelPrefix = "Period",
  }) {
    const n = Math.max(1, compoundsPerYear);
    const totalPeriods = Math.max(1, Math.round(years * n));
    const ratePer = (annualRatePct / 100) / n;
    const pmt = contribPerPeriod(contribution, contribFreq, n);

    let balance = principal;
    let invested = principal;
    const rows = [];

    // Opening row
    rows.push({
      period: 0,
      label: "Start",
      invested,
      earnings: 0,
      balance,
    });

    for (let i = 1; i <= totalPeriods; i++) {
      if (pmt > 0) {
        balance += pmt;
        invested += pmt;
      }
      balance *= 1 + ratePer;
      const earnings = balance - invested;
      rows.push({
        period: i,
        label: periodLabel(i, n, labelPrefix),
        invested,
        earnings,
        balance,
      });
    }

    const final = rows[rows.length - 1];
    return {
      rows,
      summary: summarize(final.invested, final.balance, annualRatePct, n, years),
      meta: { compoundsPerYear: n, years, annualRatePct },
    };
  }

  function periodLabel(i, n, prefix) {
    if (n === 1) return `Year ${i}`;
    if (n === 4) return `Q${((i - 1) % 4) + 1} Y${Math.ceil(i / 4)}`;
    if (n === 12) {
      const month = ((i - 1) % 12) + 1;
      const year = Math.ceil(i / 12);
      return `M${month} Y${year}`;
    }
    if (n === DAYS_YEAR || n >= 300) {
      // For daily, collapse display later — label as Day i
      return `Day ${i}`;
    }
    return `${prefix} ${i}`;
  }

  function summarize(invested, balance, ratePct, compoundsPerYear, years) {
    const earnings = balance - invested;
    const roi = invested > 0 ? (earnings / invested) * 100 : 0;
    const apy = aprToApy(ratePct, compoundsPerYear) * 100;
    const yearsSafe = Math.max(years, 1 / DAYS_YEAR);
    const cagr = invested > 0 && balance > 0
      ? (Math.pow(balance / invested, 1 / yearsSafe) - 1) * 100
      : 0;
    return {
      totalInvested: invested,
      earnings,
      finalBalance: balance,
      roi,
      apy,
      cagr,
      years,
    };
  }

  /** Investment tab */
  function calculateInvestment(input) {
    const years = Number(input.years) || 0;
    const rate = Number(input.rate) || 0;
    const n = Number(input.compound) || 12;
    const result = compoundSchedule({
      principal: Number(input.principal) || 0,
      annualRatePct: rate,
      years,
      compoundsPerYear: n,
      contribution: Number(input.contribution) || 0,
      contribFreq: input.contribFreq,
    });

    // Display-friendly schedule: for daily over long spans, sample monthly
    const displayRows = downsampleRows(result.rows, n, years);
    return {
      type: "investment",
      title: "Investment",
      currency: "$",
      asset: "USD",
      ratePct: rate,
      compoundsPerYear: n,
      years,
      displayUnit: n >= 300 ? (years > 2 ? "month" : "day") : n === 12 ? "month" : n === 4 ? "quarter" : "year",
      ...finalize(result, displayRows, rate, n, years, input),
    };
  }

  /**
   * Crypto flexible / staking — daily accrual with optional contributions.
   * Contributions applied monthly (converted) to avoid huge daily schedules when period is years.
   */
  function calculateCryptoFlexible(input, mode) {
    const days = Math.max(1, toDays(Number(input.period), input.periodUnit));
    const years = days / DAYS_YEAR;
    const apr = Number(input.apr) || 0;
    const principal = Number(input.principal) || 0;
    const contribution = Number(input.contribution) || 0;
    const contribFreq = input.contribFreq || "monthly";

    // Simulate month-by-month for readability when span > 90 days, else daily
    const useDaily = days <= 90;
    const steps = useDaily ? days : Math.max(1, Math.round(days / 30.4167));
    const daysPerStep = useDaily ? 1 : days / steps;
    const ratePerStep = Math.pow(1 + apr / 100 / DAYS_YEAR, daysPerStep) - 1;
    const pmtPerStep = contribution
      ? (contribPerYear(contribution, contribFreq) / DAYS_YEAR) * daysPerStep
      : 0;

    let balance = principal;
    let invested = principal;
    const rows = [{ period: 0, label: "Start", invested, earnings: 0, balance }];

    for (let i = 1; i <= steps; i++) {
      if (pmtPerStep > 0) {
        balance += pmtPerStep;
        invested += pmtPerStep;
      }
      balance *= 1 + ratePerStep;
      rows.push({
        period: i,
        label: useDaily ? `Day ${i}` : `Month ${i}`,
        invested,
        earnings: balance - invested,
        balance,
      });
    }

    const final = rows[rows.length - 1];
    const base = {
      rows,
      summary: summarize(final.invested, final.balance, apr, DAYS_YEAR, years),
      meta: { compoundsPerYear: DAYS_YEAR, years, annualRatePct: apr },
    };

    return {
      type: "crypto",
      subtype: mode,
      title: mode === "staking" ? "Crypto · Staking" : "Crypto · Flexible",
      currency: "",
      asset: input.asset || "USDT",
      ratePct: apr,
      compoundsPerYear: DAYS_YEAR,
      years,
      days,
      displayUnit: useDaily ? "day" : "month",
      notes: mode === "staking"
        ? ["Modeled as daily compounding of staking APR (typical when rewards auto-restake)."]
        : ["Modeled like flexible earn: daily compounding of the quoted APR on the growing balance."],
      ...finalize(base, rows, apr, DAYS_YEAR, years, input),
    };
  }

  /** Simple Earn: regular APR compounds daily; bonus APR is simple daily on capped amount only */
  function calculateSimpleEarn(input) {
    const days = Math.max(1, toDays(Number(input.period), input.periodUnit));
    const years = days / DAYS_YEAR;
    const principal = Number(input.principal) || 0;
    const contribution = Number(input.contribution) || 0;
    const contribFreq = input.contribFreq || "monthly";
    const regularApr = Number(input.regularApr) || 0;
    const bonusApr = Number(input.bonusApr) || 0;
    const bonusCap = Number(input.bonusCap) || 0;

    const useDaily = days <= 90;
    const steps = useDaily ? days : Math.max(1, Math.round(days / 30.4167));
    const daysPerStep = useDaily ? 1 : days / steps;
    const regularRate = Math.pow(1 + regularApr / 100 / DAYS_YEAR, daysPerStep) - 1;
    const pmtPerStep = contribution
      ? (contribPerYear(contribution, contribFreq) / DAYS_YEAR) * daysPerStep
      : 0;

    let balance = principal; // earn wallet (compounds)
    let invested = principal;
    let bonusCash = 0; // spot rewards, non-compounding
    const rows = [];

    const snapshot = () => ({
      invested,
      earnings: balance + bonusCash - invested,
      balance: balance + bonusCash,
      earnBalance: balance,
      bonusCash,
    });

    rows.push({ period: 0, label: "Start", ...snapshot() });

    for (let i = 1; i <= steps; i++) {
      if (pmtPerStep > 0) {
        balance += pmtPerStep;
        invested += pmtPerStep;
      }
      // Bonus on capped portion of earn balance (not including prior bonus cash)
      const bonusBase = Math.min(balance, bonusCap);
      const bonusThisStep = bonusBase * (bonusApr / 100) * (daysPerStep / DAYS_YEAR);
      bonusCash += bonusThisStep;

      // Regular APR compounds on earn balance
      balance *= 1 + regularRate;

      rows.push({
        period: i,
        label: useDaily ? `Day ${i}` : `Month ${i}`,
        ...snapshot(),
      });
    }

    const final = rows[rows.length - 1];
    const effApr = estimateBlendedApr(principal, regularApr, bonusApr, bonusCap);
    const regularEarnings = final.earnBalance - final.invested;
    const base = {
      rows,
      summary: {
        ...summarize(final.invested, final.balance, effApr, DAYS_YEAR, years),
        regularEarnings,
        bonusEarnings: final.bonusCash,
      },
      meta: { compoundsPerYear: DAYS_YEAR, years, annualRatePct: effApr },
    };

    return {
      type: "crypto",
      subtype: "simple_earn",
      title: "Crypto · Simple Earn",
      currency: "",
      asset: input.asset || "USDT",
      ratePct: effApr,
      regularApr,
      bonusApr,
      bonusCap,
      compoundsPerYear: DAYS_YEAR,
      years,
      days,
      displayUnit: useDaily ? "day" : "month",
      notes: [
        `Regular APR ${regularApr}% compounds daily on your Earn balance.`,
        `Bonus APR ${bonusApr}% applies only up to ${formatNum(bonusCap)} ${input.asset || "USDT"} and does not compound (paid like Spot rewards).`,
        `Effective blended APR ≈ ${effApr.toFixed(2)}% on starting principal for scenario stress tests.`,
      ],
      extras: {
        regularEarnings,
        bonusEarnings: final.bonusCash,
      },
      ...finalize(base, rows, effApr, DAYS_YEAR, years, input),
    };
  }

  function estimateBlendedApr(principal, regularApr, bonusApr, bonusCap) {
    if (principal <= 0) return regularApr;
    const capped = Math.min(principal, bonusCap);
    const rest = Math.max(0, principal - bonusCap);
    return (capped * (regularApr + bonusApr) + rest * regularApr) / principal;
  }

  /** Fixed term — simple interest for lock period; optional multi-roll for long comparisons */
  function calculateFixedTerm(input) {
    let days;
    if (input.fixedTerm === "custom") {
      days = Math.max(1, Number(input.customDays) || 1);
    } else {
      days = Math.max(1, Number(input.fixedTerm) || 30);
    }
    const apr = Number(input.fixedApr) || 0;
    const principal = Number(input.principal) || 0;
    // Fixed products typically don't take mid-term contributions
    const interest = principal * (apr / 100) * (days / DAYS_YEAR);
    const balance = principal + interest;
    const years = days / DAYS_YEAR;

    const rows = [
      { period: 0, label: "Start", invested: principal, earnings: 0, balance: principal },
      { period: 1, label: `Maturity (Day ${days})`, invested: principal, earnings: interest, balance },
    ];

    const base = {
      rows,
      summary: summarize(principal, balance, apr, 1, years),
      meta: { compoundsPerYear: 1, years, annualRatePct: apr },
    };

    return {
      type: "crypto",
      subtype: "fixed_term",
      title: "Crypto · Fixed Term",
      currency: "",
      asset: input.asset || "USDT",
      ratePct: apr,
      compoundsPerYear: 1,
      years,
      days,
      displayUnit: "term",
      notes: [
        "Fixed term modeled as simple interest: Principal × APR ÷ 365 × lock days.",
        "No compounding during the lock. Reinvest at maturity for a new term if desired.",
        "Additional contributions are ignored for fixed-term products (typical exchange behavior).",
      ],
      ...finalize(base, rows, apr, 1, years, input),
    };
  }

  /** ETF / Stocks */
  function calculateEtf(input) {
    const years = toYears(Number(input.period), input.periodUnit);
    const principal = Number(input.principal) || 0;
    const contribution = Number(input.contribution) || 0;
    const contribFreq = input.contribFreq || "monthly";
    const priceReturn = Number(input.annualReturn) || 0;
    const isAdvanced = input.etfType === "advanced";
    const months = Math.max(1, Math.round(years * 12));

    if (!isAdvanced) {
      return wrapSimpleEtf(input, years, months, principal, contribution, contribFreq, priceReturn);
    }

    const dividendYield = Number(input.dividendYield) || 0;
    const expenseRatio = Number(input.expenseRatio) || 0;
    const reinvest = !!input.reinvestDividends;
    const withdrawFee = Number(input.withdrawFee) || 0;

    const pmt = contribPerPeriod(contribution, contribFreq, 12);
    const monthlyPrice = priceReturn / 100 / 12;
    const monthlyExpense = expenseRatio / 100 / 12;
    const monthlyDiv = dividendYield / 100 / 12;

    let sharesValue = principal;
    let invested = principal;
    let cashDividends = 0;
    const rows = [{
      period: 0,
      label: "Start",
      invested,
      earnings: 0,
      balance: principal,
      cashDividends: 0,
    }];

    for (let i = 1; i <= months; i++) {
      if (pmt > 0) {
        sharesValue += pmt;
        invested += pmt;
      }
      sharesValue *= 1 + monthlyPrice;
      sharesValue *= 1 - monthlyExpense;

      const div = sharesValue * monthlyDiv;
      if (reinvest) {
        sharesValue += div;
      } else {
        cashDividends += div;
      }

      const balance = sharesValue + cashDividends;
      rows.push({
        period: i,
        label: `Month ${i}`,
        invested,
        earnings: balance - invested,
        balance,
        cashDividends,
      });
    }

    const final = rows[rows.length - 1];
    const effectiveRate = priceReturn + (reinvest ? dividendYield : 0) - expenseRatio;
    const base = {
      rows,
      summary: {
        ...summarize(final.invested, final.balance, effectiveRate, 12, years),
        cashDividends: final.cashDividends,
        afterWithdraw: withdrawFee > 0 ? final.balance * (1 - withdrawFee / 100) : null,
        withdrawFee,
        expenseRatio,
        dividendYield,
        reinvest,
      },
      meta: { compoundsPerYear: 12, years, annualRatePct: effectiveRate },
    };

    const displayRows = months > 120
      ? rows.filter((r, idx) => idx === 0 || r.period % 12 === 0 || idx === rows.length - 1)
          .map((r) => (r.period === 0 ? r : { ...r, label: `Year ${Math.round(r.period / 12)}` }))
      : rows;

    return {
      type: "etf",
      subtype: "advanced",
      title: "ETF · Advanced",
      currency: "$",
      asset: "USD",
      ratePct: effectiveRate,
      compoundsPerYear: 12,
      years,
      displayUnit: months > 120 ? "year" : "month",
      notes: [
        `Price return ${priceReturn}% − expense ratio ${expenseRatio}%${reinvest ? ` + reinvested dividend yield ${dividendYield}%` : ` (dividends taken as cash @ ${dividendYield}%)`}.`,
        reinvest
          ? "DRIP on: dividends buy more of the fund and compound."
          : "DRIP off: dividends accumulate as cash and do not compound inside the ETF.",
        withdrawFee > 0
          ? `Withdrawal fee ${withdrawFee}% applied only to the “after withdraw” figure.`
          : null,
      ].filter(Boolean),
      extras: {
        afterWithdraw: base.summary.afterWithdraw,
        withdrawFee,
        cashDividends: final.cashDividends,
        reinvest,
      },
      ...finalize(base, displayRows, effectiveRate, 12, years, input),
    };
  }

  function wrapSimpleEtf(input, years, months, principal, contribution, contribFreq, annualReturn) {
    const result = compoundSchedule({
      principal,
      annualRatePct: annualReturn,
      years,
      compoundsPerYear: 12,
      contribution,
      contribFreq,
    });
    const displayRows = months > 120
      ? downsampleToYears(result.rows)
      : result.rows;
    return {
      type: "etf",
      subtype: "simple",
      title: "Stocks / ETFs · Simple",
      currency: "$",
      asset: "USD",
      ratePct: annualReturn,
      compoundsPerYear: 12,
      years,
      displayUnit: months > 120 ? "year" : "month",
      notes: ["Simple mode compounds your assumed annual return monthly with contributions."],
      ...finalize(result, displayRows, annualReturn, 12, years, input),
    };
  }

  function downsampleToYears(rows) {
    // rows are monthly from compoundSchedule with n=12
    return rows.filter((r, idx) => idx === 0 || r.period % 12 === 0 || idx === rows.length - 1)
      .map((r) => {
        if (r.period === 0) return r;
        return { ...r, label: `Year ${Math.round(r.period / 12)}` };
      });
  }

  function downsampleRows(rows, n, years) {
    if (n < 300) return rows;
    if (years <= 0.25) return rows; // keep daily for short
    // sample every ~30 days
    const step = 30;
    const sampled = rows.filter((r, idx) => idx === 0 || r.period % step === 0 || idx === rows.length - 1);
    return sampled.map((r) => {
      if (r.period === 0) return r;
      return { ...r, label: `Day ${r.period}` };
    });
  }

  function finalize(result, displayRows, ratePct, compoundsPerYear, years, input) {
    const expected = result;
    const bestRate = ratePct * 1.2;
    const worstRate = Math.max(0, ratePct * 0.8);

    const scenarios = {
      expected: expected.summary,
      best: null,
      worst: null,
    };

    // Rebuild scenarios with adjusted rates using a lightweight runner
    scenarios.best = runScenarioVariant(input, expected, bestRate).summary;
    scenarios.worst = runScenarioVariant(input, expected, worstRate).summary;

    return {
      rows: displayRows,
      fullRows: result.rows,
      summary: expected.summary,
      scenarios,
      chartPreference: pickChartType(years, displayRows.length),
    };
  }

  function pickChartType(years, pointCount) {
    if (years <= 0.25 || pointCount <= 40) return "bar";
    return "line";
  }

  /**
   * Scenario variants: scale the primary rate. For complex types we approximate
   * by re-running with scaled rate fields.
   */
  function runScenarioVariant(input, expectedTemplate, newRate) {
    if (!input) {
      // scale final balance roughly — fallback
      return expectedTemplate;
    }

    if (input._source === "investment") {
      return compoundSchedule({
        principal: Number(input.principal) || 0,
        annualRatePct: newRate,
        years: Number(input.years) || 0,
        compoundsPerYear: Number(input.compound) || 12,
        contribution: Number(input.contribution) || 0,
        contribFreq: input.contribFreq,
      });
    }

    if (input._source === "crypto") {
      if (input.cryType === "fixed_term") {
        const days = input.fixedTerm === "custom"
          ? Math.max(1, Number(input.customDays) || 1)
          : Math.max(1, Number(input.fixedTerm) || 30);
        const principal = Number(input.principal) || 0;
        const interest = principal * (newRate / 100) * (days / DAYS_YEAR);
        const balance = principal + interest;
        const years = days / DAYS_YEAR;
        return {
          rows: [],
          summary: summarize(principal, balance, newRate, 1, years),
        };
      }
      if (input.cryType === "simple_earn") {
        // Scale both regular and bonus proportionally from blended target
        const baseBlend = estimateBlendedApr(
          Number(input.principal) || 0,
          Number(input.regularApr) || 0,
          Number(input.bonusApr) || 0,
          Number(input.bonusCap) || 0
        );
        const scale = baseBlend > 0 ? newRate / baseBlend : 1;
        const cloned = {
          ...input,
          regularApr: (Number(input.regularApr) || 0) * scale,
          bonusApr: (Number(input.bonusApr) || 0) * scale,
        };
        // Inline quick path: call calculateSimpleEarn core without full wrap
        return simpleEarnCore(cloned);
      }
      // flexible / staking
      const days = Math.max(1, toDays(Number(input.period), input.periodUnit));
      const years = days / DAYS_YEAR;
      const useDaily = days <= 90;
      const steps = useDaily ? days : Math.max(1, Math.round(days / 30.4167));
      const daysPerStep = useDaily ? 1 : days / steps;
      const ratePerStep = Math.pow(1 + newRate / 100 / DAYS_YEAR, daysPerStep) - 1;
      const contribution = Number(input.contribution) || 0;
      const pmtPerStep = contribution
        ? (contribPerYear(contribution, input.contribFreq || "monthly") / DAYS_YEAR) * daysPerStep
        : 0;
      let balance = Number(input.principal) || 0;
      let invested = balance;
      for (let i = 1; i <= steps; i++) {
        if (pmtPerStep > 0) {
          balance += pmtPerStep;
          invested += pmtPerStep;
        }
        balance *= 1 + ratePerStep;
      }
      return {
        rows: [],
        summary: summarize(invested, balance, newRate, DAYS_YEAR, years),
      };
    }

    if (input._source === "etf") {
      if (input.etfType === "advanced") {
        const div = Number(input.dividendYield) || 0;
        const exp = Number(input.expenseRatio) || 0;
        const reinvest = !!input.reinvestDividends;
        const price = newRate - (reinvest ? div : 0) + exp;
        return etfAdvancedCore({
          ...input,
          annualReturn: price,
        });
      }
      return compoundSchedule({
        principal: Number(input.principal) || 0,
        annualRatePct: newRate,
        years: toYears(Number(input.period), input.periodUnit),
        compoundsPerYear: 12,
        contribution: Number(input.contribution) || 0,
        contribFreq: input.contribFreq,
      });
    }

    return expectedTemplate;
  }

  function etfAdvancedCore(input) {
    const years = toYears(Number(input.period), input.periodUnit);
    const months = Math.max(1, Math.round(years * 12));
    const principal = Number(input.principal) || 0;
    const contribution = Number(input.contribution) || 0;
    const contribFreq = input.contribFreq || "monthly";
    const priceReturn = Number(input.annualReturn) || 0;
    const dividendYield = Number(input.dividendYield) || 0;
    const expenseRatio = Number(input.expenseRatio) || 0;
    const reinvest = !!input.reinvestDividends;
    const pmt = contribPerPeriod(contribution, contribFreq, 12);
    const monthlyPrice = priceReturn / 100 / 12;
    const monthlyExpense = expenseRatio / 100 / 12;
    const monthlyDiv = dividendYield / 100 / 12;

    let sharesValue = principal;
    let invested = principal;
    let cashDividends = 0;
    for (let i = 1; i <= months; i++) {
      if (pmt > 0) {
        sharesValue += pmt;
        invested += pmt;
      }
      sharesValue *= 1 + monthlyPrice;
      sharesValue *= 1 - monthlyExpense;
      const divAmt = sharesValue * monthlyDiv;
      if (reinvest) sharesValue += divAmt;
      else cashDividends += divAmt;
    }
    const balance = sharesValue + cashDividends;
    const effectiveRate = priceReturn + (reinvest ? dividendYield : 0) - expenseRatio;
    return {
      rows: [],
      summary: summarize(invested, balance, effectiveRate, 12, years),
    };
  }

  function simpleEarnCore(input) {
    const days = Math.max(1, toDays(Number(input.period), input.periodUnit));
    const years = days / DAYS_YEAR;
    const principal = Number(input.principal) || 0;
    const contribution = Number(input.contribution) || 0;
    const contribFreq = input.contribFreq || "monthly";
    const regularApr = Number(input.regularApr) || 0;
    const bonusApr = Number(input.bonusApr) || 0;
    const bonusCap = Number(input.bonusCap) || 0;
    const useDaily = days <= 90;
    const steps = useDaily ? days : Math.max(1, Math.round(days / 30.4167));
    const daysPerStep = useDaily ? 1 : days / steps;
    const regularRate = Math.pow(1 + regularApr / 100 / DAYS_YEAR, daysPerStep) - 1;
    const pmtPerStep = contribution
      ? (contribPerYear(contribution, contribFreq) / DAYS_YEAR) * daysPerStep
      : 0;
    let balance = principal;
    let invested = principal;
    let bonusCash = 0;
    for (let i = 1; i <= steps; i++) {
      if (pmtPerStep > 0) {
        balance += pmtPerStep;
        invested += pmtPerStep;
      }
      const bonusBase = Math.min(balance, bonusCap);
      bonusCash += bonusBase * (bonusApr / 100) * (daysPerStep / DAYS_YEAR);
      balance *= 1 + regularRate;
    }
    const total = balance + bonusCash;
    const eff = estimateBlendedApr(principal, regularApr, bonusApr, bonusCap);
    return {
      rows: [],
      summary: summarize(invested, total, eff, DAYS_YEAR, years),
    };
  }

  function formatNum(n) {
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function calculate(source, raw) {
    const input = { ...raw, _source: source };
    if (source === "investment") {
      input._source = "investment";
      return calculateInvestment(input);
    }
    if (source === "crypto") {
      input._source = "crypto";
      input.cryType = raw.cryType;
      switch (raw.cryType) {
        case "simple_earn":
          return calculateSimpleEarn(input);
        case "fixed_term":
          return calculateFixedTerm(input);
        case "staking":
          return calculateCryptoFlexible(input, "staking");
        case "default":
        default:
          return calculateCryptoFlexible(input, "default");
      }
    }
    if (source === "etf") {
      input._source = "etf";
      return calculateEtf(input);
    }
    throw new Error("Unknown calculator source");
  }

  return {
    calculate,
    aprToApy,
    toYears,
    toDays,
    contribPerYear,
    formatNum,
    clamp,
  };
})();
