/**
 * test-tci-scheme.js — Tests for clinician-feasible TCI scheme planner
 */

// ============ INLINE PK ENGINE (same boilerplate) ============
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
function calcParams(pt){const{age:a,weight:w,height:h,male:m,opioid:o}=pt;const bmi=w/Math.pow(h/100,2);const ffm=fatFreeMass(w,h,a,m);const pma=(a*52)+40;const of=o?1:0;const WR=70,AR=35;const V1=TH.V1*(sigmoid(w,TH.V1_E50_WGT,1)/sigmoid(WR,TH.V1_E50_WGT,1));const V2=TH.V2*(w/WR)*Math.exp(TH.V2_aging*(a-AR));const fr=fatFreeMass(WR,170,AR,true);const V3=TH.V3*(ffm/fr)*Math.exp(of*TH.V3_aging_opioid*(a-AR));const cm=sigmoid(pma,TH.CL_mat_PMA50,TH.CL_mat_hill)/sigmoid((AR*52+40),TH.CL_mat_PMA50,TH.CL_mat_hill);const CL=TH.CL*Math.pow(w/WR,0.75)*cm*(m?1:TH.CL_female)*Math.exp(of*TH.CL_aging_opioid*(a-AR));const Q2=TH.Q2*Math.pow(V2/TH.V2,0.75);const q3m=sigmoid(a,TH.Q3_mat_AGE50,TH.Q3_mat_hill)/sigmoid(AR,TH.Q3_mat_AGE50,TH.Q3_mat_hill);const Q3=TH.Q3*Math.pow(V3/TH.V3,0.75)*(m?1:q3m);const ke0=TH.ke0_ref*Math.pow(w/WR,TH.ke0_wgt_exp);return{V1,V2,V3,CL,Q2,Q3,ke0}}
function buildSysMat(p){const{V1,V2,V3,CL,Q2,Q3,ke0}=p;const A=mat4();A[0]=-(CL+Q2+Q3)/V1;A[1]=Q2/V2;A[2]=Q3/V3;A[4]=Q2/V1;A[5]=-Q2/V2;A[8]=Q3/V1;A[10]=-Q3/V3;A[12]=ke0/V1;A[15]=-ke0;return A}
function createEngine(p){const A=buildSysMat(p);const{V1,V2,V3}=p;let st=new Float64Array(4);function adv(dt,R){if(dt<=0)return;const e=expm4(scale4(A,dt));const xH=mulVec4(e,st);if(R===0){st=xH;return}const Ai=inv4(A);if(!Ai){st=xH;return}const M=mul4(Ai,sub4(e,eye4()));for(let i=0;i<4;i++)st[i]=xH[i]+M[i*4]*R}function gc(){return{Cp:st[0]/V1,C2:st[1]/V2,C3:st[2]/V3,Ce:st[3],A1:st[0],A2:st[1],A3:st[2]}}function pCe(dt,R){const s=new Float64Array(st);adv(dt,R);const ce=st[3];st=s;return ce}function reset(){st=new Float64Array(4)}function getState(){return new Float64Array(st)}function setState(s){st=new Float64Array(s)}function getSystemMatrix(){return new Float64Array(A)}return{advance:adv,getConcentrations:gc,predictCe:pCe,reset,getState,setState,getSystemMatrix,get params(){return p}}}

// ============ INLINE STEADY-STATE RATE ============
function computeSteadyStateRate(engine, ceTarget) {
  if (ceTarget <= 0) return null;
  const A = engine.getSystemMatrix();
  const Ainv = inv4(A);
  if (!Ainv) return null;
  const cePerRate = -Ainv[3 * 4 + 0];
  if (cePerRate <= 0) return null;
  return ceTarget / cePerRate;
}

// ============ INLINE TCI PLANNER ============
function planTCIScheme(engine, startState, startTime, ceTarget, config={}) {
  const cfg={tolerancePct:0.05,maxRate:200,maxSteps:12,maxPlanTime:480,simStep:0.1,rateSearchIter:35,minStepDuration:3.0,rateStablePct:0.05,...config};
  const scheme=[];
  if(ceTarget<=0){scheme.push({type:'rate',time:startTime,value:0});return scheme}
  const saved=engine.getState();engine.setState(startState);
  const currentCe=engine.getConcentrations().Ce;
  const upper=ceTarget*(1+cfg.tolerancePct),lower=ceTarget*(1-cfg.tolerancePct);
  let simTime=startTime;

  // Loading bolus
  if(currentCe<lower){
    const bolusMg=calcBolus(engine,ceTarget,cfg);
    if(bolusMg>0){scheme.push({type:'bolus',time:simTime,value:bolusMg});engine.advance(0.05,bolusMg/0.05);simTime+=0.05}
  }

  // Rate steps
  let prevRate=-1;
  for(let step=0;step<cfg.maxSteps;step++){
    if(simTime>=startTime+cfg.maxPlanTime)break;
    const rate=findRate(engine,ceTarget,cfg,step);
    if(prevRate>0&&Math.abs(rate-prevRate)/prevRate<cfg.rateStablePct){scheme.push({type:'rate',time:simTime,value:rate});break}
    scheme.push({type:'rate',time:simTime,value:rate});prevRate=rate;
    const stepEnd=runUntilDrift(engine,ceTarget,rate,simTime,cfg);simTime=stepEnd;
    if(simTime>=startTime+cfg.maxPlanTime)break;
  }
  // Append terminal rates for V3 equilibration
  if(ceTarget>0&&scheme.length>0){
    const lr=scheme[scheme.length-1];
    if(lr.type==='rate'){
      const LONG_LA=300;const fs=engine.getState();
      let lo2=0,hi2=cfg.maxRate;
      for(let i=0;i<30;i++){const mid=(lo2+hi2)/2;engine.setState(fs);engine.advance(LONG_LA,mid);if(engine.getConcentrations().Ce<ceTarget)lo2=mid;else hi2=mid}
      engine.setState(fs);const ltRate=(lo2+hi2)/2;
      if(Math.abs(ltRate-lr.value)/lr.value>0.005)scheme.push({type:'rate',time:simTime,value:ltRate});
      const ssRate=computeSteadyStateRate(engine,ceTarget);
      const cl=scheme[scheme.length-1];
      if(ssRate!=null&&Math.abs(ssRate-cl.value)/cl.value>0.005)scheme.push({type:'rate',time:simTime+LONG_LA,value:ssRate});
    }
  }
  engine.setState(saved);return scheme;
}

function calcBolus(engine,ceTarget,cfg){
  const saved=engine.getState();let lo=0,hi=ceTarget*engine.params.V1*3;
  for(let i=0;i<cfg.rateSearchIter;i++){
    const mid=(lo+hi)/2;engine.setState(saved);engine.advance(0.05,mid/0.05);
    let peak=0;for(let t=0;t<15;t+=0.25){engine.advance(0.25,0);const ce=engine.getConcentrations().Ce;if(ce>peak)peak=ce;else if(ce<peak-0.001)break}
    if(Math.abs(peak-ceTarget)<0.01){engine.setState(saved);return mid}
    if(peak<ceTarget)lo=mid;else hi=mid;
  }
  engine.setState(saved);return(lo+hi)/2;
}

function findRate(engine,ceTarget,cfg,stepNum){
  const saved=engine.getState();let lo=0,hi=cfg.maxRate;
  // Early steps: short lookahead (5 min) to compensate for redistribution
  // Later steps: longer lookahead converging toward true maintenance
  const lookAhead = Math.min(5 + stepNum * 5, 60);
  for(let i=0;i<cfg.rateSearchIter;i++){
    const mid=(lo+hi)/2;engine.setState(saved);engine.advance(lookAhead,mid);
    const ce=engine.getConcentrations().Ce;
    if(Math.abs(ce-ceTarget)<0.001){engine.setState(saved);return mid}
    if(ce<ceTarget)lo=mid;else hi=mid;
  }
  engine.setState(saved);return(lo+hi)/2;
}

function runUntilDrift(engine,ceTarget,rate,fromTime,cfg){
  const upper=ceTarget*(1+cfg.tolerancePct),lower=ceTarget*(1-cfg.tolerancePct);
  let t=fromTime,minReached=false;
  const maxEnd=fromTime+cfg.maxPlanTime;
  while(t<maxEnd){
    engine.advance(cfg.simStep,rate);t+=cfg.simStep;
    if(t-fromTime>=cfg.minStepDuration)minReached=true;
    if(minReached){const ce=engine.getConcentrations().Ce;if(ce>upper||ce<lower)return t}
  }
  return t;
}

// ============ TESTS ============
let passed=0,failed=0;
function assert(c,m){if(c){passed++;console.log(`  ✓ ${m}`)}else{failed++;console.error(`  ✗ ${m}`)}}

const params=calcParams({age:35,weight:70,height:170,male:true,opioid:false});
const CONC=10; // mg/mL

function fmtScheme(scheme,wgt){
  for(const s of scheme){
    if(s.type==='bolus'){
      console.log(`    ${s.time.toFixed(1)} min: BOLUS ${s.value.toFixed(1)} mg (${(s.value/wgt).toFixed(2)} mg/kg)`);
    }else{
      const mlh=(s.value/CONC)*60;
      console.log(`    ${s.time.toFixed(1)} min: RATE ${mlh.toFixed(1)} mL/h (${s.value.toFixed(2)} mg/min)`);
    }
  }
}

console.log('\n=== TEST 1: Basic Scheme Generation (Ce=3.0, ±5%) ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0);
  
  console.log(`  Generated ${scheme.length} steps:`);
  fmtScheme(scheme,70);
  
  assert(scheme.length>=2,'At least bolus + 1 rate step');
  assert(scheme.length<=10,'No more than 10 steps (clinician feasible)');
  assert(scheme[0].type==='bolus','First step is a bolus');
  assert(scheme[0].value>50,'Bolus > 50mg for 70kg patient targeting 3.0');
  assert(scheme[0].value<300,'Bolus < 300mg (reasonable)');
  
  // Rates should be decreasing over time
  const rates=scheme.filter(s=>s.type==='rate').map(s=>s.value);
  if(rates.length>=2){
    assert(rates[0]>rates[rates.length-1],'Rates decrease over time (distribution compensation)');
  }
}

console.log('\n=== TEST 2: Verify Concentrations During Maintenance ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0, {tolerancePct:0.05});
  
  // Find when the last rate step starts
  const lastRateEvt=scheme.filter(s=>s.type==='rate').pop();
  const checkFrom=lastRateEvt?lastRateEvt.time+5:15; // 5 min after last step settles
  
  // Replay the scheme
  eng.reset();
  let currentRate=0, simTime=0, evtIdx=0;
  let maxDeviation=0, worstTime=0;
  
  for(let t=0;t<60;t+=0.1){
    while(evtIdx<scheme.length&&scheme[evtIdx].time<=t){
      const evt=scheme[evtIdx];
      const dt=evt.time-simTime;
      if(dt>0){eng.advance(dt,currentRate);simTime=evt.time}
      if(evt.type==='bolus'){eng.advance(0.05,evt.value/0.05);simTime+=0.05}
      else{currentRate=evt.value}
      evtIdx++;
    }
    const dt=t-simTime;
    if(dt>0){eng.advance(dt,currentRate);simTime=t}
    
    const ce=eng.getConcentrations().Ce;
    if(t>checkFrom){
      const dev=Math.abs(ce-3.0)/3.0;
      if(dev>maxDeviation){maxDeviation=dev;worstTime=t}
    }
  }
  
  console.log(`  Checking from t=${checkFrom.toFixed(1)} min onward`);
  console.log(`  Max Ce deviation during maintenance: ${(maxDeviation*100).toFixed(1)}% at t=${worstTime.toFixed(1)} min`);
  assert(maxDeviation<0.15,'Ce stays within 15% during maintenance phase');
}

console.log('\n=== TEST 3: Tight Tolerance (±2%) ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0, {tolerancePct:0.02});
  
  console.log(`  Tight scheme: ${scheme.length} steps`);
  fmtScheme(scheme,70);
  
  // Tighter tolerance should produce more steps
  const eng2=createEngine(params);
  const loosScheme=planTCIScheme(eng2, eng2.getState(), 0, 3.0, {tolerancePct:0.10});
  
  console.log(`  Loose scheme: ${loosScheme.length} steps`);
  assert(scheme.length>=loosScheme.length,'Tighter tolerance → same or more steps');
}

console.log('\n=== TEST 4: Loose Tolerance (±10%) ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0, {tolerancePct:0.10});
  
  console.log(`  Loose scheme: ${scheme.length} steps`);
  fmtScheme(scheme,70);
  
  assert(scheme.length<=8,'Loose tolerance produces few steps');
}

console.log('\n=== TEST 5: Bolus Dose Is Reasonable ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0);
  const bolus=scheme[0];
  
  const mgKg=bolus.value/70;
  console.log(`  Bolus: ${bolus.value.toFixed(1)} mg = ${mgKg.toFixed(2)} mg/kg`);
  
  // Standard propofol induction: 1.5-2.5 mg/kg
  assert(mgKg>0.5,'Bolus > 0.5 mg/kg');
  assert(mgKg<5.0,'Bolus < 5.0 mg/kg');
}

console.log('\n=== TEST 6: Scheme From Non-Zero State (Target Change) ===');
{
  const eng=createEngine(params);
  // Run at Ce≈2.0 for a while
  eng.advance(0.05, 80/0.05); // bolus 80mg
  eng.advance(20, 1.0); // 20 min at 1 mg/min
  const state=eng.getState();
  const ce=eng.getConcentrations().Ce;
  console.log(`  Starting Ce: ${ce.toFixed(3)} μg/mL`);
  
  // Now plan scheme to Ce=4.0 (step up)
  const scheme=planTCIScheme(eng, state, 20, 4.0);
  console.log(`  Step-up scheme (2→4): ${scheme.length} steps`);
  fmtScheme(scheme,70);
  
  assert(scheme.length>=2,'Has bolus + rate steps for step-up');
  // Should have a bolus since we're below target
  const hasBolus=scheme.some(s=>s.type==='bolus');
  assert(hasBolus,'Step-up includes a bolus');
}

console.log('\n=== TEST 7: Step-Down (No Bolus Needed) ===');
{
  const eng=createEngine(params);
  // Bring Ce to ~4.0
  eng.advance(0.05, 120/0.05);
  for(let i=0;i<120;i++){
    // Quick TCI-like approach
    const ce=eng.getConcentrations().Ce;
    const rate=ce<4?eng.params.CL*4:eng.params.CL*4*0.5;
    eng.advance(10/60, rate);
  }
  const state=eng.getState();
  const ce=eng.getConcentrations().Ce;
  console.log(`  Starting Ce: ${ce.toFixed(3)} (target was ~4.0)`);

  // Step down to 2.0
  const scheme=planTCIScheme(eng, state, 20, 2.0);
  console.log(`  Step-down scheme: ${scheme.length} steps`);
  fmtScheme(scheme,70);

  // Should NOT have a bolus
  const hasBolus=scheme.some(s=>s.type==='bolus');
  assert(!hasBolus,'Step-down has no bolus');
  // First rate should be low or zero (let Ce decay)
  if(scheme.length>0&&scheme[0].type==='rate'){
    assert(scheme[0].value<eng.params.CL*3,'First rate is low/zero for step-down');
  }
}

console.log('\n=== TEST 8: Engine State Preserved ===');
{
  const eng=createEngine(params);
  eng.advance(10, 2.0);
  const before=new Float64Array(eng.getState());
  planTCIScheme(eng, eng.getState(), 10, 3.0);
  const after=eng.getState();
  let ok=true;
  for(let i=0;i<4;i++){if(Math.abs(before[i]-after[i])>1e-10){ok=false;break}}
  assert(ok,'Engine state preserved after planning');
}

console.log('\n=== TEST 9: Long-Duration Drift — Ce stays within ±5% at t=300,600,900 min ===');
{
  const ceTarget = 3.0;
  const eng = createEngine(params);
  const scheme = planTCIScheme(eng, eng.getState(), 0, ceTarget);

  console.log(`  Scheme: ${scheme.length} steps`);
  fmtScheme(scheme, 70);

  // Replay scheme forward to 900 minutes
  eng.reset();
  let currentRate = 0, simTime = 0, evtIdx = 0;
  const checkTimes = [300, 600, 900];
  const results = {};

  for (let t = 0; t <= 900; t += 0.5) {
    while (evtIdx < scheme.length && scheme[evtIdx].time <= t) {
      const evt = scheme[evtIdx];
      const dt = evt.time - simTime;
      if (dt > 0) { eng.advance(dt, currentRate); simTime = evt.time; }
      if (evt.type === 'bolus') { eng.advance(0.05, evt.value / 0.05); simTime += 0.05; }
      else { currentRate = evt.value; }
      evtIdx++;
    }
    const dt = t - simTime;
    if (dt > 0) { eng.advance(dt, currentRate); simTime = t; }

    if (checkTimes.includes(t)) {
      const ce = eng.getConcentrations().Ce;
      const dev = (ce - ceTarget) / ceTarget;
      results[t] = { ce, dev };
      console.log(`  t=${t} min: Ce=${ce.toFixed(4)}, deviation=${(dev*100).toFixed(2)}%`);
    }
  }

  for (const t of checkTimes) {
    const { dev } = results[t];
    assert(Math.abs(dev) < 0.05, `Ce within ±5% at t=${t} min (actual: ${(dev*100).toFixed(2)}%)`);
  }
}

console.log('\n=== TEST 10: Analytical SS Rate Matches True Steady State ===');
{
  const ceTarget = 3.5;
  const eng = createEngine(params);
  const ssRate = computeSteadyStateRate(eng, ceTarget);
  console.log(`  SS rate for Ce=${ceTarget}: ${ssRate.toFixed(4)} mg/min (${(ssRate/10*60).toFixed(1)} mL/h)`);

  // Verify: run engine at ssRate for 2000 min (>>V3 tau), check Ce ≈ ceTarget
  eng.reset();
  eng.advance(2000, ssRate);
  const ce = eng.getConcentrations().Ce;
  const dev = Math.abs(ce - ceTarget) / ceTarget;
  console.log(`  Ce at t=2000 min: ${ce.toFixed(4)} (deviation: ${(dev*100).toFixed(4)}%)`);
  assert(dev < 0.005, `SS rate converges Ce to target within 0.5% (actual: ${(dev*100).toFixed(4)}%)`);
}

console.log('\n=== TEST 11: SS Rate Event Is Emitted In Scheme ===');
{
  const ceTarget = 3.0;
  const eng = createEngine(params);
  const scheme = planTCIScheme(eng, eng.getState(), 0, ceTarget);
  const rates = scheme.filter(s => s.type === 'rate');

  // The last rate should be close to the analytical SS rate
  const ssRate = computeSteadyStateRate(eng, ceTarget);
  const lastRate = rates[rates.length - 1].value;
  const dev = Math.abs(lastRate - ssRate) / ssRate;
  console.log(`  Last emitted rate: ${lastRate.toFixed(4)} mg/min`);
  console.log(`  Analytical SS rate: ${ssRate.toFixed(4)} mg/min`);
  console.log(`  Deviation: ${(dev*100).toFixed(2)}%`);
  assert(dev < 0.02, `Last emitted rate within 2% of analytical SS rate (actual: ${(dev*100).toFixed(2)}%)`);
}

// ---- SUMMARY ----
console.log(`\n${'='.repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed>0?1:0);
