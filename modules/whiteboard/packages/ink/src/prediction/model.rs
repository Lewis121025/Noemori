use super::{
    bounded_position, linear_velocity, observed_velocity, unit_direction, PredictionOptions,
};
use crate::numerical::least_squares;
use crate::validation::{checked_point, finite};
use crate::{InkError, Point, StrokeSample};
use nalgebra::DMatrix;
use std::collections::VecDeque;

#[cfg(test)]
#[path = "../../../../../../test/whiteboard/ink/unit/prediction_models.rs"]
mod tests;

/// 局部归一化运动模型；拟合证据与可执行的有界外推分离，预测始终锚定最后真实位置。
#[derive(Debug)]
pub(super) struct MotionModel {
    anchor: StrokeSample,
    duration: f64,
    scale: f64,
    linear: Point,
    quadratic: Option<Point>,
    direction: Option<Point>,
    aicc: f64,
}

impl MotionModel {
    fn relative_time(&self, time: f64) -> Result<Option<f64>, InkError> {
        let u = (time - self.anchor.time_ms) / self.duration;
        finite(u, "归一化预测时距")?;
        Ok((u >= 0.0).then_some(u))
    }

    fn offset(&self, u: f64, quadratic: Point) -> Point {
        Point {
            x: (self.linear.x + u * quadratic.x) * u,
            y: (self.linear.y + u * quadratic.y) * u,
        }
    }

    fn validation_error(
        &self,
        sample: StrokeSample,
        options: PredictionOptions,
    ) -> Result<Option<f64>, InkError> {
        if sample.time_ms - self.anchor.time_ms > options.max_horizon_ms {
            return Ok(None);
        }
        let Some(offset) = self.predict(sample.time_ms)? else {
            return Ok(None);
        };
        let length = offset.x.hypot(offset.y);
        finite(length, "回放预测位移")?;
        let position = if length == 0.0 {
            self.anchor.position
        } else {
            bounded_position(
                self.anchor.position,
                unit_direction(offset),
                length.min(options.max_distance),
                options.max_distance,
            )?
            .unwrap_or(self.anchor.position)
        };
        Ok(Some(
            ((position.x - sample.position.x) / self.scale)
                .hypot((position.y - sample.position.y) / self.scale),
        ))
    }

    /// 曲率只延续一个历史跨度，之后沿边界切线延续，保持位置与速度连续。
    /// 支撑范围外不继续积累加速度，也不把证据不足误当作用户减速；最终位移仍受调用方预算限制。
    /// 只依赖已选模型，坐标运算溢出返回错误，不写入真实历史。
    pub(super) fn predict(&self, time: f64) -> Result<Option<Point>, InkError> {
        let Some(u) = self.relative_time(time)? else {
            return Ok(None);
        };
        let Some(direction) = self.direction else {
            return Ok(Some(Point { x: 0.0, y: 0.0 }));
        };
        let Some(quadratic) = self.quadratic else {
            // 线性回放保持实际线性执行策略，不对可靠的匀速运动施加曲率衰减。
            return Ok(Some(checked_point(
                self.linear.x * u * self.scale,
                self.linear.y * u * self.scale,
            )?));
        };
        let mut supported_time = u.min(1.0);
        let velocity = self.linear.x * direction.x + self.linear.y * direction.y;
        let acceleration = 2.0 * (quadratic.x * direction.x + quadratic.y * direction.y);
        // 减速模型到达前进分量为零的位置就停止，不把用户可能的停笔外推为反向运动。
        if velocity <= 0.0 {
            supported_time = 0.0;
        } else if acceleration < 0.0 {
            supported_time = supported_time.min(-velocity / acceleration);
        }
        let mut offset = self.offset(supported_time, quadratic);
        if u > 1.0 && supported_time == 1.0 {
            // 延续同一条轨迹的边界位置与导数，不能切换成从原点起算的另一条直线。
            // 若已在支撑区间内停笔，则没有余速，不追加延伸。
            let extension = u - 1.0;
            offset.x += (self.linear.x + 2.0 * quadratic.x) * extension;
            offset.y += (self.linear.y + 2.0 * quadratic.y) * extension;
        }
        Ok(Some(checked_point(
            offset.x * self.scale,
            offset.y * self.scale,
        )?))
    }
}

fn fit_model(
    samples: &VecDeque<StrokeSample>,
    count: usize,
    degree: usize,
) -> Result<Option<MotionModel>, InkError> {
    let anchor = samples[count - 1];
    let duration = anchor.time_ms - samples[0].time_ms;
    let mut scale: f64 = 0.0;
    for sample in samples.iter().take(count) {
        let delta = checked_point(
            sample.position.x - anchor.position.x,
            sample.position.y - anchor.position.y,
        )?;
        scale = scale.max(delta.x.abs()).max(delta.y.abs());
    }
    if scale == 0.0 {
        return Ok(None);
    }
    let design = DMatrix::from_fn(count, degree + 1, |row, column| {
        let u = (samples[row].time_ms - anchor.time_ms) / duration;
        match column {
            0 => 1.0,
            1 => u,
            _ => u * u,
        }
    });
    let observations = DMatrix::from_fn(count, 2, |row, column| {
        let sample = samples[row];
        if column == 0 {
            (sample.position.x - anchor.position.x) / scale
        } else {
            (sample.position.y - anchor.position.y) / scale
        }
    });
    let Some(parameters) = least_squares(design, &observations)? else {
        return Ok(None);
    };
    let mut squared_error = 0.0;
    for row in 0..count {
        let u = (samples[row].time_ms - anchor.time_ms) / duration;
        for column in 0..2 {
            let fitted = parameters[(0, column)]
                + parameters[(1, column)] * u
                + if degree == 2 {
                    parameters[(2, column)] * u * u
                } else {
                    0.0
                };
            squared_error += (fitted - observations[(row, column)]).powi(2);
        }
    }
    // AICc 对短窗口的额外参数施加惩罚，包括未知噪声方差，避免把随机抖动解释为加速度。
    let observations_count = (count * 2) as f64;
    let parameter_count = ((degree + 1) * 2 + 1) as f64;
    let aicc = if observations_count > parameter_count + 1.0 {
        let variance = (squared_error / observations_count).max((64.0 * f64::EPSILON).powi(2));
        observations_count * variance.ln()
            + 2.0 * parameter_count
            + 2.0 * parameter_count * (parameter_count + 1.0)
                / (observations_count - parameter_count - 1.0)
    } else {
        f64::INFINITY
    };
    let current = observed_velocity(samples, count)?;
    // 拟合残差仍用于 AICc；留出样本则必须使用实际执行的停笔、转向和限速策略评分。
    let linear = if degree == 1 {
        let velocity = match current {
            Some(current) => linear_velocity(samples, count, current)?,
            None => None,
        }
        .unwrap_or(Point { x: 0.0, y: 0.0 });
        checked_point(velocity.x / scale * duration, velocity.y / scale * duration)?
    } else {
        Point {
            x: parameters[(1, 0)],
            y: parameters[(1, 1)],
        }
    };
    Ok(Some(MotionModel {
        anchor,
        duration,
        scale,
        linear,
        direction: current.map(unit_direction),
        quadratic: if degree == 2 {
            Some(Point {
                x: parameters[(2, 0)],
                y: parameters[(2, 1)],
            })
        } else {
            None
        },
        aicc,
    }))
}

/// 在最近两个历史时刻分别回放下一点；二次模型须改善两次误差和完整窗口的 AICc 才采用。
/// 只处理已观测数据，不把未来时刻的真实坐标泄漏进选择过程；证据不足返回 None。
pub(super) fn select_quadratic_model(
    samples: &VecDeque<StrokeSample>,
    options: PredictionOptions,
) -> Result<Option<MotionModel>, InkError> {
    if samples.len() < 6 {
        return Ok(None);
    }
    // 每次只用目标之前的数据重新拟合，保证回放时距与实时下一点预测一致；
    // 从同一前缀预测两点会把第二点变成超出预算的远期预测，错误排除低采样率输入。
    for training_count in samples.len() - 2..samples.len() {
        let Some(linear) = fit_model(samples, training_count, 1)? else {
            return Ok(None);
        };
        let Some(quadratic) = fit_model(samples, training_count, 2)? else {
            return Ok(None);
        };
        let sample = samples[training_count];
        let (Some(a), Some(b)) = (
            linear.validation_error(sample, options)?,
            quadratic.validation_error(sample, options)?,
        ) else {
            return Ok(None);
        };
        finite(a, "线性模型回放误差")?;
        finite(b, "二次模型回放误差")?;
        // 差异小于归一化空间的舍入误差时，保持更简单的线性模型。
        if b + 64.0 * f64::EPSILON >= a {
            return Ok(None);
        }
    }
    let Some(model) = fit_model(samples, samples.len(), 2)? else {
        return Ok(None);
    };
    let Some(linear) = fit_model(samples, samples.len(), 1)? else {
        return Ok(None);
    };
    if model.aicc >= linear.aicc {
        return Ok(None);
    }
    Ok(Some(model))
}
