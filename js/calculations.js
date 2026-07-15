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

  /** Nominal APR implied by a quoted APY under n compounds/year */
  function apyToApr(apyPct, n) {
    const y = apyPct / 100;
    if (n <= 0) return apyPct;
    if (y <= -1) return 0;
    return n * (Math.pow(1 + y, 1 / n) - 1) * 100;
  }

  /**
   * Flexible earn: platforms may quote APR or APY. Engine always compounds nominal APR daily.
   * APY → APR uses n = 365 (matches our daily-compound model).
   */
  function resolveFlexibleApr(input) {
    const quoted = Number(input.apr) || 0;
    if (input.rateQuote === "apy") {
      return {
        apr: apyToApr(quoted, DAYS_YEAR),
        quotedRate: quoted,
        rateQuote: "apy",
      };
    }
    return {
      apr: quoted,
      quotedRate: quoted,
      rateQuote: "apr",
    };
  }

  function normalizeGrowth(growth) {
    if (!growth || !growth.enabled) return null;
    return {
      enabled: true,
      mode: growth.mode || "percent",
      every: growth.every === "quarter" ? "quarter" : "year",
      amount: Number(growth.amount) || 0,
      percent: Number(growth.percent) || 0,
      minPercent: Number(growth.minPercent),
      maxPercent: Number(growth.maxPercent),
    };
  }

  function applyGrowthStep(amount, growth, stepIndex) {
    if (!growth) return amount;
    if (growth.mode === "fixed") {
      return Math.max(0, amount + (Number(growth.amount) || 0));
    }
    if (growth.mode === "percent") {
      return Math.max(0, amount * (1 + (Number(growth.percent) || 0) / 100));
    }
    // Variable swing: smooth oscillating change between min/max (deterministic).
    let minP = Number.isFinite(growth.minPercent) ? growth.minPercent : -2;
    let maxP = Number.isFinite(growth.maxPercent) ? growth.maxPercent : 8;
    if (minP > maxP) {
      const tmp = minP;
      minP = maxP;
      maxP = tmp;
    }
    const mid = (minP + maxP) / 2;
    const amp = (maxP - minP) / 2;
    const delta = mid + amp * Math.sin(stepIndex * 0.9);
    return Math.max(0, amount * (1 + delta / 100));
  }

  function contribEventsPerYear(contribFreq) {
    switch (contribFreq) {
      case "yearly":
        return 1;
      case "quarterly":
        return 4;
      case "monthly":
      default:
        return 12;
    }
  }

  function normalizeContribTiming(timing, legacyAfterStart) {
    if (timing === "beginning" || timing === "end") return timing;
    // Legacy checkbox: false = beginning, true = old “after start” (now true end-of-period).
    if (legacyAfterStart === false) return "beginning";
    return "end";
  }

  function timingFromInput(input) {
    return normalizeContribTiming(input?.contribTiming, input?.contribAfterStart);
  }

  /**
   * Contribution cash-flows on an event timeline (independent of compounding steps).
   *
   * beginning — annuity due: deposit at the start of each contrib interval (t = 0, 1/f, …)
   * end — ordinary annuity: deposit at the end of each contrib interval (t = 1/f, 2/f, …)
   *
   * Both modes produce the same number of deposits over the horizon; only timing differs.
   */
  function createContributionStepper({
    baseContribution = 0,
    contribFreq = "monthly",
    stepsPerYear = 12,
    growth = null,
    contribTiming = "end",
  }) {
    const atBeginning = contribTiming !== "end";
    const g = normalizeGrowth(growth);
    let currentAmount = Number(baseContribution) || 0;
    let growthStep = 0;
    const eventsPerYear = contribEventsPerYear(contribFreq);
    const spy = Math.max(1, stepsPerYear);
    const growthPerYear = !g ? 0 : g.every === "quarter" ? 4 : 1;
    let nextGrowthBoundary = growthPerYear > 0 ? 1 / growthPerYear : Infinity;
    // beginning: event 0 at t=0; end: event 1 at first period boundary.
    let nextEvent = atBeginning ? 0 : 1;

    return {
      atBeginning,
      /** Call once per simulation period (1-based index). */
      next(periodIndex) {
        const t0 = (periodIndex - 1) / spy;
        const t1 = periodIndex / spy;

        if (g && growthPerYear > 0) {
          while (nextGrowthBoundary < t1 - 1e-12) {
            if (nextGrowthBoundary >= t0 - 1e-12) {
              currentAmount = applyGrowthStep(currentAmount, g, growthStep++);
            }
            nextGrowthBoundary += 1 / growthPerYear;
          }
        }

        let pmt = 0;
        while (true) {
          const et = nextEvent / eventsPerYear;
          if (atBeginning) {
            // [t0, t1) — deposit at period start lands in this step
            if (et >= t1 - 1e-12) break;
            if (et >= t0 - 1e-12) pmt += currentAmount;
          } else {
            // (t0, t1] — deposit at period end lands in this step
            if (et > t1 + 1e-12) break;
            if (et > t0 + 1e-12 && et <= t1 + 1e-12) pmt += currentAmount;
          }
          nextEvent += 1;
        }

        return {
          pmt,
          currentAmount,
          annualized: currentAmount * eventsPerYear,
        };
      },
    };
  }

  /**
   * First time portfolio annual earnings (balance × rate) cover the then-current
   * annual contribution rate — i.e. growth alone can replace deposits.
   */
  function findSelfFundingPoint(rows, annualRatePct) {
    if (!rows?.length || !(annualRatePct > 0)) return null;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const annualContrib = Number(row.annualContribution) || 0;
      if (annualContrib <= 0) continue;
      const annualEarnings = row.balance * (annualRatePct / 100);
      if (annualEarnings >= annualContrib) {
        return {
          period: row.period,
          label: row.label,
          balance: row.balance,
          annualContribution: annualContrib,
          annualEarnings,
        };
      }
    }
    return null;
  }

  /**
   * Generic periodic compound with recurring contributions.
   * beginning = deposit then compound; end = compound then deposit.
   */
  function compoundSchedule({
    principal,
    annualRatePct,
    years,
    compoundsPerYear,
    contribution = 0,
    contribFreq = "monthly",
    contribGrowth = null,
    contribTiming = "end",
    contribAfterStart,
    labelPrefix = "Period",
  }) {
    const timing = normalizeContribTiming(contribTiming, contribAfterStart);
    const n = Math.max(1, compoundsPerYear);
    const totalPeriods = Math.max(1, Math.round(years * n));
    const ratePer = (annualRatePct / 100) / n;
    const stepper = createContributionStepper({
      baseContribution: contribution,
      contribFreq,
      stepsPerYear: n,
      growth: contribGrowth,
      contribTiming: timing,
    });
    const atBeginning = stepper.atBeginning;

    let balance = principal;
    let invested = principal;
    let endingContribution = Number(contribution) || 0;
    const rows = [];

    // t=0 deposit: money is in, no compound period has finished yet (earnings = 0).
    // Period 1+ = end of each compound step (M1 has the first month's interest, etc.).
    rows.push({
      period: 0,
      label: "Start",
      invested,
      earnings: 0,
      balance,
      annualContribution: contribPerYear(contribution, contribFreq),
      contributionLevel: Number(contribution) || 0,
    });

    for (let i = 1; i <= totalPeriods; i++) {
      const { pmt, currentAmount, annualized } = stepper.next(i);
      endingContribution = currentAmount;
      if (atBeginning) {
        if (pmt > 0) {
          balance += pmt;
          invested += pmt;
        }
        balance *= 1 + ratePer;
      } else {
        balance *= 1 + ratePer;
        if (pmt > 0) {
          balance += pmt;
          invested += pmt;
        }
      }
      const earnings = balance - invested;
      rows.push({
        period: i,
        label: periodLabel(i, n, labelPrefix),
        invested,
        earnings,
        balance,
        annualContribution: annualized,
        contributionLevel: currentAmount,
      });
    }

    const final = rows[rows.length - 1];
    const summary = summarize(final.invested, final.balance, annualRatePct, n, years);
    summary.selfFund = findSelfFundingPoint(rows, annualRatePct);
    summary.endingContribution = endingContribution;
    summary.contribGrowthEnabled = !!(normalizeGrowth(contribGrowth));

    return {
      rows,
      summary,
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
      contribGrowth: input.contribGrowth,
      contribTiming: timingFromInput(input),
    });

    // Display-friendly schedule: for daily over long spans, sample monthly
    const displayRows = downsampleRows(result.rows, n, years);
    const displayUnit = n >= 300 ? (years > 2 ? "month" : "day") : n === 12 ? "month" : n === 4 ? "quarter" : "year";
    return {
      type: "investment",
      title: "Investment",
      currency: "$",
      asset: "USD",
      ratePct: rate,
      compoundsPerYear: n,
      years,
      displayUnit,
      ...finalize(result, displayRows, rate, n, years, input, { displayUnit }),
    };
  }

  /**
   * Crypto flexible / staking — daily accrual with optional contributions.
   * Contributions applied monthly (converted) to avoid huge daily schedules when period is years.
   */
  function calculateCryptoFlexible(input, mode) {
    const days = Math.max(1, toDays(Number(input.period), input.periodUnit));
    const years = days / DAYS_YEAR;
    // APY quoting is only for Flexible (default); staking stays APR-in.
    const resolved = mode === "default"
      ? resolveFlexibleApr(input)
      : { apr: Number(input.apr) || 0, quotedRate: Number(input.apr) || 0, rateQuote: "apr" };
    const apr = resolved.apr;
    const principal = Number(input.principal) || 0;
    const contribution = Number(input.contribution) || 0;
    const contribFreq = input.contribFreq || "monthly";

    // Simulate month-by-month for readability when span > 90 days, else daily
    const useDaily = days <= 90;
    const steps = useDaily ? days : Math.max(1, Math.round(days / 30.4167));
    const daysPerStep = useDaily ? 1 : days / steps;
    const ratePerStep = Math.pow(1 + apr / 100 / DAYS_YEAR, daysPerStep) - 1;
    const stepsPerYear = useDaily ? DAYS_YEAR : 12;
    const stepper = createContributionStepper({
      baseContribution: contribution,
      contribFreq,
      stepsPerYear,
      growth: input.contribGrowth,
      contribTiming: timingFromInput(input),
    });
    const atBeginning = stepper.atBeginning;

    let balance = principal;
    let invested = principal;
    let endingContribution = contribution;
    const rows = [{
      period: 0,
      label: "Start",
      invested,
      earnings: 0,
      balance,
      annualContribution: contribPerYear(contribution, contribFreq),
      contributionLevel: contribution,
    }];

    for (let i = 1; i <= steps; i++) {
      const { pmt, currentAmount, annualized } = stepper.next(i);
      endingContribution = currentAmount;
      if (atBeginning) {
        if (pmt > 0) {
          balance += pmt;
          invested += pmt;
        }
        balance *= 1 + ratePerStep;
      } else {
        balance *= 1 + ratePerStep;
        if (pmt > 0) {
          balance += pmt;
          invested += pmt;
        }
      }
      rows.push({
        period: i,
        label: useDaily ? `Day ${i}` : periodLabel(i, 12),
        invested,
        earnings: balance - invested,
        balance,
        annualContribution: annualized,
        contributionLevel: currentAmount,
      });
    }

    const final = rows[rows.length - 1];
    const summary = summarize(final.invested, final.balance, apr, DAYS_YEAR, years);
    summary.selfFund = findSelfFundingPoint(rows, apr);
    summary.endingContribution = endingContribution;
    summary.contribGrowthEnabled = !!(normalizeGrowth(input.contribGrowth));
    const base = {
      rows,
      summary,
      meta: { compoundsPerYear: DAYS_YEAR, years, annualRatePct: apr },
    };

    const flexNotes = (() => {
      if (mode === "staking") {
        return ["Modeled as daily compounding of staking APR (typical when rewards auto-restake)."];
      }
      if (resolved.rateQuote === "apy") {
        return [
          `Quoted ${resolved.quotedRate.toFixed(2)}% APY converted to ≈ ${apr.toFixed(4)}% APR for daily compounding (n=365).`,
          "Modeled like flexible earn: daily compounding on the growing balance.",
        ];
      }
      return ["Modeled like flexible earn: daily compounding of the quoted APR on the growing balance."];
    })();

    return {
      type: "crypto",
      subtype: mode,
      title: mode === "staking" ? "Crypto · Staking" : "Crypto · Flexible",
      currency: "",
      asset: input.asset || "USDT",
      ratePct: apr,
      rateQuote: resolved.rateQuote,
      quotedRate: resolved.quotedRate,
      compoundsPerYear: DAYS_YEAR,
      years,
      days,
      displayUnit: useDaily ? "day" : "month",
      notes: flexNotes,
      ...finalize(base, rows, apr, DAYS_YEAR, years, {
        ...input,
        // Scenarios must scale the engineered APR, not re-read a raw APY quote.
        apr,
        rateQuote: "apr",
      }, { displayUnit: useDaily ? "day" : "month" }),
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
    const stepsPerYear = useDaily ? DAYS_YEAR : 12;
    const stepper = createContributionStepper({
      baseContribution: contribution,
      contribFreq,
      stepsPerYear,
      growth: input.contribGrowth,
      contribTiming: timingFromInput(input),
    });
    const atBeginning = stepper.atBeginning;

    let balance = principal; // earn wallet (compounds)
    let invested = principal;
    let bonusCash = 0; // spot rewards, non-compounding
    let endingContribution = contribution;
    const rows = [];

    const snapshot = (annualized = 0, contributionLevel = contribution) => ({
      invested,
      earnings: balance + bonusCash - invested,
      balance: balance + bonusCash,
      earnBalance: balance,
      bonusCash,
      annualContribution: annualized,
      contributionLevel,
    });

    rows.push({ period: 0, label: "Start", ...snapshot(contribPerYear(contribution, contribFreq)) });

    for (let i = 1; i <= steps; i++) {
      const { pmt, currentAmount, annualized } = stepper.next(i);
      endingContribution = currentAmount;
      if (atBeginning && pmt > 0) {
        balance += pmt;
        invested += pmt;
      }
      // Bonus on capped portion of earn balance (not including prior bonus cash)
      const bonusBase = Math.min(balance, bonusCap);
      const bonusThisStep = bonusBase * (bonusApr / 100) * (daysPerStep / DAYS_YEAR);
      bonusCash += bonusThisStep;

      // Regular APR compounds on earn balance
      balance *= 1 + regularRate;

      if (!atBeginning && pmt > 0) {
        balance += pmt;
        invested += pmt;
      }

      rows.push({
        period: i,
        label: useDaily ? `Day ${i}` : periodLabel(i, 12),
        ...snapshot(annualized, currentAmount),
      });
    }

    const final = rows[rows.length - 1];
    const effApr = estimateBlendedApr(principal, regularApr, bonusApr, bonusCap);
    const regularEarnings = final.earnBalance - final.invested;
    const summary = {
      ...summarize(final.invested, final.balance, effApr, DAYS_YEAR, years),
      regularEarnings,
      bonusEarnings: final.bonusCash,
      selfFund: findSelfFundingPoint(rows, effApr),
      endingContribution,
      contribGrowthEnabled: !!(normalizeGrowth(input.contribGrowth)),
    };
    const base = {
      rows,
      summary,
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
      ...finalize(base, rows, effApr, DAYS_YEAR, years, input, {
        displayUnit: useDaily ? "day" : "month",
      }),
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
      ...finalize(base, rows, apr, 1, years, input, { displayUnit: "term" }),
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

    const stepper = createContributionStepper({
      baseContribution: contribution,
      contribFreq,
      stepsPerYear: 12,
      growth: input.contribGrowth,
      contribTiming: timingFromInput(input),
    });
    const atBeginning = stepper.atBeginning;
    const monthlyPrice = priceReturn / 100 / 12;
    const monthlyExpense = expenseRatio / 100 / 12;
    const monthlyDiv = dividendYield / 100 / 12;

    let sharesValue = principal;
    let invested = principal;
    let cashDividends = 0;
    let endingContribution = contribution;
    const rows = [{
      period: 0,
      label: "Start",
      invested,
      earnings: 0,
      balance: principal,
      cashDividends: 0,
      annualContribution: contribPerYear(contribution, contribFreq),
      contributionLevel: contribution,
    }];

    for (let i = 1; i <= months; i++) {
      const { pmt, currentAmount, annualized } = stepper.next(i);
      endingContribution = currentAmount;
      if (atBeginning && pmt > 0) {
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

      if (!atBeginning && pmt > 0) {
        sharesValue += pmt;
        invested += pmt;
      }

      const balance = sharesValue + cashDividends;
      rows.push({
        period: i,
        label: periodLabel(i, 12),
        invested,
        earnings: balance - invested,
        balance,
        cashDividends,
        annualContribution: annualized,
        contributionLevel: currentAmount,
      });
    }

    const final = rows[rows.length - 1];
    const effectiveRate = priceReturn + (reinvest ? dividendYield : 0) - expenseRatio;
    const summary = {
      ...summarize(final.invested, final.balance, effectiveRate, 12, years),
      cashDividends: final.cashDividends,
      afterWithdraw: withdrawFee > 0 ? final.balance * (1 - withdrawFee / 100) : null,
      withdrawFee,
      expenseRatio,
      dividendYield,
      reinvest,
      selfFund: findSelfFundingPoint(rows, effectiveRate),
      endingContribution,
      contribGrowthEnabled: !!(normalizeGrowth(input.contribGrowth)),
    };
    const base = {
      rows,
      summary,
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
      ...finalize(base, displayRows, effectiveRate, 12, years, input, {
        displayUnit: months > 120 ? "year" : "month",
      }),
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
      contribGrowth: input.contribGrowth,
      contribTiming: timingFromInput(input),
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
      ...finalize(result, displayRows, annualReturn, 12, years, input, {
        displayUnit: months > 120 ? "year" : "month",
      }),
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

  function horizonToDays(unit, count) {
    const n = Math.max(1, Number(count) || 1);
    switch (unit) {
      case "days": return n;
      case "months": return Math.round(n * 30.4167);
      case "quarters": return Math.round(n * 91.25);
      case "years":
      default: return Math.round(n * DAYS_YEAR);
    }
  }

  function unitLabel(unit, count) {
    const n = Math.max(1, Number(count) || 1);
    const singular = unit === "days" ? "day"
      : unit === "months" ? "month"
      : unit === "quarters" ? "quarter"
      : "year";
    const word = n === 1 ? singular : (singular === "day" ? "days"
      : singular === "month" ? "months"
      : singular === "quarter" ? "quarters"
      : "years");
    return `${n} ${word}`;
  }

  /**
   * Short horizons auto-step to a finer axis:
   * 1 year → 12 months, 1 month → 30 days, 1 quarter → 3 months.
   */
  function autoChartSubdivision(baseUnit, baseCount) {
    const unit = baseUnit || "years";
    const count = Math.max(1, Math.round(Number(baseCount) || 1));
    if (unit === "years" && count === 1) return { unit: "months", count: 12 };
    if (unit === "months" && count === 1) return { unit: "days", count: 30 };
    if (unit === "quarters" && count === 1) return { unit: "months", count: 3 };
    return { unit, count };
  }

  function buildSubdivisionOptions(baseUnit, baseCount) {
    const days = horizonToDays(baseUnit, baseCount);
    const auto = autoChartSubdivision(baseUnit, baseCount);
    const seen = new Set();
    const opts = [];
    const push = (id, unit, count) => {
      const c = Math.max(1, Math.round(Number(count) || 1));
      const key = `${unit}:${c}`;
      if (seen.has(key) && id !== "auto") return;
      seen.add(key);
      const label = id === "auto"
        ? `Auto · ${unitLabel(unit, c)}`
        : unitLabel(unit, c);
      opts.push({ id, unit, count: c, label });
    };

    push("auto", auto.unit, auto.count);
    push(baseUnit, baseUnit, baseCount);

    if (days >= DAYS_YEAR) {
      push("years", "years", Math.max(1, Math.round(days / DAYS_YEAR)));
    }
    if (days >= 90) {
      push("quarters", "quarters", Math.max(1, Math.round(days / 91.25)));
    }
    if (days >= 28) {
      const months = Math.max(1, Math.round(days / 30.4167));
      if (months <= 120) push("months", "months", months);
    }
    if (days <= 120) {
      push("days", "days", Math.max(1, Math.round(days)));
    }

    return opts;
  }

  function buildChartMeta(input, years) {
    let baseUnit = "years";
    let baseCount = Math.max(1, Math.round(years || 1));

    if (input?._source === "investment") {
      baseUnit = "years";
      baseCount = Math.max(1, Math.round(Number(input.years) || years || 1));
    } else if (input?._source === "crypto" && input.cryType === "fixed_term") {
      baseUnit = "days";
      baseCount = input.fixedTerm === "custom"
        ? Math.max(1, Number(input.customDays) || 1)
        : Math.max(1, Number(input.fixedTerm) || 30);
    } else if (input?._source === "crypto" || input?._source === "etf") {
      baseUnit = input.periodUnit || "years";
      baseCount = Math.max(1, Math.round(Number(input.period) || 1));
    }

    const auto = autoChartSubdivision(baseUnit, baseCount);
    const subdivisions = buildSubdivisionOptions(baseUnit, baseCount);
    return {
      baseUnit,
      baseCount,
      axisUnit: auto.unit,
      axisCount: auto.count,
      autoUnit: auto.unit,
      autoCount: auto.count,
      subdivisions,
      allowsGrainSelect: subdivisions.length > 1,
    };
  }

  const TABLE_GRAIN_RANK = { day: 0, month: 1, quarter: 2, year: 3 };

  function getSimGrain({ compoundsPerYear, years, displayUnit, rows }) {
    // Prefer engine step over displayUnit (display may already be downsampled).
    if (displayUnit === "term") return "year";

    const n = Number(compoundsPerYear) || 1;
    if (n >= 300) {
      const maxP = Number(rows?.[rows.length - 1]?.period) || 0;
      const dayHorizon = Math.max(1, Math.round((Number(years) || 0) * DAYS_YEAR));
      // Crypto long flexible: APR daily but stepped monthly → far fewer periods than calendar days
      if (maxP > 0 && dayHorizon > 90 && maxP <= Math.ceil(dayHorizon / 20)) return "month";
      return "day";
    }
    if (n === 12) return "month";
    if (n === 4) return "quarter";
    if (n === 1) return "year";

    const unit = displayUnit || "";
    if (unit === "day" || unit === "days") return "day";
    if (unit === "month" || unit === "months") return "month";
    if (unit === "quarter" || unit === "quarters") return "quarter";
    return "year";
  }

  function horizonDaysFrom(years, rows, simGrain) {
    if (Number(years) > 0) return Math.max(1, Math.round(Number(years) * DAYS_YEAR));
    const maxP = Number(rows?.[rows.length - 1]?.period) || 0;
    if (simGrain === "day") return Math.max(1, maxP);
    if (simGrain === "month") return Math.max(1, Math.round(maxP * 30.4167));
    if (simGrain === "quarter") return Math.max(1, Math.round(maxP * 91.25));
    return Math.max(1, Math.round(maxP * DAYS_YEAR));
  }

  function pickAutoTableGrain(simGrain, years, days) {
    const y = Number(years) || days / DAYS_YEAR;
    if (simGrain === "day") {
      // Up to 1 year of daily steps stays readable; beyond that, collapse.
      if (days <= 365) return "day";
      if (y <= 2) return "month";
      return "year";
    }
    if (simGrain === "month") {
      if (y <= 2) return "month";
      return "year";
    }
    if (simGrain === "quarter") return "quarter";
    return "year";
  }

  function grainSelectLabel(grain) {
    switch (grain) {
      case "day": return "Days";
      case "month": return "Months";
      case "quarter": return "Quarters";
      case "year": return "Years";
      default: return grain;
    }
  }

  function buildTableMeta({ simGrain, years, rows }) {
    const days = horizonDaysFrom(years, rows, simGrain);
    const monthsEst = Math.max(1, Math.round(days / 30.4167));
    const quartersEst = Math.max(1, Math.round(days / 91.25));
    const yearsEst = Math.max(1, Math.round(days / DAYS_YEAR));
    const autoGrain = pickAutoTableGrain(simGrain, years, days);
    const simRank = TABLE_GRAIN_RANK[simGrain] ?? 3;

    const allowed = [];
    const consider = ["day", "month", "quarter", "year"];
    for (const g of consider) {
      if ((TABLE_GRAIN_RANK[g] ?? 99) < simRank) continue;
      if (g === "day" && (simGrain !== "day" || days > 365)) continue;
      if (g === "month" && (days < 28 || monthsEst > 120)) continue;
      if (g === "quarter" && (days < 90 || quartersEst > 80)) continue;
      if (g === "year" && days < 180) continue;
      allowed.push(g);
    }

    if (!allowed.includes(simGrain)) allowed.unshift(simGrain);
    if (!allowed.includes(autoGrain)) allowed.unshift(autoGrain);

    const unique = [...new Set(allowed)];
    unique.sort((a, b) => (TABLE_GRAIN_RANK[a] ?? 0) - (TABLE_GRAIN_RANK[b] ?? 0));

    const grains = [
      { id: "auto", grain: autoGrain, label: `Auto · ${grainSelectLabel(autoGrain)}` },
      ...unique.map((g) => ({ id: g, grain: g, label: grainSelectLabel(g) })),
    ];

    return {
      simGrain,
      autoGrain,
      grains,
      allowsGrainSelect: unique.length > 1,
    };
  }

  function periodStepForGrain(simGrain, targetGrain) {
    const map = {
      day: { day: 1, month: 30, quarter: 91, year: 365 },
      month: { month: 1, quarter: 3, year: 12 },
      quarter: { quarter: 1, year: 4 },
      year: { year: 1 },
    };
    return map[simGrain]?.[targetGrain] || 1;
  }

  function labelForAggregatedPeriod(period, targetGrain, simGrain) {
    if (!(period > 0)) return "Start";
    if (targetGrain === "day") return `Day ${period}`;

    if (simGrain === "day") {
      if (targetGrain === "month") {
        return `Month ${Math.max(1, Math.round(period / 30.4167))}`;
      }
      if (targetGrain === "quarter") {
        return `Quarter ${Math.max(1, Math.round(period / 91.25))}`;
      }
      if (targetGrain === "year") {
        return `Year ${Math.max(1, Math.round(period / DAYS_YEAR))}`;
      }
    }

    if (simGrain === "month") {
      if (targetGrain === "month") {
        const month = ((period - 1) % 12) + 1;
        const year = Math.ceil(period / 12);
        return `M${month} Y${year}`;
      }
      if (targetGrain === "quarter") {
        const qIndex = Math.ceil(period / 3);
        const year = Math.ceil(qIndex / 4);
        const q = ((qIndex - 1) % 4) + 1;
        return `Q${q} Y${year}`;
      }
      if (targetGrain === "year") {
        return `Year ${Math.round(period / 12)}`;
      }
    }

    if (simGrain === "quarter") {
      if (targetGrain === "quarter") {
        const year = Math.ceil(period / 4);
        const q = ((period - 1) % 4) + 1;
        return `Q${q} Y${year}`;
      }
      if (targetGrain === "year") {
        return `Year ${Math.round(period / 4)}`;
      }
    }

    return `Year ${period}`;
  }

  /**
   * Aggregate fullRows up to a coarser grain (never invent finer steps).
   * Keeps Start (period 0) and end-of-bucket snapshots.
   */
  function aggregateRowsForGrain(fullRows, grain, simGrain) {
    const rows = fullRows || [];
    if (!rows.length) return [];
    const target = ["day", "month", "quarter", "year"].includes(grain) ? grain : simGrain;

    if ((TABLE_GRAIN_RANK[target] ?? 99) < (TABLE_GRAIN_RANK[simGrain] ?? 0)) {
      return aggregateRowsForGrain(rows, simGrain, simGrain);
    }

    if (target === simGrain) {
      return rows.map((r) => {
        const label = String(r.label || "");
        // Keep custom maturity / term labels
        if (label.startsWith("Maturity") || label.includes("Maturity")) return { ...r };
        return {
          ...r,
          label: labelForAggregatedPeriod(Number(r.period) || 0, target, simGrain),
        };
      });
    }

    const step = periodStepForGrain(simGrain, target);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const p = Number(r.period) || 0;
      const isLast = i === rows.length - 1;
      if (p === 0 || (p > 0 && p % step === 0) || isLast) {
        if (isLast && out.length && Number(out[out.length - 1].period) === p) continue;
        out.push({
          ...r,
          label: labelForAggregatedPeriod(p, target, simGrain),
        });
      }
    }
    return out;
  }

  function resolveTableGrainId(tableMeta, grainId) {
    const id = grainId || "auto";
    const opt = (tableMeta?.grains || []).find((g) => g.id === id);
    if (opt) return opt.grain;
    return tableMeta?.autoGrain || tableMeta?.simGrain || "year";
  }

  function rowsForTableGrain(result, grainId) {
    const full = result.fullRows?.length ? result.fullRows : (result.rows || []);
    const simGrain = result.simGrain || result.tableMeta?.simGrain || "year";
    const resolved = resolveTableGrainId(result.tableMeta, grainId || "auto");
    return aggregateRowsForGrain(full, resolved, simGrain);
  }

  function finalize(result, displayRows, ratePct, compoundsPerYear, years, input, extras = {}) {
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

    const chartMeta = buildChartMeta(input, years);
    const axisCount = chartMeta.axisCount;
    const fullRows = result.rows;
    const displayUnit = extras.displayUnit;
    const simGrain = getSimGrain({
      compoundsPerYear,
      years,
      displayUnit,
      rows: fullRows,
    });
    const tableMeta = buildTableMeta({ simGrain, years, rows: fullRows });
    const autoRows = aggregateRowsForGrain(fullRows, tableMeta.autoGrain, simGrain);

    return {
      rows: autoRows,
      fullRows,
      simGrain,
      tableMeta,
      summary: expected.summary,
      scenarios,
      chartMeta,
      chartPreference: pickChartType(axisCount),
      chartAllowsToggle: chartAllowsToggle(axisCount),
    };
  }

  /** 1–10 bars default; 11–30 line default; both allow toggle. 31+ line only. */
  function pickChartType(axisCount) {
    return axisCount <= 10 ? "bar" : "line";
  }

  function chartAllowsToggle(axisCount) {
    return axisCount >= 1 && axisCount <= 30;
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
        contribGrowth: input.contribGrowth,
        contribTiming: timingFromInput(input),
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
      const stepsPerYear = useDaily ? DAYS_YEAR : 12;
      const stepper = createContributionStepper({
        baseContribution: Number(input.contribution) || 0,
        contribFreq: input.contribFreq || "monthly",
        stepsPerYear,
        growth: input.contribGrowth,
        contribTiming: timingFromInput(input),
      });
      const atBeginning = stepper.atBeginning;
      let balance = Number(input.principal) || 0;
      let invested = balance;
      for (let i = 1; i <= steps; i++) {
        const { pmt } = stepper.next(i);
        if (atBeginning) {
          if (pmt > 0) {
            balance += pmt;
            invested += pmt;
          }
          balance *= 1 + ratePerStep;
        } else {
          balance *= 1 + ratePerStep;
          if (pmt > 0) {
            balance += pmt;
            invested += pmt;
          }
        }
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
        contribGrowth: input.contribGrowth,
        contribTiming: timingFromInput(input),
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
    const stepper = createContributionStepper({
      baseContribution: contribution,
      contribFreq,
      stepsPerYear: 12,
      growth: input.contribGrowth,
      contribTiming: timingFromInput(input),
    });
    const atBeginning = stepper.atBeginning;
    const monthlyPrice = priceReturn / 100 / 12;
    const monthlyExpense = expenseRatio / 100 / 12;
    const monthlyDiv = dividendYield / 100 / 12;

    let sharesValue = principal;
    let invested = principal;
    let cashDividends = 0;
    for (let i = 1; i <= months; i++) {
      const { pmt } = stepper.next(i);
      if (atBeginning && pmt > 0) {
        sharesValue += pmt;
        invested += pmt;
      }
      sharesValue *= 1 + monthlyPrice;
      sharesValue *= 1 - monthlyExpense;
      const divAmt = sharesValue * monthlyDiv;
      if (reinvest) sharesValue += divAmt;
      else cashDividends += divAmt;
      if (!atBeginning && pmt > 0) {
        sharesValue += pmt;
        invested += pmt;
      }
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
    const stepsPerYear = useDaily ? DAYS_YEAR : 12;
    const stepper = createContributionStepper({
      baseContribution: contribution,
      contribFreq,
      stepsPerYear,
      growth: input.contribGrowth,
      contribTiming: timingFromInput(input),
    });
    const atBeginning = stepper.atBeginning;
    let balance = principal;
    let invested = principal;
    let bonusCash = 0;
    for (let i = 1; i <= steps; i++) {
      const { pmt } = stepper.next(i);
      if (atBeginning && pmt > 0) {
        balance += pmt;
        invested += pmt;
      }
      const bonusBase = Math.min(balance, bonusCap);
      bonusCash += bonusBase * (bonusApr / 100) * (daysPerStep / DAYS_YEAR);
      balance *= 1 + regularRate;
      if (!atBeginning && pmt > 0) {
        balance += pmt;
        invested += pmt;
      }
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
    apyToApr,
    toYears,
    toDays,
    contribPerYear,
    formatNum,
    clamp,
    aggregateRowsForGrain,
    rowsForTableGrain,
    resolveTableGrainId,
  };
})();
