/**
 * test-steady-state-predictor.js — Tests for the slope-based plateau
 * detector used by the manual-mode SS label, and for the
 * relative-tolerance curve scan used by the TCI time-to-target label.
 *
 * Inline copies of math, Eleveld/Fentanyl parameter calculators, the
 * PK engine, and the predictor mirror the CommonJS pattern used by
 * the rest of the test suite (test-decay.js, test-pk.js).
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

// Fentanyl (Shafer 1990, per js/pk/fentanyl.js — ng-scale Ce)
function calcFentanylParams(pt){const{weight:w,height:h}=pt;const bmi=w/Math.pow(h/100,2);const pkm=(w>=85&&bmi>30)?(52/(1+(196.4*Math.exp(-0.025*w)-53.66)/100)):w;const s=pkm/70;return{V1:7.35*s,V2:33.94*s,V3:275.62*s,CL:(36.47/60)*s,Q2:(207.71/60)*s,Q3:(99.22/60)*s,ke0:0.1195}}

// Ketamine (per js/pk/ketamine.js — Domino weight-scaled)
function calcKetamineParams(pt){const w=pt.weight;const s=w/70;return{V1:21*s,V2:56*s,V3:195*s,CL:(96/60)*s,Q2:(179.4/60)*s,Q3:(90.36/60)*s,ke0:0.52}}

function buildSysMat(p){const{V1,V2,V3,CL,Q2,Q3,ke0}=p;const A=mat4();A[0]=-(CL+Q2+Q3)/V1;A[1]=Q2/V2;A[2]=Q3/V3;A[4]=Q2/V1;A[5]=-Q2/V2;A[8]=Q3/V1;A[10]=-Q3/V3;A[12]=ke0/V1;A[15]=-ke0;return A}
function createEngine(p){const A=buildSysMat(p);const{V1,V2,V3}=p;let st=new Float64Array(4);function adv(dt,R){if(dt<=0)return;const e=expm4(scale4(A,dt));const xH=mulVec4(e,st);if(R===0){st=xH;return}const Ai=inv4(A);if(!Ai){st=xH;return}const M=mul4(Ai,sub4(e,eye4()));for(let i=0;i<4;i++)st[i]=xH[i]+M[i*4]*R}function gc(){return{Cp:st[0]/V1,C2:st[1]/V2,C3:st[2]/V3,Ce:st[3],A1:st[0],A2:st[1],A3:st[2]}}function reset(){st=new Float64Array(4)}function getState(){return new Float64Array(st)}function setState(s){st=new Float64Array(s)}return{advance:adv,getConcentrations:gc,reset,getState,setState,get params(){return p}}}

// ============ INLINE PREDICTOR (mirror of js/pk/steady-state-predictor.js) ============
function predictSteadyState(engine, startState, startTime, rate, slopeTol, opts = {}) {
  if (rate <= 0) return null;
  if (!(slopeTol > 0 && slopeTol < 1)) return null;

  const STEP          = opts.step         ?? 1;
  const HORIZON       = opts.horizon      ?? 360;
  const SUSTAIN       = opts.sustain      ?? 15;
  const EXIT_HORIZON  = opts.exitHorizon  ?? HORIZON;
  const EXIT_BAND_PCT = opts.exitBandPct  ?? 0.05;
  const N             = HORIZON + EXIT_HORIZON + SUSTAIN;

  const savedState = engine.getState();
  try {
    engine.setState(startState);
    const ce = new Float64Array(N + 1);
    ce[0] = engine.getConcentrations().Ce;
    for (let i = 1; i <= N; i++) {
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

    if (entryIdx < 0) {
      return {
        plateauCe: null, timeToSsMin: null, exitMin: null,
        bandLow: null, bandHigh: null, noSteadyState: true,
      };
    }

    const pCe     = ce[entryIdx];
    const bandLow  = pCe * (1 - EXIT_BAND_PCT);
    const bandHigh = pCe * (1 + EXIT_BAND_PCT);
    let exitIdx = -1;
    for (let j = entryIdx + SUSTAIN; j <= N; j++) {
      if (ce[j] < bandLow || ce[j] > bandHigh) {
        exitIdx = j;
        break;
      }
    }

    return {
      plateauCe:   pCe,
      timeToSsMin: entryIdx,
      exitMin:     exitIdx >= 0 ? exitIdx : null,
      bandLow,
      bandHigh,
      noSteadyState: false,
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

// Test tolerance levels (per-minute relative slope). Default is TOL_STD.
const TOL_STRICTEST = 0.0002;
const TOL_STRICT    = 0.0006;
const TOL_STD       = 0.0010;
const TOL_LOOSE     = 0.0014;
const TOL_LOOSEST   = 0.0018;

console.log('\n=== TEST 1: Propofol from zero at default 0.10 %/min (regression lock) ===');
{
  const eng = createEngine(propParams);
  const state = eng.getState();
  const rate = 5.4;   // ~324 mg/h — typical maintenance for 70 kg adult
  const result = predictSteadyState(eng, state, 0, rate, TOL_STD);
  assert(result !== null, 'Result returned');
  assert(result.noSteadyState === false, 'Plateau found within 6h at default threshold');
  assert(result.timeToSsMin === 146, `timeToSsMin = 146 (got ${result.timeToSsMin})`);
  assert(Math.abs(result.plateauCe - 2.068589) < 1e-4,
    `plateauCe ≈ 2.069 mcg/mL (got ${result.plateauCe.toFixed(6)})`);
  assert(result.exitMin === 201, `Propofol exit at 201 min with ±5% band (got ${result.exitMin})`);
  assert(result.bandLow < result.plateauCe,
    `bandLow (${result.bandLow.toFixed(4)}) < plateauCe`);
  assert(result.bandHigh > result.plateauCe,
    `bandHigh (${result.bandHigh.toFixed(4)}) > plateauCe`);
}

console.log('\n=== TEST 2: Propofol from zero at strictest 0.02 %/min → noSteadyState ===');
{
  const eng = createEngine(propParams);
  const state = eng.getState();
  const rate = 5.4;
  const result = predictSteadyState(eng, state, 0, rate, TOL_STRICTEST);
  assert(result !== null, 'Result returned (not null)');
  assert(result.noSteadyState === true, 'noSteadyState is true at strictest threshold');
  assert(result.plateauCe === null && result.timeToSsMin === null,
    'plateauCe and timeToSsMin are null when no plateau');
  assert(result.exitMin === null, 'exitMin is null when noSteadyState');
  assert(result.bandLow === null && result.bandHigh === null,
    'bandLow/High are null when noSteadyState');
}

console.log('\n=== TEST 3: Fentanyl — slow PK reflected in thresholds ===');
{
  // Fentanyl's slow V3 makes it harder to flatten than propofol at the
  // same nominal threshold. At default 0.10 %/min → noSteadyState. At
  // 0.18 %/min → plateau found. The predictor is drug-agnostic: it just
  // reports what the Ce curve does.
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  const state = eng.getState();

  const rDefault = predictSteadyState(eng, state, 0, 0.0018, TOL_STD);
  assert(rDefault.noSteadyState === true,
    'Fentanyl at default 0.10 %/min: noSteadyState within 6h');

  const rLoosest = predictSteadyState(eng, state, 0, 0.0018, TOL_LOOSEST);
  assert(rLoosest.noSteadyState === false,
    'Fentanyl at 0.18 %/min: plateau found');
  assert(rLoosest.plateauCe > 0 && rLoosest.plateauCe < 0.02,
    `Fentanyl plateauCe in ng-scale range (${rLoosest.plateauCe.toExponential(2)} mcg/mL)`);
  assert(rLoosest.timeToSsMin === 239,
    `Fentanyl 0.18 %/min timeToSsMin = 239 (got ${rLoosest.timeToSsMin})`);
  assert(rLoosest.exitMin === 268,
    `Fentanyl from-zero exit at 268 min with ±5% band (got ${rLoosest.exitMin})`);
}

console.log('\n=== TEST 4: Ketamine from zero at default 0.10 %/min ===');
{
  const ketParams = calcKetamineParams(patient);
  const eng = createEngine(ketParams);
  const state = eng.getState();
  const result = predictSteadyState(eng, state, 0, 1.5, TOL_STD);
  assert(result !== null && result.noSteadyState === false,
    'Ketamine plateau found within 6h at default threshold');
  assert(result.timeToSsMin === 276,
    `Ketamine timeToSsMin = 276 (got ${result.timeToSsMin})`);
  assert(result.plateauCe > 0,
    `Ketamine plateauCe > 0 (got ${result.plateauCe.toFixed(3)})`);
}

console.log('\n=== TEST 5: Primed state reaches plateau faster than zero start ===');
{
  const eng = createEngine(propParams);
  const zeroState = eng.getState();
  const rate = 5.4;
  // Use TOL_STRICT — at TOL_STD the primed state is already flat (timeToSsMin=0)
  // so we wouldn't see any "faster" signal. At TOL_STRICT, from-zero takes 288 min
  // and primed takes 88 min — a clear 200-min advantage.
  const fromZero = predictSteadyState(eng, zeroState, 0, rate, TOL_STRICT);

  eng.setState(zeroState);
  eng.advance(200, rate);   // 200 min of prior infusion
  const primedState = eng.getState();
  const fromPrimed = predictSteadyState(eng, primedState, 200, rate, TOL_STRICT);

  assert(fromZero.timeToSsMin === 288 && fromPrimed.timeToSsMin === 88,
    `from-zero=288, from-primed=88 (got ${fromZero.timeToSsMin}, ${fromPrimed.timeToSsMin})`);
  assert(fromPrimed.timeToSsMin < fromZero.timeToSsMin - 150,
    'Primed state reaches plateau >150 min faster');
}

console.log('\n=== TEST 6: Post-bolus overshoot — 15-min sustain window bridges transient ===');
{
  const eng = createEngine(propParams);

  // 80 mg loading bolus over 30 sec: Cp spikes high, Ce lags and rises.
  eng.advance(0.5, 80 / 0.5);
  const postBolusState = eng.getState();

  // Low maintenance rate — asymptote is far below the Cp transient peak.
  // The Ce curve rises from ~0.4, overshoots maintenance asymptote briefly
  // (tracking Cp), then decays. The 15-min sustain window must not trigger
  // inside the transient.
  const mainRate = 1.5;
  const result = predictSteadyState(eng, postBolusState, 0.5, mainRate, TOL_STD);
  assert(result !== null && result.noSteadyState === false,
    'Plateau found despite post-bolus overshoot');
  assert(result.timeToSsMin === 59,
    `Post-bolus timeToSsMin = 59 (got ${result.timeToSsMin})`);

  // The plateau must be stable: verify the per-minute slope stays below TOL_STD
  // for the full 15-min sustain window past timeToSsMin (already guaranteed by
  // the algorithm, but worth a direct check).
  eng.setState(postBolusState);
  eng.advance(result.timeToSsMin, mainRate);
  let prev = eng.getConcentrations().Ce;
  let maxSlope = 0;
  for (let k = 0; k < 15; k++) {
    eng.advance(1, mainRate);
    const cur = eng.getConcentrations().Ce;
    const slope = Math.abs(cur - prev) / Math.max(prev, 1e-9);
    if (slope > maxSlope) maxSlope = slope;
    prev = cur;
  }
  assert(maxSlope < TOL_STD,
    `Slope stays < 0.10 %/min for 15 min post-arrival (max ${(maxSlope*100).toFixed(4)} %/min)`);
}

console.log('\n=== TEST 7: Already flat (pre-advanced 10h) → timeToSsMin === 0 ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  eng.advance(600, rate);   // 10 h — well past propofol's fast transients
  const deepState = eng.getState();
  const result = predictSteadyState(eng, deepState, 600, rate, TOL_STD);
  assert(result !== null && result.noSteadyState === false, 'Result returned');
  assert(result.timeToSsMin === 0,
    `timeToSsMin === 0 when already flat (got ${result.timeToSsMin})`);
}

console.log('\n=== TEST 8: Rate ≤ 0 or bad input returns null ===');
{
  const eng = createEngine(propParams);
  assert(predictSteadyState(eng, eng.getState(), 0, 0,  TOL_STD) === null, 'Rate = 0 returns null');
  assert(predictSteadyState(eng, eng.getState(), 0, -1, TOL_STD) === null, 'Negative rate returns null');
  assert(predictSteadyState(eng, eng.getState(), 0, 5.4, 0)   === null, 'slopeTol = 0 returns null');
  assert(predictSteadyState(eng, eng.getState(), 0, 5.4, 1)   === null, 'slopeTol = 1 returns null');
}

console.log('\n=== TEST 9: Engine state restoration (byte-identical) ===');
{
  const eng = createEngine(propParams);
  eng.advance(7, 5.4);   // non-trivial prior state
  const beforeState = eng.getState();
  const startStateCopy = eng.getState();
  predictSteadyState(eng, startStateCopy, 7, 5.4, TOL_STD);
  const afterState = eng.getState();
  let identical = true;
  for (let i = 0; i < 4; i++) if (beforeState[i] !== afterState[i]) identical = false;
  assert(identical, 'Engine state is byte-identical before and after predict call');
}

console.log('\n=== TEST 10: Threshold monotonicity (looser → earlier plateau) ===');
{
  const eng = createEngine(propParams);
  const state = eng.getState();
  const rate = 5.4;
  const rLoosest  = predictSteadyState(eng, state, 0, rate, TOL_LOOSEST);
  const rLoose    = predictSteadyState(eng, state, 0, rate, TOL_LOOSE);
  const rStd      = predictSteadyState(eng, state, 0, rate, TOL_STD);
  const rStrict   = predictSteadyState(eng, state, 0, rate, TOL_STRICT);
  const rStrictest = predictSteadyState(eng, state, 0, rate, TOL_STRICTEST);

  // All finite results must be monotone non-decreasing as threshold tightens;
  // tightest can flip to noSteadyState.
  assert(rLoosest.timeToSsMin <= rLoose.timeToSsMin,
    `loosest=${rLoosest.timeToSsMin} ≤ loose=${rLoose.timeToSsMin}`);
  assert(rLoose.timeToSsMin <= rStd.timeToSsMin,
    `loose=${rLoose.timeToSsMin} ≤ std=${rStd.timeToSsMin}`);
  assert(rStd.timeToSsMin <= rStrict.timeToSsMin,
    `std=${rStd.timeToSsMin} ≤ strict=${rStrict.timeToSsMin}`);
  assert(rStrictest.noSteadyState === true,
    'strictest threshold flips to noSteadyState');
}

console.log('\n=== TEST 11: Rate lowered from high — plateauCe < startCe ===');
{
  const eng = createEngine(propParams);

  // Prime the engine at a high rate: brief loading bolus + sustained high rate.
  eng.advance(0.05, 150 / 0.05);   // ~150 mg bolus (5 mg/min for 30 sec equivalent)
  eng.advance(30, 10.0);           // 30 min at 10 mg/min
  const highState = eng.getState();
  const startCe = eng.getConcentrations().Ce;

  // Now predict under a much lower maintenance rate.
  const lowRate = 2.0;
  const result = predictSteadyState(eng, highState, 30, lowRate, TOL_STD);
  assert(result !== null && result.noSteadyState === false, 'Result returned');
  assert(result.plateauCe < startCe,
    `plateauCe (${result.plateauCe.toFixed(3)}) < startCe (${startCe.toFixed(3)})`);
  assert(result.timeToSsMin === 87,
    `Rate-lowered timeToSsMin = 87 (got ${result.timeToSsMin})`);
}

// ============ PLATEAU EXIT DETECTION TESTS ============

console.log('\n=== TEST 12: Fentanyl bolus + infusion — local plateau with exit ===');
{
  // 100 mcg bolus (0.1 mg over 30 sec), 5 min gap, then 100 mcg/h maintenance.
  // Creates a local plateau where post-bolus Ce decline balances V3 fill,
  // followed by exit as V3 equilibration dominates.
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  eng.advance(0.5, 0.1 / 0.5);   // bolus
  eng.advance(5, 0);              // 5 min gap
  const state = eng.getState();
  const rate = 0.1 / 60;          // 100 mcg/h = 0.001667 mg/min
  const result = predictSteadyState(eng, state, 5.5, rate, TOL_LOOSEST);
  assert(result !== null && result.noSteadyState === false,
    'Local plateau found for fentanyl bolus + infusion');
  assert(result.timeToSsMin === 40,
    `Entry at 40 min (got ${result.timeToSsMin})`);
  assert(result.exitMin === 98,
    `Exit at 98 min with ±5% band (got ${result.exitMin})`);
  assert(result.bandLow < result.bandHigh,
    `Non-degenerate band: bandLow (${result.bandLow.toExponential(3)}) < bandHigh (${result.bandHigh.toExponential(3)})`);
}

console.log('\n=== TEST 13: band bounds for propofol plateau ===');
{
  const eng = createEngine(propParams);
  const result = predictSteadyState(eng, eng.getState(), 0, 5.4, TOL_STD);
  assert(result.bandLow < result.plateauCe,
    `bandLow (${result.bandLow.toFixed(4)}) < plateauCe (${result.plateauCe.toFixed(4)})`);
  assert(result.bandHigh > result.plateauCe,
    `bandHigh (${result.bandHigh.toFixed(4)}) > plateauCe (${result.plateauCe.toFixed(4)})`);
  assert(result.bandLow > 0 && result.bandHigh > 0,
    'bandLow and bandHigh are positive');
  // Verify band is exactly ±5% of plateauCe
  assert(Math.abs(result.bandLow - result.plateauCe * 0.95) < 1e-9,
    'bandLow = plateauCe × 0.95');
  assert(Math.abs(result.bandHigh - result.plateauCe * 1.05) < 1e-9,
    'bandHigh = plateauCe × 1.05');
}

console.log('\n=== TEST 14b: Exit band width monotonicity — wider band → later exit ===');
{
  const eng = createEngine(propParams);
  const state = eng.getState();
  const r2 = predictSteadyState(eng, state, 0, 5.4, TOL_STD, { exitBandPct: 0.02 });
  const r5 = predictSteadyState(eng, state, 0, 5.4, TOL_STD, { exitBandPct: 0.05 });
  const r10 = predictSteadyState(eng, state, 0, 5.4, TOL_STD, { exitBandPct: 0.10 });
  assert(r2.exitMin === 167, `±2% band exit at 167 (got ${r2.exitMin})`);
  assert(r5.exitMin === 201, `±5% band exit at 201 (got ${r5.exitMin})`);
  assert(r10.exitMin === 266, `±10% band exit at 266 (got ${r10.exitMin})`);
  assert(r2.exitMin < r5.exitMin && r5.exitMin < r10.exitMin,
    'Wider band → later exit');
  // Entry time unchanged (slope-based, not affected by band)
  assert(r2.timeToSsMin === r5.timeToSsMin && r5.timeToSsMin === r10.timeToSsMin,
    'Entry time independent of exit band');
}

// ============ TCI TIME-TO-TARGET TESTS ============

console.log('\n=== TEST 14: Propofol TCI tolerance at default 95% ===');
{
  // Synthetic propofol-scale curve: Ce rises linearly from 0 at t=0 to 3.5
  // at t=20 min, in 0.5-min samples.
  const curve = [];
  for (let t = 0; t <= 20; t += 0.5) curve.push({ time: t, Ce: 3.5 * (t / 20) });
  const target = 3.0;
  const dt = estimateTimeToTarget(curve, 0, 0, target, 0.95);

  // Band is 5% of 3 = 0.15, so threshold Ce = 2.85. First sample with Ce >= 2.85
  // is at t such that 3.5 * (t/20) >= 2.85 → t >= 16.285... → nearest 0.5-min
  // sample is t = 16.5.
  assert(dt !== null, 'Result returned');
  assert(Math.abs(dt - 16.5) < 1e-6, `First crossing at t = 16.5 (got ${dt})`);
}

console.log('\n=== TEST 15: Fentanyl-scale target does not latch at sample 0 ===');
{
  // Fentanyl-scale: target 0.003 mcg/mL (3 ng/mL), curve starts at 0.0001
  // and rises to 0.005. Old 0.05 mcg/mL absolute tolerance would latch at
  // sample 0 (0.0001 ≥ 0.003 − 0.05 = −0.047). New relative tolerance must
  // not.
  const curve = [];
  for (let t = 0; t <= 30; t += 0.5) {
    curve.push({ time: t, Ce: 0.0001 + (0.005 - 0.0001) * (t / 30) });
  }
  const target = 0.003;
  const dt = estimateTimeToTarget(curve, 0, 0.0001, target, 0.95);
  assert(dt !== null, 'Result returned');
  assert(dt > 0, `Does not latch at sample 0 (dt = ${dt})`);
  // Band = 5% of 0.003 = 0.00015. Target - band = 0.00285. First sample where
  // Ce >= 0.00285: 0.00285 = 0.0001 + 0.0049 * (t/30) → t/30 = 0.5612 → t ≈ 16.84 → next 0.5 sample = 17.0.
  assert(Math.abs(dt - 17.0) < 1e-6, `First crossing at t ≈ 17.0 (got ${dt})`);
}

console.log('\n=== TEST 16: Approach from above (Ce > target) ===');
{
  // Curve starts at 5.0 and decays linearly to 2.9 over 30 min.
  const curve = [];
  for (let t = 0; t <= 30; t += 0.5) {
    curve.push({ time: t, Ce: 5.0 - (5.0 - 2.9) * (t / 30) });
  }
  const target = 3.0;
  const dt = estimateTimeToTarget(curve, 0, 5.0, target, 0.95);
  // Band = 0.15. Threshold (from above) = target + band = 3.15.
  // First sample where Ce <= 3.15: 3.15 = 5.0 - 2.1 * (t/30) → t/30 = 0.881 → t ≈ 26.43 → next 0.5 sample = 26.5.
  assert(dt !== null, 'Result returned');
  assert(Math.abs(dt - 26.5) < 1e-6, `First crossing from above at t ≈ 26.5 (got ${dt})`);
}

console.log('\n=== TEST 17: TCI fraction monotonicity ===');
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