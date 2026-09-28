"""采集文件的验证、时间序列展开与离线回放转换；原始事件永不被转换结果覆盖。"""
import math
import statistics


def number(value,name):
    """拒绝布尔值和非有限值，避免损坏的坐标进入内核。"""
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
        raise ValueError(name+' 必须是有限数')
    return value


def validate(record):
    """检查结构与数值；时间倒退留给质量报告识别，不能通过排序伪造有效输入。"""
    if not isinstance(record,dict) or record.get('schema_version')!=1 or record.get('provenance') not in ('manual','automation_test'):
        raise ValueError('未知采集格式或来源')
    if not isinstance(record.get('device_label'),str) or not record['device_label'].strip():
        raise ValueError('缺少设备名称')
    strokes=record.get('strokes')
    if not isinstance(strokes,list) or not 1<=len(strokes)<=500:
        raise ValueError('笔画数量无效')
    count=0
    for stroke in strokes:
        if not isinstance(stroke,dict) or stroke.get('pointer_type') not in ('mouse','pen','touch') or not isinstance(stroke.get('task'),str):
            raise ValueError('缺少输入类型或任务标签')
        if not isinstance(stroke.get('events'),list) or not stroke['events']:raise ValueError('笔画缺少事件')
        if stroke.get('ended_received_ms') is not None:number(stroke['ended_received_ms'],'结束时刻')
        for batch in stroke['events']:
            if not isinstance(batch,dict) or not isinstance(batch.get('coalesced'),list):raise ValueError('事件结构无效')
            if batch['kind'] not in ('pointerdown','pointermove','pointerup','pointercancel','lostcapture','viewport_changed','stopped'):
                raise ValueError('未知事件类型')
            number(batch['received_ms'],'到达时间')
            for point in [batch['main'],*batch['coalesced']]:
                if not isinstance(point,dict):raise ValueError('采样结构无效')
                for key in ('x','y','time_ms'):
                    number(point[key],key)
                if point['time_ms']<0:raise ValueError('事件时间为负')
                if point.get('pressure') is not None:
                    pressure=number(point['pressure'],'压感')
                    if not 0<=pressure<=1:raise ValueError('压感越界')
                count+=1
    if count>200000:raise ValueError('会话采样过多，请分批保存')
    if not isinstance(record.get('frames',[]),list):raise ValueError('渲染记录结构无效')
    for frame in record.get('frames',[]):
        if not isinstance(frame,dict):raise ValueError('渲染记录结构无效')
        for key in ('callback_ms','raf_ms','latest_event_ms'):
            number(frame[key],key)
    return record


def batch_points(batch):
    """一个批次同时可用，因此批内同时间戳可取最后位置；取消事件没有可用绘图坐标。"""
    if batch['kind'] in ('pointercancel','lostcapture','viewport_changed','stopped'):return []
    # W3C 要求父事件与合并事件择一处理，父事件仍保存在原始记录中。
    points=batch['coalesced'] or [batch['main']]
    result=[]
    for point in points:
        p=[point['x'],point['y'],point['time_ms']]
        if result and p[2]==result[-1][2]:result[-1]=p
        else:result.append(p)
    return result


def stroke_points(stroke):
    """按到达顺序展开合并事件；仅合并同一时间戳，保留最后位置，不跨取消事件补点。"""
    result=[]
    for batch in stroke['events']:
        for p in batch_points(batch):
            if result and p[2]<result[-1][2]:raise ValueError('原始事件时间倒退')
            if result and p[2]==result[-1][2]:result[-1]=p
            else:result.append(p)
    if result:
        origin=result[0][2]
        result=[[x,y,t-origin] for x,y,t in result]
    return result


def distribution(values):
    """汇总软件时间差，保留负值计数，不把时间原点不一致的数字当成有效延迟。"""
    if not values:return {'count':0}
    values=sorted(values)
    return {'count':len(values),'p50':statistics.median(values),'p95':values[int((len(values)-1)*.95)],
            'max':values[-1],'negative_count':sum(v<0 for v in values)}


def summarize(record):
    """仅报告软件事件/回调差值及数据质量，不声称测量了输入到屏幕发光的延迟。"""
    validate(record)
    valid,invalid,points=0,[],0
    intervals=[];unchanged=0;long_gaps=0
    for index,stroke in enumerate(record['strokes']):
        try:values=stroke_points(stroke)
        except ValueError as error:
            invalid.append({'stroke':index,'reason':str(error)})
            continue
        valid+=1;points+=len(values)
        for a,b in zip(values,values[1:]):
            intervals.append(b[2]-a[2]);unchanged+=a[:2]==b[:2];long_gaps+=b[2]-a[2]>120
    delivery=[b['received_ms']-b['main']['time_ms'] for s in record['strokes'] for b in s['events']
              if b['kind'] in ('pointerdown','pointermove','pointerup')]
    render=[f['callback_ms']-f['latest_event_ms'] for f in record.get('frames',[])]
    untrusted=sum(p.get('is_trusted') is not True for s in record['strokes'] for b in s['events'] for p in [b['main'],*b['coalesced']])
    return {'valid_strokes':valid,'invalid_strokes':invalid,'coalesced_points_after_duplicate_times':points,
            'event_delivery_age_ms':distribution(delivery),'latest_sample_to_raf_callback_ms':distribution(render),
            'latency_scope':'Software clocks only; no input-to-photon measurement.',
            'pointer_types':sorted({s['pointer_type'] for s in record['strokes']}),'untrusted_samples':untrusted,
            'input_interval_ms':distribution(intervals),'unchanged_position_pairs':unchanged,'gaps_over_120ms':long_gaps}


def convert(record,identifier,allow_automation=False):
    """生成内核回放输入；自动化轨迹默认拒绝，坏时序保留在原文件并显式列出排除原因。"""
    quality=summarize(record)
    if record['provenance']!='manual' and not allow_automation:
        raise ValueError('自动化检查轨迹不能作为设备实测数据')
    if record['provenance']=='manual' and quality['untrusted_samples']:
        raise ValueError('人工记录包含非可信浏览器事件，不能计入设备实测')
    drawings=[];delivery_strokes=[];batches=[];causal_exclusions=[]
    invalid={v['stroke'] for v in quality['invalid_strokes']}
    for i,stroke in enumerate(record['strokes']):
        points=[] if i in invalid else stroke_points(stroke)
        raw_points=[p for batch in stroke['events'] for p in batch_points(batch)]
        origin=raw_points[0][2] if raw_points else 0
        eligible=i not in invalid and bool(points)
        last=None
        for batch in stroke['events']:
            values=batch_points(batch)
            if last and values and values[0][2]==last[2] and values[0][:2]!=last[:2]:
                eligible=False;causal_exclusions.append({'stroke':i,'reason':'跨批次同时间戳位置冲突，不能回写过去的观测'})
            if values:last=values[-1]
            batches.append({'stroke':i,'ended':batch['kind'] in ('pointerup','pointercancel'),
                            'points':[[x,y,t-origin] for x,y,t in values]})
        category=f"{stroke['pointer_type']}/{stroke['task']}"
        delivery_strokes.append({'category':category,'origin_ms':origin,'points':points,'eligible':eligible,
                                 'ended_received_ms':stroke.get('ended_received_ms')})
        if points:
            drawings.append({'id':f'device/{identifier}/{i}',
                'category':category,'strokes':[points]})
    frames=[];previous=0
    for frame in record.get('frames',[]):
        observed=frame.get('observed_batches')
        if isinstance(observed,bool) or not isinstance(observed,int) or not previous<=observed<=len(batches):
            raise ValueError('渲染帧引用了无效的已接收事件范围')
        frames.append({'callback_ms':frame['callback_ms'],'observed_batches':observed});previous=observed
    quality['causal_exclusions']=causal_exclusions
    return {'schema_version':1,'provenance':record['provenance'],'device_label':record['device_label'],
            'quality':quality,'drawings':drawings,'delivery':{'strokes':delivery_strokes,'batches':batches,'frames':frames}}
