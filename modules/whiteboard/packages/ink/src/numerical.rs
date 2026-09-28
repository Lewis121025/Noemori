use crate::validation::finite;
use crate::InkError;
use nalgebra::{linalg::SVD, DMatrix, Dyn};

/// 已通过统一数值秩检查的分解，保留同一阈值供求解使用。
struct FullRankSvd {
    factorization: SVD<f64, Dyn, Dyn>,
    threshold: f64,
}

/// 对归一化后的设计矩阵求解最小二乘，不构造会平方条件数的正规方程。
/// 秩不足表示数据无法唯一确定参数；分解迭代有界，真正的求解失败显式返回错误。
pub(crate) fn least_squares(
    design: DMatrix<f64>,
    observations: &DMatrix<f64>,
) -> Result<Option<DMatrix<f64>>, InkError> {
    for value in observations.iter() {
        finite(*value, "最小二乘输入")?;
    }
    let Some(decomposition) = decompose(design, true)? else {
        return Ok(None);
    };
    let solution = decomposition
        .factorization
        .solve(observations, decomposition.threshold)
        .map_err(|_| InkError::NumericalFailure("奇异值分解状态不完整"))?;
    for value in solution.iter() {
        finite(*value, "最小二乘结果")?;
    }
    Ok(Some(solution))
}

/// 在同一数值秩准则下计算雅可比条件数和伪逆谱范数，避免拟合与诊断对退化的定义不一致。
pub(crate) fn sensitivity(design: DMatrix<f64>) -> Result<Option<(f64, f64)>, InkError> {
    let Some(decomposition) = decompose(design, false)? else {
        return Ok(None);
    };
    let largest = decomposition.factorization.singular_values.amax();
    let smallest = decomposition.factorization.singular_values.amin();
    Ok(Some((largest / smallest, 1.0 / smallest)))
}

fn decompose(design: DMatrix<f64>, vectors: bool) -> Result<Option<FullRankSvd>, InkError> {
    for value in design.iter() {
        finite(*value, "奇异值分解输入")?;
    }
    let (rows, columns) = design.shape();
    if rows < columns {
        return Ok(None);
    }
    let decomposition = SVD::try_new(design, vectors, vectors, f64::EPSILON, 128)
        .ok_or(InkError::NumericalFailure("奇异值分解未收敛"))?;
    let threshold =
        32.0 * f64::EPSILON * rows.max(columns) as f64 * decomposition.singular_values.amax();
    if decomposition.rank(threshold) < columns {
        return Ok(None);
    }
    Ok(Some(FullRankSvd {
        factorization: decomposition,
        threshold,
    }))
}
