//! 使用产品的同一栅格化函数生成训练视图；不加载模型，不读取预测或选择样本。

use noemori_ink::rasterize_paths;
use serde_json::Value;
use std::{
    error::Error,
    io::{self, BufRead},
};

fn main() -> Result<(), Box<dyn Error>> {
    for line in io::stdin().lock().lines() {
        let record: Value = serde_json::from_str(&line?)?;
        let paths: Vec<Vec<[f64; 2]>> = serde_json::from_value(record["paths"].clone())?;
        let references: Vec<_> = paths.iter().map(Vec::as_slice).collect();
        let image = rasterize_paths(&references)?;
        image::DynamicImage::ImageLuma8(image)
            .into_rgb8()
            .save(record["output"].as_str().ok_or("需要输出图像路径")?)?;
    }
    Ok(())
}
