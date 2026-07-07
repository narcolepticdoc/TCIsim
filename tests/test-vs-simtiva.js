/**
 * test-vs-simtiva.js — Complete cross-validation against SimTIVA
 *
 * Step 1: Parameter calculator — the REAL js/pk/eleveld.js vs SimTIVA's exact
 *         pharmacology.js formulas across 7 patients.
 * Step 2: Concentration curves — an INDEPENDENT analytical eigenvalue solution
 *         vs the REAL js/pk/engine.js matrix-exp (bolus Cp+Ce, infusion Cp+Ce).
 * Step 3: Rate-constant identity check (CL/V1 = k10 etc.).
 * Step 4: SimTIVA's exact tick-based UDF loop vs the REAL engine.
 *
 * What is imported (production) vs inline (reference oracle), and why:
 *   - IMPORTED: createEngine (js/pk/engine.js), calcEleveldParams
 *     (js/pk/eleveld.js) — these are the shipping code under validation.
 *   - INLINE (kept deliberately): the analytical bolus/infusion solver, the
 *     SimTIVA tick-UDF loop, and the SimTIVA parameter formulas
 *     (simtiva_params). These are INDEPENDENT reference oracles — importing
 *     the production solver here would make the test self-referential and
 *     validate nothing. The whole point is production-vs-independent-math.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const u = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;

// ============ INDEPENDENT ANALYTICAL EIGENVALUE SOLVER (reference oracle) ============
function cube(k10, k12, k21, k13, k31) {
  const tr = Math.asin(1) * 2 / 180;
  const a0 = k10*k21*k31;
  const a1 = k10*k31 + k21*k31 + k21*k13 + k10*k21 + k31*k12;
  const a2 = k10 + k12 + k13 + k21 + k31;
  const p = a1 - a2*a2/3, q = 2*a2*a2*a2/27 - a1*a2/3 + a0;
  const r1 = Math.sqrt(-p*p*p/27);
  let phi = (-q/2)/r1; if(phi>1) phi=1; if(phi<-1) phi=-1;
  phi = Math.acos(phi)/3;
  const r1c = 2*Math.exp(Math.log(r1)/3);
  const l = [];
  l[0] = -(Math.cos(phi)*r1c - a2/3);
  l[1] = -(Math.cos(phi + 120*tr)*r1c - a2/3);
  l[2] = -(Math.cos(phi + 240*tr)*r1c - a2/3);
  l.sort((a,b) => a-b);
  return l;
}

/**
 * Analytical bolus response for 3-compartment + effect site.
 * Cp(t) = (D/V1) · Σ A_i·exp(-λ_i·t)
 * Ce(t) = (D/V1) · Σ A_i·ke0/(ke0-λ_i)·(exp(-λ_i·t) - exp(-ke0·t))
 * A_i = (k21-λ_i)(k31-λ_i) / Π_{j≠i}(λ_j - λ_i)
 */
function analyticalBolus(params, doseMg, timesMin) {
  const k10=params.k10/60, k12=params.k12/60, k13=params.k13/60;
  const k21=params.k21/60, k31=params.k31/60, ke0=params.ke0/60;
  const V1=params.V1;
  const lam = cube(k10,k12,k21,k13,k31);
  const A = [];
  for (let i=0; i<3; i++) {
    let num = (k21-lam[i])*(k31-lam[i]);
    let den = 1;
    for (let j=0; j<3; j++) if(j!==i) den *= (lam[j]-lam[i]);
    A[i] = num/den;
  }
  const results = [];
  for (const tMin of timesMin) {
    const t = tMin*60;
    let cp=0, ce=0;
    for (let i=0; i<3; i++) {
      const eL = Math.exp(-lam[i]*t);
      const eK = Math.exp(-ke0*t);
      cp += A[i]*eL;
      ce += A[i]*ke0/(ke0-lam[i])*(eL - eK);
    }
    cp *= doseMg/V1;
    ce *= doseMg/V1;
    results.push({time:tMin, Cp:cp, Ce:ce});
  }
  return results;
}

/**
 * Analytical constant infusion response.
 * Cp(t) = (R/V1) · Σ A_i/λ_i·(1 - exp(-λ_i·t))
 * Ce(t) = (R/V1) · Σ A_i·ke0/((ke0-λ_i)·λ_i)·((1-exp(-λ_i·t)) - λ_i/ke0·(1-exp(-ke0·t)))
 */
function analyticalInfusion(params, rateMgMin, timesMin) {
  const k10=params.k10/60, k12=params.k12/60, k13=params.k13/60;
  const k21=params.k21/60, k31=params.k31/60, ke0=params.ke0/60;
  const V1=params.V1;
  const rateMgSec = rateMgMin/60;
  const lam = cube(k10,k12,k21,k13,k31);
  const A = [];
  for (let i=0; i<3; i++) {
    let num=(k21-lam[i])*(k31-lam[i]), den=1;
    for(let j=0;j<3;j++) if(j!==i) den*=(lam[j]-lam[i]);
    A[i]=num/den;
  }
  const results = [];
  for (const tMin of timesMin) {
    const t = tMin*60;
    let cp=0, ce=0;
    for (let i=0; i<3; i++) {
      cp += A[i]/lam[i]*(1-Math.exp(-lam[i]*t));
      ce += A[i]*ke0/((ke0-lam[i])*lam[i])*((1-Math.exp(-lam[i]*t)) - lam[i]/ke0*(1-Math.exp(-ke0*t)));
    }
    cp *= rateMgSec/V1;
    ce *= rateMgSec/V1;
    results.push({time:tMin, Cp:cp, Ce:ce});
  }
  return results;
}

/**
 * SimTIVA tick-based UDF simulation (1-second ticks, exactly as pharmacology.js
 * does). The gold-standard reference — replicates SimTIVA's actual compute loop.
 */
function simtivaTickSim(params, rateMgSec, durationSec) {
  const k10=params.k10/60, k12=params.k12/60, k13=params.k13/60;
  const k21=params.k21/60, k31=params.k31/60, ke0=params.ke0/60;
  const V1=params.V1;
  const lam = cube(k10,k12,k21,k13,k31);
  const k41 = ke0;
  const p_coef = [];
  p_coef[0] = (k21-lam[0])*(k31-lam[0])/((lam[0]-lam[1])*(lam[0]-lam[2]))/V1/lam[0];
  p_coef[1] = (k21-lam[1])*(k31-lam[1])/((lam[1]-lam[0])*(lam[1]-lam[2]))/V1/lam[1];
  p_coef[2] = (k21-lam[2])*(k31-lam[2])/((lam[2]-lam[0])*(lam[2]-lam[1]))/V1/lam[2];
  const e_coef = [];
  e_coef[0] = p_coef[0]/(k41-lam[0])*k41;
  e_coef[1] = p_coef[1]/(k41-lam[1])*k41;
  e_coef[2] = p_coef[2]/(k41-lam[2])*k41;
  e_coef[3] = (k41-k21)*(k41-k31)/((lam[0]-k41)*(lam[1]-k41)*(lam[2]-k41))/V1;
  const l1=Math.exp(-lam[0]), l2=Math.exp(-lam[1]), l3=Math.exp(-lam[2]), l4=Math.exp(-k41);
  let pt1=0, pt2=0, pt3=0;
  let et1=0, et2=0, et3=0, et4=0;
  const snapshots = [];
  for (let t=1; t<=durationSec; t++) {
    pt1 = pt1*l1 + p_coef[0]*(1-l1)*rateMgSec;
    pt2 = pt2*l2 + p_coef[1]*(1-l2)*rateMgSec;
    pt3 = pt3*l3 + p_coef[2]*(1-l3)*rateMgSec;
    const Cp = pt1 + pt2 + pt3;
    et1 = et1*l1 + e_coef[0]*(1-l1)*rateMgSec;
    et2 = et2*l2 + e_coef[1]*(1-l2)*rateMgSec;
    et3 = et3*l3 + e_coef[2]*(1-l3)*rateMgSec;
    et4 = et4*l4 + e_coef[3]*(1-l4)*rateMgSec;
    const Ce = et1 + et2 + et3 + et4;
    snapshots.push({t, Cp, Ce});
  }
  return snapshots;
}

// ============ SIMTIVA PARAMETER CALCULATOR (reference oracle, exact from pharmacology.js) ============
function simtiva_fsigmoid(x,y,z){return Math.pow(x,z)/(Math.pow(x,z)+Math.pow(y,z))}
function simtiva_params(age, mass, height, gender, opioid) {
  const toweeks = 52.1429;
  const PMA = age * toweeks + 40;
  const bmi = mass / Math.pow(height/100, 2);
  function fclmaturation(x){return simtiva_fsigmoid(x,42.3,9.06)}
  function fq3maturation(x){return simtiva_fsigmoid(x+40,68.3,1)}
  function fcentral(x){return simtiva_fsigmoid(x,33.6,1)}
  function fageing(x){return Math.exp(x*(age-35))}
  function fffm(){
    if(gender==0)return(0.88+(1-0.88)/(1+Math.pow(age/13.4,-12.7)))*((9270*mass)/(6680+216*bmi));
    return(1.11+(1-1.11)/(1+Math.pow(age/7.1,-1.1)))*((9270*mass)/(8780+244*bmi));
  }
  const ffmref=(0.88+(1-0.88)/(1+Math.pow(35/13.4,-12.7)))*((9270*70)/(6680+216*24.22145));
  const vc=6.28*fcentral(mass)/fcentral(70);
  const v2=25.5*mass/70*fageing(-0.0156);
  const v2ref=25.5;
  let v3;
  if(opioid==1){v3=273*fffm()/ffmref*Math.exp(-0.0138*age)}
  else{v3=273*fffm()/ffmref}
  const v3ref=273;
  let cl1;
  if(gender==0){
    cl1=opioid==1?1.79*Math.pow(mass/70,0.75)*(fclmaturation(PMA)/fclmaturation(35*toweeks+40))*Math.exp(-0.00286*age)
                  :1.79*Math.pow(mass/70,0.75)*(fclmaturation(PMA)/fclmaturation(35*toweeks+40));
  }else{
    cl1=opioid==1?2.1*Math.pow(mass/70,0.75)*(fclmaturation(PMA)/fclmaturation(35*toweeks+40))*Math.exp(-0.00286*age)
                  :2.1*Math.pow(mass/70,0.75)*(fclmaturation(PMA)/fclmaturation(35*toweeks+40));
  }
  const cl2=1.75*Math.pow(v2/v2ref,0.75)*(1+1.3*(1-fq3maturation(age*toweeks)));
  const cl3=1.11*Math.pow(v3/v3ref,0.75)*(fq3maturation(age*toweeks)/fq3maturation(35*toweeks));
  const ke0=0.146*Math.pow(mass/70,-0.25);
  return{V1:vc,V2:v2,V3:v3,CL:cl1,Q2:cl2,Q3:cl3,ke0,
    k10:cl1/vc,k12:cl2/vc,k13:cl3/vc,k21:cl2/v2,k31:cl3/v3};
}

// k10..k31 (per-min) from a params object that only carries V/CL/Q — the
// analytical solver needs the rate constants. Uses the identity CL/V1 = k10.
function withRateConstants(p) {
  return { ...p, k10:p.CL/p.V1, k12:p.Q2/p.V1, k13:p.Q3/p.V1, k21:p.Q2/p.V2, k31:p.Q3/p.V3 };
}

let passed=0, failed=0;
function assert(c, m) { if(c){passed++;console.log(`  ✓ ${m}`)} else {failed++;console.error(`  ✗ ${m}`)} }

const testCases = [
  {name:'Reference male 35y/70kg/170cm no-opioid', age:35,weight:70,height:170,male:true,gender:0,opioid:0},
  {name:'Female 35y/70kg/170cm no-opioid',          age:35,weight:70,height:170,male:false,gender:1,opioid:0},
  {name:'Elderly male 75y/70kg/170cm no-opioid',    age:75,weight:70,height:170,male:true,gender:0,opioid:0},
  {name:'Male 35y/70kg/170cm with-opioid',          age:35,weight:70,height:170,male:true,gender:0,opioid:1},
  {name:'Obese male 45y/120kg/175cm no-opioid',     age:45,weight:120,height:175,male:true,gender:0,opioid:0},
  {name:'Elderly female 70y/55kg/160cm with-opioid', age:70,weight:55,height:160,male:false,gender:1,opioid:1},
  {name:'Young male 20y/80kg/180cm no-opioid',      age:20,weight:80,height:180,male:true,gender:0,opioid:0},
];

(async () => {
  const { createEngine } = await import(u('js/pk/engine.js'));
  const { calcEleveldParams } = await import(u('js/pk/eleveld.js'));

  // ===== STEP 1: REAL Eleveld vs SimTIVA parameter oracle =====
  console.log('\n===== STEP 1: Parameter Calculator Validation (real eleveld.js vs SimTIVA) =====\n');
  for (const tc of testCases) {
    const st = simtiva_params(tc.age, tc.weight, tc.height, tc.gender, tc.opioid);
    const ours = calcEleveldParams({ age:tc.age, weight:tc.weight, height:tc.height, male:tc.male, opioid:!!tc.opioid });
    let allMatch = true;
    const details = [];
    for (const p of ['V1','V2','V3','CL','Q2','Q3','ke0']) {
      const rel = Math.abs(st[p]-ours[p]) / Math.max(Math.abs(st[p]),0.001) * 100;
      if (rel > 0.1) { allMatch=false; details.push(`${p}: ST=${st[p].toFixed(4)} Ours=${ours[p].toFixed(4)} (${rel.toFixed(2)}%)`); }
    }
    if (allMatch) { console.log(`  ✓ ${tc.name}`); passed++; }
    else { console.log(`  ✗ ${tc.name}`); failed++; for(const d of details) console.log(`      ${d}`); }
  }

  // ===== STEP 2: Bolus concentration curves (analytical oracle vs REAL engine) =====
  console.log('\n===== STEP 2: Bolus Concentration Curves =====');
  console.log('  Independent analytical eigenvalue solution vs the real matrix-exp engine\n');
  function testBolus(label, params, doseMg) {
    const sampleTimes = [0.5, 1, 2, 5, 10, 20, 30, 60];
    const analytical = analyticalBolus(params, doseMg, sampleTimes);
    let maxCpErr=0, maxCeErr=0;
    for (const pt of analytical) {
      const eng = createEngine(params);
      const bolusDur = 1/60; // 1 second in minutes
      eng.advance(bolusDur, doseMg/bolusDur);
      if (pt.time > bolusDur) eng.advance(pt.time - bolusDur, 0);
      const ours = eng.getConcentrations();
      const cpErr = pt.Cp > 0.001 ? Math.abs(ours.Cp-pt.Cp)/pt.Cp*100 : 0;
      const ceErr = pt.Ce > 0.001 ? Math.abs(ours.Ce-pt.Ce)/pt.Ce*100 : 0;
      if (pt.time >= 1 && cpErr > maxCpErr) maxCpErr = cpErr;
      if (pt.time >= 1 && ceErr > maxCeErr) maxCeErr = ceErr;
    }
    console.log(`  ${label}: ${doseMg}mg bolus — max err (t≥1m): Cp=${maxCpErr.toFixed(3)}%, Ce=${maxCeErr.toFixed(3)}%`);
    assert(maxCpErr < 1.0, `${label}: Bolus Cp within 1% for t≥1min`);
    assert(maxCeErr < 1.0, `${label}: Bolus Ce within 1% for t≥1min`);
  }
  testBolus('Ref male no-opioid', simtiva_params(35,70,170,0,0), 100);
  testBolus('Elderly female opioid', simtiva_params(70,55,160,1,1), 50);
  testBolus('Young male', simtiva_params(20,80,180,0,0), 150);

  // ===== STEP 3: Constant infusion curves =====
  console.log('\n===== STEP 3: Constant Infusion Curves =====\n');
  function testInfusion(label, params, rateMgMin) {
    const sampleTimes = [1, 2, 5, 10, 20, 30, 60];
    const analytical = analyticalInfusion(params, rateMgMin, sampleTimes);
    let maxCpErr=0, maxCeErr=0;
    for (const pt of analytical) {
      const eng = createEngine(params);
      eng.advance(pt.time, rateMgMin);
      const ours = eng.getConcentrations();
      const cpErr = pt.Cp > 0.001 ? Math.abs(ours.Cp-pt.Cp)/pt.Cp*100 : 0;
      const ceErr = pt.Ce > 0.001 ? Math.abs(ours.Ce-pt.Ce)/pt.Ce*100 : 0;
      if (cpErr > maxCpErr) maxCpErr = cpErr;
      if (ceErr > maxCeErr) maxCeErr = ceErr;
    }
    console.log(`  ${label}: ${rateMgMin} mg/min — max err: Cp=${maxCpErr.toFixed(4)}%, Ce=${maxCeErr.toFixed(4)}%`);
    assert(maxCpErr < 0.1, `${label}: Infusion Cp within 0.1%`);
    assert(maxCeErr < 0.1, `${label}: Infusion Ce within 0.1%`);
  }
  testInfusion('Ref male', simtiva_params(35,70,170,0,0), 2.0);
  testInfusion('Elderly female opioid', simtiva_params(70,55,160,1,1), 1.5);

  // ===== STEP 4: SimTIVA tick-based UDF comparison (gold standard vs REAL engine) =====
  console.log('\n===== STEP 4: SimTIVA Tick-Based UDF vs Real Engine =====\n');
  function testVsUDF(label, params, rateMgMin, durationMin) {
    const rateMgSec = rateMgMin/60;
    const durationSec = durationMin*60;
    const ticks = simtivaTickSim(params, rateMgSec, durationSec);
    const sampleSec = [60, 120, 300, 600, 1200, 1800, 3600].filter(s => s <= durationSec);
    let maxCpErr=0, maxCeErr=0;
    for (const tSec of sampleSec) {
      const udf = ticks[tSec-1];
      const eng = createEngine(params);
      eng.advance(tSec/60, rateMgMin);
      const ours = eng.getConcentrations();
      const cpErr = udf.Cp > 0.001 ? Math.abs(ours.Cp-udf.Cp)/udf.Cp*100 : 0;
      const ceErr = udf.Ce > 0.001 ? Math.abs(ours.Ce-udf.Ce)/udf.Ce*100 : 0;
      if (cpErr > maxCpErr) maxCpErr = cpErr;
      if (ceErr > maxCeErr) maxCeErr = ceErr;
    }
    console.log(`  ${label}: ${rateMgMin} mg/min for ${durationMin} min — max err: Cp=${maxCpErr.toFixed(4)}%, Ce=${maxCeErr.toFixed(4)}%`);
    assert(maxCpErr < 0.5, `${label}: UDF Cp within 0.5%`);
    assert(maxCeErr < 0.5, `${label}: UDF Ce within 0.5%`);
  }
  testVsUDF('Ref male no-opioid', simtiva_params(35,70,170,0,0), 2.0, 60);
  testVsUDF('Elderly female opioid', simtiva_params(70,55,160,1,1), 1.5, 60);
  testVsUDF('Obese male', simtiva_params(45,120,175,0,0), 3.0, 60);

  // ===== STEP 5: Rate-constant identity, on the REAL Eleveld params =====
  console.log('\n===== STEP 5: Rate-Constant Identity (CL/V = k) on real eleveld.js =====\n');
  {
    const p = withRateConstants(calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false }));
    const k10s=p.k10/60, k12s=p.k12/60, k13s=p.k13/60, k21s=p.k21/60, k31s=p.k31/60;
    const V1=p.V1, V2=p.V2, V3=p.V3;
    const CL_s=p.CL/60, Q2_s=p.Q2/60, Q3_s=p.Q3/60;
    const checks = [
      ['k10=CL/V1',  k10s, CL_s/V1],
      ['k12=Q2/V1',  k12s, Q2_s/V1],
      ['k21=Q2/V2',  k21s, Q2_s/V2],
      ['k13=Q3/V1',  k13s, Q3_s/V1],
      ['k31=Q3/V3',  k31s, Q3_s/V3],
    ];
    let maxErr = 0;
    for (const [name, expected, actual] of checks) {
      const err = Math.abs(expected-actual)/expected*100;
      if (err > maxErr) maxErr = err;
    }
    assert(maxErr < 0.001, 'All rate constants match within 0.001%');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
