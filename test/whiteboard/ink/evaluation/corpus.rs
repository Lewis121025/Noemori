//! 显式运行的大规模评测；默认仅开发集，保留集须指定 NOUS_INK_CORPUS_SPLIT=holdout。
//! NOUS_INK_EVALUATION_OUTPUT 可指定 JSON 报告路径。真实数据的固定时距参考由相邻观测
//! 插值得到，最大参考间隔为 32 ms；合成数据使用解析真值，两者绝不合并为同一精度指标。
use flate2::read::GzDecoder;
use nous_ink::{analyze_circle, fit_line, fit_rectangle, Point, StrokePredictor, StrokeSample};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const HORIZONS: [f64; 4] = [4.0, 8.0, 16.0, 24.0];

mod device_replay;
mod predictors;
mod transitions;

#[path = "../unit/corpus_evaluation.rs"]
mod tests;

/// 仅反序列化评测所需字段，来源识别标签不参与评分或过滤。
#[derive(Deserialize)]
struct Drawing {
    id: String,
    category: String,
    strokes: Vec<Vec<[f64; 3]>>,
}

/// 固定解析标签不依赖正在被比较的算法。
#[derive(Deserialize)]
struct Truth {
    shape: String,
    center: [f64; 2],
    radius: f64,
    width: f64,
    height: f64,
    angle: f64,
    arc_degrees: f64,
    line_start: [f64; 2],
    line_end: [f64; 2],
}

/// 运动案例保留未来真值，几何案例保留原始参数；二者采用不同指标。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Synthetic {
    Motion {
        id: String,
        group: String,
        family: String,
        rate_hz: usize,
        noise_bound: f64,
        samples: Vec<[f64; 3]>,
        queries: Vec<(usize, f64, f64, f64)>,
    },
    Geometry {
        family: String,
        noise_bound: f64,
        points: Vec<[f64; 2]>,
        truth: Truth,
    },
}

/// 记录无预测及异常，不能通过弃权隐藏误差；同时报告原始单位和绘图尺度归一化误差。
#[derive(Default)]
struct Scores {
    errors: Vec<f64>,
    relative_errors: Vec<f64>,
    hold_errors: Vec<f64>,
    predictions: usize,
    algorithm_errors: usize,
    missing_reference: usize,
}

fn distance(a: Point, b: Point) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}

fn point(p: [f64; 2]) -> Point {
    Point { x: p[0], y: p[1] }
}

fn sample(p: [f64; 3]) -> StrokeSample {
    StrokeSample {
        position: Point { x: p[0], y: p[1] },
        time_ms: p[2],
        pressure: None,
    }
}

fn distribution(values: &mut [f64]) -> Value {
    if values.is_empty() {
        return json!({"count": 0});
    }
    values.sort_by(f64::total_cmp);
    let q = |p: f64| values[((values.len() - 1) as f64 * p) as usize];
    json!({"count": values.len(), "rms": (values.iter().map(|x| x*x).sum::<f64>()/values.len() as f64).sqrt(),
           "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": values[values.len()-1]})
}

impl Scores {
    fn observe(
        &mut self,
        predictor: &dyn predictors::Predictor,
        input: StrokeSample,
        horizon: f64,
        target: Point,
        scale: f64,
    ) {
        let position = match predictor.predict(input.time_ms + horizon) {
            Ok(Some(p)) => {
                self.predictions += 1;
                p.position
            }
            Ok(None) => input.position,
            Err(_) => {
                self.algorithm_errors += 1;
                input.position
            }
        };
        let error = distance(position, target);
        self.errors.push(error);
        self.relative_errors
            .push(if scale > 0.0 { error / scale } else { error });
        self.hold_errors.push(distance(input.position, target));
    }

    fn report(&mut self) -> Value {
        json!({"position_error": distribution(&mut self.errors),
            "relative_to_drawing_diagonal": distribution(&mut self.relative_errors),
            "hold_last_observation_error": distribution(&mut self.hold_errors),
            "predictions": self.predictions, "algorithm_errors": self.algorithm_errors,
            "missing_reference": self.missing_reference})
    }
}

fn corpus_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../test/whiteboard/ink/fixtures")
        .join(name)
}

fn records(name: &str, split: &str) -> impl Iterator<Item = String> {
    let root = corpus_path(name);
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let entry = &manifest["splits"][split];
    let filename = entry["file"].as_str().unwrap();
    assert_eq!(filename, format!("{split}.ndjson.gz"));
    let data = fs::read(root.join(filename)).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&data)),
        entry["sha256"].as_str().unwrap()
    );
    BufReader::new(GzDecoder::new(std::io::Cursor::new(data)))
        .lines()
        .map(Result::unwrap)
}

fn drawing_scale(strokes: &[Vec<[f64; 3]>]) -> f64 {
    let (mut low_x, mut low_y, mut high_x, mut high_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in strokes.iter().flatten() {
        low_x = low_x.min(p[0]);
        low_y = low_y.min(p[1]);
        high_x = high_x.max(p[0]);
        high_y = high_y.max(p[1]);
    }
    (high_x - low_x).hypot(high_y - low_y)
}

fn unique_times(stroke: Vec<[f64; 3]>) -> Vec<[f64; 3]> {
    // 同一事件时刻取最后报告的位置，原始文件仍保留全部点；不能把重复时间递交给内核。
    let mut result: Vec<[f64; 3]> = Vec::new();
    for p in stroke {
        if result.last().is_some_and(|last| last[2] == p[2]) {
            result.pop();
        }
        if let Some(last) = result.last() {
            assert!(p[2] > last[2]);
        }
        result.push(p);
    }
    result
}

fn reference(stroke: &[[f64; 3]], time: f64) -> Option<Point> {
    let after = stroke.partition_point(|p| p[2] < time);
    let b = *stroke.get(after)?;
    if b[2] == time {
        return Some(Point { x: b[0], y: b[1] });
    }
    let a = *stroke.get(after.checked_sub(1)?)?;
    if b[2] - a[2] > 32.0 {
        return None;
    }
    let fraction = (time - a[2]) / (b[2] - a[2]);
    Some(Point {
        x: a[0] + (b[0] - a[0]) * fraction,
        y: a[1] + (b[1] - a[1]) * fraction,
    })
}

fn forecast_position(
    predictor: &dyn predictors::Predictor,
    last: StrokeSample,
    time: f64,
) -> Point {
    predictor
        .predict(time)
        .expect("合法语料上的重预测查询不能产生数值错误")
        .map_or(last.position, |p| p.position)
}

fn before_update(
    predictor: &dyn predictors::Predictor,
    previous: Option<StrokeSample>,
    input: StrokeSample,
) -> Option<Point> {
    previous
        .filter(|p| input.time_ms - p.time_ms <= 20.0)
        .map(|p| forecast_position(predictor, p, input.time_ms + 4.0))
}

fn evaluate_real(split: &str, experiment: &str) -> Value {
    evaluate_drawings(
        records("corpus-v1", split).map(|line| serde_json::from_str(&line).unwrap()),
        experiment,
    )
}

fn evaluate_drawings(input_drawings: impl Iterator<Item = Drawing>, experiment: &str) -> Value {
    let mut scores = BTreeMap::<String, Scores>::new();
    let mut drawing_rms = Vec::new();
    let mut drawing_relative_rms = Vec::new();
    let mut paired_drawings = Vec::new();
    let mut reforecast_changes = Vec::new();
    let (mut drawings, mut strokes, mut observations) = (0, 0, 0);
    for drawing in input_drawings {
        let scale = drawing_scale(&drawing.strokes);
        let (mut squares, mut queries) = (0.0, 0);
        for raw in drawing.strokes {
            let stroke = unique_times(raw);
            let mut predictor = predictors::create(experiment);
            for (index, p) in stroke.iter().enumerate() {
                let input = sample(*p);
                let previous = index.checked_sub(1).map(|i| sample(stroke[i]));
                let old_future = before_update(predictor.as_ref(), previous, input);
                predictor
                    .push(input)
                    .unwrap_or_else(|e| panic!("{}: {e}", drawing.id));
                if let Some(old) = old_future {
                    reforecast_changes.push(distance(
                        old,
                        forecast_position(predictor.as_ref(), input, input.time_ms + 4.0),
                    ));
                }
                for horizon in HORIZONS {
                    let score = scores
                        .entry(format!("interpolated/{}/{horizon}ms", drawing.category))
                        .or_default();
                    if let Some(target) = reference(&stroke, p[2] + horizon) {
                        score.observe(predictor.as_ref(), input, horizon, target, scale);
                        squares += score.errors.last().unwrap().powi(2);
                        queries += 1;
                    } else {
                        score.missing_reference += 1;
                    }
                }
                let score = scores
                    .entry(format!("observed_next/{}", drawing.category))
                    .or_default();
                if let Some(next) = stroke.get(index + 1).filter(|next| next[2] - p[2] <= 24.0) {
                    score.observe(
                        predictor.as_ref(),
                        input,
                        next[2] - p[2],
                        Point {
                            x: next[0],
                            y: next[1],
                        },
                        scale,
                    );
                } else {
                    score.missing_reference += 1;
                }
            }
            observations += stroke.len();
            strokes += 1;
        }
        if queries > 0 {
            let rms = (squares / queries as f64).sqrt();
            drawing_rms.push(rms);
            drawing_relative_rms.push(if scale > 0.0 { rms / scale } else { rms });
            paired_drawings.push(
                json!({"id":drawing.id,"rms":rms,"relative_rms":if scale>0.0{rms/scale}else{rms}}),
            );
        }
        drawings += 1;
    }
    let groups: BTreeMap<_, _> = scores
        .iter_mut()
        .map(|(k, v)| (k.clone(), v.report()))
        .collect();
    json!({"reference": "interpolated groups: future observation interpolation with gap <=32ms; observed_next groups: next real sample within 24ms; neither fed to predictor",
        "drawings": drawings, "strokes": strokes, "observations_after_duplicate_time_coalescing": observations,
        "per_drawing_fixed_horizon_rms_distribution": distribution(&mut drawing_rms),
        "per_drawing_fixed_horizon_relative_rms_distribution": distribution(&mut drawing_relative_rms),
        "paired_drawings":paired_drawings,
        "reforecast_change_same_target_4ms":distribution(&mut reforecast_changes),
        "reforecast_definition":"prediction change at identical target time before/after a real event, dt<=20ms; abstention holds latest observed position; not ground-truth error",
        "groups": groups})
}

fn corners(center: Point, width: f64, height: f64, angle: f64) -> Vec<Point> {
    let (s, c) = angle.sin_cos();
    [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)]
        .iter()
        .map(|(x, y)| {
            let (u, v) = (x * width / 2.0, y * height / 2.0);
            Point {
                x: center.x + u * c - v * s,
                y: center.y + u * s + v * c,
            }
        })
        .collect()
}

fn symmetric_distance(a: &[Point], b: &[Point]) -> f64 {
    let directed = |a: &[Point], b: &[Point]| {
        a.iter()
            .map(|a| {
                b.iter()
                    .map(|b| distance(*a, *b))
                    .fold(f64::INFINITY, f64::min)
            })
            .fold(0.0, f64::max)
    };
    directed(a, b).max(directed(b, a))
}

/// 显式计入不可拟合案例；参数偏差与残差分别记录，避免低残差掩盖不稳定参数。
#[derive(Default)]
struct GeometryScores {
    cases: usize,
    failed: usize,
    algorithm_errors: usize,
    parameter_errors: Vec<f64>,
    residuals: Vec<f64>,
    condition_numbers: Vec<f64>,
    relative_residual_sensitivities: Vec<f64>,
    sensitivity_unavailable: usize,
}

fn evaluate_geometry(points: Vec<[f64; 2]>, truth: Truth, score: &mut GeometryScores) {
    score.cases += 1;
    let points: Vec<_> = points.into_iter().map(point).collect();
    let result = match truth.shape.as_str() {
        "circle" => analyze_circle(&points).map(|analysis| {
            analysis.map(|analysis| {
                let f = analysis.fit;
                if let Some(sensitivity) = analysis.sensitivity {
                    score.condition_numbers.push(sensitivity.condition_number);
                    score
                        .relative_residual_sensitivities
                        .push(sensitivity.relative_residual_sensitivity);
                } else {
                    score.sensitivity_unavailable += 1;
                }
                (
                    (distance(f.geometry.center, point(truth.center))
                        + (f.geometry.radius - truth.radius).abs())
                        / truth.radius,
                    f.rms_deviation,
                )
            })
        }),
        "line" => fit_line(&points).map(|fit| {
            fit.map(|f| {
                (
                    symmetric_distance(
                        &[f.geometry.start, f.geometry.end],
                        &[point(truth.line_start), point(truth.line_end)],
                    ) / distance(point(truth.line_start), point(truth.line_end)),
                    f.rms_deviation,
                )
            })
        }),
        "rectangle" => fit_rectangle(&points).map(|fit| {
            fit.map(|f| {
                (
                    symmetric_distance(
                        &corners(
                            f.geometry.center,
                            f.geometry.width,
                            f.geometry.height,
                            f.geometry.angle,
                        ),
                        &corners(point(truth.center), truth.width, truth.height, truth.angle),
                    ) / truth.width.hypot(truth.height),
                    f.rms_deviation,
                )
            })
        }),
        _ => panic!("未知真值形状"),
    };
    match result {
        Ok(Some((error, residual))) => {
            score.parameter_errors.push(error);
            score.residuals.push(residual);
        }
        Ok(None) => score.failed += 1,
        Err(_) => {
            score.failed += 1;
            score.algorithm_errors += 1;
        }
    }
}

fn evaluate_synthetic(split: &str, experiment: &str) -> Value {
    let mut motion = BTreeMap::<String, Scores>::new();
    let mut geometry = BTreeMap::<String, GeometryScores>::new();
    let mut reforecast = BTreeMap::<String, Vec<f64>>::new();
    let mut paired_motion_cases = Vec::new();
    for line in records("synthetic-v1", split) {
        match serde_json::from_str::<Synthetic>(&line).unwrap() {
            Synthetic::Motion {
                id,
                group,
                family,
                rate_hz,
                noise_bound,
                samples,
                queries,
            } => {
                let scale = drawing_scale(std::slice::from_ref(&samples));
                let mut predictor = predictors::create(experiment);
                let mut queries = queries.into_iter().peekable();
                let mut previous = None;
                let (mut case_squares, mut case_queries) = (0.0, 0usize);
                for (i, p) in samples.into_iter().enumerate() {
                    let input = sample(p);
                    let old_future = before_update(predictor.as_ref(), previous, input);
                    predictor.push(input).unwrap();
                    if let Some(old) = old_future {
                        reforecast
                            .entry(format!("{family}/{rate_hz}Hz/noise{noise_bound}"))
                            .or_default()
                            .push(distance(
                                old,
                                forecast_position(predictor.as_ref(), input, input.time_ms + 4.0),
                            ));
                    }
                    previous = Some(input);
                    while queries.peek().is_some_and(|q| q.0 == i) {
                        let (_, horizon, x, y) = queries.next().unwrap();
                        let score = motion
                            .entry(format!(
                                "{family}/{rate_hz}Hz/noise{noise_bound}/{horizon}ms"
                            ))
                            .or_default();
                        score.observe(predictor.as_ref(), input, horizon, Point { x, y }, scale);
                        case_squares += score.errors.last().unwrap().powi(2);
                        case_queries += 1;
                    }
                }
                assert!(queries.next().is_none(), "真值索引没有对应采样");
                paired_motion_cases.push(
                    json!({"id":id,"group":group,"family":family,"rate_hz":rate_hz,
                    "noise_bound":noise_bound,"rms":(case_squares/case_queries as f64).sqrt()}),
                );
            }
            Synthetic::Geometry {
                family,
                noise_bound,
                points,
                truth,
            } => {
                let group = if family == "arc" {
                    format!("{family}/{}deg/noise{noise_bound}", truth.arc_degrees)
                } else {
                    format!("{family}/noise{noise_bound}")
                };
                evaluate_geometry(points, truth, geometry.entry(group).or_default());
            }
        }
    }
    let motion: BTreeMap<_, _> = motion
        .iter_mut()
        .map(|(k, v)| (k.clone(), v.report()))
        .collect();
    let geometry: BTreeMap<_,_> = geometry.iter_mut().map(|(k,v)|(k.clone(),json!({"cases":v.cases,
        "failed":v.failed,"algorithm_errors":v.algorithm_errors,"relative_parameter_error":distribution(&mut v.parameter_errors),
        "point_residual":distribution(&mut v.residuals),
        "circle_condition_number":distribution(&mut v.condition_numbers),
        "circle_relative_residual_sensitivity":distribution(&mut v.relative_residual_sensitivities),
        "circle_sensitivity_unavailable":v.sensitivity_unavailable}))).collect();
    let reforecast: BTreeMap<_, _> = reforecast
        .iter_mut()
        .map(|(k, v)| (k.clone(), distribution(v)))
        .collect();
    json!({"reference":"analytic ground truth; independent of predictor", "motion":motion,"geometry":geometry,
        "paired_motion_cases":paired_motion_cases,"reforecast_change_same_target_4ms":reforecast})
}

#[test]
#[ignore = "大规模离线评分，显式运行；开发过程中不自动打开保留集评分"]
fn evaluate_corpus() {
    if let Ok(path) = std::env::var("NOUS_INK_DEVICE_CORPUS") {
        evaluate_device_recording(Path::new(&path));
        return;
    }
    let split =
        std::env::var("NOUS_INK_CORPUS_SPLIT").unwrap_or_else(|_| "development".to_string());
    assert!(["development", "validation", "holdout"].contains(&split.as_str()));
    let experiment =
        std::env::var("NOUS_INK_EXPERIMENT").unwrap_or_else(|_| "baseline".to_string());
    let _ = predictors::create(&experiment);
    let transition_report = if std::env::var("NOUS_INK_TRANSITIONS").as_deref() == Ok("1") {
        transitions::evaluate(&split, &experiment)
    } else {
        Value::Null
    };
    let manifests: BTreeMap<_, _> = ["corpus-v1", "synthetic-v1"]
        .into_iter()
        .map(|name| {
            (
                name,
                format!(
                    "{:x}",
                    Sha256::digest(fs::read(corpus_path(name).join("manifest.json")).unwrap())
                ),
            )
        })
        .collect();
    let report = json!({"split":split,"experiment":experiment,"corpus_manifest_sha256":manifests,
        "kernel_source_sha256":kernel_fingerprint(),
        "evaluation_source_sha256":format!("{:x}",Sha256::digest(include_bytes!("corpus.rs"))),
        "experimental_predictors_sha256":format!("{:x}",Sha256::digest(include_bytes!("predictors.rs"))),
        "quantile_method":"floor((n-1)*p) after ascending sort",
        "real":evaluate_real(&split,&experiment),"synthetic":evaluate_synthetic(&split,&experiment),"transitions":transition_report});
    let output = serde_json::to_string_pretty(&report).unwrap();
    if let Ok(path) = std::env::var("NOUS_INK_EVALUATION_OUTPUT") {
        fs::write(&path, output).unwrap();
        println!("评测报告：{path}");
    } else {
        println!("{output}");
    }
}

fn evaluate_device_recording(path: &Path) {
    #[derive(Deserialize)]
    struct DeviceInput {
        schema_version: u32,
        provenance: String,
        device_label: String,
        source_sha256: String,
        quality: Value,
        drawings: Vec<Drawing>,
        delivery: device_replay::Timeline,
    }
    let data: DeviceInput = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(data.schema_version, 1);
    assert!(
        data.provenance == "manual"
            || (data.provenance == "automation_test"
                && std::env::var("NOUS_INK_ALLOW_AUTOMATION").as_deref() == Ok("1")),
        "自动化轨迹不属于设备实测"
    );
    let experiment =
        std::env::var("NOUS_INK_EXPERIMENT").unwrap_or_else(|_| "baseline".to_string());
    let report = json!({"mode":"device_recording","provenance":data.provenance,"device_label":data.device_label,
        "source_sha256":data.source_sha256,"quality":data.quality,"experiment":experiment,"kernel_source_sha256":kernel_fingerprint(),
        "evaluation_source_sha256":format!("{:x}",Sha256::digest(include_bytes!("corpus.rs"))),
        "experimental_predictors_sha256":format!("{:x}",Sha256::digest(include_bytes!("predictors.rs"))),
        "sample_time_replay":evaluate_drawings(data.drawings.into_iter(),&experiment),
        "delivery_time_replay":device_replay::evaluate(&data.delivery,&experiment)});
    let output = serde_json::to_string_pretty(&report).unwrap();
    if let Ok(path) = std::env::var("NOUS_INK_EVALUATION_OUTPUT") {
        fs::write(path, output).unwrap();
    } else {
        println!("{output}");
    }
}

#[test]
#[ignore = "独立测量完整更新加查询耗时，不把机器相关时间作为 CI 断言"]
fn benchmark_focused_prediction() {
    use std::{hint::black_box, time::Instant};
    let mut metrics = BTreeMap::new();
    for name in [
        "baseline",
        "kalman32",
        "kalman32_noise",
        "kalman32_adaptive",
    ] {
        let mut times = Vec::new();
        for rate in [60.0, 120.0, 500.0] {
            for _ in 0..20 {
                let mut predictor = predictors::create(name);
                for i in 0..200 {
                    let t = f64::from(i) * 1000.0 / rate;
                    let input =
                        sample([0.4 * t + 0.2 * (t * 1.7).sin(), 20.0 * (t * 0.01).sin(), t]);
                    let start = Instant::now();
                    predictor.push(black_box(input)).unwrap();
                    black_box(predictor.predict(black_box(t + 16.0)).unwrap());
                    times.push(start.elapsed().as_secs_f64() * 1e6);
                }
            }
        }
        metrics.insert(name, distribution(&mut times));
    }
    let output=serde_json::to_string_pretty(&json!({"unit":"microseconds","scope":"push plus first 16ms query; 60/120/500Hz; synthetic curve with coordinate noise","metrics":metrics})).unwrap();
    if let Ok(path) = std::env::var("NOUS_INK_TIMING_OUTPUT") {
        fs::write(path, output).unwrap();
    } else {
        println!("{output}");
    }
}

fn kernel_fingerprint() -> String {
    fn collect(root: &Path, files: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect(&path, files);
            } else {
                files.push(path);
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![root.join("Cargo.toml"), root.join("Cargo.lock")];
    collect(&root.join("src"), &mut files);
    files.sort();
    let mut hash = Sha256::new();
    for file in files {
        hash.update(
            file.strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .as_bytes(),
        );
        hash.update([0]);
        hash.update(fs::read(file).unwrap());
        hash.update([0]);
    }
    format!("{hash:x}", hash = hash.finalize())
}
