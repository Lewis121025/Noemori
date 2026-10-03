//! Noemori 库内核。
//!
//! 负责打开笔记库、按相对路径读写原始字节，以及链接索引、派生索引
//! （标题/标签/属性/全文）与改名事务。
//! 本 crate 不依赖 Node-API，测试直接调用此处 API。

mod error;
mod index;
mod links;
mod markdown;
mod opening;
mod rename;
mod search;
mod storage;
mod vault;

pub use error::Error;
pub use opening::{OpenObserver, OpenPhase, OpenProgress};
pub use index::{HeadingRecord, TagCount};
pub use links::graph::{Graph, GraphEdge, GraphNode};
pub use links::identity::NoteKeys;
pub use links::link::{LinkKind, LinkRecord, LinkResolution, LinkTarget};
pub use links::mention::{MentionKind, MentionRecord, Mentions};
pub use rename::{RenameBatchIssue, RenameBatchOutcome, RenameOutcome};
pub use search::hybrid::{HybridQuery, HybridHit, HybridEvidence, HybridPage, SemanticStatus, SemanticState, EvidenceKind};
pub use search::cancellation::SearchCancellation;
pub use search::{
    SearchExpr, SearchHit, SearchLocation, SearchMatch, SearchMatchesPage, SearchPage, SearchQuery,
    SNIPPET_END, SNIPPET_START,
};
pub use storage::attachments::{ImportedAttachment, MAX_ATTACHMENT_BYTES};
pub use storage::bookmarks::Bookmark;
pub use storage::entries::{EntryKind, EntryMutation, VaultEntry};
pub use storage::path::path_to_slashes;
pub use storage::recovery::Draft;
pub use storage::save::{FileSnapshot, SavedCopy, WriteOutcome};
pub use storage::watch::{start_watch, WatchHandle};
pub use vault::Vault;
