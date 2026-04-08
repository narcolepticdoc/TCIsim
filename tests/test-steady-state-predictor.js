/**
 * test-steady-state-predictor.js — Tests for the asymptote-fraction
 * steady-state predictor used by the manual-mode SS label and (via
 * _estimateTimeToTarget) the TCI time-to-target label.
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
function predictSteadyState(engine, startState, startTime, rate, fraction, opts = {}) {
  if (rate <= 0) return null;
  if (!(fraction > 0 && fraction < 1)) return null;
  const scanStep       = opts.scanStep       ?? 0.5;
  const maxScanMin     = opts.maxScanMin     ?? 2880;
  const asympHorizon0  = opts.asympHorizon   ?? 60;
  const asympDoublings = opts.asympDoublings ?? 10;
  const asympRelTol    = opts.asympRelTol    ?? 1e-6;

  const savedState = engine.getState();
  try {
    engine.setState(startState);
    let horizon = asympHorizon0;
    engine.advance(horizon, rate);
    let prevCe = engine.getConcentrations().Ce;
    let ssCeAsymptote = prevCe;
    for (let k = 0; k < asympDoublings; k++) {
      engine.advance(horizon, rate);
      horizon *= 2;
      const ce = engine.getConcentrations().Ce;
      const rel = Math.abs(ce - prevCe) / Math.max(Math.abs(ce), 1e-9);
      prevCe = ce;
      ssCeAsymptote = ce;
      if (rel < asympRelTol) break;
    }
    if (ssCeAsymptote <= 1e-9) return null;

    const tolerance = 1 - fraction;
    const band = tolerance * ssCeAsymptote;

    engine.setState(startState);
    const startCe = engine.getConcentrations().Ce;
    if (Math.abs(startCe - ssCeAsymptote) <= band) {
      return { ssCeAsymptote, timeToSsMin: 0 };
    }

    engine.setState(startState);
    let lastOutside = -1;
    const nSteps = Math.floor(maxScanMin / scanStep);
    for (let i = 1; i <= nSteps; i++) {
      engine.advance(scanStep, rate);
      const ce = engine.getConcentrations().Ce;
      if (Math.abs(ce - ssCeAsymptote) > band) lastOutside = i;
    }

    if (lastOutside < 0) return { ssCeAsymptote, timeToSsMin: 0 };
    const lastOutsideTime = lastOutside * scanStep;
    if (lastOutsideTime >= maxScanMin - scanStep) {
      return { ssCeAsymptote, timeToSsMin: maxScanMin };
    }
    return { ssCeAsymptote, timeToSsMin: (lastOutside + 1) * scanStep };
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

console.log('\n=== TEST 1: Approach from zero (propofol) ===');
{
  const eng = createEngine(propParams);
  const state = eng.getState();
  // Rate that yields ~3 mcg/mL asymptote. Eleveld propofol CL ≈ 1.8 L/min →
  // Cp_ss ≈ R / CL; Ce tracks Cp. 3 mcg/mL * ~1.8 L/min ≈ 5.4 mg/min.
  const rate = 5.4;
  const result = predictSteadyState(eng, state, 0, rate, 0.95);
  assert(result !== null, 'Result returned');
  assert(result.ssCeAsymptote > 0, `ssCeAsymptote > 0 (got ${result.ssCeAsymptote.toFixed(3)})`);
  assert(result.timeToSsMin > 0, `timeToSsMin > 0 (got ${result.timeToSsMin.toFixed(1)})`);

  // Verify Ce at the predicted arrival time is inside the ±5% band.
  eng.setState(state);
  eng.advance(result.timeToSsMin, rate);
  const ceAtArrival = eng.getConcentrations().Ce;
  const band = 0.05 * result.ssCeAsymptote;
  assert(Math.abs(ceAtArrival - result.ssCeAsymptote) <= band,
    `Ce at arrival (${ceAtArrival.toFixed(3)}) within ±5% of asymptote (${result.ssCeAsymptote.toFixed(3)})`);
}

console.log('\n=== TEST 2: Asymptote matches long forward advance ===');
{
  const eng = createEngine(propParams);
  const state = eng.getState();
  const rate = 5.4;
  const result = predictSteadyState(eng, state, 0, rate, 0.95);

  // Propofol's slow V3 has τ ≈ 316 min, so 24 h is only ~99% of asymptote.
  // Compare to a 96-hour run instead — that's > 18 slow-compartment τ,
  // which puts Ce within ~1e-8 of the true asymptote.
  const eng2 = createEngine(propParams);
  eng2.advance(5760, rate);
  const trueAsymp = eng2.getConcentrations().Ce;
  const relErr = Math.abs(result.ssCeAsymptote - trueAsymp) / trueAsymp;
  assert(relErr < 0.0001, `Asymptote matches 96h advance within 0.01% (rel err ${(relErr*100).toFixed(6)}%)`);
}

console.log('\n=== TEST 3: Fraction monotonicity ===');
{
  const eng = createEngine(propParams);
  const state = eng.getState();
  const rate = 5.4;
  const r90 = predictSteadyState(eng, state, 0, rate, 0.90);
  const r95 = predictSteadyState(eng, state, 0, rate, 0.95);
  const r99 = predictSteadyState(eng, state, 0, rate, 0.99);
  assert(r90.timeToSsMin < r95.timeToSsMin, `timeTo(0.90)=${r90.timeToSsMin} < timeTo(0.95)=${r95.timeToSsMin}`);
  assert(r95.timeToSsMin < r99.timeToSsMin, `timeTo(0.95)=${r95.timeToSsMin} < timeTo(0.99)=${r99.timeToSsMin}`);
}

console.log('\n=== TEST 4: Drug independence (fentanyl, ketamine) ===');
{
  // Fentanyl — ng/mL scale. Target ~3 ng/mL = 0.003 mcg/mL. Shafer CL ~ 0.6 L/min.
  // Rate ≈ 0.003 * 0.6 = 0.0018 mg/min.
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  const state = eng.getState();
  const result = predictSteadyState(eng, state, 0, 0.0018, 0.95);
  assert(result !== null, 'Fentanyl result returned');
  assert(result.ssCeAsymptote > 0 && result.ssCeAsymptote < 0.02,
    `Fentanyl asymptote in ng-scale range (${result.ssCeAsymptote.toExponential(2)} mcg/mL)`);
  assert(result.timeToSsMin > 0, 'Fentanyl time > 0');

  // Ketamine — mcg-scale but different PK.
  const ketParams = calcKetamineParams(patient);
  const eng2 = createEngine(ketParams);
  const state2 = eng2.getState();
  const result2 = predictSteadyState(eng2, state2, 0, 1.5, 0.95);
  assert(result2 !== null, 'Ketamine result returned');
  assert(result2.ssCeAsymptote > 0, `Ketamine asymptote > 0 (${result2.ssCeAsymptote.toFixed(3)})`);
  assert(result2.timeToSsMin > 0, 'Ketamine time > 0');
}

console.log('\n=== TEST 5: Zero rate returns null ===');
{
  const eng = createEngine(propParams);
  const result = predictSteadyState(eng, eng.getState(), 0, 0, 0.95);
  assert(result === null, 'Rate = 0 returns null');
  const result2 = predictSteadyState(eng, eng.getState(), 0, -1, 0.95);
  assert(result2 === null, 'Negative rate returns null');
}

console.log('\n=== TEST 6: Engine state restoration ===');
{
  const eng = createEngine(propParams);
  // Prime the engine to a non-trivial state so byte-identity is meaningful.
  eng.advance(7, 5.4);
  const beforeState = eng.getState();
  const startStateCopy = eng.getState();
  predictSteadyState(eng, startStateCopy, 7, 5.4, 0.95);
  const afterState = eng.getState();
  let identical = true;
  for (let i = 0; i < 4; i++) if (beforeState[i] !== afterState[i]) identical = false;
  assert(identical, 'Engine state is byte-identical before and after predict call');
}

console.log('\n=== TEST 7: Primed state is faster ===');
{
  const eng = createEngine(propParams);
  const zeroState = eng.getState();
  const rate = 5.4;
  const fromZero = predictSteadyState(eng, zeroState, 0, rate, 0.95);

  // Prime by running 200 min under the same rate — far enough along the
  // transient that the remaining time-to-band is visibly shorter.
  eng.setState(zeroState);
  eng.advance(200, rate);
  const primedState = eng.getState();
  const fromPrimed = predictSteadyState(eng, primedState, 200, rate, 0.95);

  assert(fromPrimed.timeToSsMin < fromZero.timeToSsMin - 100,
    `Primed state reaches SS >100 min faster (${fromPrimed.timeToSsMin} vs ${fromZero.timeToSsMin})`);
}

console.log('\n=== TEST 8: Approach from above (rate lowered) ===');
{
  const eng = createEngine(propParams);

  // Prime the engine at a high rate so Ce is well above any low-rate asymptote.
  // Use a loading bolus then a sustained high rate.
  eng.advance(0.05, 150 / 0.05);   // ~150 mg bolus (5 mg/min for 30 s)
  eng.advance(30, 10.0);           // 30 min at 10 mg/min
  const highState = eng.getState();
  const startCe = eng.getConcentrations().Ce;

  // Now predict for a much lower maintenance rate whose asymptote is < startCe.
  const lowRate = 2.0;
  const result = predictSteadyState(eng, highState, 30, lowRate, 0.95);
  assert(result !== null, 'Result returned for lowered rate');
  assert(result.ssCeAsymptote < startCe,
    `New asymptote (${result.ssCeAsymptote.toFixed(3)}) < starting Ce (${startCe.toFixed(3)})`);
  assert(result.timeToSsMin > 0, `timeToSsMin > 0 (got ${result.timeToSsMin.toFixed(1)})`);

  // Verify: after advancing timeToSsMin from highState under lowRate, Ce is in the ±5% band.
  eng.setState(highState);
  eng.advance(result.timeToSsMin, lowRate);
  const ceAtArrival = eng.getConcentrations().Ce;
  const band = 0.05 * result.ssCeAsymptote;
  assert(Math.abs(ceAtArrival - result.ssCeAsymptote) <= band,
    `Approaches from above: Ce at arrival (${ceAtArrival.toFixed(3)}) within ±5% of ${result.ssCeAsymptote.toFixed(3)}`);
}

console.log('\n=== TEST 9: Post-bolus overshoot ===');
{
  const eng = createEngine(propParams);

  // Loading bolus: 80 mg as a 30-sec push. Immediately after, Ce is still
  // low (Ce lags Cp), but Cp is very high. Start a low maintenance rate —
  // Ce will rise toward the Cp peak (briefly overshooting the asymptote of
  // the low maintenance rate), then decay back to the maintenance asymptote.
  eng.advance(0.5, 80 / 0.5);       // 80 mg over 30 sec
  const postBolusState = eng.getState();

  const mainRate = 1.5;  // low maintenance — asymptote well below transient peak
  const result = predictSteadyState(eng, postBolusState, 0.5, mainRate, 0.95);
  assert(result !== null, 'Result returned');

  // Verify Ce at the predicted arrival is within the band.
  eng.setState(postBolusState);
  eng.advance(result.timeToSsMin, mainRate);
  const ceAtArrival = eng.getConcentrations().Ce;
  const band = 0.05 * result.ssCeAsymptote;
  assert(Math.abs(ceAtArrival - result.ssCeAsymptote) <= band,
    `Post-bolus: Ce at arrival (${ceAtArrival.toFixed(3)}) within ±5% of ${result.ssCeAsymptote.toFixed(3)}`);

  // Sanity: Ce at the predicted arrival must stay in the band for the next
  // 30 min — the predictor's "last time outside" semantics should survive
  // any transient overshoot on the way up.
  let stayed = true;
  for (let k = 1; k <= 60; k++) {
    eng.advance(0.5, mainRate);
    const ce = eng.getConcentrations().Ce;
    if (Math.abs(ce - result.ssCeAsymptote) > band * 1.01) { stayed = false; break; }
  }
  assert(stayed, 'Ce stays inside band for 30 min after predicted arrival (no re-exit)');
}

console.log('\n=== TEST 10: Already inside the band ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  // Advance 2000 min — propofol's slow τ ≈ 316 min, so 2000 = 6.3τ and
  // Ce is within ~0.2% of asymptote, well inside the 5% band.
  eng.advance(2000, rate);
  const deepState = eng.getState();
  const result = predictSteadyState(eng, deepState, 2000, rate, 0.95);
  assert(result !== null, 'Result returned');
  assert(result.timeToSsMin === 0, `timeToSsMin is 0 when already at SS (got ${result.timeToSsMin})`);
}

console.log('\n=== TEST 11: Tolerance symmetry (startCe slightly above asymp) ===');
{
  // Construct a case where the starting Ce is 3% above the asymptote of
  // the current rate. With fraction=0.95 (band=5%), we're inside the band
  // and timeToSsMin should be 0.
  const eng = createEngine(propParams);

  // Find asymptote Ce for rate R1.
  const R1 = 3.0;
  const eng1 = createEngine(propParams);
  eng1.advance(1440, R1);
  const asymp1 = eng1.getConcentrations().Ce;

  // Start from asymp1 * 1.03 (3% above). To get there, run a slightly higher
  // rate that reaches exactly 1.03 * asymp1. Since Cp_ss scales linearly with R,
  // use R = R1 * 1.03 for a long time.
  eng.advance(1440, R1 * 1.03);
  const startCe = eng.getConcentrations().Ce;
  const startState = eng.getState();

  // startCe/asymp1 should be ~1.03 (3% deviation, inside 5% band).
  const result = predictSteadyState(eng, startState, 1440, R1, 0.95);
  assert(result !== null, 'Result returned');
  const rel = Math.abs(startCe - result.ssCeAsymptote) / result.ssCeAsymptote;
  assert(rel < 0.05, `Starting Ce is within 5% band (rel dev ${(rel*100).toFixed(2)}%)`);
  assert(result.timeToSsMin === 0, `timeToSsMin is 0 (got ${result.timeToSsMin})`);
}

// ============ TCI TIME-TO-TARGET TESTS ============

console.log('\n=== TEST 12: Propofol TCI tolerance at default 95% ===');
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

console.log('\n=== TEST 13: Fentanyl-scale target does not latch at sample 0 ===');
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

console.log('\n=== TEST 14: Approach from above (Ce > target) ===');
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

console.log('\n=== TEST 15: TCI fraction monotonicity ===');
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