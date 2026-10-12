// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('@babel/register')({extensions:['.ts'],presets:[['@babel/preset-env',{targets:{node:'current'}}],'@babel/preset-typescript'],ignore:[/node_modules/],babelrc:false,configFile:false});
const { estimateHeight }=require('../../cvat-ui/src/utils/height-diagnostic/estimate.ts');
const fixtures=require('./fixtures/height-projection.json');
const clone=(x)=>JSON.parse(JSON.stringify(x));
test('recovers heights from Python projector fixtures, including tilt and separate horizontal height',()=>{
 for(const f of fixtures){const before=JSON.stringify(f);const r=estimateHeight(f.track,f.metadata);assert.ok(Math.abs(r.height-f.height)<1e-6,JSON.stringify(r));assert.ok(r.rms<1e-5);assert.equal(JSON.stringify(f),before);}
});
test('two-endpoint unsaved corrections and undo/redo are read fresh, not cached',()=>{
 const f=clone(fixtures[0]);f.track.shapes=[f.track.shapes[0],f.track.shapes.at(-1)];const a=estimateHeight(f.track,f.metadata);assert.ok(Math.abs(a.height-f.height)<1e-6);assert.ok(a.warnings.some(w=>w.includes('two')));
 f.track.shapes[1].points[1]+=25;const b=estimateHeight(f.track,f.metadata);assert.ok(Math.abs(a.height-b.height)>.05);f.track.shapes[1].points[1]-=25;assert.equal(estimateHeight(f.track,f.metadata).height,a.height);
});
test('legacy, stale, invalid and incomplete metadata cannot produce an estimate',()=>{
 for(const status of ['missing','stale','invalid'])assert.ok(estimateHeight(fixtures[0].track,{version:1,status}).reason);
 for(const change of [f=>f.metadata.bags[0].frames.pop(),f=>f.metadata.bags[0].frames[0].width++,f=>f.metadata.bags[0].frames[0].projection[0]=NaN]){
  const f=clone(fixtures[0]);change(f);assert.ok(estimateHeight(f.track,f.metadata).reason);
 }
});
test('foreign bag spans are rejected even without an intermediate keyframe',()=>{
 const f=clone(fixtures[0]);f.metadata.bags.push({...f.metadata.bags[0],bag_id:2,frames:[f.metadata.bags[0].frames[4]]});f.metadata.bags[0].frames.splice(4,1);f.track.shapes=[f.track.shapes[0],f.track.shapes.at(-1)];assert.ok(estimateHeight(f.track,f.metadata).reason.includes('crosses'));
});
test('deleted outside keyframes cannot hide a cross-bag visible span; restoring them restores the boundary',()=>{
 const f=clone(fixtures[0]);
 f.metadata.bags.push({...f.metadata.bags[0],bag_id:2,frames:f.metadata.bags[0].frames.splice(4)});
 f.track.shapes=[f.track.shapes[0],f.track.shapes[2],{...f.track.shapes[4],outside:true}];
 assert.ok(Math.abs(estimateHeight(f.track,f.metadata).height-f.height)<1e-6);
 f.metadata.deleted_frames=[4];const before=JSON.stringify(f);
 const result=estimateHeight(f.track,f.metadata);
 assert.equal(result.height,undefined);assert.match(result.reason,/crosses recordings/);
 assert.equal(JSON.stringify(f),before);
 f.metadata.deleted_frames=[];assert.ok(Math.abs(estimateHeight(f.track,f.metadata).height-f.height)<1e-6);
});
test('a deleted visible keyframe does not start a track in another bag',()=>{
 const f=clone(fixtures[0]);
 f.metadata.bags.push({...f.metadata.bags[0],bag_id:2,frames:f.metadata.bags[0].frames.splice(4)});
 f.track.shapes=[f.track.shapes[0],f.track.shapes[4],f.track.shapes[8]];
 f.metadata.deleted_frames=[0];
 const result=estimateHeight(f.track,f.metadata);
 assert.ok(Math.abs(result.height-f.height)<1e-6);assert.equal(result.count,2);assert.equal(result.first,4);
});
test('outside, occluded and deleted frames are excluded without inventing observations',()=>{
 const f=clone(fixtures[0]);f.track.shapes[2].outside=true;f.track.shapes[3].occluded=true;f.metadata.deleted_frames=[4];const r=estimateHeight(f.track,f.metadata);assert.equal(r.count,6);assert.ok(Math.abs(r.height-f.height)<1e-6);
 f.track.shapes.forEach(s=>{s.outside=true});assert.ok(estimateHeight(f.track,f.metadata).reason);
});
test('stationary cameras and unsupported multipoint tracks have no numeric estimate',()=>{
 const f=clone(fixtures[0]);f.metadata.bags[0].frames.forEach(x=>x.target_to_camera=f.metadata.bags[0].frames[0].target_to_camera);f.track.shapes.forEach(x=>x.points=f.track.shapes[0].points);assert.ok(estimateHeight(f.track,f.metadata).reason);
 const g=clone(fixtures[0]);g.track.shapes[0].points.push(1,2);assert.ok(estimateHeight(g.track,g.metadata).reason);
});
test('noisy annotations retain best fit and display a quality warning',()=>{
 const f=clone(fixtures[0]);f.track.shapes[4].points[1]+=40;const r=estimateHeight(f.track,f.metadata);assert.ok(r.height>0);assert.ok(r.rms>5);assert.ok(r.warnings.some(w=>w.includes('poorly')));
});
test('weak motion produces a warning; a constrained boundary is unavailable',()=>{
 const f=clone(fixtures.at(-1));const r=estimateHeight(f.track,f.metadata);assert.ok(r.height>0);assert.ok(r.warnings.some(w=>w.includes('20 pixels')));
 // Scaling displacement requests an unphysical height above the search interval.
 const g=clone(fixtures[0]);const y=g.track.shapes[0].points[1];g.track.shapes.forEach(s=>s.points[1]=y+(s.points[1]-y)*.001);assert.ok(estimateHeight(g.track,g.metadata).reason);
});
