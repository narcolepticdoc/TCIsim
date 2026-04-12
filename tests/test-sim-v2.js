/**
 * test-sim-v2.js — Tests for the event-driven simulation controller
 * 
 * Tests the rewritten simulation.js that uses events.js + tci-planner.js
 * instead of the old tick-based tci.js approach.
 */

// ============ INLINE DEPENDENCIES ============
// (Minified versions of math, engine, pd, events, tci-planner, decay-predictor)

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
    predictCe(dt,R){const sv=new Float64Array(st);this.advance(dt,R);const ce=st[3];st=sv;return ce},
    getState(){return new Float64Array(st)},
    setState(s){st=new Float64Array(s)},
    reset(){st=new Float64Array(4)},
    get params(){return p},
  };
}

// Mini event system (from events.js)
let _nid=1;
function createEvt(drug,time,type,value,opts={}){return{id:'e'+(_nid++),drug,time,type,value,status:opts.status||'executed',source:opts.source||'manual',snapshot:null,annotation:opts.annotation||''}}
function createEventList(){
  let events=[];const engines={};
  function registerEngine(d,e){engines[d]=e}
  function getEngine(d){return engines[d]||null}
  function insert(e){let idx=events.length;for(let i=events.length-1;i>=0;i--){if(events[i].time<=e.time){idx=i+1;break}if(i===0)idx=0}events.splice(idx,0,e);return e}
  function getByDrug(d){return events.filter(e=>e.drug===d)}
  function getPlanned(d){return events.filter(e=>e.status==='planned'&&(!d||e.drug===d))}
  function clearPlanned(d){if(d)events=events.filter(e=>!(e.status==='planned'&&e.drug===d));else events=events.filter(e=>e.status!=='planned')}
  function clearAll(){events=[];_nid=1;for(const d of Object.keys(engines))engines[d].reset()}
  function getActiveRateForDrug(d,beforeIdx){for(let i=beforeIdx;i>=0;i--){if(events[i].drug!==d)continue;if(events[i].type==='rate')return events[i].value;if(events[i].type==='pause')return 0}return 0}
  function getRateAtTime(d,time){let r=0;for(const e of events){if(e.drug!==d)continue;if(e.time>time)break;if(e.type==='rate')r=e.value;else if(e.type==='pause')r=0}return r}
  function replayDrug(d){const eng=engines[d];if(!eng)return;eng.reset();let ct=0,cr=0;for(const evt of events){if(evt.drug!==d)continue;const dt=evt.time-ct;if(dt>0)eng.advance(dt,cr);ct=evt.time;if(evt.type==='bolus'){eng.advance(0.05,evt.value/0.05);ct+=0.05}else if(evt.type==='rate')cr=evt.value;else if(evt.type==='pause')cr=0;evt.snapshot=eng.getState()}}
  function getConcentrationsAt(d,time){const eng=engines[d];if(!eng)return{Cp:0,Ce:0,C2:0,C3:0,rate:0};let le=null,li=-1;for(let i=events.length-1;i>=0;i--){if(events[i].drug===d&&events[i].time<=time){le=events[i];li=i;break}}if(!le)return{Cp:0,Ce:0,C2:0,C3:0,rate:0};if(!le.snapshot)replayDrug(d);eng.setState(le.snapshot);let ct=le.time;if(le.type==='bolus')ct+=0.05;const cr=getActiveRateForDrug(d,li);const dt=time-ct;if(dt>0)eng.advance(dt,cr);return{...eng.getConcentrations(),rate:cr}}
  function promoteEvents(t,d){const p=[];for(const e of events){if(e.status!=='planned')continue;if(d&&e.drug!==d)continue;if(e.time<=t){e.status='executed';p.push(e)}}return p}
  function addManualRate(d,time,rate,ann){clearPlanned(d);const e=createEvt(d,time,'rate',rate,{annotation:ann||''});insert(e);replayDrug(d);return e}
  function addManualBolus(d,time,mg,ann){const pr=getRateAtTime(d,time);clearPlanned(d);const be=createEvt(d,time,'bolus',mg,{annotation:ann||''});insert(be);const re=createEvt(d,time+0.05,'rate',pr,{source:'system',annotation:'Rate restored'});insert(re);replayDrug(d);return be}
  function addTCIplan(d,steps,ann){clearPlanned(d);const created=[];for(const s of steps){const e=createEvt(d,s.time,'rate',s.rate,{status:'planned',source:'tci',annotation:ann||''});insert(e);created.push(e)}if(created.length>0)replayDrug(d);return created}
  function getLastExecutedState(d){for(let i=events.length-1;i>=0;i--){if(events[i].drug===d&&events[i].status==='executed'&&events[i].snapshot)return{state:events[i].snapshot,time:events[i].time}}return{state:engines[d]?new Float64Array(4):new Float64Array(4),time:0}}
  function editEvent(id,changes){const evt=events.find(e=>e.id===id);if(!evt)return null;const d=evt.drug;clearPlanned(d);if(changes.value!=null)evt.value=changes.value;if(changes.time!=null){const idx=events.indexOf(evt);if(idx!==-1)events.splice(idx,1);evt.time=changes.time;insert(evt)}replayDrug(d);return evt}
  function deleteEvent(id){const evt=events.find(e=>e.id===id);if(!evt)return null;const d=evt.drug;const idx=events.indexOf(evt);if(idx!==-1)events.splice(idx,1);clearPlanned(d);replayDrug(d);return evt}
  function getAll(){return[...events]}
  return{registerEngine,getEngine,insert,getByDrug,getPlanned,clearPlanned,clearAll,replayDrug,getConcentrationsAt,promoteEvents,addManualRate,addManualBolus,addTCIplan,getLastExecutedState,editEvent,deleteEvent,getAll,getRateAtTime,get length(){return events.length},get raw(){return events}};
}

// Mini PD model
function createPDModel(p){
  function effect(Ce){const g=Ce<p.Ce50?p.gamma1:p.gamma2;return Math.pow(Ce,g)/(Math.pow(Ce,g)+Math.pow(p.Ce50,g))}
  function predict(Ce){return p.BIS_baseline*(1-effect(Ce))}
  return{effect,predict};
}

// Mini Eleveld (reference male only, for testing)
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
  const Ce50=3.08*Math.exp(-0.00635*(age-35));
  return{V1,V2,V3,CL,Q2,Q3,ke0,Ce50,gamma1:1.47,gamma2:1.89,BIS_baseline:93,patient:pt};
}

// ============ SIMULATION (UNDER TEST) ============
// Inline the new simulation.js logic to test it standalone

const SimState={READY:'READY',RUNNING:'RUNNING',PAUSED:'PAUSED'};
const DrugMode={TCI:'tci',MANUAL:'manual',BOLUS:'bolus'};

function createDrugState(drugId){return{drugId,mode:DrugMode.MANUAL,ceTarget:0,bolusConfig:{dose:0,troughCe:0},tciConfig:{}}}

function createSimulation(config={}){
  const cfg={tickInterval:1000,tickStep:10/60,maxSimTime:480,concentration:10,...config};
  let state=SimState.READY,simTime=0;
  let eventList=null,pdModels={},drugStates={};
  let patient={age:35,weight:70,height:170,male:true,opioid:false},params=null;
  const listeners={};

  function on(ev,cb){if(!listeners[ev])listeners[ev]=[];listeners[ev].push(cb)}
  function emit(ev,data){if(!listeners[ev])return;for(const cb of listeners[ev])try{cb(data)}catch(e){}}

  function setPatient(p){patient={...patient,...p};recalcParams()}
  function getPatient(){return{...patient}}
  function recalcParams(){
    params=calcEleveldParams(patient);
    if(eventList){const old=eventList.getEngine('propofol');if(old){const sv=old.getState();const ne=createEngine(params);ne.setState(sv);eventList.registerEngine('propofol',ne)}}
    pdModels.propofol=createPDModel({Ce50:params.Ce50,gamma1:params.gamma1,gamma2:params.gamma2,BIS_baseline:params.BIS_baseline});
    emit('paramChange',{params,patient});
  }

  function init(){
    params=calcEleveldParams(patient);
    eventList=createEventList();
    eventList.registerEngine('propofol',createEngine(params));
    drugStates.propofol=createDrugState('propofol');
    pdModels.propofol=createPDModel({Ce50:params.Ce50,gamma1:params.gamma1,gamma2:params.gamma2,BIS_baseline:params.BIS_baseline});
    simTime=0;
  }

  function start(){if(state===SimState.RUNNING)return;if(state===SimState.READY)init();state=SimState.RUNNING;emit('stateChange',{state})}
  function pause(){if(state!==SimState.RUNNING)return;state=SimState.PAUSED;emit('stateChange',{state})}
  function resume(){if(state!==SimState.PAUSED)return;state=SimState.RUNNING;emit('stateChange',{state})}
  function reset(){if(eventList)eventList.clearAll();simTime=0;drugStates={};pdModels={};eventList=null;state=SimState.READY;emit('stateChange',{state})}

  // Manual tick (no setInterval — tests drive this directly)
  function manualTick(){
    if(state!==SimState.RUNNING)return null;
    if(simTime>=cfg.maxSimTime){pause();return null}
    simTime+=cfg.tickStep;
    eventList.promoteEvents(simTime);
    const drugData={};
    for(const d of Object.keys(drugStates)){
      const conc=eventList.getConcentrationsAt(d,simTime);
      const pd=pdModels[d];
      drugData[d]={...conc,bis:pd?pd.predict(conc.Ce):null,effect:pd?pd.effect(conc.Ce):null,mode:drugStates[d].mode,ceTarget:drugStates[d].ceTarget};
    }
    const tickData={time:simTime,dt:cfg.tickStep,drugs:drugData,simState:state};
    emit('tick',tickData);
    return tickData;
  }

  function setDrugMode(d,mode){const ds=drugStates[d];if(!ds)return;ds.mode=mode;eventList.clearPlanned(d)}
  function getDrugMode(d){return drugStates[d]?.mode??null}

  function setManualRate(d,rate){if(!eventList)init();drugStates[d].mode=DrugMode.MANUAL;eventList.addManualRate(d,simTime,rate);emit('rateChange',{drugId:d,rate})}
  function giveManualBolus(d,mg){if(!eventList)init();drugStates[d].mode=DrugMode.MANUAL;eventList.addManualBolus(d,simTime,mg);emit('bolusGiven',{drugId:d,dose:mg})}

  function setBolusConfig(d,dose,troughCe){const ds=drugStates[d];if(!ds)return;ds.mode=DrugMode.BOLUS;ds.bolusConfig={dose,troughCe};eventList.clearPlanned(d)}
  function giveIntermittentBolus(d){if(!eventList)init();const ds=drugStates[d];if(!ds||ds.bolusConfig.dose<=0)return null;eventList.addManualBolus(d,simTime,ds.bolusConfig.dose);return{dose:ds.bolusConfig.dose}}

  function getConcentrations(d='propofol'){if(!eventList)return{Cp:0,Ce:0,C2:0,C3:0,rate:0};return eventList.getConcentrationsAt(d,simTime)}
  function getSimTime(){return simTime}
  function getState(){return state}
  function getParams(){return params}
  function getEventList(){return eventList}
  function getEvents(d){if(!eventList)return[];return d?eventList.getByDrug(d):eventList.getAll()}
  function editEvent(id,ch){if(!eventList)return null;return eventList.editEvent(id,ch)}
  function deleteEvent(id){if(!eventList)return null;return eventList.deleteEvent(id)}
  function registerDrug(d,pk,pd){if(!eventList)init();eventList.registerEngine(d,createEngine(pk));drugStates[d]=createDrugState(d);if(pd)pdModels[d]=createPDModel(pd)}
  function jumpToTime(t){if(!eventList)init();if(t>simTime){while(simTime<t&&simTime<cfg.maxSimTime){simTime+=cfg.tickStep;eventList.promoteEvents(simTime)}}else simTime=Math.max(0,t)}

  return{start,pause,resume,reset,manualTick,setPatient,getPatient,recalcParams,setDrugMode,getDrugMode,setManualRate,giveManualBolus,setBolusConfig,giveIntermittentBolus,getConcentrations,getSimTime,getState,getParams,getEventList,getEvents,editEvent,deleteEvent,registerDrug,jumpToTime,on,get config(){return{...cfg}}};
}

// ============ TESTS ============
let passed=0,failed=0;
function ok(c,m){if(c){passed++;console.log(`  ✓ ${m}`)}else{failed++;console.error(`  ✗ ${m}`)}}
function near(a,b,tol,m){const r=Math.abs(b)>1e-9?Math.abs(a-b)/Math.abs(b):Math.abs(a-b);ok(r<tol,`${m} (${a.toFixed(4)} vs ${b.toFixed(4)})`)}

console.log('\n===== 1. State Machine =====\n');

{
  const sim = createSimulation();
  ok(sim.getState() === 'READY', 'Initial state is READY');

  sim.start();
  ok(sim.getState() === 'RUNNING', 'After start: RUNNING');

  sim.pause();
  ok(sim.getState() === 'PAUSED', 'After pause: PAUSED');

  sim.resume();
  ok(sim.getState() === 'RUNNING', 'After resume: RUNNING');

  sim.reset();
  ok(sim.getState() === 'READY', 'After reset: READY');
  ok(sim.getSimTime() === 0, 'After reset: simTime = 0');
}

{
  const sim = createSimulation();
  sim.start();
  sim.start(); // double start should be no-op
  ok(sim.getState() === 'RUNNING', 'Double start stays RUNNING');

  sim.pause();
  sim.pause(); // double pause
  ok(sim.getState() === 'PAUSED', 'Double pause stays PAUSED');
}

console.log('\n===== 2. State Change Callbacks =====\n');

{
  const sim = createSimulation();
  const states = [];
  sim.on('stateChange', d => states.push(d.state));

  sim.start();
  sim.pause();
  sim.resume();
  sim.reset();

  ok(states.length === 4, `4 state changes emitted (got ${states.length})`);
  ok(states[0] === 'RUNNING', 'First: RUNNING');
  ok(states[1] === 'PAUSED', 'Second: PAUSED');
  ok(states[2] === 'RUNNING', 'Third: RUNNING');
  ok(states[3] === 'READY', 'Fourth: READY');
}

console.log('\n===== 3. Manual Mode — Rate + Bolus =====\n');

{
  const sim = createSimulation();
  sim.start();

  // Set a manual infusion rate
  sim.setManualRate('propofol', 2.0);
  ok(sim.getDrugMode('propofol') === 'manual', 'Mode set to manual');

  // Advance 5 minutes
  for (let i = 0; i < 30; i++) sim.manualTick(); // 30 × 10/60 = 5 min

  const c = sim.getConcentrations();
  ok(c.Cp > 0, `After 5 min infusion: Cp > 0 (${c.Cp.toFixed(4)})`);
  ok(c.Ce > 0, `After 5 min infusion: Ce > 0 (${c.Ce.toFixed(4)})`);
  ok(c.Ce < c.Cp, 'Ce < Cp (still equilibrating)');

  // Verify against direct engine
  const eng = createEngine(sim.getParams());
  eng.advance(5, 2.0);
  near(c.Cp, eng.getConcentrations().Cp, 0.02, 'Sim Cp matches direct engine within 2%');
}

{
  const sim = createSimulation();
  sim.start();

  // Give a manual bolus
  sim.giveManualBolus('propofol', 100);

  // Advance 2 minutes
  for (let i = 0; i < 12; i++) sim.manualTick();

  const c = sim.getConcentrations();
  ok(c.Cp > 0, `After bolus + 2 min: Cp > 0 (${c.Cp.toFixed(4)})`);
  ok(c.Ce > 0, `After bolus + 2 min: Ce > 0 (${c.Ce.toFixed(4)})`);
}

console.log('\n===== 4. Event Log Integration =====\n');

{
  const sim = createSimulation();
  sim.start();

  sim.giveManualBolus('propofol', 100);
  // Advance past the bolus delivery window (0.05 min) before setting rate
  sim.manualTick(); // advances ~0.167 min
  sim.setManualRate('propofol', 5.0);

  const events = sim.getEvents('propofol');
  ok(events.length >= 3, `Events created: ${events.length} (bolus + rate-restore + manual rate)`);

  const bolus = events.find(e => e.type === 'bolus');
  ok(bolus !== undefined, 'Bolus event exists');
  ok(bolus.value === 100, 'Bolus value is 100 mg');

  const rates = events.filter(e => e.type === 'rate');
  const lastRate = rates[rates.length - 1];
  ok(lastRate.value === 5.0, 'Last rate event is 5.0 mg/min');
}

console.log('\n===== 5. Patient Change Mid-Simulation =====\n');

{
  const sim = createSimulation();
  sim.start();
  sim.setManualRate('propofol', 2.0);

  // Advance 2 min
  for (let i = 0; i < 12; i++) sim.manualTick();
  const c1 = sim.getConcentrations();

  // Change patient weight (heavier = larger V1 = lower Cp)
  sim.setPatient({ weight: 120 });
  const p2 = sim.getParams();
  ok(p2.V1 > 6.28, 'After weight increase: V1 increased');

  // Concentrations should reflect new V1 but preserve state
  const c2 = sim.getConcentrations();
  ok(c2.Cp > 0, 'Concentrations still exist after param change');
  // Note: Cp may differ because A1/V1 changes with new V1
}

console.log('\n===== 6. Event Editing =====\n');

{
  const sim = createSimulation();
  sim.start();

  sim.giveManualBolus('propofol', 100);

  // Advance 3 min
  for (let i = 0; i < 18; i++) sim.manualTick();
  const before = sim.getConcentrations();

  // Find the bolus event and change its dose
  const events = sim.getEvents('propofol');
  const bolus = events.find(e => e.type === 'bolus');
  sim.editEvent(bolus.id, { value: 200 }); // double the dose

  const after = sim.getConcentrations();
  ok(after.Cp > before.Cp, 'Editing bolus from 100→200 mg increases Cp');
}

{
  const sim = createSimulation();
  sim.start();

  sim.giveManualBolus('propofol', 100);
  for (let i = 0; i < 18; i++) sim.manualTick();
  const before = sim.getConcentrations();

  // Delete the bolus
  const events = sim.getEvents('propofol');
  const bolus = events.find(e => e.type === 'bolus');
  sim.deleteEvent(bolus.id);

  const after = sim.getConcentrations();
  ok(after.Cp < before.Cp, 'Deleting bolus reduces Cp');
}

console.log('\n===== 7. Multi-Drug Isolation =====\n');

{
  const sim = createSimulation();
  sim.start();

  // Register fentanyl with different PK
  sim.registerDrug('fentanyl',
    { V1: 10, V2: 30, V3: 200, CL: 1.0, Q2: 1.5, Q3: 0.8, ke0: 0.1 },
    { Ce50: 0.003, gamma1: 3.0, gamma2: 3.0, BIS_baseline: 93 }
  );

  // Give propofol bolus only
  sim.giveManualBolus('propofol', 100);
  for (let i = 0; i < 6; i++) sim.manualTick(); // 1 min

  const cp = sim.getConcentrations('propofol');
  const cf = sim.getConcentrations('fentanyl');

  ok(cp.Cp > 0, 'Propofol has concentrations after bolus');
  ok(cf.Cp === 0, 'Fentanyl has zero concentrations (no drug given)');
}

console.log('\n===== 8. Intermittent Bolus Mode =====\n');

{
  const sim = createSimulation();
  sim.start();

  sim.setBolusConfig('propofol', 50, 1.0); // 50mg bolus, trough at Ce=1.0
  ok(sim.getDrugMode('propofol') === 'bolus', 'Mode set to bolus');

  sim.giveIntermittentBolus('propofol');
  for (let i = 0; i < 6; i++) sim.manualTick();

  const c = sim.getConcentrations();
  ok(c.Cp > 0, 'Intermittent bolus delivered');

  const events = sim.getEvents('propofol');
  const boli = events.filter(e => e.type === 'bolus');
  ok(boli.length === 1, 'One bolus event in log');
  ok(boli[0].value === 50, 'Bolus dose is 50 mg');
}

console.log('\n===== 9. Jump To Time =====\n');

{
  const sim = createSimulation();
  sim.start();
  sim.setManualRate('propofol', 2.0);

  // Jump forward 10 min
  sim.jumpToTime(10);
  near(sim.getSimTime(), 10, 0.02, 'After jumpToTime(10): simTime ≈ 10');

  const c = sim.getConcentrations();
  ok(c.Cp > 0, 'Concentrations available after jump');

  // Jump backward
  sim.jumpToTime(2);
  ok(sim.getSimTime() === 2, 'After jumpToTime(2): simTime = 2');

  const c2 = sim.getConcentrations();
  ok(c2.Cp > 0, 'Concentrations available after backward jump');
  ok(c2.Cp < c.Cp, 'Cp at t=2 < Cp at t=10 (less drug accumulated)');
}

console.log('\n===== 10. Tick Emits Data =====\n');

{
  const sim = createSimulation();
  const ticks = [];
  sim.on('tick', d => ticks.push(d));

  sim.start();
  sim.setManualRate('propofol', 2.0);
  sim.manualTick();
  sim.manualTick();
  sim.manualTick();

  ok(ticks.length === 3, `3 ticks emitted (got ${ticks.length})`);
  ok(ticks[0].time > 0, 'First tick has time > 0');
  ok(ticks[0].drugs.propofol.Cp >= 0, 'First tick has drugs.propofol.Cp');
  ok(ticks[0].drugs.propofol.Ce >= 0, 'First tick has drugs.propofol.Ce');
  ok(ticks[0].drugs.propofol.bis <= 93 && ticks[0].drugs.propofol.bis > 0, 'First tick has valid BIS');
  ok(ticks[1].time > ticks[0].time, 'Tick times are increasing');
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
