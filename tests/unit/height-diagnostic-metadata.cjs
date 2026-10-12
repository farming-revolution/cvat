// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('module');
require('@babel/register')({extensions:['.ts'],presets:[['@babel/preset-env',{targets:{node:'current'}}],'@babel/preset-typescript'],ignore:[/node_modules/],babelrc:false,configFile:false});
let focus, requests=0, response, release;
global.window={addEventListener:(event,fn)=>{assert.equal(event,'focus');focus=fn;}};
const original=Module._load;
Module._load=function(name,...args){
 if(name==='cvat-core-wrapper')return {getCore:()=>({server:{request:async(url,config)=>{
  requests++;assert.match(url,/^\/api\/jobs\/\d+\/height-diagnostic$/);assert.deepEqual(config,{method:'get',timeout:5000});
  if(release)await new Promise(r=>release=r);if(response instanceof Error)throw response;return {data:response};
 }}})};
 return original.call(this,name,...args);
};
const {jobMetadata,refreshMetadata}=require('../../cvat-ui/src/utils/height-diagnostic/metadata.ts');
Module._load=original;
test('one shared request per job, focus/open revalidation, no fetch per frame, failures disable safely',async()=>{
 const entry=jobMetadata(1);assert.equal(jobMetadata(1),entry);let notifications=0;entry.listeners.add(()=>notifications++);
 response={version:1,status:'missing',reason:'Available after next App–CVAT synchronization.'};release=true;
 const first=refreshMetadata(entry);const second=refreshMetadata(entry);assert.equal(requests,1);release();release=null;await Promise.all([first,second]);
 assert.equal(entry.value,null);assert.match(entry.reason,/synchronization/);assert.equal(notifications,1);
 for(let i=0;i<100;i++)await refreshMetadata(jobMetadata(1));assert.equal(requests,1);
 response={version:1,status:'available',bags:[],frames:[],deleted_frames:[],frame_fingerprint:'f'};
 await refreshMetadata(entry,true);assert.equal(requests,2);assert.equal(entry.value,response);assert.equal(notifications,2);
 await refreshMetadata(entry,true);assert.equal(notifications,2); // unchanged responses don't rerender every control
 entry.checked=Date.now()-31000;focus();await entry.request;assert.equal(requests,4);
 response=new Error('404 legacy server');await refreshMetadata(entry,true);assert.equal(entry.value,null);assert.ok(entry.reason);
 const next=jobMetadata(2);assert.notEqual(next,entry);assert.equal(next.value,null);
});
