//! 音视频以不可变字节或远端引用保存；协议编码与文件传输的职责分开。

mod format;
mod source;

use crate::{Error, Image};
pub use format::{AudioFormat, VideoFormat};
use serde::{Deserialize, Serialize};
pub use source::MediaSource;

/// 用户或工具提供的音频输入；格式由宿主声明，编解码有效性由接收模型校验。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Audio {
    format: AudioFormat,
    source: MediaSource,
}

impl Audio {
    /// 绑定音频格式与来源，不下载、上传或转写文件。
    ///
    /// # 错误
    /// 本地字节为空、超过 25 MiB 或引用格式无效时返回配置错误。
    pub fn new(format: AudioFormat, source: MediaSource) -> Result<Self, Error> {
        source.validate()?;
        Ok(Self { format, source })
    }

    /// 返回音频格式，适配器据此生成 MIME 类型或供应商格式标识。
    pub fn format(&self) -> AudioFormat {
        self.format
    }

    /// 只读访问来源，避免已保存的消息在请求之间改变内容。
    pub fn source(&self) -> &MediaSource {
        &self.source
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        self.source.validate()
    }
}

/// 用户或工具提供的视频输入；保留原始音视频，由原生模型处理时序信息。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Video {
    format: VideoFormat,
    source: MediaSource,
}

impl Video {
    /// 绑定视频格式与来源，不下载、上传、转码或抽帧。
    ///
    /// # 错误
    /// 本地字节为空、超过 25 MiB 或引用格式无效时返回配置错误。
    pub fn new(format: VideoFormat, source: MediaSource) -> Result<Self, Error> {
        source.validate()?;
        Ok(Self { format, source })
    }

    /// 返回视频容器格式；具体编码和时长限制由目标模型校验。
    pub fn format(&self) -> VideoFormat {
        self.format
    }

    /// 只读访问视频字节或引用。
    pub fn source(&self) -> &MediaSource {
        &self.source
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        self.source.validate()
    }
}

/// 工具结果中的有序媒体附件；载荷单独编码为原生内容，不进入工具 JSON 正文。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Media {
    /// 视觉图片。
    Image(Image),
    /// 音频文件。
    Audio(Audio),
    /// 视频文件。
    Video(Video),
}

impl Media {
    pub(crate) fn as_ref(&self) -> MediaRef<'_> {
        match self {
            Self::Image(value) => MediaRef::Image(value),
            Self::Audio(value) => MediaRef::Audio(value),
            Self::Video(value) => MediaRef::Video(value),
        }
    }
    pub(crate) fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Image(value) => value.validate(),
            Self::Audio(value) => value.validate(),
            Self::Video(value) => value.validate(),
        }
    }
}

/// 借用用户内容或工具附件中的媒体，公共校验无需克隆字节或远端引用。
#[derive(Clone, Copy)]
pub(crate) enum MediaRef<'a> {
    Image(&'a Image),
    Audio(&'a Audio),
    Video(&'a Video),
}

impl MediaRef<'_> {
    pub(crate) fn inline_size(self) -> usize {
        let source = match self {
            Self::Image(image) => return image.data().len(),
            Self::Audio(audio) => audio.source(),
            Self::Video(video) => video.source(),
        };
        match source {
            MediaSource::Bytes(bytes) => bytes.len(),
            _ => 0,
        }
    }
}

// 历史迁移只发生在读取边界；旧 images 数组转换后统一写为带类型的 media。
pub(crate) fn deserialize_media<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Media>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StoredMedia {
        Current(Media),
        Legacy(Image),
    }
    Vec::<StoredMedia>::deserialize(deserializer).map(|items| {
        items
            .into_iter()
            .map(|item| match item {
                StoredMedia::Current(media) => media,
                StoredMedia::Legacy(image) => Media::Image(image),
            })
            .collect()
    })
}
