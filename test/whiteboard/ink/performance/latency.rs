//! 单独运行的性能观测，不以机器负载相关的耗时作为功能断言。
#[path = "../fixtures/quickdraw.rs"]
mod quickdraw;
#[path = "../support/mod.rs"]
mod support;
use nous_ink::{fit_circle, fit_rectangle, Point, StrokePredictor};
use std::hint::black_box;
use std::time::Instant;
use support::*;

#[test]
#[ignore = "在 release 模式手动测量；不把机器负载相关的时间作为 CI 断言"]
fn report_kernel_timings() {
    let mut predictions = Vec::new();
    let mut repeated_predictions = Vec::new();
    for _ in 0..20 {
        for record in quickdraw::RECORDINGS {
            let mut predictor = StrokePredictor::default();
            for (i, &(x, y, time)) in record.samples.iter().enumerate() {
                predictor
                    .push(sample(x, y, time))
                    .unwrap_or_else(|error| panic!("{}: {error}", record.id));
                let Some(&(_, _, next_time)) = record.samples.get(i + 1) else {
                    continue;
                };
                if next_time - time > 24.0 {
                    continue;
                }
                let started = Instant::now();
                black_box(predictor.predict(next_time).unwrap());
                predictions.push(started.elapsed().as_secs_f64() * 1e6);
                // 一次真实采样可被多个显示帧读取；改变时距，避免只测相同结果的重复返回。
                for horizon in [4.0, 8.0, 12.0, 16.0, 20.0, 24.0] {
                    let started = Instant::now();
                    black_box(predictor.predict(black_box(time + horizon)).unwrap());
                    repeated_predictions.push(started.elapsed().as_secs_f64() * 1e6);
                }
            }
        }
    }
    predictions.sort_by(f64::total_cmp);
    eprintln!(
        "预测 {} 次：p50={:.3} µs，p95={:.3} µs",
        predictions.len(),
        predictions[predictions.len() / 2],
        predictions[predictions.len() * 95 / 100]
    );
    repeated_predictions.sort_by(f64::total_cmp);
    eprintln!(
        "同一历史改变时距重复查询 {} 次：p50={:.3} µs，p95={:.3} µs",
        repeated_predictions.len(),
        repeated_predictions[repeated_predictions.len() / 2],
        repeated_predictions[repeated_predictions.len() * 95 / 100]
    );
    let circle: Vec<_> = circle(80.0, 1000)
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            point(
                p.x + (i as f64 * 2.3).sin() * 0.2,
                p.y + (i as f64 * 1.7).cos() * 0.2,
            )
        })
        .collect();
    let corners = rectangle(0.37);
    let rectangle: Vec<Point> = corners
        .windows(2)
        .flat_map(|pair| {
            (0..10).map(move |i| {
                let t = f64::from(i) / 10.0;
                point(
                    pair[0].x + (pair[1].x - pair[0].x) * t,
                    pair[0].y + (pair[1].y - pair[0].y) * t,
                )
            })
        })
        .enumerate()
        .map(|(i, p)| point(p.x + (i as f64 * 2.3).sin() * 0.2, p.y))
        .collect();
    let start = Instant::now();
    for _ in 0..30 {
        black_box(fit_circle(&circle).unwrap().unwrap());
    }
    eprintln!(
        "{} 点圆拟合：平均 {:.3} ms",
        circle.len(),
        start.elapsed().as_secs_f64() * 1000.0 / 30.0
    );
    let start = Instant::now();
    for _ in 0..30 {
        black_box(fit_rectangle(&rectangle).unwrap().unwrap());
    }
    eprintln!(
        "{} 点矩形拟合：平均 {:.3} ms",
        rectangle.len(),
        start.elapsed().as_secs_f64() * 1000.0 / 30.0
    );
}
