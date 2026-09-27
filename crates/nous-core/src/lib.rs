//! Nous 库内核。
//!
//! 负责打开笔记库、按相对路径读写原始字节，以及链接索引、派生索引
//! （标题/标签/属性/全文）与改名事务。
//! 本 crate 不依赖 Node-API，测试直接调用此处 API。

mod attachments;
mod bookmarks;
mod entries;
mod error;
mod frontmatter;
mod graph;
mod identity;
mod index;
mod link;
mod mention;
mod pathutil;
mod recovery;
mod rename;
mod rename_journal;
mod rewrite;
mod save;
mod scan;
mod search;
mod search_control;
mod search_index;
mod search_text;
mod tag;
mod vault;
mod watch;
mod wiki;

pub use attachments::{ImportedAttachment, MAX_ATTACHMENT_BYTES};
pub use bookmarks::Bookmark;
pub use entries::{EntryKind, EntryMutation, VaultEntry};
pub use error::Error;
pub use graph::{Graph, GraphEdge, GraphNode};
pub use identity::NoteKeys;
pub use index::{HeadingRecord, TagCount};
pub use link::{LinkKind, LinkRecord, LinkResolution, LinkTarget};
pub use mention::{MentionKind, MentionRecord, Mentions};
pub use pathutil::path_to_slashes;
pub use recovery::Draft;
pub use rename::{RenameBatchIssue, RenameBatchOutcome, RenameOutcome};
pub use save::{FileSnapshot, SavedCopy, WriteOutcome};
pub use search::{
    SearchExpr, SearchHit, SearchLocation, SearchMatch, SearchMatchesPage, SearchPage, SearchQuery,
    SNIPPET_END, SNIPPET_START,
};
pub use search_control::SearchCancellation;
pub use vault::Vault;
pub use watch::{start_watch, WatchHandle};
