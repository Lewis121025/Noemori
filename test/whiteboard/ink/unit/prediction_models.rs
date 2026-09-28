//! 回放评分必须反映实际线性预测的减速和急转保护，不能用另一个更差的模型充当基线。
use super::fit_model;
use crate::{Point, PredictionOptions, StrokePredictor, StrokeSample};
use std::collections::VecDeque;

fn sample(x: f64, y: f64, time_ms: f64) -> StrokeSample {
    StrokeSample {
        position: Point { x, y },
        time_ms,
        pressure: None,
    }
}

#[test]
fn validation_uses_the_same_linear_policy_as_live_prediction() {
    for (last, future) in [
        (sample(22.0, 0.0, 30.0), sample(24.0, 0.0, 40.0)),
        (sample(20.0, 0.0, 30.0), sample(20.0, 0.0, 40.0)),
        (sample(20.0, 10.0, 30.0), sample(20.0, 20.0, 40.0)),
        (sample(30.0, 0.0, 30.0), sample(50.0, 0.0, 50.0)),
    ] {
        let samples = VecDeque::from([
            sample(0.0, 0.0, 0.0),
            sample(10.0, 0.0, 10.0),
            sample(20.0, 0.0, 20.0),
            last,
        ]);
        for max_distance in [0.5, 24.0] {
            let options = PredictionOptions {
                max_distance,
                ..Default::default()
            };
            let mut predictor = StrokePredictor::new(options).unwrap();
            for input in &samples {
                predictor.push(*input).unwrap();
            }
            let predicted = predictor
                .predict(future.time_ms)
                .unwrap()
                .map_or(last.position, |p| p.position);
            let expected_error =
                (predicted.x - future.position.x).hypot(predicted.y - future.position.y);
            let model = fit_model(&samples, samples.len(), 1).unwrap().unwrap();
            let error = model.validation_error(future, options).unwrap().unwrap() * model.scale;
            assert!(
                (error - expected_error).abs() < 1e-10,
                "回放误差 {error}，实际策略误差 {expected_error}"
            );
        }
    }
}

#[test]
fn quadratic_validation_stops_at_zero_forward_velocity() {
    // 匀减速运动在 t=100、x=100 停止；不应继续外推为向后运动。
    let samples: VecDeque<_> = (0..6)
        .map(|i| {
            let t = f64::from(i) * 18.0;
            sample(2.0 * t - 0.01 * t * t, 0.0, t)
        })
        .collect();
    let model = fit_model(&samples, samples.len(), 2).unwrap().unwrap();
    let error = model
        .validation_error(sample(100.0, 0.0, 114.0), PredictionOptions::default())
        .unwrap()
        .unwrap()
        * model.scale;
    assert!(error < 1e-10, "停笔位置误差 {error}");
    assert!(
        model
            .validation_error(sample(100.0, 0.0, 115.0), PredictionOptions::default())
            .unwrap()
            .is_none(),
        "超出时距预算不能用来选择模型"
    );
}
