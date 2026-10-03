//! 融合查询和模型操作的库入口；推理不持有正文写锁。

use super::Vault;
use crate::Error;
use std::{io, path::Path};

impl Vault {
    /// 配置全应用共享模型目录；开库提交前调用，不执行模型加载。
    /// # Errors
    /// 模型状态锁失效。
    pub fn configure_search_model(&self, directory: &Path) -> Result<(), Error> {
        self.semantic.configure(directory)
    }

    /// 安装固定且校验过的 Harrier 模型；source 为空时下载，否则从目录导入。
    /// # Errors
    /// 取消、网络、文件校验或磁盘错误；失败不发布半份模型。
    pub fn install_search_model(
        &self,
        source: Option<&Path>,
        token: &crate::SearchCancellation,
    ) -> Result<(), Error> {
        self.semantic.install(source, token)
    }

    /// 后台处理正文变更；模型缺失时保留待处理状态，不影响词法查询。
    /// # Errors
    /// 推理、索引持久化或取消错误。
    pub fn publish_semantic_index(&self, token: &crate::SearchCancellation) -> Result<(), Error> {
        self.semantic.synchronize(self, token)
    }

    /// 查询模型与当前正文的覆盖状态，不加载模型。
    /// # Errors
    /// 数据库或状态锁错误。
    pub fn semantic_status(&self) -> Result<crate::SemanticStatus, Error> {
        self.semantic.status(&*self.lock_conn()?)
    }

    /// 融合召回在同一正文快照上筛选；首次冻结排名，续页只消费已有会话。
    /// # Errors
    /// 无效查询、取消、过期游标、数据库或倒排索引错误。
    pub fn search_hybrid(
        &self,
        query: &crate::HybridQuery,
        cursor: Option<&str>,
        token: &crate::SearchCancellation,
    ) -> Result<crate::HybridPage, Error> {
        use crate::search::hybrid;
        token.check()?;
        hybrid::validate(query)?;
        // 推理不持有正文快照或写锁；之后捕获本次查询实际使用的最新版本。
        let (vector, model_error) = if cursor.is_none() {
            match self.semantic.query_vector(&query.text, token) {
                Ok(vector) => (vector, None),
                Err(Error::SearchCancelled) => return Err(Error::SearchCancelled),
                Err(error) => (None, Some(error.to_string())),
            }
        } else {
            (None, None)
        };
        let (conn, index) = self.search_snapshot(token)?;
        if let Some(cursor) = cursor {
            return self
                .hybrid_sessions
                .lock()
                .map_err(|_| io::Error::other("搜索会话锁已失效"))?
                .page(query, &index.revision, cursor);
        }
        let eligible = hybrid::eligible(&conn, query, token)?;
        let mut status = self.semantic.status(&conn)?;
        if let Some(message) = model_error {
            status.state = crate::SemanticState::Failed { message };
        }
        let vectors = if let Some(vector) = vector {
            match self
                .semantic
                .retrieve(&conn, &self.index_dir, &vector, &eligible, token)
            {
                Ok(hits) => hits,
                Err(Error::SearchCancelled) => return Err(Error::SearchCancelled),
                Err(error) => {
                    status.state = crate::SemanticState::Failed {
                        message: error.to_string(),
                    };
                    hybrid::VectorRecall::default()
                }
            }
        } else {
            hybrid::VectorRecall::default()
        };
        let (hits, limited) =
            hybrid::retrieve(&conn, &index, query, &eligible, &vectors.hits, token)?;
        token.check()?;
        self.hybrid_sessions
            .lock()
            .map_err(|_| io::Error::other("搜索会话锁已失效"))?
            .publish(
                query,
                &index.revision,
                hits,
                status,
                limited || vectors.limited,
            )
    }

    /// 融合查询的精确命中仍按其字面子查询分页，语义证据不进入命中计数。
    /// # Errors
    /// 无效查询、过期游标、取消或数据库错误。
    pub fn hybrid_matches(
        &self,
        query: &crate::HybridQuery,
        cursor: &str,
        token: &crate::SearchCancellation,
    ) -> Result<crate::SearchMatchesPage, Error> {
        crate::search::hybrid::validate(query)?;
        token.check()?;
        let identity = crate::search::hybrid::fingerprint(query)?;
        let literal = crate::search::hybrid::literal_query(query);
        let result = self.search_snapshot(token).and_then(|(reader, snapshot)| {
            crate::search::execute_matches_identity(
                &reader, &snapshot, &literal, &identity, cursor, token,
            )
        });
        token.check()?;
        result
    }
}
