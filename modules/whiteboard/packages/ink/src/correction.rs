use crate::geometry::Project;
use crate::validation::non_negative;
use crate::{
    fit_circle, fit_line, fit_rectangle, CorrectionOptions, Geometry, InkError, Point, Shape,
    StrokeCorrection,
};

/// 为明确指定的几何目标生成逐点修正候选；保留采样数量、顺序和原输入。
/// max_deviation 是所有原始点的硬上限。不可拟合或任一点超限时返回 None。
///
/// # Errors
/// 配置或坐标非法、数值分解失败或算术溢出时返回错误；调用方按点下标保留真实时间与压感。
pub fn correct_stroke(
    points: &[Point],
    options: CorrectionOptions,
) -> Result<Option<StrokeCorrection>, InkError> {
    non_negative(options.max_deviation, "最大修正偏移")?;
    let fit = match options.shape {
        Shape::Line => fit_line(points)?.map(|f| f.map(Geometry::Line)),
        Shape::Circle => fit_circle(points)?.map(|f| f.map(Geometry::Circle)),
        Shape::Rectangle => fit_rectangle(points)?.map(|f| f.map(Geometry::Rectangle)),
    };
    let Some(fit) = fit else {
        return Ok(None);
    };
    if fit.max_deviation > options.max_deviation {
        return Ok(None);
    }
    let projected = points
        .iter()
        .map(|p| fit.geometry.project(*p))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(StrokeCorrection {
        geometry: fit.geometry,
        points: projected,
        rms_deviation: fit.rms_deviation,
        max_deviation: fit.max_deviation,
    }))
}
