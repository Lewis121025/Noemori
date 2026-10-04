//! 在相同向量上比较训练 PNG 与端侧栅格化的预测；JSONL 输入输出用于保留可审查结果。

use noemori_ink::{LABELS, ShapeClassifier, rasterize_paths};
use serde_json::{Value, json};
use std::{
    error::Error,
    io::{self, BufRead},
    path::Path,
};

fn main() -> Result<(), Box<dyn Error>> {
    let model = std::env::args().nth(1).ok_or("需要 ONNX 路径")?;
    let mut classifier = ShapeClassifier::load(Path::new(&model))?;
    for line in io::stdin().lock().lines() {
        let record: Value = serde_json::from_str(&line?)?;
        let paths: Vec<Vec<[f64; 2]>> = serde_json::from_value(record["paths"].clone())?;
        let references: Vec<_> = paths.iter().map(Vec::as_slice).collect();
        let native_image = rasterize_paths(&references)?;
        let original_image =
            image::open(record["image"].as_str().ok_or("需要图像路径")?)?.into_luma8();
        let original_logits = classifier.logits(&original_image)?;
        let native_logits = classifier.logits(&native_image)?;
        let (original_index, original_confidence) = classifier.classify_image(&original_image)?;
        let (native_index, native_confidence) = classifier.classify_image(&native_image)?;
        println!(
            "{}",
            json!({
                "sample_id": record["sample_id"], "label": record["label"],
                "original": {"label": LABELS[original_index], "confidence": original_confidence, "logits": original_logits},
                "native": {"label": LABELS[native_index], "confidence": native_confidence, "logits": native_logits},
                "pixel_mae": original_image.iter().zip(native_image.iter()).map(|(a,b)|
                    (f64::from(*a)-f64::from(*b)).abs()).sum::<f64>() / (224.0 * 224.0),
            })
        );
    }
    Ok(())
}
