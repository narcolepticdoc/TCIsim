/**
 * test-steady-state-predictor.js — Tests for:
 *   1. Analytical steady-state predictor (predictSteadyStateCe, predictTimeToSteadyState)
 *   2. Slope-reversal plateau detector (predictPlateau)
 *   3. Relative-tolerance curve scan for TCI time-to-target
 *
 * Inline copies of math, Eleveld/Fentanyl/Ketamine parameter calculators,
 * the PK engine, and the predictors mirror the CommonJS pattern used by
 * the rest of the test suite.
 */

// ============ INLINE math + engine (compact — mirrors test-decay.js) ============
const N=4;function mat4(){return new Float64Array(16)}function eye4(){const m=mat4();m[0]=m[5]=m[10]=m[15]=1;return m}
function mul4(A,B){const C=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++){let s=0;for(let k=0;k<N;k++)s+=A[i*N+k]*B[k*N+j];C[i*N+j]=s}return C}
function mulVec4(A,x){const y=new Float64Array(4);for(let i=0;i<N;i++){let s=0;for(let j=0;j<N;j++)s+=A[i*N+j]*x[j];y[i]=s}return y}
function add4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]+B[i];return C}
function sub4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]-B[i];return C}
function scale4(A,s){const B=mat4();for(let i=0;i<16;i++)B[i]=A[i]*s;return B}
function inv4(M){const a=new Float64Array(32);for(let i=0;i<N;i++){for(let j=0;j<N;j++)a[i*8+j]=M[i*N+j];a[i*8+(N+i)]=1}for(let col=0;col<N;col++){let mv=Math.abs(a[col*8+col]),mr=col;for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r}}if(mv<1e-15)return null;if(mr!==col)for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t}const p=a[col*8+col];for(let j=0;j<8;j++)a[col*8+j]/=p;for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j]}}const inv=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv}
function expm4(A){const c=[1,1/2,5/44,1/66,1/792,1/15840,1/665280];const nA=(()=>{let mx=0;for(let j=0;j<N;j++){let cs=0;for(let i=0;i<N;i++)cs+=Math.abs(A[i*N+j]);if(cs>mx)mx=cs}return mx})();let s=0;if(nA>0.5){s=Math.ceil(Math.log2(nA/0.5));if(s<0)s=0}const As=(s>0)?scale4(A,1/(1<<s)):A;const As2=mul4(As,As),As3=mul4(As,As2),As4=mul4(As2,As2),As5=mul4(As,As4),As6=mul4(As2,As4);const I=eye4();const powers=[I,As,As2,As3,As4,As5,As6];let Nm=mat4(),Dm=mat4();for(let k=0;k<=6;k++){const sg=(k%2===0)?1:-1;for(let i=0;i<16;i++){Nm[i]+=c[k]*powers[k][i];Dm[i]+=sg*c[k]*powers[k][i]}}const Di=inv4(Dm);if(!Di)return add4(I,A);let result=mul4(Di,Nm);for(let i=0;i<s;i++)result=mul4(result,result);return result}

function sigmoid(x,E50,g){return Math.pow(x,g)/(Math.pow(x,g)+Math.pow(E50,g))}
function fatFreeMass(w,h,a,m){const b=w/Math.pow(h/100,2);if(m)return(.88+(1-.88)/(1+Math.pow(a/13.4,-12.7)))*((9270*w)/(6680+216*b));return(1.11+(1-1.11)/(1+Math.pow(a/7.1,-1.1)))*((9270*w)/(8780+244*b))}
const TH={V1:6.28,V2:25.5,V3:273,CL:1.89,Q2:1.75,Q3:1.11,V2_aging:-0.0156,CL_aging_opioid:-0.00286,V3_aging_opioid:-0.00286,V1_E50_WGT:33.6,CL_female:1.30,CL_mat_PMA50:42.3,CL_mat_hill:9.06,Q3_mat_AGE50:68.3,Q3_mat_hill:1.89,ke0_ref:0.146,ke0_wgt_exp:-0.25};

function calcEleveldParams(pt){const{age:a,weight:w,height:h,male:m,opioid:o}=pt;const bmi=w/Math.pow(h/100,2);const ffm=fatFreeMass(w,h,a,m);const pma=(a*52)+40;const of=o?1:0;const WR=70,AR=35;const V1=TH.V1*(sigmoid(w,TH.V1_E50_WGT,1)/sigmoid(WR,TH.V1_E50_WGT,1));const V2=TH.V2*(w/WR)*Math.exp(TH.V2_aging*(a-AR));const fr=fatFreeMass(WR,170,AR,true);const V3=TH.V3*(ffm/fr)*Math.exp(of*TH.V3_aging_opioid*(a-AR));const cm=sigmoid(pma,TH.CL_mat_PMA50,TH.CL_mat_hill)/sigmoid((AR*52+40),TH.CL_mat_PMA50,TH.CL_mat_hill);const CL=TH.CL*Math.pow(w/WR,0.75)*cm*(m?1:TH.CL_female)*Math.exp(of*TH.CL_aging_opioid*(a-AR));const Q2=TH.Q2*Math.pow(V2/TH.V2,0.75);const q3m=sigmoid(a,TH.Q3_mat_AGE50,TH.Q3_mat_hill)/sigmoid(AR,TH.Q3_mat_AGE50,TH.Q3_mat_hill);const Q3=TH.Q3*Math.pow(V3/TH.V3,0.75)*(m?1:q3m);const ke0=TH.ke0_ref*Math.pow(w/WR,TH.ke0_wgt_exp);return{V1,V2,V3,CL,Q2,Q3,ke0}}

function calcFentanylParams(pt){const{weight:w,height:h}=pt;const bmi=w/Math.pow(h/100,2);const pkm=(w>=85&&bmi>30)?(52/(1+(196.4*Math.exp(-0.025*w)-53.66)/100)):w;const s=pkm/70;return{V1:7.35*s,V2:33.94*s,V3:275.62*s,CL:(36.47/60)*s,Q2:(207.71/60)*s,Q3:(99.22/60)*s,ke0:0.1195}}

function calcKetamineParams(pt){const w=pt.weight;const s=w/70;return{V1:21*s,V2:56*s,V3:195*s,CL:(96/60)*s,Q2:(179.4/60)*s,Q3:(90.36/60)*s,ke0:0.52}}

function buildSysMat(p){const{V1,V2,V3,CL,Q2,Q3,ke0}=p;const A=mat4();A[0]=-(CL+Q2+Q3)/V1;A[1]=Q2/V2;A[2]=Q3/V3;A[4]=Q2/V1;A[5]=-Q2/V2;A[8]=Q3/V1;A[10]=-Q3/V3;A[12]=ke0/V1;A[15]=-ke0;return A}
function createEngine(p){const A=buildSysMat(p);const{V1,V2,V3}=p;let st=new Float64Array(4);function adv(dt,R){if(dt<=0)return;const e=expm4(scale4(A,dt));const xH=mulVec4(e,st);if(R===0){st=xH;return}const Ai=inv4(A);if(!Ai){st=xH;return}const M=mul4(Ai,sub4(e,eye4()));for(let i=0;i<4;i++)st[i]=xH[i]+M[i*4]*R}function gc(){return{Cp:st[0]/V1,C2:st[1]/V2,C3:st[2]/V3,Ce:st[3],A1:st[0],A2:st[1],A3:st[2]}}function getSystemMatrix(){return new Float64Array(A)}function reset(){st=new Float64Array(4)}function getState(){return new Float64Array(st)}function setState(s){st=new Float64Array(s)}return{advance:adv,getConcentrations:gc,getSystemMatrix,reset,getState,setState,get params(){return p}}}

// ============ INLINE PREDICTOR (mirrors js/pk/steady-state-predictor.js) ============

const SS_FRACTION = 0.95;

function predictSteadyStateCe(engine, rate) {
  if (rate <= 0) return null;
  const A = engine.getSystemMatrix();
  const Ainv = inv4(A);
  if (!Ainv) return null;
  const ceSS = -Ainv[3 * 4 + 0] * rate;
  return ceSS > 0 ? ceSS : null;
}

function predictTimeToSteadyState(engine, startState, rate, opts = {}) {
  const ceSS = predictSteadyStateCe(engine, rate);
  if (ceSS === null) return null;
  const STEP    = opts.step    ?? 1;
  const HORIZON = opts.horizon ?? 360;
  const TOL     = 1 - SS_FRACTION;
  const savedState = engine.getState();
  try {
    engine.setState(startState);
    const ce0 = engine.getConcentrations().Ce;
    if (Math.abs(ce0 - ceSS) / ceSS <= TOL) {
      return { ceSS, timeToSsMin: 0, reachable: true };
    }
    for (let i = 1; i <= HORIZON; i++) {
      engine.advance(STEP, rate);
      const ce = engine.getConcentrations().Ce;
      if (Math.abs(ce - ceSS) / ceSS <= TOL) {
        return { ceSS, timeToSsMin: i, reachable: true };
      }
    }
    return { ceSS, timeToSsMin: null, reachable: false };
  } finally {
    engine.setState(savedState);
  }
}

function predictPlateau(engine, startState, rate, slopeTol, opts = {}) {
  if (rate <= 0) return null;
  if (!(slopeTol > 0 && slopeTol < 1)) return null;
  const STEP          = opts.step         ?? 1;
  const HORIZON       = opts.horizon      ?? 360;
  const SUSTAIN       = opts.sustain      ?? 15;
  const EXIT_HORIZON  = opts.exitHorizon  ?? HORIZON;
  const EXIT_BAND_PCT = opts.exitBandPct  ?? 0.05;
  const NN            = HORIZON + EXIT_HORIZON + SUSTAIN;
  const noPlateauResult = {
    plateauCe: null, entryMin: null, exitMin: null,
    bandLow: null, bandHigh: null, noPlateau: true,
  };
  const savedState = engine.getState();
  try {
    engine.setState(startState);
    const ce = new Float64Array(NN + 1);
    ce[0] = engine.getConcentrations().Ce;
    for (let i = 1; i <= NN; i++) {
      engine.advance(STEP, rate);
      ce[i] = engine.getConcentrations().Ce;
    }
    const EPS = 1e-9;
    let entryIdx = -1;
    outer:
    for (let i = 0; i <= HORIZON; i++) {
      for (let k = 0; k < SUSTAIN; k++) {
        const base = Math.max(ce[i + k], EPS);
        const rel  = Math.abs(ce[i + k + 1] - ce[i + k]) / base;
        if (rel >= slopeTol) continue outer;
      }
      entryIdx = i;
      break;
    }
    if (entryIdx < 0) return noPlateauResult;
    const lookback = Math.max(0, entryIdx - SUSTAIN);
    const preDirection  = ce[entryIdx] - ce[lookback];
    const postStart = entryIdx + SUSTAIN;
    let hasReversal = false;
    const DIR_EPS = EPS;
    if (Math.abs(preDirection) > DIR_EPS) {
      const preRising = preDirection > 0;
      for (let j = postStart + 1; j <= Math.min(postStart + EXIT_HORIZON, NN); j++) {
        const delta = ce[j] - ce[postStart];
        if (Math.abs(delta) <= DIR_EPS) continue;
        if ((preRising && delta < -DIR_EPS) || (!preRising && delta > DIR_EPS)) {
          hasReversal = true;
          break;
        }
      }
    }
    if (!hasReversal) return noPlateauResult;
    const pCe     = ce[entryIdx];
    const bandLow  = pCe * (1 - EXIT_BAND_PCT);
    const bandHigh = pCe * (1 + EXIT_BAND_PCT);
    let exitIdx = -1;
    for (let j = entryIdx + SUSTAIN; j <= NN; j++) {
      if (ce[j] < bandLow || ce[j] > bandHigh) { exitIdx = j; break; }
    }
    return {
      plateauCe: pCe, entryMin: entryIdx, exitMin: exitIdx >= 0 ? exitIdx : null,
      bandLow, bandHigh, noPlateau: false,
    };
  } finally {
    engine.setState(savedState);
  }
}

// Mirror of drug-panel.js: relative-tolerance curve scan for TCI "time to target".
function estimateTimeToTarget(curve, t, Ce, ceTarget, fraction) {
  if (!curve) return null;
  if (!(ceTarget > 0)) return null;
  const tol = (1 - fraction) * ceTarget;
  const approaching = Ce < ceTarget;
  for (const pt of curve) {
    if (pt.time <= t) continue;
    if (approaching  && pt.Ce >= ceTarget - tol) return pt.time - t;
    if (!approaching && pt.Ce <= ceTarget + tol) return pt.time - t;
  }
  return null;
}

// ============ TEST HARNESS ============
let passed = 0, failed = 0;
function assert(c, m) {
  if (c) { passed++; console.log('  \u2713 ' + m); }
  else   { failed++; console.error('  \u2717 ' + m); }
}

const patient = { age: 35, weight: 70, height: 170, male: true, opioid: false };
const propParams = calcEleveldParams(patient);

// Test tolerance levels (per-minute relative slope).
const TOL_STRICTEST = 0.0002;
const TOL_STRICT    = 0.0006;
const TOL_STD       = 0.0010;
const TOL_LOOSE     = 0.0014;
const TOL_LOOSEST   = 0.0018;

// ============ ANALYTICAL STEADY STATE TESTS ============

console.log('\n=== TEST 1: Propofol Ce_ss analytical computation (regression lock) ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  const ceSS = predictSteadyStateCe(eng, rate);
  assert(ceSS !== null, 'Ce_ss computed');
  assert(Math.abs(ceSS - 2.857143) < 1e-4,
    `Ce_ss = 2.857143 (got ${ceSS.toFixed(6)})`);

  // Ce_ss should equal Cp_ss at true steady state
  const A = eng.getSystemMatrix();
  const Ainv = inv4(A);
  const cpSS = (-Ainv[0] * rate) / propParams.V1;
  assert(Math.abs(ceSS - cpSS) < 1e-10,
    `Ce_ss equals Cp_ss (diff ${Math.abs(ceSS - cpSS).toExponential(2)})`);
}

console.log('\n=== TEST 2: Propofol time to 95% of Ce_ss from zero (not reachable in 6h) ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  const result = predictTimeToSteadyState(eng, eng.getState(), rate);
  assert(result !== null, 'Result returned');
  assert(result.reachable === false,
    'Not reachable within 6h (propofol V3 time constant too slow)');
  assert(Math.abs(result.ceSS - 2.857143) < 1e-4,
    `ceSS reported correctly (${result.ceSS.toFixed(6)})`);
  assert(result.timeToSsMin === null,
    'timeToSsMin is null when not reachable');
}

console.log('\n=== TEST 3: Propofol with extended horizon reaches 95% ===');
{
  const eng = createEngine(propParams);
  const result = predictTimeToSteadyState(eng, eng.getState(), 5.4, { horizon: 1000 });
  assert(result !== null && result.reachable === true,
    'Reachable within 1000 min');
  assert(result.timeToSsMin === 824,
    `Time to 95% = 824 min (got ${result.timeToSsMin})`);
}

console.log('\n=== TEST 4: Pre-advanced state (at SS) → timeToSsMin = 0 ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  eng.advance(2000, rate);   // 33+ hours — well past SS
  const deepState = eng.getState();
  const result = predictTimeToSteadyState(eng, deepState, rate);
  assert(result !== null && result.reachable === true, 'Reachable');
  assert(result.timeToSsMin === 0,
    `Already at SS → timeToSsMin = 0 (got ${result.timeToSsMin})`);
}

console.log('\n=== TEST 5: Fentanyl Ce_ss analytical computation ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  const rate = 0.1 / 60;   // 100 mcg/h
  const ceSS = predictSteadyStateCe(eng, rate);
  assert(ceSS !== null, 'Ce_ss computed');
  assert(ceSS > 0.002 && ceSS < 0.003,
    `Fentanyl Ce_ss in expected ng-scale range (${ceSS.toExponential(3)} mcg/mL)`);
}

console.log('\n=== TEST 6: Ketamine Ce_ss analytical computation ===');
{
  const ketParams = calcKetamineParams({ weight: 70 });
  const eng = createEngine(ketParams);
  const rate = 1.5;
  const ceSS = predictSteadyStateCe(eng, rate);
  assert(ceSS !== null, 'Ce_ss computed');
  assert(Math.abs(ceSS - 0.9375) < 1e-4,
    `Ketamine Ce_ss = 0.9375 (got ${ceSS.toFixed(4)})`);
}

console.log('\n=== TEST 7: Rate ≤ 0 returns null ===');
{
  const eng = createEngine(propParams);
  assert(predictSteadyStateCe(eng, 0) === null, 'Rate = 0 → null');
  assert(predictSteadyStateCe(eng, -1) === null, 'Rate < 0 → null');
  assert(predictTimeToSteadyState(eng, eng.getState(), 0) === null, 'TimeToSS rate=0 → null');
}

console.log('\n=== TEST 8: Engine state restoration (analytical SS) ===');
{
  const eng = createEngine(propParams);
  eng.advance(7, 5.4);
  const beforeState = eng.getState();
  predictTimeToSteadyState(eng, eng.getState(), 5.4);
  const afterState = eng.getState();
  let identical = true;
  for (let i = 0; i < 4; i++) if (beforeState[i] !== afterState[i]) identical = false;
  assert(identical, 'Engine state byte-identical after predictTimeToSteadyState');
}

// ============ PLATEAU (SLOPE REVERSAL) TESTS ============

console.log('\n=== TEST 9: Propofol from zero — NO plateau (monotonic rise, no reversal) ===');
{
  const eng = createEngine(propParams);
  const result = predictPlateau(eng, eng.getState(), 5.4, TOL_STD);
  assert(result !== null, 'Result returned');
  assert(result.noPlateau === true,
    'Propofol from zero has no plateau (monotonic rise to SS)');
  assert(result.plateauCe === null, 'plateauCe is null');
  assert(result.entryMin === null, 'entryMin is null');
}

console.log('\n=== TEST 10: Fentanyl bolus + infusion — local plateau with reversal ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  eng.advance(0.5, 0.1 / 0.5);   // 100 mcg bolus over 30 sec
  eng.advance(5, 0);              // 5 min gap
  const state = eng.getState();
  const rate = 0.1 / 60;          // 100 mcg/h

  const result = predictPlateau(eng, state, rate, TOL_LOOSEST);
  assert(result !== null && result.noPlateau === false,
    'Plateau found (slope reversal: falling → rising)');
  assert(result.entryMin === 40,
    `Entry at 40 min (got ${result.entryMin})`);
  assert(result.exitMin === 98,
    `Exit at 98 min (got ${result.exitMin})`);
  assert(result.bandLow < result.bandHigh,
    'Non-degenerate band');
}

console.log('\n=== TEST 11: Post-bolus propofol → plateau found ===');
{
  const eng = createEngine(propParams);
  eng.advance(0.5, 80 / 0.5);   // 80 mg loading bolus
  const postBolusState = eng.getState();
  const mainRate = 1.5;

  // At TOL_STD, the Ce curve peaks from the bolus, declines, hits a local
  // flat (post-bolus decline balances maintenance fill), then resumes
  // approach to steady state.
  const result = predictPlateau(eng, postBolusState, mainRate, TOL_STD);
  assert(result !== null && result.noPlateau === false,
    'Post-bolus propofol has a local plateau (overshoot → flat → reversal)');
  assert(result.entryMin === 59,
    `Entry at 59 min (got ${result.entryMin})`);
}

console.log('\n=== TEST 12: Rate lowered from high — falling → flat → reversal ===');
{
  const eng = createEngine(propParams);
  eng.advance(0.05, 150 / 0.05);  // loading bolus
  eng.advance(30, 10.0);          // 30 min at high rate
  const highState = eng.getState();
  const startCe = eng.getConcentrations().Ce;
  const lowRate = 2.0;

  const result = predictPlateau(eng, highState, lowRate, TOL_STD);
  assert(result !== null && result.noPlateau === false,
    'Plateau found after rate lowered');
  assert(result.plateauCe < startCe,
    `plateauCe (${result.plateauCe.toFixed(3)}) < startCe (${startCe.toFixed(3)})`);
  assert(result.entryMin === 87,
    `Rate-lowered entry at 87 min (got ${result.entryMin})`);
}

console.log('\n=== TEST 13: Plateau detection — bad input returns null ===');
{
  const eng = createEngine(propParams);
  assert(predictPlateau(eng, eng.getState(), 0, TOL_STD) === null, 'Rate = 0 → null');
  assert(predictPlateau(eng, eng.getState(), -1, TOL_STD) === null, 'Rate < 0 → null');
  assert(predictPlateau(eng, eng.getState(), 5.4, 0) === null, 'slopeTol = 0 → null');
  assert(predictPlateau(eng, eng.getState(), 5.4, 1) === null, 'slopeTol = 1 → null');
}

console.log('\n=== TEST 14: Engine state restoration (plateau) ===');
{
  const eng = createEngine(propParams);
  eng.advance(7, 5.4);
  const beforeState = eng.getState();
  predictPlateau(eng, eng.getState(), 5.4, TOL_STD);
  const afterState = eng.getState();
  let identical = true;
  for (let i = 0; i < 4; i++) if (beforeState[i] !== afterState[i]) identical = false;
  assert(identical, 'Engine state byte-identical after predictPlateau');
}

console.log('\n=== TEST 15: Fentanyl from zero — no plateau at default threshold ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  const result = predictPlateau(eng, eng.getState(), 0.0018, TOL_STD);
  assert(result !== null, 'Result returned');
  assert(result.noPlateau === true,
    'Fentanyl from zero at default threshold: no plateau (no reversal)');
}

console.log('\n=== TEST 16: Ketamine from zero — no plateau (monotonic rise) ===');
{
  const ketParams = calcKetamineParams({ weight: 70 });
  const eng = createEngine(ketParams);
  const result = predictPlateau(eng, eng.getState(), 1.5, TOL_STD);
  assert(result !== null && result.noPlateau === true,
    'Ketamine from zero: no plateau (monotonic rise)');
}

console.log('\n=== TEST 17: Exit band width monotonicity — wider band → later exit ===');
{
  // Use fentanyl bolus + infusion which has a real plateau with reversal
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  eng.advance(0.5, 0.1 / 0.5);
  eng.advance(5, 0);
  const state = eng.getState();
  const rate = 0.1 / 60;

  const r2  = predictPlateau(eng, state, rate, TOL_LOOSEST, { exitBandPct: 0.02 });
  const r5  = predictPlateau(eng, state, rate, TOL_LOOSEST, { exitBandPct: 0.05 });
  const r10 = predictPlateau(eng, state, rate, TOL_LOOSEST, { exitBandPct: 0.10 });

  assert(!r2.noPlateau && !r5.noPlateau && !r10.noPlateau,
    'All three have plateaus');
  assert(r2.exitMin < r5.exitMin && r5.exitMin < r10.exitMin,
    `Wider band → later exit: ±2%=${r2.exitMin}, ±5%=${r5.exitMin}, ±10%=${r10.exitMin}`);
  // Entry time unchanged (slope-based, not affected by band)
  assert(r2.entryMin === r5.entryMin && r5.entryMin === r10.entryMin,
    'Entry time independent of exit band');
}

console.log('\n=== TEST 18: Band bounds are exactly ±exitBandPct of plateauCe ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  eng.advance(0.5, 0.1 / 0.5);
  eng.advance(5, 0);
  const state = eng.getState();
  const result = predictPlateau(eng, state, 0.1/60, TOL_LOOSEST);
  assert(!result.noPlateau, 'Plateau found');
  assert(Math.abs(result.bandLow - result.plateauCe * 0.95) < 1e-15,
    'bandLow = plateauCe × 0.95');
  assert(Math.abs(result.bandHigh - result.plateauCe * 1.05) < 1e-15,
    'bandHigh = plateauCe × 1.05');
}

console.log('\n=== TEST 19: Both predictors agree on propofol from zero (no plateau, SS exists) ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  const state = eng.getState();

  const ss = predictTimeToSteadyState(eng, state, rate);
  const plat = predictPlateau(eng, state, rate, TOL_STD);

  assert(ss !== null && ss.ceSS > 0, 'SS exists');
  assert(ss.reachable === false, 'SS not reachable in 6h');
  assert(plat !== null && plat.noPlateau === true, 'No plateau (monotonic)');
  // Both predictors should agree: this is a monotonic approach to SS
}

// ============ TCI TIME-TO-TARGET TESTS ============

console.log('\n=== TEST 20: Propofol TCI tolerance at default 95% ===');
{
  const curve = [];
  for (let t = 0; t <= 20; t += 0.5) curve.push({ time: t, Ce: 3.5 * (t / 20) });
  const target = 3.0;
  const dt = estimateTimeToTarget(curve, 0, 0, target, 0.95);
  assert(dt !== null, 'Result returned');
  assert(Math.abs(dt - 16.5) < 1e-6, `First crossing at t = 16.5 (got ${dt})`);
}

console.log('\n=== TEST 21: Fentanyl-scale target does not latch at sample 0 ===');
{
  const curve = [];
  for (let t = 0; t <= 30; t += 0.5) {
    curve.push({ time: t, Ce: 0.0001 + (0.005 - 0.0001) * (t / 30) });
  }
  const target = 0.003;
  const dt = estimateTimeToTarget(curve, 0, 0.0001, target, 0.95);
  assert(dt !== null, 'Result returned');
  assert(dt > 0, `Does not latch at sample 0 (dt = ${dt})`);
  assert(Math.abs(dt - 17.0) < 1e-6, `First crossing at t ≈ 17.0 (got ${dt})`);
}

console.log('\n=== TEST 22: Approach from above (Ce > target) ===');
{
  const curve = [];
  for (let t = 0; t <= 30; t += 0.5) {
    curve.push({ time: t, Ce: 5.0 - (5.0 - 2.9) * (t / 30) });
  }
  const target = 3.0;
  const dt = estimateTimeToTarget(curve, 0, 5.0, target, 0.95);
  assert(dt !== null, 'Result returned');
  assert(Math.abs(dt - 26.5) < 1e-6, `First crossing from above at t ≈ 26.5 (got ${dt})`);
}

console.log('\n=== TEST 23: TCI fraction monotonicity ===');
{
  const curve = [];
  for (let t = 0; t <= 40; t += 0.5) curve.push({ time: t, Ce: 4.0 * (t / 40) });
  const target = 3.0;
  const t90 = estimateTimeToTarget(curve, 0, 0, target, 0.90);
  const t95 = estimateTimeToTarget(curve, 0, 0, target, 0.95);
  const t99 = estimateTimeToTarget(curve, 0, 0, target, 0.99);
  assert(t90 <= t95, `t(0.90)=${t90} ≤ t(0.95)=${t95}`);
  assert(t95 <= t99, `t(0.95)=${t95} ≤ t(0.99)=${t99}`);
  assert(t90 > 0 && t99 > 0, 'All crossings positive');
}

// ============ SUMMARY ============
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
