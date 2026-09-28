// 原始采样与显示分离：绘制可合并到下一帧，记录保留每个实际到达的事件及其合并样本。
const $=(id)=>document.getElementById(id);
const canvas=$('pad');const ctx=canvas.getContext('2d');
const automated=new URLSearchParams(location.search).get('automation')==='1';
$('notice').hidden=!automated;
$('capabilities').textContent=`合并采样 API：${typeof PointerEvent.prototype.getCoalescedEvents==='function'?'可用':'不可用，将保留主事件'}。鼠标类输入也可能来自触控板，请准确命名设备。`;
let session=null,active=null,recording=false,saving=false,started=0,batches=0,dirty=false,lastEvent=0,replayToken=0;

function resize(){
  if(active)finish('viewport_changed');
  const rect=canvas.getBoundingClientRect(),ratio=devicePixelRatio;
  canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.lineWidth=2;ctx.strokeStyle='#244c3c';ctx.lineCap='round';ctx.lineJoin='round';
  if(session){for(const stroke of session.strokes)stroke.painted=0;dirty=true;}
}
new ResizeObserver(resize).observe(canvas);

function point(event,rect){
  return {x:event.clientX-rect.left,y:event.clientY-rect.top,time_ms:event.timeStamp,
    pressure:Number.isFinite(event.pressure)?event.pressure:null,tilt_x:event.tiltX??null,tilt_y:event.tiltY??null,
    twist:event.twist??null,buttons:event.buttons,is_trusted:event.isTrusted};
}

function append(event,kind=event.type){
  const received=performance.now();let merged=[],coalescedError=null;
  if(typeof event.getCoalescedEvents==='function'){
    try{merged=event.getCoalescedEvents();}catch(error){coalescedError=error.name;}
  }
  const batch={kind,received_ms:received,main:point(event,active.rect),coalesced:merged.map(e=>point(e,active.rect)),coalesced_error:coalescedError};
  active.stroke.events.push(batch);batches++;
  if(kind!=='pointercancel'){
    const points=batchPoints(batch);
    lastEvent=points[points.length-1].time_ms;dirty=true;
    for(const p of points)active.stroke.display.push(p);
  }
  $('counts').textContent=`${session.strokes.length} 笔 · ${batches} 个事件`;
}

function finish(reason){
  if(!active)return;
  active.stroke.ended_by=reason;
  active.stroke.ended_received_ms=performance.now();
  const id=active.id;active=null;
  if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
}

canvas.addEventListener('pointerdown',(event)=>{
  if(!recording||active||!event.isPrimary)return;
  if($('filter').value!=='any'&&$('filter').value!==event.pointerType)return;
  event.preventDefault();
  const rect=canvas.getBoundingClientRect();
  const stroke={id:session.strokes.length,pointer_type:event.pointerType,task:$('task').value,
    canvas:{width:rect.width,height:rect.height,device_pixel_ratio:devicePixelRatio},events:[],display:[],painted:0,ended_by:null};
  session.strokes.push(stroke);active={id:event.pointerId,rect,stroke};canvas.setPointerCapture(event.pointerId);append(event);
});
canvas.addEventListener('pointermove',(event)=>{if(active?.id===event.pointerId){event.preventDefault();append(event);}});
canvas.addEventListener('pointerup',(event)=>{if(active?.id===event.pointerId){append(event);finish('pointerup');}});
canvas.addEventListener('pointercancel',(event)=>{if(active?.id===event.pointerId){append(event);finish('pointercancel');}});
canvas.addEventListener('lostpointercapture',()=>finish('lostcapture'));

function draw(strokes,until=Infinity){
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  for(const stroke of strokes){
    ctx.beginPath();let first=true;
    for(const p of stroke.display){if(p.time_ms>until)break;if(first){ctx.moveTo(p.x,p.y);first=false;}else ctx.lineTo(p.x,p.y);}
    ctx.stroke();
  }
}

function frame(raf){
  if(session&&recording){
    if(dirty){session.frames.push({callback_ms:performance.now(),raf_ms:raf,latest_event_ms:lastEvent,observed_batches:batches});drawLive();dirty=false;}
    if(performance.now()-started>90000)stop();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function drawLive(){
  // 只绘制新增段，避免长笔迹的全量重绘改变采集期间的事件调度。
  for(const stroke of session.strokes){
    if(stroke.painted>=stroke.display.length)continue;
    ctx.beginPath();const start=Math.max(0,stroke.painted-1);
    for(let i=start;i<stroke.display.length;i++){const p=stroke.display[i];if(i===start)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}
    ctx.stroke();stroke.painted=stroke.display.length;
  }
}

$('start').addEventListener('click',()=>{
  if(saving)return;
  const label=$('device').value.trim();if(!label){$('message').textContent='请先填写设备名称，方便比较不同设备。';return;}
  replayToken++;
  if(!session){
    session={schema_version:1,provenance:automated?'automation_test':'manual',device_label:label,
      environment:{user_agent:navigator.userAgent,platform:navigator.platform,device_pixel_ratio:devicePixelRatio,
        performance_time_origin_ms:performance.timeOrigin,coalesced_supported:typeof PointerEvent.prototype.getCoalescedEvents==='function',
        event_source:'pointermove_with_coalesced'},strokes:[],frames:[]};
    batches=0;ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  }
  recording=true;started=performance.now();$('device').disabled=true;$('start').disabled=true;$('stop').disabled=false;$('save').disabled=true;$('download').disabled=true;
  $('status').textContent='采集中';$('message').textContent='请直接在画布上绘制。';
});

function stop(){
  finish('stopped');recording=false;$('status').textContent='已暂停';$('start').disabled=false;$('start').textContent='继续采集';$('stop').disabled=true;
  $('save').disabled=!session?.strokes.length;
  $('download').disabled=!session?.strokes.length;
  if(session&&dirty){draw(session.strokes);dirty=false;}
}
$('stop').addEventListener('click',stop);

function rawRecord(){return {...session,strokes:session.strokes.map(({display,painted,...stroke})=>stroke)};}
$('download').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(rawRecord())],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`ink-recording-${Date.now()}.json`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});

$('save').addEventListener('click',async()=>{
  saving=true;$('save').disabled=true;$('start').disabled=true;$('download').disabled=true;
  try{
    const raw=rawRecord();
    const response=await fetch('/api/recordings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(raw)});
    const result=await response.json();if(!response.ok)throw new Error(result.error);
    $('message').textContent=`已保存：${result.file}。有效采样 ${result.quality.coalesced_points_after_duplicate_times} 个。`;
    session=null;$('download').disabled=true;$('device').disabled=false;$('start').textContent='开始新会话';$('status').textContent='已保存';await refresh();
  }catch(error){$('message').textContent=`保存失败：${error.message}。采集内容仍保留。`;$('save').disabled=false;$('download').disabled=false;}
  finally{saving=false;$('start').disabled=false;}
});

// W3C 要求父事件与合并事件择一处理，避免引入不存在的额外采样。
function batchPoints(batch){return batch.coalesced.length?batch.coalesced:[batch.main];}

function expand(stroke){
  const display=[];
  for(const batch of stroke.events){if(['pointercancel','lostcapture','viewport_changed','stopped'].includes(batch.kind))continue;
    display.push(...batchPoints(batch));}
  return {...stroke,display};
}

async function refresh(){
  try{
    const response=await fetch('/api/recordings');if(!response.ok)throw new Error('读取记录失败');
    const rows=await response.json();$('saved-list').replaceChildren();
    for(const row of rows){
      const button=document.createElement('button');button.textContent=`${row.device_label} · ${row.strokes} 笔${row.provenance==='automation_test'?' · 自动化检查':''}`;
      button.addEventListener('click',async()=>{
        if(recording||session){$('message').textContent='请先保存当前会话，再回放已有记录。';return;}
        try{
          const loaded=await fetch(`/api/recordings/${row.file}`);if(!loaded.ok)throw new Error('读取回放失败');
          const record=await loaded.json(),strokes=record.strokes.map(expand),all=strokes.flatMap(s=>s.display);
          if(!all.length)return;
          const first=all[0].time_ms,last=all.reduce((t,p)=>Math.max(t,p.time_ms),first),begin=performance.now(),token=++replayToken;
          $('status').textContent=`回放 · ${row.device_label}`;
          const render=()=>{if(token!==replayToken)return;const time=first+performance.now()-begin;draw(strokes,time);
            if(time<last)requestAnimationFrame(render);else $('status').textContent='回放结束';};render();
        }catch(error){$('message').textContent=error.message;}
      });$('saved-list').append(button);
    }
  }catch(error){$('message').textContent=error.message;}
}
await refresh();
