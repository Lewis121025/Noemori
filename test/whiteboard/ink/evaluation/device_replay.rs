//! 按实际回调可用信息进行设备回放，不能把晚到的合并事件假装成早已可用的输入。
use super::*;

#[path = "../unit/device_delivery.rs"]
mod tests;

/// 输入由采集转换器验证，帧引用的是浏览器当时已收到的事件前缀。
#[derive(Deserialize)]
pub(super) struct Timeline {
    strokes: Vec<DeliveredStroke>,
    batches: Vec<Batch>,
    frames: Vec<Frame>,
}

#[derive(Deserialize)]
struct DeliveredStroke {
    category: String,
    origin_ms: f64,
    points: Vec<[f64; 3]>,
    eligible: bool,
    ended_received_ms: Option<f64>,
}
#[derive(Deserialize)]
struct Batch {
    stroke: usize,
    ended: bool,
    points: Vec<[f64; 3]>,
}
#[derive(Deserialize)]
struct Frame {
    callback_ms: f64,
    observed_batches: usize,
}

/// 在回调时刻预测，只使用此帧前已收到的批次；未来观测仅用于离线参考。
/// 参考仍可能使用不超过 32ms 间隔的插值，不等于物理屏幕时刻或硬件真值。
pub(super) fn evaluate(timeline: &Timeline, experiment: &str) -> Value {
    let mut scores = BTreeMap::<String, Scores>::new();
    let (mut processed, mut ended_frames, mut clock_mismatch, mut expired, mut invalid_frames) =
        (0, 0, 0, 0, 0);
    let mut current = None;
    let mut last: Option<StrokeSample> = None;
    let mut ended = false;
    let mut predictor = predictors::create(experiment);
    for frame in &timeline.frames {
        assert!(
            frame.observed_batches >= processed && frame.observed_batches <= timeline.batches.len()
        );
        for batch in &timeline.batches[processed..frame.observed_batches] {
            let stroke = &timeline.strokes[batch.stroke];
            if current != Some(batch.stroke) {
                predictor = predictors::create(experiment);
                current = Some(batch.stroke);
                last = None;
                ended = false;
            }
            if stroke.eligible {
                for p in &batch.points {
                    let input = sample(*p);
                    if last.is_some_and(|last| last.time_ms == input.time_ms) {
                        assert_eq!(
                            last.unwrap().position,
                            input.position,
                            "冲突时间戳必须由转换器标为不适用"
                        );
                        continue;
                    }
                    predictor.push(input).unwrap();
                    last = Some(input);
                }
            }
            ended |= batch.ended;
        }
        processed = frame.observed_batches;
        let Some(index) = current else {
            continue;
        };
        let stroke = &timeline.strokes[index];
        if !stroke.eligible {
            invalid_frames += 1;
            continue;
        }
        if ended
            || stroke
                .ended_received_ms
                .is_some_and(|end| end <= frame.callback_ms)
        {
            ended_frames += 1;
            continue;
        }
        let Some(input) = last else {
            continue;
        };
        let target_time = frame.callback_ms - stroke.origin_ms;
        if target_time < input.time_ms {
            clock_mismatch += 1;
            continue;
        }
        if target_time - input.time_ms > 24.0 {
            expired += 1;
        }
        let score = scores.entry(stroke.category.clone()).or_default();
        if let Some(target) = reference(&stroke.points, target_time) {
            score.observe(
                predictor.as_ref(),
                input,
                target_time - input.time_ms,
                target,
                drawing_scale(std::slice::from_ref(&stroke.points)),
            );
        } else {
            score.missing_reference += 1;
        }
    }
    let groups: BTreeMap<_, _> = scores
        .iter_mut()
        .map(|(k, v)| (k.clone(), v.report()))
        .collect();
    json!({"query_clock":"actual requestAnimationFrame callback, not display presentation",
        "input_availability":"only batches referenced by the captured frame; late coalesced samples never moved into earlier frames",
        "frames":timeline.frames.len(),"ended_frames":ended_frames,"clock_mismatch_frames":clock_mismatch,
        "expired_horizon_frames":expired,"invalid_input_frames":invalid_frames,"groups":groups})
}
