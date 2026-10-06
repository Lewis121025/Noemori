//! 独立图形分类会话的薄绑定；加载与推理都在线程池执行，不进入资料库磁盘队列。

use napi::{Task, bindgen_prelude::*};
use napi_derive::napi;
use noemori_ink::ShapeClassifier;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// 轻量图形识别句柄；后台首次推理才加载固定权重，实例释放后会话随之释放。
#[napi]
pub struct NativeInk {
    path: PathBuf,
    classifier: Arc<Mutex<Option<ShapeClassifier>>>,
}

#[napi]
impl NativeInk {
    /// 路径由主进程提供，页面不能指定任意权重或文件。
    #[napi(constructor)]
    pub fn new(model_path: String) -> Self {
        Self {
            path: model_path.into(),
            classifier: Arc::new(Mutex::new(None)),
        }
    }

    /// 一笔的交错 x/y 世界坐标；非法输入、加载或推理失败通过 Promise 拒绝。
    #[napi(ts_return_type = "Promise<JsShapePrediction>")]
    pub fn classify(&self, coordinates: Vec<f64>) -> Result<AsyncTask<InkTask>> {
        if coordinates.len() < 4
            || coordinates.len() > 16384
            || !coordinates.len().is_multiple_of(2)
        {
            return Err(Error::from_reason("图形识别采样数量无效"));
        }
        Ok(AsyncTask::new(InkTask {
            path: self.path.clone(),
            classifier: Arc::clone(&self.classifier),
            coordinates,
        }))
    }
}

/// 后台分类任务；只适配坐标和结果，不承载几何拟合或文档事务。
pub struct InkTask {
    path: PathBuf,
    classifier: Arc<Mutex<Option<ShapeClassifier>>>,
    coordinates: Vec<f64>,
}

/// 已验证类别和归一化概率。
#[napi(object)]
pub struct JsShapePrediction {
    /// 固定模型类别名。
    pub label: String,
    /// 有限的 [0, 1] 置信度。
    pub confidence: f64,
    /// 只有圆/椭圆候选携带两个真实概率；几何判断不能把全部剩余概率当成另一子类型。
    pub oval: Option<JsOvalEvidence>,
    /// 同一推理的改进分类；渲染端仅在原候选无法修复时验证此候选。
    pub refinement: Option<JsShapeCandidate>,
}

/// 一个独立八类分类头的候选；不能用一个头的置信度混配另一个头的概率。
#[napi(object)]
pub struct JsShapeCandidate {
    /// 固定类别名。
    pub label: String,
    /// 此头的有限[0,1]置信度。
    pub confidence: f64,
    /// 此头在完整八类中的圆椭圆真实概率。
    pub oval: Option<JsOvalEvidence>,
}

fn candidate(probabilities: [f64; 8]) -> JsShapeCandidate {
    let (index, confidence) = probabilities
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .unwrap();
    JsShapeCandidate {
        label: noemori_ink::LABELS[index].into(),
        confidence: *confidence,
        oval: matches!(index, 1 | 2).then_some(JsOvalEvidence {
            circle: probabilities[1],
            ellipse: probabilities[2],
        }),
    }
}

/// 闭合曲线子类型的模型先验；来源于同一次八类 softmax，不重新推理。
#[napi(object)]
pub struct JsOvalEvidence {
    /// 圆在完整八类中的概率。
    pub circle: f64,
    /// 椭圆在完整八类中的概率。
    pub ellipse: f64,
}

impl Task for InkTask {
    type Output = JsShapePrediction;
    type JsValue = JsShapePrediction;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut state = self
            .classifier
            .lock()
            .map_err(|_| Error::from_reason("图形识别会话损坏"))?;
        if state.is_none() {
            *state = Some(
                ShapeClassifier::load(&self.path).map_err(|e| Error::from_reason(e.to_string()))?,
            );
        }
        let points: Vec<_> = self
            .coordinates
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| [p[0], p[1]])
            .collect();
        let evidence = state
            .as_mut()
            .ok_or_else(|| Error::from_reason("缺少图形识别会话"))?
            .evidence(&points)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let primary = candidate(evidence.primary);
        Ok(JsShapePrediction {
            label: primary.label,
            confidence: primary.confidence,
            oval: primary.oval,
            refinement: evidence.refinement.map(candidate),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
