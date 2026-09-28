use crate::validation::{finite, non_negative, point};
use crate::{InkError, Point};

/// 吸附目标；只借用标识，不依赖任何场景模型。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapTarget<'a> {
    /// 调用方提供的目标标识。
    pub id: &'a str,
    /// 目标位置，单位与输入一致。
    pub position: Point,
}

/// 单轴几何约束的方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    /// 横坐标轴。
    X,
    /// 纵坐标轴。
    Y,
}

/// 单轴导线；阈值和位置使用相同坐标单位。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AxisGuide<'a> {
    /// 调用方提供的导线标识。
    pub id: &'a str,
    /// 导线约束哪个坐标分量。
    pub axis: Axis,
    /// 导线对应的坐标值。
    pub value: f64,
}

/// 点吸附结果；输入与目标位置不会被修改。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointSnap<'a> {
    /// 吸附后的位置。
    pub position: Point,
    /// 相对输入的位移。
    pub offset: Point,
    /// 命中目标的标识。
    pub target_id: &'a str,
}

/// 双轴吸附结果；没有命中的轴保持原值。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AxisSnap<'a> {
    /// 吸附后的位置。
    pub position: Point,
    /// 相对输入的位移。
    pub offset: Point,
    /// 命中的横坐标导线标识，未命中时为 None。
    pub x_guide_id: Option<&'a str>,
    /// 命中的纵坐标导线标识，未命中时为 None。
    pub y_guide_id: Option<&'a str>,
}

/// 选择欧氏距离最近且不超过 max_distance 的目标；等距时稳定选择靠前项。
/// 阈值包含边界；空列表或未命中返回 None，所有候选都会被校验。
///
/// # Errors
/// 坐标非有限值，或阈值非法时返回错误。屏幕阈值需由调用方换算。
pub fn snap_point<'a>(
    input: Point,
    targets: &[SnapTarget<'a>],
    max_distance: f64,
) -> Result<Option<PointSnap<'a>>, InkError> {
    point(input)?;
    non_negative(max_distance, "最大吸附距离")?;
    let (mut selected, mut minimum) = (None, f64::INFINITY);
    for target in targets {
        point(target.position)?;
        let distance = (target.position.x - input.x).hypot(target.position.y - input.y);
        if distance <= max_distance && distance < minimum {
            minimum = distance;
            selected = Some(target);
        }
    }
    Ok(selected.map(|target| PointSnap {
        position: target.position,
        offset: Point {
            x: target.position.x - input.x,
            y: target.position.y - input.y,
        },
        target_id: target.id,
    }))
}

/// 独立选择两轴的最近导线；max_distance 约束每轴偏移，不约束合成后的欧氏距离。
/// 等距时选择靠前项，未命中轴保持原值，两轴都未命中返回 None。
///
/// # Errors
/// 坐标、导线位置非有限值或阈值非法时返回错误。
pub fn snap_axes<'a>(
    input: Point,
    guides: &[AxisGuide<'a>],
    max_distance: f64,
) -> Result<Option<AxisSnap<'a>>, InkError> {
    point(input)?;
    non_negative(max_distance, "最大吸附距离")?;
    let mut x_guide: Option<&AxisGuide<'a>> = None;
    let mut y_guide: Option<&AxisGuide<'a>> = None;
    for guide in guides {
        finite(guide.value, "导线位置")?;
        let (coordinate, selected) = match guide.axis {
            Axis::X => (input.x, &mut x_guide),
            Axis::Y => (input.y, &mut y_guide),
        };
        let distance = (guide.value - coordinate).abs();
        if distance <= max_distance
            && selected.is_none_or(|p| distance < (p.value - coordinate).abs())
        {
            *selected = Some(guide);
        }
    }
    if x_guide.is_none() && y_guide.is_none() {
        return Ok(None);
    }
    let position = Point {
        x: x_guide.map_or(input.x, |g| g.value),
        y: y_guide.map_or(input.y, |g| g.value),
    };
    Ok(Some(AxisSnap {
        position,
        offset: Point {
            x: position.x - input.x,
            y: position.y - input.y,
        },
        x_guide_id: x_guide.map(|g| g.id),
        y_guide_id: y_guide.map(|g| g.id),
    }))
}
