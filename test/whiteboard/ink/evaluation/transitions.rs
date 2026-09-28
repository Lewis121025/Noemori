//! 使用解析真值密集检查状态切换；事件时间和真值只用于评分，不传给预测器。
use super::*;

#[path = "../unit/transition_evaluation.rs"]
mod tests;

/// 原始生成器的参数快照，输入哈希用于阻止把不同轨迹的标签混用。
#[derive(Deserialize)]
struct Parameters {
    input_sha256: String,
    duration_ms: f64,
    groups: BTreeMap<String, Motion>,
}

#[derive(Deserialize)]
struct Motion {
    family: String,
    speed: f64,
    angle: f64,
    center: [f64; 2],
}

impl Motion {
    fn position(&self, t: f64, duration: f64) -> Point {
        let (x, y) = match self.family.as_str() {
            "pause" => (
                self.speed
                    * if t <= duration / 3.0 {
                        t
                    } else if t <= 2.0 * duration / 3.0 {
                        duration / 3.0
                    } else {
                        t - duration / 3.0
                    },
                0.0,
            ),
            "stop" => {
                let s = t.min(duration * 0.6);
                (self.speed * (s - s * s / (2.0 * duration * 0.6)), 0.0)
            }
            "corner" => (
                self.speed * t.min(duration / 2.0),
                self.speed * (t - duration / 2.0).max(0.0),
            ),
            "reversal" => (
                self.speed * if t <= duration / 2.0 { t } else { duration - t },
                0.0,
            ),
            _ => panic!("无解析切换定义的轨迹"),
        };
        let (s, c) = self.angle.sin_cos();
        Point {
            x: self.center[0] + x * c - y * s,
            y: self.center[1] + x * s + y * c,
        }
    }

    fn events(&self, duration: f64) -> Vec<(&'static str, f64)> {
        match self.family.as_str() {
            "pause" => vec![
                ("pause_stop", duration / 3.0),
                ("pause_resume", 2.0 * duration / 3.0),
            ],
            "stop" => vec![("smooth_stop", duration * 0.6)],
            "corner" => vec![("corner", duration / 2.0)],
            "reversal" => vec![("reversal", duration / 2.0)],
            _ => unreachable!(),
        }
    }
}

fn phase(event: f64, first_changed_sample: Option<f64>, time: f64, horizon: f64) -> &'static str {
    // 边界点的位置仍符合变化前的运动；严格晚于边界的首次观测才包含变化证据。
    let observed = first_changed_sample.is_some_and(|first| time + 1e-9 >= first);
    if !observed {
        if time <= event + 1e-9 {
            return if time + horizon > event + 1e-9 {
                "pre_transition_crossing"
            } else {
                "pre_transition_stable"
            };
        }
        return "no_post_transition_observation";
    }
    let elapsed = time - first_changed_sample.unwrap();
    if elapsed < 16.0 - 1e-9 {
        "response_0_16ms"
    } else if elapsed < 32.0 - 1e-9 {
        "response_16_32ms"
    } else if elapsed < 64.0 - 1e-9 {
        "response_32_64ms"
    } else {
        "settled_after_64ms"
    }
}

/// 对同一组输入与解析标签评分；连续上报和只上报坐标变化是受控实验条件，并非设备事实。
pub(super) fn evaluate(split: &str, experiment: &str) -> Value {
    let path = corpus_path(&format!("transition-parameters-{split}.json"));
    let bytes = fs::read(&path).unwrap();
    let parameters: Parameters = serde_json::from_slice(&bytes).unwrap();
    let manifest: Value =
        serde_json::from_slice(&fs::read(corpus_path("synthetic-v1/manifest.json")).unwrap())
            .unwrap();
    assert_eq!(parameters.input_sha256, manifest["splits"][split]["sha256"]);
    let mut scores = BTreeMap::<String, Scores>::new();
    let mut cases = 0;
    for line in records("synthetic-v1", split) {
        let Synthetic::Motion {
            group,
            rate_hz,
            noise_bound,
            samples,
            queries,
            ..
        } = serde_json::from_str(&line).unwrap()
        else {
            continue;
        };
        let Some(motion) = parameters.groups.get(&group) else {
            continue;
        };
        for &(index, h, x, y) in &queries {
            assert!(
                distance(
                    motion.position(samples[index][2] + h, parameters.duration_ms),
                    Point { x, y }
                ) < 1e-9
            );
        }
        cases += 1;
        let scale = drawing_scale(std::slice::from_ref(&samples));
        for policy in ["all_samples", "coordinate_changes"] {
            let mut last_position = None;
            let accepted: Vec<_> = samples
                .iter()
                .map(|p| {
                    let position = Point { x: p[0], y: p[1] };
                    let accept = policy == "all_samples" || last_position != Some(position);
                    if accept {
                        last_position = Some(position);
                    }
                    accept
                })
                .collect();
            let events: Vec<_> = motion
                .events(parameters.duration_ms)
                .into_iter()
                .map(|(name, time)| {
                    let first = samples
                        .iter()
                        .zip(&accepted)
                        .find(|(p, accepted)| **accepted && p[2] > time + 1e-9)
                        .map(|(p, _)| p[2]);
                    (name, time, first)
                })
                .collect();
            let mut predictor = predictors::create(experiment);
            for (i, p) in samples.iter().enumerate() {
                let input = sample(*p);
                if accepted[i] {
                    predictor.push(input).unwrap();
                }
                for &(event, event_time, first) in &events {
                    if input.time_ms < event_time - 24.0 || input.time_ms > event_time + 80.0 {
                        continue;
                    }
                    for h in HORIZONS {
                        if input.time_ms + h > parameters.duration_ms {
                            continue;
                        }
                        let stage = phase(event_time, first, input.time_ms, h);
                        scores
                            .entry(format!(
                                "{policy}/{event}/{rate_hz}Hz/noise{noise_bound}/{stage}/{h}ms"
                            ))
                            .or_default()
                            .observe(
                                predictor.as_ref(),
                                input,
                                h,
                                motion.position(input.time_ms + h, parameters.duration_ms),
                                scale,
                            );
                    }
                }
            }
        }
    }
    let groups: BTreeMap<_, _> = scores
        .iter_mut()
        .map(|(k, v)| (k.clone(), v.report()))
        .collect();
    json!({"cases":cases,"parameters_sha256":format!("{:x}",Sha256::digest(bytes)),
        "evaluation_source_sha256":format!("{:x}",Sha256::digest(include_bytes!("transitions.rs"))),
        "reference":"dense analytic targets; phase labels never provided to predictors",
        "sampling_policies":"all_samples versus coordinate_changes (drop only exact duplicate positions); controlled conditions, not claims about hardware",
        "observability":"first accepted sample strictly after transition; boundary-position sample alone is not evidence of a changed velocity",
        "groups":groups})
}
