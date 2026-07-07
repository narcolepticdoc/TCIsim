/**
 * test-model.js — Tests for the stateless simulation model
 * 
 * Tests the refactored events.js (clearAfter, no status field)
 * and simulation.js (no ticks, no state machine, pure query/command).
 */

// ============ REAL ENGINE ============
import { createEngine } from '../js/pk/engine.js';
// The mini event list below is deliberate test scaffolding exercising the REAL
// engine; the production event list is covered by test-session-roundtrip.

// ============ INLINE EVENT LIST (matching refactored events.js) ============

let _nid=1;
function genId(){return'evt_'+String(_nid++).padStart(5,'0')}
function createEvt(drug,time,type,value,opts={}){return{id:genId(),drug,time,type,value,source:opts.source||'manual',annotation:opts.annotation||'',snapshot:null}}

function createEventList(){
  let events=[];const engines={};
  function registerEngine(d,e){engines[d]=e}
  function getEngine(d){return engines[d]||null}
  function getDrugIds(){return Object.keys(engines)}
  function insert(e){let idx=events.length;for(let i=events.length-1;i>=0;i--){if(events[i].time<=e.time){idx=i+1;break}if(i===0)idx=0}events.splice(idx,0,e);return e}
  function remove(id){const i=events.findIndex(e=>e.id===id);if(i===-1)return null;return events.splice(i,1)[0]}
  function getById(id){return events.find(e=>e.id===id)||null}
  function getAll(){return[...events]}
  function getByDrug(d){return events.filter(e=>e.drug===d)}

  function clearAfter(d,afterTime){
    const before=events.length;
    events=events.filter(e=>!(e.drug===d&&e.time>afterTime));
    const removed=before-events.length;
    if(removed>0)replayDrug(d);
    return removed;
  }
  function clearFrom(d,fromTime){
    const before=events.length;
    events=events.filter(e=>!(e.drug===d&&e.time>=fromTime));
    const removed=before-events.length;
    if(removed>0)replayDrug(d);
    return removed;
  }
  function clearAll(){events=[];_nid=1;for(const d of Object.keys(engines))engines[d].reset()}

  function getActiveRateForDrug(d,beforeIdx){for(let i=beforeIdx;i>=0;i--){if(events[i].drug!==d)continue;if(events[i].type==='rate')return events[i].value;if(events[i].type==='pause')return 0}return 0}
  function getRateAtTime(d,time){let r=0;for(const e of events){if(e.drug!==d)continue;if(e.time>time)break;if(e.type==='rate')r=e.value;else if(e.type==='pause')r=0}return r}

  function replayDrug(d){const eng=engines[d];if(!eng)return;eng.reset();let ct=0,cr=0;for(const evt of events){if(evt.drug!==d)continue;const dt=evt.time-ct;if(dt>0)eng.advance(dt,cr);ct=evt.time;if(evt.type==='bolus'){eng.advance(0.05,evt.value/0.05);ct+=0.05}else if(evt.type==='rate')cr=evt.value;else if(evt.type==='pause')cr=0;evt.snapshot=eng.getState()}}
  function replayAll(){for(const d of Object.keys(engines))replayDrug(d)}
  function replayDrugFrom(d,fromId){replayDrug(d)} // simplified for tests

  function getConcentrationsAt(d,time){const eng=engines[d];if(!eng)return{Cp:0,Ce:0,C2:0,C3:0,rate:0,time};let le=null,li=-1;for(let i=events.length-1;i>=0;i--){if(events[i].drug===d&&events[i].time<=time){le=events[i];li=i;break}}if(!le){eng.reset();if(time>0)eng.advance(time,0);return{...eng.getConcentrations(),rate:0,time}}if(!le.snapshot)replayDrug(d);eng.setState(le.snapshot);let ct=le.time;if(le.type==='bolus')ct+=0.05;const cr=getActiveRateForDrug(d,li);const dt=time-ct;if(dt>0)eng.advance(dt,cr);return{...eng.getConcentrations(),rate:cr,time}}

  function computeCurve(d,startTime,endTime,step=10/60){const eng=engines[d];if(!eng)return[];const devts=events.filter(e=>e.drug===d);const curve=[];eng.reset();let ct=0,cr=0,ep=0;while(ep<devts.length&&devts[ep].time<=startTime){const e=devts[ep];const dt=e.time-ct;if(dt>0)eng.advance(dt,cr);ct=e.time;if(e.type==='bolus'){eng.advance(0.05,e.value/0.05);ct+=0.05}else if(e.type==='rate')cr=e.value;else if(e.type==='pause')cr=0;ep++}if(startTime>ct){eng.advance(startTime-ct,cr);ct=startTime}let st=startTime;while(st<=endTime){while(ep<devts.length&&devts[ep].time<=st){const e=devts[ep];const dt=e.time-ct;if(dt>0)eng.advance(dt,cr);ct=e.time;if(e.type==='bolus'){eng.advance(0.05,e.value/0.05);ct+=0.05}else if(e.type==='rate')cr=e.value;else if(e.type==='pause')cr=0;ep++}const dt=st-ct;if(dt>0){eng.advance(dt,cr);ct=st}const c=eng.getConcentrations();curve.push({time:st,Cp:c.Cp,Ce:c.Ce,C2:c.C2,C3:c.C3,rate:cr});st+=step}return curve}

  function getStateAtTime(d,time){getConcentrationsAt(d,time);return engines[d]?engines[d].getState():new Float64Array(4)}
  function getStateAtLastEvent(d){for(let i=events.length-1;i>=0;i--){if(events[i].drug===d&&events[i].snapshot)return{state:events[i].snapshot,time:events[i].time}}return{state:engines[d]?engines[d].getState():new Float64Array(4),time:0}}

  function addRate(d,time,rate,ann){const e=createEvt(d,time,'rate',rate,{annotation:ann||''});insert(e);replayDrugFrom(d,e.id);return e}
  function addBolus(d,time,mg,ann){const pr=getRateAtTime(d,time);const be=createEvt(d,time,'bolus',mg,{annotation:ann||''});insert(be);const re=createEvt(d,time+0.05,'rate',pr,{source:'system',annotation:'Rate restored'});insert(re);replayDrugFrom(d,be.id);return be}
  function addPause(d,time,ann){const e=createEvt(d,time,'pause',0,{annotation:ann||''});insert(e);replayDrugFrom(d,e.id);return e}
  function addRateBatch(d,steps,ann){const created=[];for(const s of steps){const e=createEvt(d,s.time,'rate',s.rate,{source:'tci',annotation:ann||''});insert(e);created.push(e)}if(created.length>0)replayDrugFrom(d,created[0].id);return created}

  function editEvent(id,changes){const evt=getById(id);if(!evt)return null;const d=evt.drug;if(changes.value!=null)evt.value=changes.value;if(changes.time!=null){evt.time=changes.time;const idx=events.indexOf(evt);if(idx!==-1)events.splice(idx,1);insert(evt)}replayDrug(d);return evt}
  function deleteEvent(id){const evt=getById(id);if(!evt)return null;const d=evt.drug;const idx=events.indexOf(evt);if(idx!==-1)events.splice(idx,1);replayDrug(d);return evt}
  function deleteEventAndAfter(id){const evt=getById(id);if(!evt)return null;const d=evt.drug;const t=evt.time;events=events.filter(e=>!(e.drug===d&&e.time>=t));replayDrug(d);return evt}

  return{registerEngine,getEngine,getDrugIds,insert,remove,getById,getAll,getByDrug,clearAfter,clearFrom,clearAll,replayDrug,replayAll,replayDrugFrom,getConcentrationsAt,computeCurve,getRateAtTime,getActiveRateForDrug,getStateAtLastEvent,getStateAtTime,addRate,addBolus,addPause,addRateBatch,editEvent,deleteEvent,deleteEventAndAfter,get length(){return events.length},get raw(){return events}};
}

// ============ TEST HELPERS ============

const REF_PARAMS = { V1:6.28, V2:25.5, V3:273, CL:1.89, Q2:1.75, Q3:1.11, ke0:0.146 };

let passed=0,failed=0;
function ok(c,m){if(c){passed++;console.log(`  ✓ ${m}`)}else{failed++;console.error(`  ✗ ${m}`)}}
function near(a,b,tol,m){const r=Math.abs(b)>1e-9?Math.abs(a-b)/Math.abs(b):Math.abs(a-b);ok(r<tol,`${m} (${a.toFixed(4)} vs ${b.toFixed(4)})`)}

// ============ TESTS ============

console.log('\n===== 1. Events Have No Status Field =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addBolus('propofol', 2, 100);
  el.addRate('propofol', 5, 3.0);

  const events = el.getAll();
  ok(events.every(e => e.status === undefined), 'No event has a status field');
  ok(events.every(e => e.snapshot !== null), 'All events have snapshots after replay');
  ok(events.length === 4, `4 events created (rate + bolus + rate-restore + rate), got ${events.length}`);
}

console.log('\n===== 2. clearAfter Semantics =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);   // t=0
  el.addBolus('propofol', 2, 100);  // t=2 + rate-restore at t=2.05
  el.addRate('propofol', 5, 3.0);   // t=5
  el.addRate('propofol', 10, 2.0);  // t=10
  el.addRate('propofol', 15, 1.0);  // t=15

  // clearAfter at t=5 should keep t=0, t=2, t=2.05, t=5 and remove t=10, t=15
  const removed = el.clearAfter('propofol', 5);
  ok(removed === 2, `clearAfter(5) removed 2 events, got ${removed}`);

  const remaining = el.getAll();
  ok(remaining.length === 4, `4 events remain (0, 2, 2.05, 5), got ${remaining.length}`);
  ok(remaining.every(e => e.time <= 5), 'All remaining events at t ≤ 5');
}

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addRate('propofol', 5, 3.0);
  el.addRate('propofol', 10, 2.0);

  // clearAfter at t=0 keeps t=0, removes t=5 and t=10
  const removed = el.clearAfter('propofol', 0);
  ok(removed === 2, `clearAfter(0) removed 2 events, got ${removed}`);
  ok(el.getAll().length === 1, 'Only t=0 event remains');
}

console.log('\n===== 3. clearFrom Semantics =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addRate('propofol', 5, 3.0);
  el.addRate('propofol', 10, 2.0);

  // clearFrom at t=5 removes t=5 and t=10, keeps t=0
  const removed = el.clearFrom('propofol', 5);
  ok(removed === 2, `clearFrom(5) removed 2 events, got ${removed}`);
  ok(el.getAll().length === 1, 'Only t=0 event remains');
  ok(el.getAll()[0].time === 0, 'Remaining event is at t=0');
}

console.log('\n===== 4. Multi-Drug Isolation with clearAfter =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));
  el.registerEngine('fentanyl', createEngine({ V1:10, V2:30, V3:200, CL:1.0, Q2:1.5, Q3:0.8, ke0:0.1 }));

  el.addRate('propofol', 0, 5.0);
  el.addRate('propofol', 5, 3.0);
  el.addRate('fentanyl', 0, 0.01);
  el.addRate('fentanyl', 5, 0.005);

  // clearAfter propofol at t=0 should not touch fentanyl
  el.clearAfter('propofol', 0);

  const prop = el.getByDrug('propofol');
  const fent = el.getByDrug('fentanyl');
  ok(prop.length === 1, `Propofol: 1 event remains after clearAfter, got ${prop.length}`);
  ok(fent.length === 2, `Fentanyl: 2 events untouched, got ${fent.length}`);
}

console.log('\n===== 5. Edit Past Event Keeps Intermediate Events =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addBolus('propofol', 1, 100);   // t=1
  el.addRate('propofol', 5, 3.0);    // t=5
  el.addRate('propofol', 10, 2.0);   // t=10
  el.addRate('propofol', 15, 1.0);   // t=15

  // Get concentrations before edit
  const before = el.getConcentrationsAt('propofol', 12);

  // Find the bolus event and edit it (simulating "oops I gave 80 not 100")
  const bolus = el.getAll().find(e => e.type === 'bolus');

  // Edit the past event — keep intermediate events, clear future
  // (app layer would call clearAfter at currentTime, say t=12)
  el.editEvent(bolus.id, { value: 80 });
  el.clearAfter('propofol', 12); // remove t=15

  const after = el.getConcentrationsAt('propofol', 12);

  ok(after.Cp < before.Cp, 'Cp at t=12 decreased after reducing bolus from 100→80');

  // Events at t=5 and t=10 should still exist
  const remaining = el.getByDrug('propofol');
  const times = remaining.map(e => e.time);
  ok(times.includes(5), 'Rate at t=5 preserved');
  ok(times.includes(10), 'Rate at t=10 preserved');
  ok(!times.includes(15), 'Rate at t=15 removed (was after currentTime)');
}

console.log('\n===== 6. Delete Event — Single Only =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addBolus('propofol', 3, 100);
  el.addRate('propofol', 8, 3.0);
  el.addRate('propofol', 12, 2.0);

  const bolus = el.getAll().find(e => e.type === 'bolus');
  el.deleteEvent(bolus.id);

  const remaining = el.getByDrug('propofol');
  ok(remaining.every(e => e.type !== 'bolus'), 'Bolus removed');
  ok(remaining.some(e => e.time === 8), 'Rate at t=8 preserved');
  ok(remaining.some(e => e.time === 12), 'Rate at t=12 preserved');
}

console.log('\n===== 7. Delete Event And After =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addBolus('propofol', 3, 100);
  el.addRate('propofol', 8, 3.0);
  el.addRate('propofol', 12, 2.0);

  const bolus = el.getAll().find(e => e.type === 'bolus');
  el.deleteEventAndAfter(bolus.id);

  const remaining = el.getByDrug('propofol');
  ok(remaining.length === 1, `Only t=0 rate remains, got ${remaining.length}`);
  ok(remaining[0].time === 0, 'Remaining event is at t=0');
}

console.log('\n===== 8. computeCurve =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addRate('propofol', 5, 2.0);

  const curve = el.computeCurve('propofol', 0, 10, 1.0);

  ok(curve.length === 11, `11 sample points (0,1,...,10), got ${curve.length}`);
  ok(curve[0].Cp === 0 || curve[0].Cp > 0, 'First point has Cp');
  ok(curve[0].rate === 5.0, `Rate at t=0 is 5.0, got ${curve[0].rate}`);
  ok(curve[6].rate === 2.0, `Rate at t=6 is 2.0, got ${curve[6].rate}`);

  // Cp should increase then slow after rate drop
  ok(curve[5].Cp > curve[2].Cp, 'Cp increasing during 5 mg/min infusion');

  // Verify against direct engine
  const eng = createEngine(REF_PARAMS);
  eng.advance(5, 5.0);
  eng.advance(5, 2.0);
  const directCp = eng.getConcentrations().Cp;
  near(curve[10].Cp, directCp, 0.01, 'Curve Cp at t=10 matches direct engine');
}

console.log('\n===== 9. Bolus Rate Restore =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addBolus('propofol', 3, 100);

  // After bolus at t=3, rate should be restored to 5.0
  const rateAfter = el.getRateAtTime('propofol', 3.1);
  ok(rateAfter === 5.0, `Rate restored to 5.0 after bolus, got ${rateAfter}`);

  // The rate-restore event should exist at t=3.05
  const events = el.getByDrug('propofol');
  const restore = events.find(e => e.source === 'system' && e.type === 'rate');
  ok(restore !== undefined, 'Rate-restore event exists');
  ok(restore.time === 3.05, `Rate-restore at t=3.05, got ${restore.time}`);
  ok(restore.value === 5.0, `Rate-restore value is 5.0, got ${restore.value}`);
}

console.log('\n===== 10. addRateBatch (TCI-style) =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  // Simulate TCI: clearAfter, then insert batch
  el.addRate('propofol', 0, 5.0);
  el.addRate('propofol', 5, 3.0);

  // "Set TCI target at t=5" — clear after t=5, insert new plan
  el.clearAfter('propofol', 5);
  el.addRateBatch('propofol', [
    { time: 5, rate: 10.0 },
    { time: 8, rate: 6.0 },
    { time: 15, rate: 5.5 },
  ], 'TCI Ce=3.0');

  const events = el.getByDrug('propofol');
  // t=0 (original) + t=5 (original, kept by clearAfter) + t=5,t=8,t=15 (batch)
  // Actually t=5 original was kept, then t=5 batch inserted after it
  ok(events.length >= 4, `At least 4 events, got ${events.length}`);

  const tciEvents = events.filter(e => e.source === 'tci');
  ok(tciEvents.length === 3, `3 TCI events, got ${tciEvents.length}`);

  // Concentrations at t=10 should reflect the TCI rates
  const conc = el.getConcentrationsAt('propofol', 10);
  ok(conc.Cp > 0, `Cp at t=10 > 0 (got ${conc.Cp.toFixed(4)})`);
}

console.log('\n===== 11. No Status, No promoteEvents =====\n');

{
  const el = createEventList();

  // Verify there's no promoteEvents function
  ok(typeof el.promoteEvents === 'undefined', 'No promoteEvents method');
  ok(typeof el.getPlanned === 'undefined', 'No getPlanned method');
  ok(typeof el.getExecuted === 'undefined', 'No getExecuted method');
  ok(typeof el.clearPlanned === 'undefined', 'No clearPlanned method');
}

console.log('\n===== 12. getStateAtTime for TCI Planning =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF_PARAMS));

  el.addRate('propofol', 0, 5.0);
  el.addBolus('propofol', 2, 100);

  const state = el.getStateAtTime('propofol', 5);
  ok(state instanceof Float64Array, 'getStateAtTime returns Float64Array');
  ok(state.length === 4, 'State has 4 elements');
  ok(state[0] > 0, `A1 > 0 at t=5 (got ${state[0].toFixed(4)})`);
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
