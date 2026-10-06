use serde::{Deserialize, Serialize};

/// 音频文件格式；每个协议仍需检查其支持的子集，不能把 MIME 字符串当作任意扩展字段。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    /// WAV 容器。
    Wav,
    /// MP3 音频。
    Mp3,
    /// AAC 音频。
    Aac,
    /// 无损 FLAC。
    Flac,
    /// Ogg 音频容器。
    Ogg,
    /// Opus 音频。
    Opus,
    /// AIFF 容器。
    Aiff,
    /// MPEG-4 音频容器。
    M4a,
    /// WebM 音频容器。
    Webm,
}

impl AudioFormat {
    /// 返回媒体声明的 MIME 类型，不根据文件名推断格式。
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Wav => "audio/wav",
            Self::Mp3 => "audio/mpeg",
            Self::Aac => "audio/aac",
            Self::Flac => "audio/flac",
            Self::Ogg => "audio/ogg",
            Self::Opus => "audio/opus",
            Self::Aiff => "audio/aiff",
            Self::M4a => "audio/m4a",
            Self::Webm => "audio/webm",
        }
    }
}

/// 视频容器格式；不假设所有模型都支持每一种容器或其中的编码。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoFormat {
    /// MPEG-4 容器。
    Mp4,
    /// WebM 容器。
    Webm,
    /// QuickTime 容器。
    Mov,
    /// Matroska 容器。
    Mkv,
    /// MPEG 视频。
    Mpeg,
    /// AVI 容器。
    Avi,
    /// Flash 视频容器。
    Flv,
    /// Windows Media 视频。
    Wmv,
    /// 3GPP 视频容器。
    #[serde(rename = "3gpp")]
    ThreeGp,
}

impl VideoFormat {
    /// 返回媒体声明的 MIME 类型；供应商的格式别名由适配器转换。
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Mp4 => "video/mp4",
            Self::Webm => "video/webm",
            Self::Mov => "video/quicktime",
            Self::Mkv => "video/x-matroska",
            Self::Mpeg => "video/mpeg",
            Self::Avi => "video/x-msvideo",
            Self::Flv => "video/x-flv",
            Self::Wmv => "video/x-ms-wmv",
            Self::ThreeGp => "video/3gpp",
        }
    }
}
