/**
 * test-vs-simtiva.js — Complete cross-validation against SimTIVA
 * 
 * Step 1: Parameter calculator — compare all PK parameters across 7 patients
 * Step 2: Concentration curves — analytical eigenvalue solution vs our matrix-exp
 *         for bolus response (Cp and Ce) and constant infusion (Cp and Ce)
 * Step 3: Rate-constant identity check (CL/V1 = k10 etc.)
 * Step 4: UDF infusion comparison — SimTIVA's exact tick-based UDF approach
 *         vs our matrix-exp for a 1 mg/s constant infusion
 */

// ============ INLINE PK ENGINE (our matrix exponential solver) ============
const N=4;function mat4(){return new Float64Array(16)}function eye4(){const m=mat4();m[0]=m[5]=m[10]=m[15]=1;return m}
function mul4(A,B){const C=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++){let s=0;for(let k=0;k<N;k++)s+=A[i*N+k]*B[k*N+j];C[i*N+j]=s}return C}
function mulVec4(A,x){const y=new Float64Array(4);for(let i=0;i<N;i++){let s=0;for(let j=0;j<N;j++)s+=A[i*N+j]*x[j];y[i]=s}return y}
function add4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]+B[i];return C}
function sub4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]-B[i];return C}
function scale4(A,s){const B=mat4();for(let i=0;i<16;i++)B[i]=A[i]*s;return B}
function inv4(M){const a=new Float64Array(32);for(let i=0;i<N;i++){for(let j=0;j<N;j++)a[i*8+j]=M[i*N+j];a[i*8+(N+i)]=1}for(let col=0;col<N;col++){let mv=Math.abs(a[col*8+col]),mr=col;for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r}}if(mv<1e-15)return null;if(mr!==col)for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t}const p=a[col*8+col];for(let j=0;j<8;j++)a[col*8+j]/=p;for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j]}}const inv=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv}
function expm4(A){const c=[1,1/2,5/44,1/66,1/792,1/15840,1/665280];const nA=(()=>{let mx=0;for(let j=0;j<N;j++){let cs=0;for(let i=0;i<N;i++)cs+=Math.abs(A[i*N+j]);if(cs>mx)mx=cs}return mx})();let s=0;if(nA>0.5){s=Math.ceil(Math.log2(nA/0.5));if(s<0)s=0}const As=(s>0)?scale4(A,1/(1<<s)):A;const As2=mul4(As,As),As3=mul4(As,As2),As4=mul4(As2,As2),As5=mul4(As,As4),As6=mul4(As2,As4);const I=eye4();const powers=[I,As,As2,As3,As4,As5,As6];let Nm=mat4(),Dm=mat4();for(let k=0;k<=6;k++){const sg=(k%2===0)?1:-1;for(let i=0;i<16;i++){Nm[i]+=c[k]*powers[k][i];Dm[i]+=sg*c[k]*powers[k][i]}}const Di=inv4(Dm);if(!Di)return add4(I,A);let result=mul4(Di,Nm);for(let i=0;i<s;i++)result=mul4(result,result);return result}

function createEngine(p) {
  const { V1, V2, V3 } = p;
  // System matrix: state = [A1, A2, A3, Ce] where Ai = amount in compartment i
  // dA1/dt = -(CL+Q2+Q3)/V1*A1 + Q2/V2*A2 + Q3/V3*A3 + R  (R = infusion rate mg/min)
  // dA2/dt = Q2/V1*A1 - Q2/V2*A2
  // dA3/dt = Q3/V1*A1 - Q3/V3*A3
  // dCe/dt = ke0*(A1/V1 - Ce)  = ke0/V1*A1 - ke0*Ce
  const A = mat4();
  A[0]  = -(p.CL + p.Q2 + p.Q3) / V1;  A[1]  = p.Q2 / V2;   A[2]  = p.Q3 / V3;
  A[4]  = p.Q2 / V1;                     A[5]  = -p.Q2 / V2;
  A[8]  = p.Q3 / V1;                     A[10] = -p.Q3 / V3;
  A[12] = p.ke0 / V1;                    A[15] = -p.ke0;
  let st = new Float64Array(4);
  function adv(dt, R) {
    if (dt <= 0) return;
    const e = expm4(scale4(A, dt));
    const xH = mulVec4(e, st);
    if (R === 0) { st = xH; return; }
    const Ai = inv4(A);
    if (!Ai) { st = xH; return; }
    // Particular solution for constant input [R, 0, 0, 0]
    const M = mul4(Ai, sub4(e, eye4()));
    for (let i = 0; i < 4; i++) st[i] = xH[i] + M[i * 4] * R;
  }
  function gc() { return { Cp: st[0] / V1, C2: st[1] / V2, C3: st[2] / V3, Ce: st[3] }; }
  function setState(s) { st = new Float64Array(s); }
  function getState() { return new Float64Array(st); }
  return { advance: adv, getConcentrations: gc, setState, getState };
}

// ============ ANALYTICAL EIGENVALUE SOLVER ============
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
 * Analytical bolus response for 3-compartment + effect site
 * 
 * Cp(t) = (D/V1) * Σ A_i * exp(-λ_i * t)        for i=1..3
 * Ce(t) = (D/V1) * Σ A_i * ke0/(ke0-λ_i) * (exp(-λ_i*t) - exp(-ke0*t))
 * 
 * where A_i = (k21-λ_i)(k31-λ_i) / Π_{j≠i}(λ_j - λ_i)
 */
function analyticalBolus(params, doseMg, timesMin) {
  const k10=params.k10/60, k12=params.k12/60, k13=params.k13/60;
  const k21=params.k21/60, k31=params.k31/60, ke0=params.ke0/60;
  const V1=params.V1;
  const lam = cube(k10,k12,k21,k13,k31);
  
  // Macro-constants
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
 * Analytical constant infusion response
 * 
 * Cp(t) = (R/V1) * Σ A_i/λ_i * (1 - exp(-λ_i*t))
 * Ce(t) = (R/V1) * Σ A_i*ke0/((ke0-λ_i)*λ_i) * ((1-exp(-λ_i*t)) - λ_i/ke0*(1-exp(-ke0*t)))
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
 * SimTIVA tick-based UDF simulation (1-second ticks, exactly as pharmacology.js does)
 * This is the gold standard — replicates SimTIVA's actual compute loop
 */
function simtivaTickSim(params, rateMgSec, durationSec) {
  const k10=params.k10/60, k12=params.k12/60, k13=params.k13/60;
  const k21=params.k21/60, k31=params.k31/60, ke0=params.ke0/60;
  const V1=params.V1;
  
  const lam = cube(k10,k12,k21,k13,k31);
  const k41 = ke0;
  
  // SimTIVA's p_coef (for infusion UDF, includes /lambda)
  const p_coef = [];
  p_coef[0] = (k21-lam[0])*(k31-lam[0])/((lam[0]-lam[1])*(lam[0]-lam[2]))/V1/lam[0];
  p_coef[1] = (k21-lam[1])*(k31-lam[1])/((lam[1]-lam[0])*(lam[1]-lam[2]))/V1/lam[1];
  p_coef[2] = (k21-lam[2])*(k31-lam[2])/((lam[2]-lam[0])*(lam[2]-lam[1]))/V1/lam[2];
  
  // SimTIVA's e_coef (for infusion UDF)
  const e_coef = [];
  e_coef[0] = p_coef[0]/(k41-lam[0])*k41;
  e_coef[1] = p_coef[1]/(k41-lam[1])*k41;
  e_coef[2] = p_coef[2]/(k41-lam[2])*k41;
  e_coef[3] = (k41-k21)*(k41-k31)/((lam[0]-k41)*(lam[1]-k41)*(lam[2]-k41))/V1;
  
  const l1=Math.exp(-lam[0]), l2=Math.exp(-lam[1]), l3=Math.exp(-lam[2]), l4=Math.exp(-k41);
  
  // Tick-based UDF accumulation (exactly as in calculate_udfs lines 5544-5550)
  let pt1=0, pt2=0, pt3=0;
  let et1=0, et2=0, et3=0, et4=0;
  
  const snapshots = [];
  for (let t=1; t<=durationSec; t++) {
    // Each tick: infusing rateMgSec for 1 second
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

// ============ SIMTIVA PARAMETER CALCULATOR (exact from pharmacology.js) ============
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

// ============ OUR FIXED ELEVELD (aligned to SimTIVA) ============
function our_params_fixed(age, weight, height, male, opioid) {
  const toweeks=52.1429;
  const PMA=age*toweeks+40;
  const bmi=weight/Math.pow(height/100,2);
  function fsig(x,y,z){return Math.pow(x,z)/(Math.pow(x,z)+Math.pow(y,z))}
  function fclmat(x){return fsig(x,42.3,9.06)}
  function fq3mat(x){return fsig(x+40,68.3,1)}
  function fcentral(x){return fsig(x,33.6,1)}
  function fageing(x){return Math.exp(x*(age-35))}
  function fffm(){
    if(male)return(0.88+(1-0.88)/(1+Math.pow(age/13.4,-12.7)))*((9270*weight)/(6680+216*bmi));
    return(1.11+(1-1.11)/(1+Math.pow(age/7.1,-1.1)))*((9270*weight)/(8780+244*bmi));
  }
  const ffmref=(0.88+(1-0.88)/(1+Math.pow(35/13.4,-12.7)))*((9270*70)/(6680+216*24.22145));
  const V1=6.28*fcentral(weight)/fcentral(70);
  const V2=25.5*weight/70*fageing(-0.0156);
  const V2ref=25.5;
  let V3;
  if(opioid){V3=273*fffm()/ffmref*Math.exp(-0.0138*age)}
  else{V3=273*fffm()/ffmref}
  const V3ref=273;
  let CL;
  const clBase=male?1.79:2.1;
  if(opioid){CL=clBase*Math.pow(weight/70,0.75)*(fclmat(PMA)/fclmat(35*toweeks+40))*Math.exp(-0.00286*age)}
  else{CL=clBase*Math.pow(weight/70,0.75)*(fclmat(PMA)/fclmat(35*toweeks+40))}
  const Q2=1.75*Math.pow(V2/V2ref,0.75)*(1+1.3*(1-fq3mat(age*toweeks)));
  const Q3=1.11*Math.pow(V3/V3ref,0.75)*(fq3mat(age*toweeks)/fq3mat(35*toweeks));
  const ke0=0.146*Math.pow(weight/70,-0.25);
  return{V1,V2,V3,CL,Q2,Q3,ke0,
    k10:CL/V1,k12:Q2/V1,k13:Q3/V1,k21:Q2/V2,k31:Q3/V3};
}

// ============ TESTS ============
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

// ===== STEP 1: Parameter validation =====
console.log('\n===== STEP 1: Parameter Calculator Validation =====\n');

for (const tc of testCases) {
  const st = simtiva_params(tc.age, tc.weight, tc.height, tc.gender, tc.opioid);
  const ours = our_params_fixed(tc.age, tc.weight, tc.height, tc.male, !!tc.opioid);
  let allMatch = true;
  const details = [];
  for (const p of ['V1','V2','V3','CL','Q2','Q3','ke0']) {
    const rel = Math.abs(st[p]-ours[p]) / Math.max(Math.abs(st[p]),0.001) * 100;
    if (rel > 0.1) { allMatch=false; details.push(`${p}: ST=${st[p].toFixed(4)} Ours=${ours[p].toFixed(4)} (${rel.toFixed(2)}%)`); }
  }
  if (allMatch) { console.log(`  ✓ ${tc.name}`); passed++; }
  else { console.log(`  ✗ ${tc.name}`); failed++; for(const d of details) console.log(`      ${d}`); }
}

// ===== STEP 2: Bolus concentration curves =====
console.log('\n===== STEP 2: Bolus Concentration Curves =====');
console.log('  Analytical eigenvalue solution vs our matrix-exponential engine\n');

function testBolus(label, params, doseMg) {
  const sampleTimes = [0.5, 1, 2, 5, 10, 20, 30, 60];
  const analytical = analyticalBolus(params, doseMg, sampleTimes);
  
  console.log(`  ${label}: ${doseMg}mg bolus`);
  console.log(`  ${'Time'.padStart(7)}  ${'Anlt Cp'.padStart(10)} ${'Ours Cp'.padStart(10)} ${'Cp%'.padStart(7)}  ${'Anlt Ce'.padStart(10)} ${'Ours Ce'.padStart(10)} ${'Ce%'.padStart(7)}`);
  
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
    
    console.log(`  ${pt.time.toFixed(1).padStart(6)}m  ${pt.Cp.toFixed(4).padStart(10)} ${ours.Cp.toFixed(4).padStart(10)} ${cpErr.toFixed(3).padStart(6)}%  ${pt.Ce.toFixed(4).padStart(10)} ${ours.Ce.toFixed(4).padStart(10)} ${ceErr.toFixed(3).padStart(6)}%`);
  }
  
  console.log(`  Max err (t≥1m): Cp=${maxCpErr.toFixed(3)}%, Ce=${maxCeErr.toFixed(3)}%`);
  assert(maxCpErr < 1.0, `${label}: Bolus Cp within 1% for t≥1min`);
  assert(maxCeErr < 1.0, `${label}: Bolus Ce within 1% for t≥1min`);
  console.log();
}

{
  const p1 = simtiva_params(35,70,170,0,0);
  testBolus('Ref male no-opioid', p1, 100);
  
  const p2 = simtiva_params(70,55,160,1,1);
  testBolus('Elderly female opioid', p2, 50);
  
  const p3 = simtiva_params(20,80,180,0,0);
  testBolus('Young male', p3, 150);
}

// ===== STEP 3: Constant infusion curves =====
console.log('===== STEP 3: Constant Infusion Curves =====\n');

function testInfusion(label, params, rateMgMin) {
  const sampleTimes = [1, 2, 5, 10, 20, 30, 60];
  const analytical = analyticalInfusion(params, rateMgMin, sampleTimes);
  
  console.log(`  ${label}: ${rateMgMin} mg/min constant infusion`);
  console.log(`  ${'Time'.padStart(7)}  ${'Anlt Cp'.padStart(10)} ${'Ours Cp'.padStart(10)} ${'Cp%'.padStart(8)}  ${'Anlt Ce'.padStart(10)} ${'Ours Ce'.padStart(10)} ${'Ce%'.padStart(8)}`);
  
  let maxCpErr=0, maxCeErr=0;
  
  for (const pt of analytical) {
    const eng = createEngine(params);
    eng.advance(pt.time, rateMgMin);
    const ours = eng.getConcentrations();
    
    const cpErr = pt.Cp > 0.001 ? Math.abs(ours.Cp-pt.Cp)/pt.Cp*100 : 0;
    const ceErr = pt.Ce > 0.001 ? Math.abs(ours.Ce-pt.Ce)/pt.Ce*100 : 0;
    if (cpErr > maxCpErr) maxCpErr = cpErr;
    if (ceErr > maxCeErr) maxCeErr = ceErr;
    
    console.log(`  ${pt.time.toString().padStart(5)}m  ${pt.Cp.toFixed(4).padStart(10)} ${ours.Cp.toFixed(4).padStart(10)} ${cpErr.toFixed(4).padStart(7)}%  ${pt.Ce.toFixed(4).padStart(10)} ${ours.Ce.toFixed(4).padStart(10)} ${ceErr.toFixed(4).padStart(7)}%`);
  }
  
  console.log(`  Max err: Cp=${maxCpErr.toFixed(4)}%, Ce=${maxCeErr.toFixed(4)}%`);
  assert(maxCpErr < 0.1, `${label}: Infusion Cp within 0.1%`);
  assert(maxCeErr < 0.1, `${label}: Infusion Ce within 0.1%`);
  console.log();
}

{
  const p1 = simtiva_params(35,70,170,0,0);
  testInfusion('Ref male', p1, 2.0);
  
  const p2 = simtiva_params(70,55,160,1,1);
  testInfusion('Elderly female opioid', p2, 1.5);
}

// ===== STEP 4: SimTIVA tick-based UDF comparison =====
console.log('===== STEP 4: SimTIVA Tick-Based UDF vs Our Engine =====');
console.log('  This is the definitive test — compares against SimTIVA\'s actual compute loop\n');

function testVsUDF(label, params, rateMgMin, durationMin) {
  const rateMgSec = rateMgMin/60;
  const durationSec = durationMin*60;
  const ticks = simtivaTickSim(params, rateMgSec, durationSec);
  
  // Sample at specific time points
  const sampleSec = [60, 120, 300, 600, 1200, 1800, 3600].filter(s => s <= durationSec);
  
  console.log(`  ${label}: ${rateMgMin} mg/min for ${durationMin} min`);
  console.log(`  ${'Time'.padStart(7)}  ${'UDF Cp'.padStart(10)} ${'Ours Cp'.padStart(10)} ${'Cp%'.padStart(8)}  ${'UDF Ce'.padStart(10)} ${'Ours Ce'.padStart(10)} ${'Ce%'.padStart(8)}`);
  
  let maxCpErr=0, maxCeErr=0;
  
  for (const tSec of sampleSec) {
    const udf = ticks[tSec-1]; // 0-indexed, tick 1 is index 0
    
    const eng = createEngine(params);
    eng.advance(tSec/60, rateMgMin); // convert seconds to minutes
    const ours = eng.getConcentrations();
    
    const cpErr = udf.Cp > 0.001 ? Math.abs(ours.Cp-udf.Cp)/udf.Cp*100 : 0;
    const ceErr = udf.Ce > 0.001 ? Math.abs(ours.Ce-udf.Ce)/udf.Ce*100 : 0;
    if (cpErr > maxCpErr) maxCpErr = cpErr;
    if (ceErr > maxCeErr) maxCeErr = ceErr;
    
    const tMin = tSec/60;
    console.log(`  ${tMin.toFixed(1).padStart(6)}m  ${udf.Cp.toFixed(4).padStart(10)} ${ours.Cp.toFixed(4).padStart(10)} ${cpErr.toFixed(4).padStart(7)}%  ${udf.Ce.toFixed(4).padStart(10)} ${ours.Ce.toFixed(4).padStart(10)} ${ceErr.toFixed(4).padStart(7)}%`);
  }
  
  console.log(`  Max err: Cp=${maxCpErr.toFixed(4)}%, Ce=${maxCeErr.toFixed(4)}%`);
  assert(maxCpErr < 0.5, `${label}: UDF Cp within 0.5%`);
  assert(maxCeErr < 0.5, `${label}: UDF Ce within 0.5%`);
  console.log();
}

{
  const p1 = simtiva_params(35,70,170,0,0);
  testVsUDF('Ref male no-opioid', p1, 2.0, 60);
  
  const p2 = simtiva_params(70,55,160,1,1);
  testVsUDF('Elderly female opioid', p2, 1.5, 60);
  
  const p3 = simtiva_params(45,120,175,0,0);
  testVsUDF('Obese male', p3, 3.0, 60);
}

// ===== STEP 5: Rate-constant cross-check =====
console.log('===== STEP 5: Rate-Constant Identity (CL/V = k) =====\n');
{
  const p = simtiva_params(35,70,170,0,0);
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
    console.log(`  ${name.padEnd(12)} expected=${expected.toFixed(10)} actual=${actual.toFixed(10)} err=${err.toFixed(8)}%`);
  }
  assert(maxErr < 0.001, 'All rate constants match within 0.001%');
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
