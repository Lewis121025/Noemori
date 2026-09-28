//! 公开真实笔迹的离线回放；用未提供给预测器的下一条实际采样验证，缺预测按保持当前位置计分。
#[path = "../fixtures/quickdraw.rs"]
mod quickdraw;
#[path = "../support/mod.rs"]
mod support;

use nous_ink::StrokePredictor;
use support::*;

#[test]
fn recorded_trajectories_improve_the_committed_baseline_without_hiding_abstentions() {
    // 固定输入在提交 0756c7d 上的逐笔 RMS；比较前先固定取样规则，未按模型表现挑数据。
    let baseline = [3.688564, 2.880497, 5.920834, 4.725880, 11.568647, 7.986860];
    let (mut total_error, mut total_frames, mut total_predictions) = (0.0, 0, 0);
    for (record, baseline) in quickdraw::RECORDINGS.iter().zip(baseline) {
        let mut predictor = StrokePredictor::default();
        let (mut error, mut frames) = (0.0, 0);
        for (i, &(x, y, time)) in record.samples.iter().enumerate() {
            predictor.push(sample(x, y, time)).unwrap();
            let Some(&(next_x, next_y, next_time)) = record.samples.get(i + 1) else {
                continue;
            };
            if next_time - time > 24.0 {
                continue;
            }
            let prediction = predictor.predict(next_time).unwrap();
            let position = if let Some(p) = prediction {
                assert_eq!(p.source_time_ms, time);
                assert_eq!(p.time_ms, next_time);
                assert!((p.position.x - x).hypot(p.position.y - y) <= 24.0);
                total_predictions += 1;
                p.position
            } else {
                point(x, y)
            };
            error += (position.x - next_x).powi(2) + (position.y - next_y).powi(2);
            frames += 1;
        }
        let rms = (error / f64::from(frames)).sqrt();
        eprintln!(
            "{}：{frames} 次预测，旧 RMS={baseline:.6}，新 RMS={rms:.6}",
            record.id
        );
        assert!(rms <= baseline * 1.02, "{} 出现明显退化：{rms}", record.id);
        total_error += error;
        total_frames += frames;
    }
    let rms = (total_error / f64::from(total_frames)).sqrt();
    eprintln!("真实回放总计：{total_frames} 次，{total_predictions} 次有预测，RMS={rms:.6}");
    assert_eq!(total_frames, 292);
    assert!(total_predictions >= 280, "不能靠大量弃权改善误差");
    assert!(rms < 6.609588 * 0.99, "真实回放尚未超过原有基线：{rms}");
}
