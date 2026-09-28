use crate::{InkError, Point, StrokeSample};

pub(crate) fn finite(value: f64, name: &'static str) -> Result<(), InkError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(InkError::NonFinite(name))
    }
}

pub(crate) fn positive(value: f64, name: &'static str) -> Result<(), InkError> {
    finite(value, name)?;
    if value > 0.0 {
        Ok(())
    } else {
        Err(InkError::OutOfRange(name))
    }
}

pub(crate) fn non_negative(value: f64, name: &'static str) -> Result<(), InkError> {
    finite(value, name)?;
    if value >= 0.0 {
        Ok(())
    } else {
        Err(InkError::OutOfRange(name))
    }
}

pub(crate) fn point(point: Point) -> Result<(), InkError> {
    finite(point.x, "横坐标")?;
    finite(point.y, "纵坐标")
}

pub(crate) fn checked_point(x: f64, y: f64) -> Result<Point, InkError> {
    let result = Point { x, y };
    point(result)?;
    Ok(result)
}

pub(crate) fn sample(sample: StrokeSample) -> Result<(), InkError> {
    point(sample.position)?;
    non_negative(sample.time_ms, "采样时间")?;
    if let Some(pressure) = sample.pressure {
        non_negative(pressure, "压感")?;
        if pressure > 1.0 {
            return Err(InkError::OutOfRange("压感"));
        }
    }
    Ok(())
}

pub(crate) fn increasing_time(time: f64, previous: Option<f64>) -> Result<(), InkError> {
    if previous.is_some_and(|p| time <= p) {
        Err(InkError::NonIncreasingTime)
    } else {
        Ok(())
    }
}
