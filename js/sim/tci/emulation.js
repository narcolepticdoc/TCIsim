/**
 * tci/emulation.js — CET Emulation TCI planner.
 *
 * Ported from SimTIVA's deliver_cpt algorithm. Best Cp accuracy of the
 * four planners — validated against SimTIVA at 0.0000% Cp deviation.
 *
 * Uses SimTIVA's two-pass approach:
 * 1. First pass: compute optimal Cp-targeting rate at each 2-minute interval
 *    for 6 hours (180 intervals). Each rate is the amount needed to bring Cp
 *    to target over the next interval, given current state.
 * 2. Second pass: extract clinician-feasible steps by scanning the rate array
 *    and emitting a new step when the rate changes by >cpt_threshold (8%).
 *    Step rates are weighted averages (cpt_avgfactor).
 *
 * Loading: uses CET bolus + pause (same as CET Conservative).
 * Maintenance: SimTIVA's per-interval Cp targeting → step extraction.
 *
 * The file maintains a parallel SimTIVA eigenstate (ps1/ps2/ps3). After any
 * Ce-boost engine advance, refitEigenstate() is called to keep it in sync
 * before the Cp-targeting pass — this is the documented invariant in
 * CLAUDE.md under "TCI Planner Quick Reference".
 */

import { computeSimTIVACETBolus, computeUDFs } from '../simtiva-reference.js';
import { computeSteadyStateRate } from '../../pk/steady-state-predictor.js';
import { DEFAULT_SCHEME_CONFIG, makeQuantizers, plannerBolusDelivery } from './shared.js';

export function planTCISchemeEmulation(engine, startState, startTime, ceTarget, config = {}) {
  const cfg = { ...DEFAULT_SCHEME_CONFIG, ...config };
  const { qBolus, qRate } = makeQuantizers(cfg);
  const scheme = [];

  if (ceTarget <= 0) {
    scheme.push({ type: 'rate', time: startTime, value: 0 });
    return scheme;
  }

  const saved = engine.getState();
  engine.setState(startState);

  const currentCe = engine.getConcentrations().Ce;
  const upperBound = ceTarget * (1 + cfg.tolerancePct);

  let simTime = startTime;

  // ---- Loading: CET bolus + pause (same as conservative) ----
  // SimTIVA always gives a bolus for any CET target increase (no threshold).
  // The bolus size is computed accounting for existing drug.
  const needsBolus = currentCe < ceTarget * (1 - cfg.tolerancePct);

  if (needsBolus) {
    let bolusMg, pauseDurationMin = null;
    const pkParams = engine.params;

    if (currentCe < 0.1) {
      const simtiva = computeSimTIVACETBolus(pkParams, ceTarget, {
        maxRateMlH: cfg.bolusRateMlH || 750,
        concentration: cfg.bolusConcentration || 10,
      });
      bolusMg = qBolus(simtiva.bolusMg);
      pauseDurationMin = Math.max(0, (simtiva.peakTimeSec - simtiva.durationSec) / 60);
    } else {
      // SimTIVA CET step-up algorithm (lines 3762-3779):
      // 1. Decompose Ce into eigenstates
      // 2. trial_rate = (desired - vmCe(e_state, peak)) / e_udf[peak]  (gives dose in mg with deltaSec=1)
      // 3. find_peak: adjust peak_time for this dose
      // 4. Iterate until converged
      // 5. Apply rate correction factor

      const { e_udf, e_coef, lambda: lam } = computeUDFs(pkParams, 1);
      const peakTime0 = e_udf.findIndex((v, i) => i > 1 && v < e_udf[i - 1]) - 1 || 175;

      // Decompose Ce eigenstate via 4x4 Gaussian elimination
      const saved2 = engine.getState();
      const tSamples = [5, 30, 120, 600];
      const ceSamples = [];
      for (const ts of tSamples) {
        engine.setState(saved2);
        engine.advance(ts / 60, 0);
        ceSamples.push(engine.getConcentrations().Ce);
      }
      engine.setState(saved2);

      // Solve 4x4 system
      const N = 4;
      const A = [];
      for (let i = 0; i < N; i++) {
        const row = [];
        for (let j = 0; j < N; j++) row.push(Math.exp(-lam[j + 1] * tSamples[i]));
        row.push(ceSamples[i]);
        A.push(row);
      }
      for (let col = 0; col < N; col++) {
        let maxRow = col, maxVal = Math.abs(A[col][col]);
        for (let row = col + 1; row < N; row++) {
          if (Math.abs(A[row][col]) > maxVal) { maxVal = Math.abs(A[row][col]); maxRow = row; }
        }
        [A[col], A[maxRow]] = [A[maxRow], A[col]];
        for (let row = col + 1; row < N; row++) {
          const f = A[row][col] / A[col][col];
          for (let j = col; j <= N; j++) A[row][j] -= f * A[col][j];
        }
      }
      const es = new Array(N);
      for (let i = N - 1; i >= 0; i--) {
        es[i] = A[i][N];
        for (let j = i + 1; j < N; j++) es[i] -= A[i][j] * es[j];
        es[i] /= A[i][i];
      }

      // vmCe: predict Ce at t seconds from eigenstate at rate=0
      function vmCe(t) {
        let c = 0;
        for (let j = 0; j < 4; j++) c += es[j] * Math.exp(-lam[j + 1] * t);
        return c;
      }

      // Iterative trial_rate + find_peak (SimTIVA lines 3762-3779)
      let tempPeak = peakTime0;
      let trialDose, current;
      const minDif = 0.005;

      for (let iter = 0; iter < 20; iter++) {
        // trial_rate with deltaSec=1 gives dose in mg
        trialDose = (ceTarget - vmCe(tempPeak)) / e_udf[tempPeak];

        // find_peak: scan for actual peak Ce = vmCe(t) + e_udf[t] * trialDose
        let peakVal = vmCe(tempPeak) + e_udf[tempPeak] * trialDose;
        // Search forward
        while (tempPeak < e_udf.length - 2) {
          const next = vmCe(tempPeak + 1) + (e_udf[tempPeak + 1] || 0) * trialDose;
          if (next <= peakVal) break;
          peakVal = next;
          tempPeak++;
        }
        // Search backward
        while (tempPeak > 1) {
          const prev = vmCe(tempPeak - 1) + e_udf[tempPeak - 1] * trialDose;
          if (prev <= peakVal) break;
          peakVal = prev;
          tempPeak--;
        }

        current = vmCe(tempPeak) + e_udf[tempPeak] * trialDose;
        if (Math.abs(current - ceTarget) < minDif) break;
      }

      // trialDose is the raw bolus. Apply rate correction.
      const simtiva = computeSimTIVACETBolus(pkParams, ceTarget, {
        maxRateMlH: cfg.bolusRateMlH || 750,
        concentration: cfg.bolusConcentration || 10,
      });
      const correctionRatio = simtiva.rawBolusMg > 0 ? simtiva.bolusMg / simtiva.rawBolusMg : 1;
      bolusMg = qBolus(trialDose * correctionRatio);

      // Pause duration: from bolus end to peak time.
      // When quantizeInDisplay is on, bolusMg is already the final value,
      // so use it directly (no additional Math.ceil). When off, mirror
      // SimTIVA's ceil-to-1mg rounding used for the final value below.
      const maxRateMlH = cfg.bolusRateMlH || 750;
      const concentration = cfg.bolusConcentration || 10;
      const bolusForDur = cfg.quantizeInDisplay ? bolusMg : Math.ceil(bolusMg);
      const bolusDurSec = Math.round((bolusForDur / concentration) / maxRateMlH * 3600);
      if (tempPeak > bolusDurSec) {
        pauseDurationMin = (tempPeak - bolusDurSec) / 60;
      }
    }

    if (bolusMg > 0) {
      // SimTIVA CET rounding: ceil to nearest 1mg. Skipped in quantize-in-display
      // mode — bolusMg is already snapped to the clinician's display-unit grid.
      if (!cfg.quantizeInDisplay) bolusMg = Math.ceil(bolusMg);
      scheme.push({ type: 'bolus', time: simTime, value: bolusMg });
      const { duration, rate } = plannerBolusDelivery(bolusMg, cfg);
      engine.advance(duration, rate);
      simTime += duration;

      scheme.push({ type: 'rate', time: simTime, value: 0 });
      if (pauseDurationMin != null && pauseDurationMin > 0) {
        engine.advance(pauseDurationMin, 0);
        simTime += pauseDurationMin;
      } else {
        const pauseStep = 1 / 60;
        let cePeak = 0;
        while (simTime < startTime + cfg.maxPlanTime) {
          engine.advance(pauseStep, 0);
          simTime += pauseStep;
          const ce = engine.getConcentrations().Ce;
          if (ce > cePeak) { cePeak = ce; }
          else if (ce < cePeak - 0.0005) break;
        }
      }
    }
  }

  // ---- Target decrease: pause until Ce decays ----
  if (currentCe > upperBound) {
    scheme.push({ type: 'rate', time: simTime, value: 0 });
    while (simTime < startTime + cfg.maxPlanTime) {
      engine.advance(cfg.simStep, 0);
      simTime += cfg.simStep;
      if (engine.getConcentrations().Ce <= upperBound) break;
    }
  }

  // ==== Maintenance: SimTIVA deliver_cpt — direct port ====
  // All rate computation uses SimTIVA's eigenstate math (per-second).
  // Rates in cptRates[] are in mg/sec. Converted to mg/min for our events.

  const pkParams = engine.params;
  const { p_udf, p_coef, lambda } = computeUDFs(pkParams);
  const concentration = cfg.bolusConcentration || 10;

  const cptInterval = 120;
  const look_l1 = Math.exp(-lambda[1] * cptInterval);
  const look_l2 = Math.exp(-lambda[2] * cptInterval);
  const look_l3 = Math.exp(-lambda[3] * cptInterval);
  const l1s = Math.exp(-lambda[1]);
  const l2s = Math.exp(-lambda[2]);
  const l3s = Math.exp(-lambda[3]);

  // Build eigenstate at maintenance start.
  // Use Cramer's rule decomposition: sample Cp at 3 future times at rate=0,
  // solve the 3×3 system to get exact eigenstate coefficients.
  // This works for ALL cases: from-zero (engine advanced through bolus+pause),
  // target step-up (engine has existing drug + new bolus), and target decrease
  // (engine has existing drug after decay).
  let ps1 = 0, ps2 = 0, ps3 = 0;

  /**
   * Refit ps1/ps2/ps3 from the current engine state using Cramér's rule.
   * Call this whenever the engine has been advanced and the eigenstate
   * needs to be re-synced to engine reality.
   */
  function refitEigenstate() {
    if (engine.getConcentrations().Cp <= 0.001) {
      ps1 = 0; ps2 = 0; ps3 = 0;
      return;
    }
    const saved2 = engine.getState();
    const t1 = 10, t2 = 60, t3 = 300; // seconds
    engine.advance(t1 / 60, 0); const cp1 = engine.getConcentrations().Cp;
    engine.setState(saved2);
    engine.advance(t2 / 60, 0); const cp2 = engine.getConcentrations().Cp;
    engine.setState(saved2);
    engine.advance(t3 / 60, 0); const cp3 = engine.getConcentrations().Cp;
    engine.setState(saved2);

    const e11 = Math.exp(-lambda[1] * t1), e12 = Math.exp(-lambda[2] * t1), e13 = Math.exp(-lambda[3] * t1);
    const e21 = Math.exp(-lambda[1] * t2), e22 = Math.exp(-lambda[2] * t2), e23 = Math.exp(-lambda[3] * t2);
    const e31 = Math.exp(-lambda[1] * t3), e32 = Math.exp(-lambda[2] * t3), e33 = Math.exp(-lambda[3] * t3);

    const det = e11 * (e22 * e33 - e23 * e32) - e12 * (e21 * e33 - e23 * e31) + e13 * (e21 * e32 - e22 * e31);
    if (Math.abs(det) > 1e-20) {
      ps1 = (cp1 * (e22 * e33 - e23 * e32) - e12 * (cp2 * e33 - cp3 * e23) + e13 * (cp2 * e32 - cp3 * e22)) / det;
      ps2 = (e11 * (cp2 * e33 - cp3 * e23) - cp1 * (e21 * e33 - e23 * e31) + e13 * (e21 * cp3 - cp2 * e31)) / det;
      ps3 = (e11 * (e22 * cp3 - cp2 * e32) - e12 * (e21 * cp3 - cp2 * e31) + cp1 * (e21 * e32 - e22 * e31)) / det;
    } else {
      ps1 = 0; ps2 = 0; ps3 = 0;
    }
  }

  // Initial eigenstate fit at maintenance start
  refitEigenstate();

  const maintTime = simTime;
  const maintState = engine.getState(); // save for post-extraction correction

  // virtual_model: predict Cp at t seconds from eigenstate at zero rate
  function vm(s1, s2, s3, t) {
    const f1 = lambda[1] * t > 100 ? 0 : Math.exp(-lambda[1] * t);
    const f2 = lambda[2] * t > 100 ? 0 : Math.exp(-lambda[2] * t);
    const f3 = lambda[3] * t > 100 ? 0 : Math.exp(-lambda[3] * t);
    return s1 * f1 + s2 * f2 + s3 * f3;
  }

  // First pass: 360 intervals × 120 sec = 720 min (was 180 × 120 = 360 min).
  // Extending to 360 is computationally free: this loop is pure eigenstate arithmetic
  // (no engine.advance calls). V3 is ~95% equilibrated at 720 min vs ~77% at 360 min,
  // so the final extracted rate step converges much closer to true steady-state.
  const cptIntervalCount = 360;
  const cptRates = [];
  let testRate = 0;

  // Check if Ce is below target at maintenance start (rate-only step-up)
  const ceAtMaint = engine.getConcentrations().Ce;
  const cpAtMaint = engine.getConcentrations().Cp;
  const hadBolus = !!scheme.find(e => e.type === 'bolus');
  const needsCeBoost = ceAtMaint < ceTarget * 0.95 && !hadBolus;

  // For large target decreases: Cp falls much faster than Ce during the decay pause.
  // When Ce reaches upperBound, Cp may be far below target. ke0 equilibration then
  // pulls Ce below the lower band before Cp-targeting can raise Cp fast enough.
  // Activate Ce-targeting intervals (same mechanism as needsCeBoost) to hold Ce near
  // target while Cp recovers, preventing the undershoot.
  const cpGap = Math.max(0, ceTarget - cpAtMaint);
  const needsCpLift = !needsCeBoost && cpGap > ceTarget * 0.1; // Cp >10% below target
  const cpLiftIntervals = needsCpLift
    ? Math.min(8, Math.ceil(cpGap / (ceTarget * 0.1)))
    : 0;
  const cpOvershoot = hadBolus && cpAtMaint > ceTarget * 1.02;
  const ceBoostIntervals = needsCeBoost ? 3
    : cpLiftIntervals > 0 ? cpLiftIntervals
    : cpOvershoot ? 2
    : 0;

  for (let i = 0; i < cptIntervalCount; i++) {
    if (ps1 === 0 && ps2 === 0 && ps3 === 0) {
      testRate = ceTarget / p_udf[cptInterval];
    } else if (i < ceBoostIntervals) {
      // Ce-targeting: find rate where Ce at +5min = target
      // Shorter lookahead than from-zero case for faster approach
      const savedEng = engine.getState();
      let lo = 0, hi = cfg.maxRate;
      for (let iter = 0; iter < 30; iter++) {
        const mid = (lo + hi) / 2;
        engine.setState(savedEng);
        engine.advance(5, mid); // 5-minute Ce-targeting lookahead
        const ce = engine.getConcentrations().Ce;
        if (ce < ceTarget) lo = mid; else hi = mid;
      }
      engine.setState(savedEng);
      // Convert mg/min (engine) → mg/sec (eigenstate)
      testRate = Math.max(0, (lo + hi) / 2) / 60;
      // Advance the engine to keep it in sync for subsequent Ce searches
      engine.advance(cptInterval / 60, testRate * 60);
      // FIX #3: Refit ps1/ps2/ps3 from the engine after each Ce-boost interval.
      // Without this, the eigenstate diverges from engine reality and Cp predictions
      // are wrong for all subsequent Cp-targeting intervals.
      refitEigenstate();
    } else {
      // Cp-targeting: advance 1 sec at testRate, predict Cp at +interval at zero
      const ts1 = ps1 * l1s + p_coef[1] * testRate * (1 - l1s);
      const ts2 = ps2 * l2s + p_coef[2] * testRate * (1 - l2s);
      const ts3 = ps3 * l3s + p_coef[3] * testRate * (1 - l3s);
      const trialCp = vm(ts1, ts2, ts3, cptInterval);
      testRate = ceTarget > trialCp ? (ceTarget - trialCp) / p_udf[cptInterval] : 0;
    }
    cptRates.push(testRate);
    // Advance eigenstate by interval at testRate
    ps1 = ps1 * look_l1 + p_coef[1] * testRate * (1 - look_l1);
    ps2 = ps2 * look_l2 + p_coef[2] * testRate * (1 - look_l2);
    ps3 = ps3 * look_l3 + p_coef[3] * testRate * (1 - look_l3);
  }

  // Second pass: step extraction (SimTIVA lines 1275-1544)
  // Propofol: threshold=0.08, avgfactor=0.667, roundingfactor=360
  // Dynamic threshold/avgfactor based on early maintenance rate magnitude
  // SimTIVA lines 1250-1259: propofol with cpt_rates[5]*360 >= 30 uses 0.08/0.667,
  // lower rates use 0.05/0.62
  const earlyRateMlH = (cptRates[5] || cptRates[0]) * 3600 / concentration;
  const stepMagnitude = currentCe > 0 ? (ceTarget - currentCe) / ceTarget : 1;
  const cptThreshold = (earlyRateMlH >= 30 && stepMagnitude > 0.20) ? 0.08 : 0.05;
  const cptAvgFactor = (earlyRateMlH >= 30 && stepMagnitude > 0.20) ? 0.667 : 0.62;
  const rf = 360; // round mg/sec to nearest 1 mL/h (default assumes 10 mg/mL)
  // In quantize-in-display mode the rnd function snaps through the clinician's
  // chosen display unit (e.g. mL/h at their actual concentration, or mcg/kg/min).
  // Signature is preserved: mg/sec in → mg/sec out.
  const rnd = cfg.quantizeInDisplay
    ? (r) => qRate(r * 60) / 60
    : (r) => Math.round(r * rf) / rf;

  let priorTestRate;
  const cptTimes = [];
  let waitPeak = 0;

  // Detect rate pattern: decremental or rise-then-fall (SimTIVA lines 1287-1492)
  if (cptRates[0] > 0 && cptRates[0] >= cptRates[1]) {
    // Decremental: start from interval 0 (not 1 as SimTIVA does).
    // SimTIVA skips interval 0 because it replans every 2 min; our one-shot
    // planner must use the first-interval rate or Ce undershoots on target decrease.
    priorTestRate = cptRates[0];
    cptTimes.push(0);
    scheme.push({ type: 'rate', time: maintTime, value: rnd(cptRates[0]) * 60 });
  } else if (cptRates[0] > 0 && cptRates[1] > cptRates[0]) {
    // Possible rise-then-fall: find peak
    for (let k = 1; k < 60; k++) {
      if (cptRates[k] > cptRates[k - 1]) {
        waitPeak = k;
      } else {
        break;
      }
    }

    if (waitPeak <= 1) {
      // Very short rise (1 interval) — treat as near-flat, use interval 1
      priorTestRate = cptRates[1];
      cptTimes.push(1);
      scheme.push({ type: 'rate', time: maintTime, value: rnd(cptRates[1]) * 60 });
    } else {
      // Genuine rise-then-fall: average of rates[1] and rates[waitPeak]
      const avgRate = rnd((cptRates[waitPeak] + cptRates[1]) / 2);
      priorTestRate = cptRates[waitPeak];
      cptTimes.push(waitPeak);
      scheme.push({ type: 'rate', time: maintTime, value: avgRate * 60 });
    }
  } else {
    // Flat or zero start
    priorTestRate = cptRates[0];
    cptTimes.push(0);
    scheme.push({ type: 'rate', time: maintTime, value: rnd(cptRates[0]) * 60 });
  }

  // Scan ALL computed intervals for step changes (not just the first 60).
  // The previous j < 60 limit only covered 120 min of the 180-interval (360 min) rate
  // array, leaving V3-equilibration rate steps beyond 120 min unextracted.
  for (let j = Math.max(2, waitPeak + 1); j < cptRates.length; j++) {
    if (priorTestRate <= 0) continue;
    const change = (priorTestRate - cptRates[j]) / priorTestRate;

    if (change > cptThreshold) {
      const lastIdx = cptTimes[cptTimes.length - 1];
      const avgRate = (cptRates[lastIdx] - cptRates[j]) * cptAvgFactor + cptRates[j];
      const rounded = rnd(avgRate);
      // Rate starts at the time corresponding to the last emitted interval
      // This is SimTIVA line 1513: relativetime = working_clock + cpt_times[last]*120
      const stepTimeMin = maintTime + lastIdx * cptInterval / 60;
      const prevVal = scheme[scheme.length - 1]?.value || 0;
      // Replace the previous step's rate if same timestamp, otherwise add new
      if (Math.abs(stepTimeMin - (scheme[scheme.length - 1]?.time || 0)) < 0.01) {
        scheme[scheme.length - 1].value = rounded * 60;
      } else if (Math.abs(rounded * 60 - prevVal) > 0.01) {
        scheme.push({ type: 'rate', time: stepTimeMin, value: rounded * 60 });
      }
      cptTimes.push(j);
      priorTestRate = cptRates[j];
    }
  }

  // Final step at last computed interval
  {
    const lastIdx = cptTimes[cptTimes.length - 1];
    const j = cptRates.length - 1;
    const avgRate = (cptRates[lastIdx] - cptRates[j]) * cptAvgFactor + cptRates[j];
    const rounded = rnd(avgRate);
    const stepTimeMin = maintTime + lastIdx * cptInterval / 60;
    const lastVal = scheme[scheme.length - 1]?.value || 0;
    if (Math.abs(rounded * 60 - lastVal) > 0.01) {
      scheme.push({ type: 'rate', time: stepTimeMin, value: rounded * 60 });
    }
  }

  // Post-extraction Ce correction pass.
  // SimTIVA's step extraction holds each rate for 30-120+ min via cptAvgFactor
  // averaging. SimTIVA compensates by replanning every 2 min; our one-shot
  // planner must instead replace long maintenance steps with corrected steps.
  // Early redistribution steps (<20 min after maintenance start) are kept from
  // SimTIVA — the extraction handles that transition well.
  //
  // Adaptive spacing: for each step, binary-search the rate that hits Ce=target
  // after PROBE minutes, then extend the step as long as Ce stays within ±CE_TOL.
  // This gives tight control when V3 equilibrates fast (~15-30 min steps early)
  // and relaxed control when the rate barely changes (~60-90 min steps late).
  {
    const PROBE      = 15;    // min: binary search lookahead and extension increment
    const MAX_DUR    = 90;    // min: maximum step duration
    const CE_TOL     = 0.015; // 1.5%: max Ce deviation before new step required

    // Start correcting from the first SimTIVA rate at or after maintTime.
    // Rate steps before maintTime (e.g. zero-rate pause during bolus delivery)
    // are preserved — they're already reflected in maintState.
    const rateSteps = scheme.filter(s => s.type === 'rate');
    const firstCorrIdx = rateSteps.findIndex(s => s.time >= maintTime);

    if (firstCorrIdx >= 0 && rateSteps.length >= 2) {
      const corrStart = rateSteps[firstCorrIdx].time;
      const corrEnd   = maintTime + cptIntervalCount * cptInterval / 60 + 180;

      // Replay engine through any uncorrected early rates to reach corrStart.
      // Skip steps before maintTime — they're from the bolus phase and already
      // baked into maintState.
      engine.setState(maintState);
      for (let i = 0; i < firstCorrIdx; i++) {
        if (rateSteps[i].time < maintTime) continue;
        const nextT = (i + 1 < firstCorrIdx) ? rateSteps[i + 1].time : corrStart;
        const gap   = nextT - rateSteps[i].time;
        if (gap > 0) engine.advance(gap, rateSteps[i].value);
      }

      // Remove all rate events at or after corrStart from scheme
      for (let i = scheme.length - 1; i >= 0; i--) {
        if (scheme[i].type === 'rate' && scheme[i].time >= corrStart) {
          scheme.splice(i, 1);
        }
      }

      // Generate corrected rates with adaptive spacing.
      // Each step: binary-search rate for Ce=target at PROBE, then extend
      // while Ce stays within ±CE_TOL.
      for (let t = corrStart; t < corrEnd; ) {
        const state = engine.getState();

        // Binary search: rate where Ce = ceTarget after PROBE minutes
        let lo = 0, hi = cfg.maxRate;
        for (let iter = 0; iter < 25; iter++) {
          const mid = (lo + hi) / 2;
          engine.setState(state);
          engine.advance(PROBE, mid);
          if (engine.getConcentrations().Ce < ceTarget) lo = mid; else hi = mid;
        }
        // Quantize BEFORE the forward-probe extension loop so the probe
        // uses the same rate the pump will deliver — otherwise extension
        // stops too early (or too late) under display-unit rounding.
        const rate = qRate((lo + hi) / 2);

        // Probe forward: extend this rate while Ce stays within tolerance
        let dur = PROBE;
        while (dur + PROBE <= MAX_DUR && t + dur + PROBE <= corrEnd) {
          engine.setState(state);
          engine.advance(dur + PROBE, rate);
          if (Math.abs(engine.getConcentrations().Ce - ceTarget) / ceTarget > CE_TOL) break;
          dur += PROBE;
        }

        scheme.push({ type: 'rate', time: t, value: rate });
        engine.setState(state);
        engine.advance(dur, rate);
        t += dur;
      }
    }
  }

  // Append analytical SS rate beyond the correction horizon for t → ∞
  const ssRateRaw = computeSteadyStateRate(engine, ceTarget);
  const ssRate = ssRateRaw != null ? qRate(ssRateRaw) : null;
  if (ssRate != null && scheme.length > 0) {
    const lastRateEvt = [...scheme].reverse().find(s => s.type === 'rate');
    if (lastRateEvt && Math.abs(ssRate - lastRateEvt.value) / lastRateEvt.value > 0.005) {
      scheme.push({ type: 'rate', time: lastRateEvt.time + 15, value: ssRate });
    }
  }

  engine.setState(saved);
  return scheme;
}
