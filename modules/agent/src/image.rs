//! 图像保持不可变并共享字节，完整历史的克隆不会重复分配页图。

use crate::Error;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{fmt, sync::Arc};

/// 跨协议共同支持的栅格格式，避免将文件路径误当成模型图像。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    /// 无损 PNG。
    Png,
    /// JPEG。
    Jpeg,
}

impl ImageFormat {
    /// 返回协议要求的媒体类型。
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
}

/// 模型可见的本地图像字节；调试输出隐藏载荷，序列化历史仍保留内容。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
// 拒绝混入类型标签等未知字段，防止损坏的媒体在旧图片迁移中被误读。
#[serde(deny_unknown_fields)]
pub struct Image {
    format: ImageFormat,
    data: Arc<[u8]>,
}

impl Image {
    /// 从字节建立图像，返回可共享的不可变内容。
    ///
    /// # 错误
    /// 空载荷、超过 5 MiB、尺寸超过 4096 像素或文件头无效时返回配置错误。
    pub fn new(format: ImageFormat, data: Vec<u8>) -> Result<Self, Error> {
        let image = Self {
            format,
            data: data.into(),
        };
        image.validate()?;
        Ok(image)
    }

    /// 返回图像格式。
    pub fn format(&self) -> ImageFormat {
        self.format
    }

    /// 只读访问字节，调用方不能修改已经附着历史的图像。
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// 返回原生协议使用的标准 Base64。
    pub fn base64(&self) -> String {
        STANDARD.encode(&self.data)
    }

    /// 返回无需第三方文件托管的图像数据 URL。
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.format.mime_type(), self.base64())
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        let valid = match self.format {
            ImageFormat::Png => self.data.starts_with(b"\x89PNG\r\n\x1a\n"),
            ImageFormat::Jpeg => self.data.starts_with(&[0xff, 0xd8, 0xff]),
        };
        if !valid || self.data.len() > 5 * 1024 * 1024 {
            return Err(Error::Config("图像格式签名不匹配或超过 5 MiB 上限".into()));
        }
        let size = imagesize::blob_size(&self.data)
            .map_err(|_| Error::Config("图像文件头或尺寸无效".into()))?;
        if size.width == 0 || size.height == 0 || size.width > 4096 || size.height > 4096 {
            return Err(Error::Config("图像尺寸必须在 1–4096 像素范围内".into()));
        }
        Ok(())
    }
}

impl fmt::Debug for Image {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Image")
            .field("format", &self.format)
            .field("bytes", &self.data.len())
            .finish()
    }
}
