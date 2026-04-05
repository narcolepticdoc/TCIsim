/**
 * test-pk.js — Validation test suite for Phase 1 PK engine
 * 
 * Run with: node --experimental-vm-modules test-pk.js
 * (or simply: node test-pk.js if using .mjs or bundler)
 * 
 * Tests:
 * 1. Eleveld parameter calculator against published reference values
 * 2. Matrix exponential accuracy
 * 3. PK engine conservation and steady-state behaviour  
 * 4. TCI algorithm convergence
 * 5. PD model BIS predictions
 */

// Since we're testing ES modules in Node, use dynamic import workaround
// For simplicity, inline the modules here for Node.js testing

// ============ INLINE math.js ============
const N = 4;
function mat4() { return new Float64Array(16); }
function eye4() { const m = mat4(); m[0]=m[5]=m[10]=m[15]=1; return m; }
function mul4(A, B) {
  const C = mat4();
  for (let i=0;i<N;i++) for (let j=0;j<N;j++) {
    let s=0; for (let k=0;k<N;k++) s+=A[i*N+k]*B[k*N+j]; C[i*N+j]=s;
  } return C;
}
function mulVec4(A, x) {
  const y = new Float64Array(4);
  for (let i=0;i<N;i++) { let s=0; for (let j=0;j<N;j++) s+=A[i*N+j]*x[j]; y[i]=s; }
  return y;
}
function add4(A, B) { const C=mat4(); for(let i=0;i<16;i++) C[i]=A[i]+B[i]; return C; }
function sub4(A, B) { const C=mat4(); for(let i=0;i<16;i++) C[i]=A[i]-B[i]; return C; }
function scale4(A, s) { const B=mat4(); for(let i=0;i<16;i++) B[i]=A[i]*s; return B; }
function norm1(A) {
  let mx=0; for(let j=0;j<N;j++){let cs=0;for(let i=0;i<N;i++) cs+=Math.abs(A[i*N+j]); if(cs>mx)mx=cs;} return mx;
}
function inv4(M) {
  const a=new Float64Array(32);
  for(let i=0;i<N;i++){for(let j=0;j<N;j++) a[i*8+j]=M[i*N+j]; a[i*8+(N+i)]=1;}
  for(let col=0;col<N;col++){
    let mv=Math.abs(a[col*8+col]),mr=col;
    for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r;}}
    if(mv<1e-15) return null;
    if(mr!==col) for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t;}
    const p=a[col*8+col]; for(let j=0;j<8;j++) a[col*8+j]/=p;
    for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j];}
  }
  const inv=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv;
}
function expm4(A) {
  const c=[1,1/2,5/44,1/66,1/792,1/15840,1/665280];
  const nA=norm1(A); let s=0;
  if(nA>0.5){s=Math.ceil(Math.log2(nA/0.5));if(s<0)s=0;}
  const As=(s>0)?scale4(A,1/(1<<s)):A;
  const As2=mul4(As,As),As3=mul4(As,As2),As4=mul4(As2,As2),As5=mul4(As,As4),As6=mul4(As2,As4);
  const I=eye4(); const powers=[I,As,As2,As3,As4,As5,As6];
  let Nm=mat4(),Dm=mat4();
  for(let k=0;k<=6;k++){const sg=(k%2===0)?1:-1;for(let i=0;i<16;i++){Nm[i]+=c[k]*powers[k][i];Dm[i]+=sg*c[k]*powers[k][i];}}
  const Di=inv4(Dm); if(!Di)return add4(I,A);
  let result=mul4(Di,Nm);
  for(let i=0;i<s;i++) result=mul4(result,result);
  return result;
}

// ============ INLINE eleveld.js ============
function sigmoid(x, E50, gamma) { const xg=Math.pow(x,gamma),eg=Math.pow(E50,gamma); return xg/(xg+eg); }
function fatFreeMass(wgt, hgt, age, male) {
  const bmi=wgt/Math.pow(hgt/100,2);
  if(male){const mf=(0.88+(1-0.88)/(1+Math.pow(age/13.4,-12.7)));return mf*((9270*wgt)/(6680+216*bmi));}
  else{const mf=(1.11+(1-1.11)/(1+Math.pow(age/7.1,-1.1)));return mf*((9270*wgt)/(8780+244*bmi));}
}
function getPMA(ageYears, pmaWeeks) { if(pmaWeeks!=null&&pmaWeeks>0) return pmaWeeks; return(ageYears*52)+40; }

const THETA = {
  V1:6.28,V2:25.5,V3:273,CL:1.89,Q2:1.75,Q3:1.11,
  V2_aging:-0.0156, CL_aging_opioid:-0.00286,
  V1_Emax_WGT:2.72, V1_E50_WGT:33.6,
  CL_female:1.30,
  CL_mat_PMA50:42.3, CL_mat_hill:9.06,
  Q3_mat_AGE50:68.3, Q3_mat_hill:1.89,
  CL_arterial:1.0, Q2_arterial:0.68,
  Ce50:3.08, ke0_ref:0.146, BIS_baseline:93.0,
  gamma:1.89, gamma2:1.47,
  Ce50_aging:-0.00635, Ce50_opioid:-0.567,
  ke0_wgt_exp:-0.25,
};

function calcEleveldParams(patient) {
  const {age,weight,height,male,opioid,ce50OpioidCorrection,pma:pmaInput}=patient;
  const bmi=weight/Math.pow(height/100,2);
  const ffm=fatFreeMass(weight,height,age,male);
  const pma=getPMA(age,pmaInput);
  const opioidFlag=opioid?1:0;
  const WGT_REF=70,AGE_REF=35;
  
  const v1r=sigmoid(weight,THETA.V1_E50_WGT,1)/sigmoid(WGT_REF,THETA.V1_E50_WGT,1);
  const V1=THETA.V1*v1r;
  const V2=THETA.V2*(weight/WGT_REF)*Math.exp(THETA.V2_aging*(age-AGE_REF));
  const ffm_ref=fatFreeMass(WGT_REF,170,AGE_REF,true);
  const V3=opioid ? THETA.V3*(ffm/ffm_ref)*Math.exp(-0.0138*age) : THETA.V3*(ffm/ffm_ref);
  const cl_mat=sigmoid(pma,THETA.CL_mat_PMA50,THETA.CL_mat_hill);
  const cl_mat_ref=sigmoid(getPMA(AGE_REF,null),THETA.CL_mat_PMA50,THETA.CL_mat_hill);
  const cl_sex=male?1:THETA.CL_female;
  const CL=THETA.CL*Math.pow(weight/WGT_REF,0.75)*(cl_mat/cl_mat_ref)*cl_sex*Math.exp(opioidFlag*THETA.CL_aging_opioid*(age-AGE_REF));
  const Q2=THETA.Q2*Math.pow(V2/THETA.V2,0.75);
  const q3_mat=sigmoid(age,THETA.Q3_mat_AGE50,THETA.Q3_mat_hill);
  const q3_mat_ref=sigmoid(AGE_REF,THETA.Q3_mat_AGE50,THETA.Q3_mat_hill);
  const q3_sex=male?1:(q3_mat/q3_mat_ref);
  const Q3=THETA.Q3*Math.pow(V3/THETA.V3,0.75)*q3_sex;
  const ke0=THETA.ke0_ref*Math.pow(weight/WGT_REF,THETA.ke0_wgt_exp);
  const ce50OpioidFlag2=(opioid&&ce50OpioidCorrection)?1:0;
  const Ce50=THETA.Ce50*Math.exp(THETA.Ce50_aging*(age-AGE_REF))*Math.exp(THETA.Ce50_opioid*ce50OpioidFlag2);
  
  return {
    patient:{age,weight,height,male,opioid,bmi,ffm,pma},
    V1,V2,V3,CL,Q2,Q3,ke0,
    k10:CL/V1,k12:Q2/V1,k21:Q2/V2,k13:Q3/V1,k31:Q3/V3,
    Ce50, gamma1:THETA.gamma, gamma2:THETA.gamma2, BIS_baseline:THETA.BIS_baseline,
  };
}

// ============ INLINE engine ============
function buildSystemMatrix(params) {
  const {V1,V2,V3,CL,Q2,Q3,ke0}=params;
  const A=mat4();
  A[0]=-(CL+Q2+Q3)/V1; A[1]=Q2/V2; A[2]=Q3/V3; A[3]=0;
  A[4]=Q2/V1; A[5]=-Q2/V2; A[6]=0; A[7]=0;
  A[8]=Q3/V1; A[9]=0; A[10]=-Q3/V3; A[11]=0;
  A[12]=ke0/V1; A[13]=0; A[14]=0; A[15]=-ke0;
  return A;
}

function createEngine(params) {
  const A=buildSystemMatrix(params);
  const B=new Float64Array([1,0,0,0]);
  const {V1,V2,V3}=params;
  let state=new Float64Array(4);
  
  function advance(dt,R) {
    if(dt<=0)return;
    const eAdt=expm4(scale4(A,dt));
    const xHom=mulVec4(eAdt,state);
    if(R===0){state=xHom;return;}
    const Ainv=inv4(A);
    if(!Ainv){state=xHom;return;}
    const eAdtmI=sub4(eAdt,eye4());
    const M=mul4(Ainv,eAdtmI);
    for(let i=0;i<4;i++) state[i]=xHom[i]+M[i*4+0]*R;
  }
  
  function getConcentrations() {
    return {Cp:state[0]/V1,C2:state[1]/V2,C3:state[2]/V3,Ce:state[3],A1:state[0],A2:state[1],A3:state[2]};
  }
  
  function predictCe(dt,R) {
    const saved=new Float64Array(state); advance(dt,R); const ce=state[3]; state=saved; return ce;
  }
  
  function reset() { state=new Float64Array(4); }
  function getState() { return new Float64Array(state); }
  function setState(s) { state=new Float64Array(s); }
  
  return {advance,getConcentrations,predictCe,reset,getState,setState,get params(){return params;}};
}

// ============ INLINE pd.js ============
function drugEffect(Ce,Ce50,g1,g2) {
  if(Ce<=0)return 0;if(Ce50<=0)return 1;
  const g=(Ce<=Ce50)?g1:g2;const r=Ce/Ce50;const rg=Math.pow(r,g);return rg/(1+rg);
}
function predictBIS(Ce,p) {
  const e=drugEffect(Ce,p.Ce50,p.gamma1,p.gamma2);return Math.max(0,Math.min(100,p.BIS_baseline*(1-e)));
}

// ============ TEST RUNNER ============
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function approxEqual(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

function relEqual(a, b, relTol) {
  if (b === 0) return Math.abs(a) < relTol;
  return Math.abs((a - b) / b) < relTol;
}

// ---- TEST 1: Eleveld Reference Individual ----
console.log('\n=== TEST 1: Eleveld Reference Individual (35y, 70kg, 170cm, male, no opioid) ===');
{
  const p = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });
  
  // Published reference values (Eleveld 2018, Table)
  console.log(`  V1  = ${p.V1.toFixed(3)} L   (expected: ~6.28)`);
  console.log(`  V2  = ${p.V2.toFixed(3)} L   (expected: ~25.5)`);
  console.log(`  V3  = ${p.V3.toFixed(3)} L   (expected: ~273)`);
  console.log(`  CL  = ${p.CL.toFixed(3)} L/min (expected: ~1.79-1.89)`);
  console.log(`  Q2  = ${p.Q2.toFixed(3)} L/min (expected: ~1.75)`);
  console.log(`  Q3  = ${p.Q3.toFixed(3)} L/min (expected: ~1.11)`);
  console.log(`  ke0 = ${p.ke0.toFixed(4)} min⁻¹ (expected: 0.146)`);
  console.log(`  FFM = ${p.patient.ffm.toFixed(1)} kg`);
  console.log(`  BMI = ${p.patient.bmi.toFixed(1)} kg/m²`);
  console.log(`  Ce50= ${p.Ce50.toFixed(3)} μg/mL`);
  
  assert(relEqual(p.V1, 6.28, 0.10), `V1 within 10% of 6.28 (got ${p.V1.toFixed(3)})`);
  assert(relEqual(p.V2, 25.5, 0.10), `V2 within 10% of 25.5 (got ${p.V2.toFixed(3)})`);
  assert(relEqual(p.V3, 273, 0.10),  `V3 within 10% of 273 (got ${p.V3.toFixed(1)})`);
  assert(relEqual(p.CL, 1.89, 0.10), `CL within 10% of 1.89 (got ${p.CL.toFixed(3)})`);
  assert(relEqual(p.Q2, 1.75, 0.10), `Q2 within 10% of 1.75 (got ${p.Q2.toFixed(3)})`);
  assert(relEqual(p.Q3, 1.11, 0.10), `Q3 within 10% of 1.11 (got ${p.Q3.toFixed(3)})`);
  assert(relEqual(p.ke0, 0.146, 0.05), `ke0 within 5% of 0.146 (got ${p.ke0.toFixed(4)})`);
}

// ---- TEST 2: Matrix Exponential ----
console.log('\n=== TEST 2: Matrix Exponential ===');
{
  // Test: expm(0) = I
  const zero = mat4();
  const eZ = expm4(zero);
  assert(approxEqual(eZ[0], 1, 1e-10) && approxEqual(eZ[5], 1, 1e-10), 'expm(0) = Identity');
  
  // Test: expm(I) diagonal should be e ≈ 2.71828
  const I = eye4();
  const eI = expm4(I);
  assert(approxEqual(eI[0], Math.E, 0.001), `expm(I)[0,0] ≈ e (got ${eI[0].toFixed(5)})`);
  
  // Test: expm(A) · expm(-A) ≈ I
  const params = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });
  const A = buildSystemMatrix(params);
  const eA = expm4(A);
  const emA = expm4(scale4(A, -1));
  const product = mul4(eA, emA);
  assert(approxEqual(product[0], 1, 1e-6), 'expm(A) · expm(-A) ≈ I');
}

// ---- TEST 3: PK Engine — Bolus Decay ----
console.log('\n=== TEST 3: PK Engine — Bolus then decay ===');
{
  const params = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });
  const eng = createEngine(params);
  
  // Deliver 100mg bolus over 0.1 minutes (fast push)
  eng.advance(0.1, 100 / 0.1); // 1000 mg/min for 0.1 min = 100 mg
  
  const afterBolus = eng.getConcentrations();
  console.log(`  After 100mg bolus: Cp=${afterBolus.Cp.toFixed(2)} μg/mL, Ce=${afterBolus.Ce.toFixed(2)} μg/mL`);
  assert(afterBolus.Cp > 10, `Cp after bolus > 10 (got ${afterBolus.Cp.toFixed(2)})`);
  assert(afterBolus.Ce < afterBolus.Cp, `Ce < Cp initially (Ce=${afterBolus.Ce.toFixed(2)}, Cp=${afterBolus.Cp.toFixed(2)})`);
  
  // Decay for 10 minutes
  eng.advance(10, 0);
  const after10 = eng.getConcentrations();
  console.log(`  After 10min decay: Cp=${after10.Cp.toFixed(2)} μg/mL, Ce=${after10.Ce.toFixed(2)} μg/mL`);
  assert(after10.Cp < afterBolus.Cp, 'Cp decreases during decay');
  
  // After long decay, all should approach zero
  eng.advance(120, 0);
  const after130 = eng.getConcentrations();
  console.log(`  After 130min total: Cp=${after130.Cp.toFixed(4)} μg/mL`);
  assert(after130.Cp < 0.1, 'Cp approaches 0 after long decay');
  
  // Mass conservation check: total amount should be less than initial dose (some eliminated)
  const totalAmount = after10.A1 + after10.A2 + after10.A3;
  assert(totalAmount < 100, `Total amount after 10min < 100mg (got ${totalAmount.toFixed(1)}mg)`);
  assert(totalAmount > 0, `Total amount > 0 (got ${totalAmount.toFixed(1)}mg)`);
}

// ---- TEST 4: TCI Algorithm ----
console.log('\n=== TEST 4: TCI Ce Targeting ===');
{
  const params = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });
  const eng = createEngine(params);
  const tciInterval = 10/60; // 10 seconds
  
  // Simple TCI step function (inline for test)
  function tciStep(engine, target, dt, maxRate) {
    if(target<=0) return 0;
    const ceMax = engine.predictCe(dt, maxRate);
    if(ceMax <= target) return maxRate;
    const ceZero = engine.predictCe(dt, 0);
    if(ceZero >= target) return 0;
    let lo=0, hi=maxRate;
    for(let i=0;i<30;i++){
      const mid=(lo+hi)/2;
      const ce=engine.predictCe(dt,mid);
      if(Math.abs(ce-target)<0.001){return mid;}
      if(ce<target) lo=mid; else hi=mid;
    }
    return (lo+hi)/2;
  }
  
  // Target Ce = 3.0 μg/mL, run for 5 minutes
  const target = 3.0;
  const steps = Math.ceil(5 / tciInterval);
  let lastCe = 0;
  
  for (let i = 0; i < steps; i++) {
    const rate = tciStep(eng, target, tciInterval, 200);
    eng.advance(tciInterval, rate);
    lastCe = eng.getConcentrations().Ce;
  }
  
  console.log(`  After 5min targeting Ce=${target}: actual Ce=${lastCe.toFixed(3)} μg/mL`);
  // At 5 min, Ce may still be equilibrating (overshoot is expected with Ce targeting)
  // Just check it's in a reasonable range and converging
  assert(lastCe > 0 && lastCe < 10, `Ce at 5min in reasonable range 0-10 (got ${lastCe.toFixed(3)})`);
  
  // Continue for another 10 minutes — should reach steady-state
  for (let i = 0; i < Math.ceil(10 / tciInterval); i++) {
    const rate = tciStep(eng, target, tciInterval, 200);
    eng.advance(tciInterval, rate);
    lastCe = eng.getConcentrations().Ce;
  }
  
  console.log(`  After 15min targeting Ce=${target}: actual Ce=${lastCe.toFixed(3)} μg/mL`);
  assert(approxEqual(lastCe, target, 0.05), `Ce steady-state within 0.05 of target (got ${lastCe.toFixed(3)})`);
}

// ---- TEST 5: PD Model — BIS Prediction ----
console.log('\n=== TEST 5: PD Model — BIS Prediction ===');
{
  const params = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });
  const pdParams = { Ce50:params.Ce50, gamma1:params.gamma1, gamma2:params.gamma2, BIS_baseline:params.BIS_baseline };
  
  // At Ce = 0: BIS = baseline
  const bis0 = predictBIS(0, pdParams);
  assert(approxEqual(bis0, 93, 0.01), `BIS at Ce=0 is baseline (${bis0.toFixed(1)})`);
  
  // At Ce = Ce50: BIS ≈ 50% of baseline = ~46.5
  const bisCe50 = predictBIS(params.Ce50, pdParams);
  console.log(`  BIS at Ce50 (${params.Ce50.toFixed(2)}): ${bisCe50.toFixed(1)} (expected ~46.5)`);
  assert(approxEqual(bisCe50, 93 * 0.5, 1.0), `BIS at Ce50 ≈ 46.5 (got ${bisCe50.toFixed(1)})`);
  
  // At very high Ce: BIS → 0
  const bisHigh = predictBIS(20, pdParams);
  assert(bisHigh < 10, `BIS at Ce=20 → near 0 (got ${bisHigh.toFixed(1)})`);
  
  // BIS should decrease monotonically
  let prev = 100;
  let monotonic = true;
  for (let ce = 0; ce <= 10; ce += 0.5) {
    const bis = predictBIS(ce, pdParams);
    if (bis > prev + 0.001) { monotonic = false; break; }
    prev = bis;
  }
  assert(monotonic, 'BIS decreases monotonically with increasing Ce');
}

// ---- TEST 6: Parameter variation with covariates ----
console.log('\n=== TEST 6: Covariate Sensitivity ===');
{
  const base = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });
  const elderly = calcEleveldParams({ age:75, weight:70, height:170, male:true, opioid:false });
  const female = calcEleveldParams({ age:35, weight:70, height:170, male:false, opioid:false });
  const opioid = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:true });
  const obese = calcEleveldParams({ age:35, weight:120, height:170, male:true, opioid:false });
  
  // Elderly: V2 should decrease, Ce50 should decrease (more sensitive)
  assert(elderly.V2 < base.V2, `Elderly V2 (${elderly.V2.toFixed(1)}) < Base V2 (${base.V2.toFixed(1)})`);
  assert(elderly.Ce50 < base.Ce50, `Elderly Ce50 (${elderly.Ce50.toFixed(2)}) < Base Ce50 (${base.Ce50.toFixed(2)})`);
  
  // Female: CL should be higher
  assert(female.CL > base.CL, `Female CL (${female.CL.toFixed(3)}) > Male CL (${base.CL.toFixed(3)})`);
  
  // Opioid: Ce50 is the same as base by default (opioid correction off, matches SimTIVA).
  // The Eleveld paper correction (exp(-0.567)) is only applied when ce50OpioidCorrection=true.
  assert(opioid.Ce50 === base.Ce50, `Opioid Ce50 (${opioid.Ce50.toFixed(2)}) === Base Ce50 (${base.Ce50.toFixed(2)}) — correction off by default`);

  // Opioid: V3 must decrease (exp(-0.0138*age) applied only with opioid)
  // At age 35: V3 = 273 * ffm/ffmref * exp(-0.0138*35) ≈ 168 L, NOT 273 L
  assert(opioid.V3 < base.V3, `Opioid V3 (${opioid.V3.toFixed(1)}) < Base V3 (${base.V3.toFixed(1)})`);
  assert(opioid.V3 < 175, `Opioid V3 at age 35 ≈ 168 L (got ${opioid.V3.toFixed(1)})`);
  
  // Opioid: Q3 should also decrease (indirectly via V3 allometric scaling)
  assert(opioid.Q3 < base.Q3, `Opioid Q3 (${opioid.Q3.toFixed(3)}) < Base Q3 (${base.Q3.toFixed(3)}) — indirect via V3`);
  
  // Opioid at age 65: V3 reduction should be much larger
  const elderly_opioid = calcEleveldParams({ age:65, weight:70, height:170, male:true, opioid:true });
  assert(elderly_opioid.V3 < 120, `Opioid V3 at age 65 ≈ 111 L (got ${elderly_opioid.V3.toFixed(1)})`);
  
  // Obese: V1 should increase (Emax with weight)
  assert(obese.V1 > base.V1, `Obese V1 (${obese.V1.toFixed(2)}) > Base V1 (${base.V1.toFixed(2)})`);
  
  console.log('  Parameter summary:');
  console.log(`  Base:    V1=${base.V1.toFixed(2)} V2=${base.V2.toFixed(1)} V3=${base.V3.toFixed(0)} CL=${base.CL.toFixed(3)} Ce50=${base.Ce50.toFixed(2)}`);
  console.log(`  Elderly: V1=${elderly.V1.toFixed(2)} V2=${elderly.V2.toFixed(1)} V3=${elderly.V3.toFixed(0)} CL=${elderly.CL.toFixed(3)} Ce50=${elderly.Ce50.toFixed(2)}`);
  console.log(`  Female:  V1=${female.V1.toFixed(2)} V2=${female.V2.toFixed(1)} V3=${female.V3.toFixed(0)} CL=${female.CL.toFixed(3)} Ce50=${female.Ce50.toFixed(2)}`);
  console.log(`  Opioid:  V1=${opioid.V1.toFixed(2)} V2=${opioid.V2.toFixed(1)} V3=${opioid.V3.toFixed(0)} CL=${opioid.CL.toFixed(3)} Ce50=${opioid.Ce50.toFixed(2)}`);
  console.log(`  Obese:   V1=${obese.V1.toFixed(2)} V2=${obese.V2.toFixed(1)} V3=${obese.V3.toFixed(0)} CL=${obese.CL.toFixed(3)} Ce50=${obese.Ce50.toFixed(2)}`);
}

// ---- TEST 7: Ce50 Absolute Values vs Eleveld Paper & TivaTrainer ----
// These tests catch the -0.0517 bug that was invisible at age 35.
// Sources: Eleveld 2018 Table 3, TivaTrainer DiY4, Vandemoortele 2022 review.

console.log('\n=== TEST 7: Ce50 Absolute Values (Age-Stratified) ===');
{
  // Expected Ce50 values (no opioid, 70kg 170cm male):
  //   Vandemoortele 2022 (PMC9101974): age 20 → 3.4, age 80 → 2.3
  //   TivaTrainer DiY4 (80kg 40y male): 2.9837
  //   Formula: 3.08 * exp(-0.00635 * (age - 35))
  const cases = [
    { age: 20, expected: 3.388, tol: 0.01, source: 'paper ~3.4' },
    { age: 35, expected: 3.080, tol: 0.001, source: 'baseline' },
    { age: 50, expected: 2.800, tol: 0.01, source: 'formula' },
    { age: 65, expected: 2.546, tol: 0.01, source: 'formula' },
    { age: 80, expected: 2.314, tol: 0.01, source: 'paper ~2.3' },
  ];

  for (const c of cases) {
    const p = calcEleveldParams({ age: c.age, weight: 70, height: 170, male: true, opioid: false });
    const err = Math.abs(p.Ce50 - c.expected);
    assert(err < c.tol,
      `Ce50 age ${c.age}: ${p.Ce50.toFixed(3)} ≈ ${c.expected} (${c.source})`);
  }

  // TivaTrainer DiY4 exact match: 80kg, 40y, 170cm male → 2.98374611609866
  const ttP = calcEleveldParams({ age: 40, weight: 80, height: 170, male: true, opioid: false });
  assert(Math.abs(ttP.Ce50 - 2.98374611609866) < 0.001,
    `Ce50 matches TivaTrainer DiY4 (${ttP.Ce50.toFixed(6)} ≈ 2.983746)`);

  // Opioid at age 50 (default, correction off): Ce50 = 2.800 (same as no-opioid)
  const opP = calcEleveldParams({ age: 50, weight: 70, height: 170, male: true, opioid: true });
  assert(Math.abs(opP.Ce50 - 2.800) < 0.01,
    `Ce50 age 50 + opioid (correction off): ${opP.Ce50.toFixed(3)} ≈ 2.800`);
  // With correction on: Ce50 = 2.800 * exp(-0.567) ≈ 1.588
  const opPCorr = calcEleveldParams({ age: 50, weight: 70, height: 170, male: true, opioid: true, ce50OpioidCorrection: true });
  const opCorrExpected = 2.800 * Math.exp(-0.567);
  assert(Math.abs(opPCorr.Ce50 - opCorrExpected) < 0.02,
    `Ce50 age 50 + opioid (correction on): ${opPCorr.Ce50.toFixed(3)} ≈ ${opCorrExpected.toFixed(3)}`);
}

// ---- TEST 8: Gamma Split-Direction (BIS Curve Shape) ----
// TivaTrainer DiY4: IF(Ce <= Ce50, 1.89, 1.47)
// gamma=1.89 below Ce50 (steeper), gamma=1.47 above (shallower)

console.log('\n=== TEST 8: Gamma Split Direction ===');
{
  const p = calcEleveldParams({ age: 35, weight: 70, height: 170, male: true, opioid: false });

  // Verify gamma assignment
  assert(p.gamma1 === 1.89, `gamma1 = 1.89 (below/at Ce50), got ${p.gamma1}`);
  assert(p.gamma2 === 1.47, `gamma2 = 1.47 (above Ce50), got ${p.gamma2}`);

  // BIS at Ce = 2.0 (below Ce50=3.08): should be ~64.5 with correct gamma
  const bis_below = predictBIS(2.0, p);
  assert(approxEqual(bis_below, 64.5, 1.0),
    `BIS at Ce=2.0 (below Ce50): ${bis_below.toFixed(1)} ≈ 64.5`);

  // BIS at Ce = 5.0 (above Ce50=3.08): should be ~30.6 with correct gamma
  const bis_above = predictBIS(5.0, p);
  assert(approxEqual(bis_above, 30.6, 1.0),
    `BIS at Ce=5.0 (above Ce50): ${bis_above.toFixed(1)} ≈ 30.6`);

  // Sanity: BIS at Ce50 = 46.5 (unaffected by gamma swap)
  const bis_mid = predictBIS(p.Ce50, p);
  assert(approxEqual(bis_mid, 46.5, 0.5),
    `BIS at Ce=Ce50: ${bis_mid.toFixed(1)} ≈ 46.5 (midpoint)`);
}

// ---- SUMMARY ----
console.log(`\n${'='.repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
