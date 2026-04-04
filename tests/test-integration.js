/**
 * test-integration.js — End-to-end integration test
 * 
 * Validates the full module chain: setPatient → planTCI → computeCurve
 * → verify concentration curve has realistic pharmacokinetic shape.
 * 
 * This test exercises all modules wired together through createModel(),
 * not in isolation. It serves as a regression anchor before app.js
 * starts layering DOM code on top.
 */

// ============ INLINE DEPENDENCIES ============
// Full math, engine, pd, eleveld, events, tci-planner, simulation

const N=4;
function mat4(){return new Float64Array(16)}
function eye4(){const m=mat4();m[0]=m[5]=m[10]=m[15]=1;return m}
function mul4(A,B){const C=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++){let s=0;for(let k=0;k<N;k++)s+=A[i*N+k]*B[k*N+j];C[i*N+j]=s}return C}
function mulVec4(A,x){const y=new Float64Array(4);for(let i=0;i<N;i++){let s=0;for(let j=0;j<N;j++)s+=A[i*N+j]*x[j];y[i]=s}return y}
function add4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]+B[i];return C}
function sub4(A,B){const C=mat4();for(let i=0;i<16;i++)C[i]=A[i]-B[i];return C}
function scale4(A,s){const B=mat4();for(let i=0;i<16;i++)B[i]=A[i]*s;return B}
function inv4(M){const a=new Float64Array(32);for(let i=0;i<N;i++){for(let j=0;j<N;j++)a[i*8+j]=M[i*N+j];a[i*8+(N+i)]=1}for(let col=0;col<N;col++){let mv=Math.abs(a[col*8+col]),mr=col;for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r}}if(mv<1e-15)return null;if(mr!==col)for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t}const p=a[col*8+col];for(let j=0;j<8;j++)a[col*8+j]/=p;for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j]}}const inv=mat4();for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv}
function expm4(A){const c=[1,1/2,5/44,1/66,1/792,1/15840,1/665280];const nA=(()=>{let mx=0;for(let j=0;j<N;j++){let cs=0;for(let i=0;i<N;i++)cs+=Math.abs(A[i*N+j]);if(cs>mx)mx=cs}return mx})();let s=0;if(nA>0.5){s=Math.ceil(Math.log2(nA/0.5));if(s<0)s=0}const As=(s>0)?scale4(A,1/(1<<s)):A;const As2=mul4(As,As),As3=mul4(As,As2),As4=mul4(As2,As2),As5=mul4(As,As4),As6=mul4(As2,As4);const I=eye4();const powers=[I,As,As2,As3,As4,As5,As6];let Nm=mat4(),Dm=mat4();for(let k=0;k<=6;k++){const sg=(k%2===0)?1:-1;for(let i=0;i<16;i++){Nm[i]+=c[k]*powers[k][i];Dm[i]+=sg*c[k]*powers[k][i]}}const Di=inv4(Dm);if(!Di)return add4(I,A);let result=mul4(Di,Nm);for(let i=0;i<s;i++)result=mul4(result,result);return result}

function createEngine(p){
  const{V1,V2,V3}=p;
  const A=mat4();
  A[0]=-(p.CL+p.Q2+p.Q3)/V1;A[1]=p.Q2/V2;A[2]=p.Q3/V3;
  A[4]=p.Q2/V1;A[5]=-p.Q2/V2;
  A[8]=p.Q3/V1;A[10]=-p.Q3/V3;
  A[12]=p.ke0/V1;A[15]=-p.ke0;
  let st=new Float64Array(4);
  return{
    advance(dt,R){if(dt<=0)return;const e=expm4(scale4(A,dt));const xH=mulVec4(e,st);if(R===0){st=xH;return}const Ai=inv4(A);if(!Ai){st=xH;return}const M=mul4(Ai,sub4(e,eye4()));for(let i=0;i<4;i++)st[i]=xH[i]+M[i*4]*R},
    getConcentrations(){return{Cp:st[0]/V1,C2:st[1]/V2,C3:st[2]/V3,Ce:st[3],A1:st[0],A2:st[1],A3:st[2]}},
    getState(){return new Float64Array(st)},
    setState(s){st=new Float64Array(s)},
    reset(){st=new Float64Array(4)},
    get params(){return p},
  };
}

// Inline Eleveld (reference male, corrected PD)
function calcEleveldParams(pt){
  const{age,weight,height,male,opioid}=pt;
  const bmi=weight/Math.pow(height/100,2);
  const fsig=(x,y,z)=>Math.pow(x,z)/(Math.pow(x,z)+Math.pow(y,z));
  const fcentral=x=>fsig(x,33.6,1);
  const V1=6.28*fcentral(weight)/fcentral(70);
  const V2=25.5*weight/70*Math.exp(-0.0156*(age-35));
  const toweeks=52.1429;
  const ffm=male?(0.88+(1-0.88)/(1+Math.pow(age/13.4,-12.7)))*((9270*weight)/(6680+216*bmi)):(1.11+(1-1.11)/(1+Math.pow(age/7.1,-1.1)))*((9270*weight)/(8780+244*bmi));
  const ffmref=(0.88+(1-0.88)/(1+Math.pow(35/13.4,-12.7)))*((9270*70)/(6680+216*24.22145));
  const V3=opioid?273*ffm/ffmref*Math.exp(-0.0138*age):273*ffm/ffmref;
  const PMA=age*toweeks+40;const PMA_REF=35*toweeks+40;
  const fclmat=x=>fsig(x,42.3,9.06);
  const fq3mat=x=>fsig(x+40,68.3,1);
  const clBase=male?1.79:2.1;
  let CL=clBase*Math.pow(weight/70,0.75)*(fclmat(PMA)/fclmat(PMA_REF));
  if(opioid)CL*=Math.exp(-0.00286*age);
  const Q2=1.75*Math.pow(V2/25.5,0.75)*(1+1.3*(1-fq3mat(age*toweeks)));
  const Q3=1.11*Math.pow(V3/273,0.75)*(fq3mat(age*toweeks)/fq3mat(35*toweeks));
  const ke0=0.146*Math.pow(weight/70,-0.25);
  const Ce50=3.08*Math.exp(-0.00635*(age-35))*Math.exp(-0.567*(opioid?1:0));
  return{V1,V2,V3,CL,Q2,Q3,ke0,Ce50,gamma1:1.89,gamma2:1.47,BIS_baseline:93,
    k10:CL/V1,k12:Q2/V1,k21:Q2/V2,k13:Q3/V1,k31:Q3/V3,patient:pt};
}

// Inline event list (stateless, matching refactored events.js)
let _nid=1;
function genId(){return'evt_'+String(_nid++).padStart(5,'0')}
function createEvt(drug,time,type,value,opts={}){return{id:genId(),drug,time,type,value,source:opts.source||'manual',annotation:opts.annotation||'',snapshot:null}}
function createEventList(){
  let events=[];const engines={};
  function registerEngine(d,e){engines[d]=e}
  function getEngine(d){return engines[d]||null}
  function insert(e){let idx=events.length;for(let i=events.length-1;i>=0;i--){if(events[i].time<=e.time){idx=i+1;break}if(i===0)idx=0}events.splice(idx,0,e);return e}
  function getAll(){return[...events]}
  function getByDrug(d){return events.filter(e=>e.drug===d)}
  function clearAfter(d,t){const b=events.length;events=events.filter(e=>!(e.drug===d&&e.time>t));if(b!==events.length)replayDrug(d);return b-events.length}
  function clearAll(){events=[];_nid=1;for(const d of Object.keys(engines))engines[d].reset()}
  function getActiveRateForDrug(d,bi){for(let i=bi;i>=0;i--){if(events[i].drug!==d)continue;if(events[i].type==='rate')return events[i].value;if(events[i].type==='pause')return 0}return 0}
  function getRateAtTime(d,time){let r=0;for(const e of events){if(e.drug!==d)continue;if(e.time>time)break;if(e.type==='rate')r=e.value;else if(e.type==='pause')r=0}return r}
  function replayDrug(d){const eng=engines[d];if(!eng)return;eng.reset();let ct=0,cr=0;for(const evt of events){if(evt.drug!==d)continue;const dt=evt.time-ct;if(dt>0)eng.advance(dt,cr);ct=evt.time;if(evt.type==='bolus'){eng.advance(0.05,evt.value/0.05);ct+=0.05}else if(evt.type==='rate')cr=evt.value;else if(evt.type==='pause')cr=0;evt.snapshot=eng.getState()}}
  function replayAll(){for(const d of Object.keys(engines))replayDrug(d)}
  function getConcentrationsAt(d,time){const eng=engines[d];if(!eng)return{Cp:0,Ce:0,C2:0,C3:0,rate:0,time};let le=null,li=-1;for(let i=events.length-1;i>=0;i--){if(events[i].drug===d&&events[i].time<=time){le=events[i];li=i;break}}if(!le){eng.reset();if(time>0)eng.advance(time,0);return{...eng.getConcentrations(),rate:0,time}}if(!le.snapshot)replayDrug(d);eng.setState(le.snapshot);let ct=le.time;if(le.type==='bolus')ct+=0.05;const cr=getActiveRateForDrug(d,li);const dt=time-ct;if(dt>0)eng.advance(dt,cr);return{...eng.getConcentrations(),rate:cr,time}}
  function computeCurve(d,startTime,endTime,step=10/60){const eng=engines[d];if(!eng)return[];const devts=events.filter(e=>e.drug===d);const curve=[];eng.reset();let ct=0,cr=0,ep=0;while(ep<devts.length&&devts[ep].time<=startTime){const e=devts[ep];const dt=e.time-ct;if(dt>0)eng.advance(dt,cr);ct=e.time;if(e.type==='bolus'){eng.advance(0.05,e.value/0.05);ct+=0.05}else if(e.type==='rate')cr=e.value;else if(e.type==='pause')cr=0;ep++}if(startTime>ct){eng.advance(startTime-ct,cr);ct=startTime}let st=startTime;while(st<=endTime){while(ep<devts.length&&devts[ep].time<=st){const e=devts[ep];const dt=e.time-ct;if(dt>0)eng.advance(dt,cr);ct=e.time;if(e.type==='bolus'){eng.advance(0.05,e.value/0.05);ct+=0.05}else if(e.type==='rate')cr=e.value;else if(e.type==='pause')cr=0;ep++}const dt=st-ct;if(dt>0){eng.advance(dt,cr);ct=st}const c=eng.getConcentrations();curve.push({time:st,Cp:c.Cp,Ce:c.Ce,C2:c.C2,C3:c.C3,rate:cr});st+=step}return curve}
  function getStateAtTime(d,time){getConcentrationsAt(d,time);return engines[d]?engines[d].getState():new Float64Array(4)}
  function getStateAtLastEvent(d){for(let i=events.length-1;i>=0;i--){if(events[i].drug===d&&events[i].snapshot)return{state:events[i].snapshot,time:events[i].time}}return{state:engines[d]?engines[d].getState():new Float64Array(4),time:0}}
  function addRate(d,time,rate,ann){const e=createEvt(d,time,'rate',rate,{annotation:ann||''});insert(e);replayDrug(d);return e}
  function addBolus(d,time,mg,ann){const pr=getRateAtTime(d,time);const be=createEvt(d,time,'bolus',mg,{annotation:ann||''});insert(be);const re=createEvt(d,time+0.05,'rate',pr,{source:'system',annotation:'Rate restored'});insert(re);replayDrug(d);return be}
  function addRateBatch(d,steps,ann){const created=[];for(const s of steps){const e=createEvt(d,s.time,'rate',s.rate,{source:'tci',annotation:ann||''});insert(e);created.push(e)}if(created.length>0)replayDrug(d);return created}
  return{registerEngine,getEngine,insert,getAll,getByDrug,clearAfter,clearAll,replayDrug,replayAll,getConcentrationsAt,computeCurve,getRateAtTime,getActiveRateForDrug,getStateAtLastEvent,getStateAtTime,addRate,addBolus,addRateBatch,get length(){return events.length},get raw(){return events}};
}

// Inline TCI planner (simplified — generates bolus + rate steps)
function planTCIScheme(engine, startState, startTime, ceTarget, config={}) {
  const cfg = { tolerancePct: 0.05, maxRate: 200, maxSteps: 8, maxPlanTime: 120,
    simStep: 0.1, rateSearchIter: 35, minStepDuration: 3.0, rateStablePct: 0.05, ...config };
  const scheme = [];
  if (ceTarget <= 0) { scheme.push({ type: 'rate', time: startTime, value: 0 }); return scheme; }
  const saved = engine.getState();
  engine.setState(startState);
  const currentCe = engine.getConcentrations().Ce;
  let simTime = startTime;
  // Loading bolus if needed
  if (currentCe < ceTarget * (1 - cfg.tolerancePct)) {
    // Binary search for bolus dose
    let lo = 0, hi = 500;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const sv = engine.getState();
      engine.advance(0.05, mid / 0.05);
      // Scan forward for Ce peak
      let peakCe = 0;
      for (let t = 0; t < 300; t++) { engine.advance(cfg.simStep, 0); const ce = engine.getConcentrations().Ce; if (ce > peakCe) peakCe = ce; else break; }
      engine.setState(sv);
      if (peakCe < ceTarget) lo = mid; else hi = mid;
    }
    const bolusMg = Math.round((lo + hi) / 2 * 10) / 10;
    if (bolusMg > 0) {
      scheme.push({ type: 'bolus', time: simTime, value: bolusMg });
      engine.advance(0.05, bolusMg / 0.05);
      simTime += 0.05;
    }
  }
  // Find maintenance rate by binary search
  function findRate() {
    let lo = 0, hi = cfg.maxRate;
    for (let i = 0; i < cfg.rateSearchIter; i++) {
      const mid = (lo + hi) / 2;
      const ce = engine.predictCe ? engine.predictCe(cfg.minStepDuration, mid) : (() => {
        const sv = engine.getState(); engine.advance(cfg.minStepDuration, mid);
        const ce = engine.getConcentrations().Ce; engine.setState(sv); return ce;
      })();
      if (ce < ceTarget) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  // Generate a few rate steps
  let prevRate = -1;
  for (let step = 0; step < cfg.maxSteps; step++) {
    if (simTime >= startTime + cfg.maxPlanTime) break;
    const rate = findRate();
    if (prevRate > 0 && Math.abs(rate - prevRate) / prevRate < cfg.rateStablePct) {
      scheme.push({ type: 'rate', time: simTime, value: rate });
      break;
    }
    scheme.push({ type: 'rate', time: simTime, value: rate });
    prevRate = rate;
    // Advance at this rate until Ce drifts
    const sv = engine.getState();
    let dur = 0;
    while (dur < cfg.maxPlanTime) {
      engine.advance(cfg.simStep, rate);
      dur += cfg.simStep;
      const ce = engine.getConcentrations().Ce;
      if (dur >= cfg.minStepDuration && (ce > ceTarget * (1 + cfg.tolerancePct) || ce < ceTarget * (1 - cfg.tolerancePct))) break;
    }
    simTime += dur;
  }
  engine.setState(saved);
  return scheme;
}

// Inline PD
function predictBIS(Ce, p) {
  if (Ce <= 0) return p.BIS_baseline;
  const g = Ce <= p.Ce50 ? p.gamma1 : p.gamma2;
  const r = Ce / p.Ce50;
  const rg = Math.pow(r, g);
  const effect = rg / (1 + rg);
  return Math.max(0, Math.min(100, p.BIS_baseline * (1 - effect)));
}

// ============ MINI createModel (matching refactored simulation.js) ============
function createModel(config = {}) {
  const cfg = { primaryDrug: 'propofol', ...config };
  let eventList = createEventList();
  let pdModels = {};
  let patient = { age: 35, weight: 70, height: 170, male: true, opioid: false };
  let params = null;

  function init() {
    params = calcEleveldParams(patient);
    eventList.registerEngine(cfg.primaryDrug, createEngine(params));
    pdModels[cfg.primaryDrug] = { Ce50: params.Ce50, gamma1: params.gamma1, gamma2: params.gamma2, BIS_baseline: params.BIS_baseline };
  }
  init();

  function setPatient(p) {
    patient = { ...patient, ...p };
    params = calcEleveldParams(patient);
    const old = eventList.getEngine(cfg.primaryDrug);
    const sv = old ? old.getState() : null;
    const ne = createEngine(params);
    if (sv) ne.setState(sv);
    eventList.registerEngine(cfg.primaryDrug, ne);
    pdModels[cfg.primaryDrug] = { Ce50: params.Ce50, gamma1: params.gamma1, gamma2: params.gamma2, BIS_baseline: params.BIS_baseline };
    eventList.replayAll();
    return params;
  }

  function planTCI(drugId, fromTime, ceTarget, tciConfig = {}) {
    const engine = eventList.getEngine(drugId);
    if (!engine) return { scheme: [], events: [] };
    eventList.clearAfter(drugId, fromTime);
    const startState = eventList.getStateAtTime(drugId, fromTime);
    const scheme = planTCIScheme(engine, startState, fromTime, ceTarget, tciConfig);
    const bolus = scheme.find(s => s.type === 'bolus');
    if (bolus) eventList.addBolus(drugId, bolus.time, bolus.value, `TCI bolus Ce=${ceTarget.toFixed(1)}`);
    const rateSteps = scheme.filter(s => s.type === 'rate').map(s => ({ time: s.time, rate: s.value }));
    const inserted = eventList.addRateBatch(drugId, rateSteps, `TCI Ce=${ceTarget.toFixed(1)}`);
    return { scheme, events: inserted };
  }

  return {
    setPatient, getPatient: () => ({ ...patient }), getParams: () => params,
    addRate: (d, t, r, a) => eventList.addRate(d, t, r, a),
    addBolus: (d, t, m, a) => eventList.addBolus(d, t, m, a),
    planTCI, clearAfter: (d, t) => eventList.clearAfter(d, t),
    getConcentrationsAt: (d, t) => eventList.getConcentrationsAt(d, t),
    computeCurve: (d, s, e, st) => eventList.computeCurve(d, s, e, st),
    predictBIS: (d, t) => { const pd = pdModels[d]; if (!pd) return null; const c = eventList.getConcentrationsAt(d, t); return predictBIS(c.Ce, pd); },
    getEvents: (d) => d ? eventList.getByDrug(d) : eventList.getAll(),
    get primaryDrug() { return cfg.primaryDrug; },
    reset() { eventList.clearAll(); pdModels = {}; init(); },
  };
}

// ============ TESTS ============
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

console.log('\n===== 1. Full Chain: setPatient → planTCI → computeCurve =====\n');

{
  const model = createModel();
  model.setPatient({ age: 50, weight: 80, height: 175, male: true, opioid: true });

  const params = model.getParams();
  ok(params.V1 > 0, `Params computed: V1=${params.V1.toFixed(2)}`);
  ok(params.Ce50 > 0, `Ce50=${params.Ce50.toFixed(3)}`);

  // Plan TCI at Ce=3.0 from t=0
  const { scheme } = model.planTCI('propofol', 0, 3.0);
  ok(scheme.length >= 2, `TCI scheme has ${scheme.length} steps (bolus + rates)`);

  const bolus = scheme.find(s => s.type === 'bolus');
  ok(bolus !== undefined, `Scheme includes a loading bolus`);
  ok(bolus.value > 50 && bolus.value < 300, `Bolus dose reasonable: ${bolus.value.toFixed(1)} mg`);

  // Compute curve for 30 minutes at 10-second resolution
  const curve = model.computeCurve('propofol', 0, 30, 10/60);
  ok(curve.length > 100, `Curve has ${curve.length} points (30 min @ 10s)`);
}

console.log('\n===== 2. Curve Shape: PK Pharmacology =====\n');

{
  const model = createModel();
  // Standard reference patient, no opioid
  const { scheme } = model.planTCI('propofol', 0, 3.0);
  const curve = model.computeCurve('propofol', 0, 30, 10/60);

  // Peak Cp should be near bolus dose / V1
  const params = model.getParams();
  const bolus = scheme.find(s => s.type === 'bolus');
  const expectedPeakCp = bolus ? bolus.value / params.V1 : 0;
  const actualPeakCp = Math.max(...curve.map(p => p.Cp));
  ok(actualPeakCp > expectedPeakCp * 0.5, `Peak Cp (${actualPeakCp.toFixed(1)}) reasonable vs dose/V1 (${expectedPeakCp.toFixed(1)})`);

  // Ce should lag Cp — at t=0.5 min, Cp > Ce
  const early = curve.find(p => p.time >= 0.5);
  if (early) {
    ok(early.Cp > early.Ce, `At t=0.5 min: Cp (${early.Cp.toFixed(2)}) > Ce (${early.Ce.toFixed(2)}) — Ce lags`);
  }

  // Ce should approach target by 15 min
  const at15 = curve.find(p => p.time >= 15);
  if (at15) {
    ok(Math.abs(at15.Ce - 3.0) < 0.5, `At t=15 min: Ce (${at15.Ce.toFixed(2)}) near target 3.0`);
  }

  // Cp should decrease after bolus (redistribution)
  const at1 = curve.find(p => p.time >= 1);
  const at5 = curve.find(p => p.time >= 5);
  if (at1 && at5) {
    ok(at5.Cp < at1.Cp, `Cp at 5 min (${at5.Cp.toFixed(2)}) < Cp at 1 min (${at1.Cp.toFixed(2)}) — redistribution`);
  }

  // Rate should decrease over time (stepped down by TCI scheme)
  const significantRates = curve.filter(p => p.rate > 1.0).map(p => p.rate);
  const firstSignificantRate = significantRates[0];
  const lastSignificantRate = significantRates[significantRates.length - 1];
  ok(lastSignificantRate < firstSignificantRate, `Rate decreases: first=${firstSignificantRate.toFixed(1)} → last=${lastSignificantRate.toFixed(1)} mg/min`);
}

console.log('\n===== 3. BIS Prediction Along Curve =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  // BIS at t=0 should be baseline (93)
  const bis0 = model.predictBIS('propofol', 0);
  ok(bis0 > 90, `BIS at t=0: ${bis0.toFixed(1)} (near baseline 93)`);

  // BIS at t=10 should be in anaesthetic range (below 60)
  const bis10 = model.predictBIS('propofol', 10);
  ok(bis10 < 60, `BIS at t=10 min: ${bis10.toFixed(1)} (anaesthetic range)`);

  // BIS at t=15 should be near target BIS (~47 at Ce=Ce50, lower at Ce=3.0)
  const bis15 = model.predictBIS('propofol', 15);
  ok(bis15 > 20 && bis15 < 60, `BIS at t=15 min: ${bis15.toFixed(1)} (in clinical range 20-60)`);
}

console.log('\n===== 4. Target Change Mid-Case =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  // Get Ce at 10 min
  const c10 = model.getConcentrationsAt('propofol', 10);

  // Change target to 4.0 at t=10
  model.planTCI('propofol', 10, 4.0);

  // Get curve from 10 to 30
  const curve = model.computeCurve('propofol', 10, 30, 10/60);

  // Ce should rise toward 4.0
  const at25 = curve.find(p => p.time >= 25);
  ok(at25.Ce > c10.Ce, `After target increase: Ce at 25 min (${at25.Ce.toFixed(2)}) > Ce at 10 min (${c10.Ce.toFixed(2)})`);
  ok(Math.abs(at25.Ce - 4.0) < 1.0, `Ce approaching new target 4.0 (got ${at25.Ce.toFixed(2)})`);
}

console.log('\n===== 5. Manual Bolus During TCI =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  const ceBefore = model.getConcentrationsAt('propofol', 5).Ce;

  // Give manual bolus at t=5, then clear future TCI events
  model.addBolus('propofol', 5, 50, 'Manual rescue bolus');
  model.clearAfter('propofol', 5.05); // keep bolus + rate restore, clear TCI future

  const ceAfter = model.getConcentrationsAt('propofol', 5.1).Ce;
  ok(ceAfter > ceBefore, `Bolus at t=5 raises Ce: before=${ceBefore.toFixed(2)}, after=${ceAfter.toFixed(2)}`);

  // Rate should be restored to what it was before bolus
  const events = model.getEvents('propofol');
  const restore = events.find(e => e.source === 'system' && e.time > 5);
  ok(restore !== undefined, 'Rate-restore event exists after bolus');
  ok(restore.value > 0, `Restored rate is ${restore.value.toFixed(2)} mg/min (not zero)`);
}

console.log('\n===== 6. Elderly Patient — Age-Adjusted PD =====\n');

{
  const model = createModel();
  model.setPatient({ age: 75, weight: 60, height: 165, male: false, opioid: true });

  const params = model.getParams();

  // Ce50 should be lower for elderly + opioid
  ok(params.Ce50 < 2.0, `Elderly+opioid Ce50=${params.Ce50.toFixed(3)} (should be <2.0)`);

  // Plan TCI at Ce=2.0 (appropriate for elderly)
  model.planTCI('propofol', 0, 2.0);

  // BIS at 15 min should be in anaesthetic range
  const bis = model.predictBIS('propofol', 15);
  ok(bis > 20 && bis < 60, `Elderly BIS at t=15: ${bis.toFixed(1)} (anaesthetic range)`);

  // Bolus dose should be smaller than for reference patient
  const events = model.getEvents('propofol');
  const bolus = events.find(e => e.type === 'bolus');
  ok(bolus.value < 150, `Elderly bolus dose: ${bolus.value.toFixed(1)} mg (should be modest)`);
}

console.log('\n===== 7. computeCurve Resolution Check =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  // Default 10-second step for 30 min → 181 points
  const curve10s = model.computeCurve('propofol', 0, 30, 10/60);
  ok(curve10s.length >= 180, `10s step: ${curve10s.length} points for 30 min`);

  // 1-minute step → 31 points
  const curve1m = model.computeCurve('propofol', 0, 30, 1.0);
  ok(curve1m.length === 31, `1 min step: ${curve1m.length} points for 30 min`);

  // Both should give similar Ce at t=15
  const ce10s = curve10s.find(p => Math.abs(p.time - 15) < 0.1);
  const ce1m = curve1m.find(p => p.time === 15);
  const diff = Math.abs(ce10s.Ce - ce1m.Ce);
  ok(diff < 0.05, `Ce at t=15 agrees between resolutions: diff=${diff.toFixed(4)}`);
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
